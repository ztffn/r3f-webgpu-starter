#!/usr/bin/env node
// df2-extract — Phase 0 asset pipeline (seed).
//
// PFF3/PFF2 archive unpack and .trn manifest parsing, verified against real
// DF-era terrain archives — see docs/06-asset-extraction-findings.md and
// docs/02-asset-format-specification.md §1/§5.
//
// The rest of the pipeline lives alongside: PCX decoding and PNG encoding in
// imageio.mjs, and JPEG passthrough plus the grassHeightField bake in
// prepare-terrain.mjs.
//
// No dependencies — Node built-ins only. Runs on plain `node`.
//
// Usage:
//   node df2extract.mjs list    <archive.pff>
//   node df2extract.mjs extract <archive.pff> <outdir>
//   node df2extract.mjs trn     <file.trn>

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const SIG_PFF3 = 0x33464650; // 'PFF3'
const SIG_PFF2 = 0x32464650; // 'PFF2'

/** Read a NUL-terminated string from a fixed-length field. */
export function cstr(buf, off, len) {
  let s = "";
  for (let i = 0; i < len; i++) {
    const c = buf[off + i];
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

/** Parse a PFF3/PFF2 archive buffer into { sig, entries[] }. */
export function parsePff(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const headerSize = dv.getUint32(0, true);
  const signature = dv.getUint32(4, true);
  const recordCount = dv.getUint32(8, true);
  const recordSize = dv.getUint32(12, true);
  const recordOffset = dv.getUint32(16, true);

  const sig =
    signature === SIG_PFF3 ? "PFF3" : signature === SIG_PFF2 ? "PFF2" : null;
  if (!sig) throw new Error(`Not a PFF archive (sig 0x${signature.toString(16)})`);
  // recordSize 36 is the later PFF3 revision: the same 32-byte record plus a
  // trailing 4-byte checksum (verified against MED.PFF: offsets stay contiguous
  // and the name field is still 16 bytes).
  if (headerSize !== 20 || (recordSize !== 32 && recordSize !== 36))
    throw new Error(`Unexpected headerSize=${headerSize} recordSize=${recordSize}`);

  const entries = [];
  for (let i = 0; i < recordCount; i++) {
    const o = recordOffset + i * recordSize;
    const deleted = dv.getUint32(o, true);
    const fileOffset = dv.getUint32(o + 4, true);
    const fileSize = dv.getUint32(o + 8, true);
    const fileModified = dv.getUint32(o + 12, true);
    // The name field is the remaining 16 bytes of the 32-byte record, NUL-padded.
    // Reading only 15 truncated any name that filled the field.
    const name = cstr(buf, o + 16, 16);
    entries.push({ deleted: !!deleted, fileOffset, fileSize, fileModified, name });
  }
  return { sig, headerSize, recordCount, recordSize, recordOffset, entries };
}

/** Parse a .trn manifest (plain text) into a key→value object. `filter` becomes [r,g,b]. */
export function parseTrn(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(\w+)\s+(.*)$/);
    if (!m) continue;
    let [, key, val] = m;
    val = val.trim();
    const q = val.match(/^"(.*)"$/);
    if (q) val = q[1];
    else if (val.includes(",")) val = val.split(",").map((s) => Number(s.trim()));
    else if (/^-?\d+$/.test(val)) val = Number(val);
    out[key] = val;
  }
  return out;
}

// --- CLI ---------------------------------------------------------------------
async function main() {
  const [cmd, file, outdir] = process.argv.slice(2);
  if (!cmd || !file) {
    console.error(
      "usage:\n  df2extract.mjs list <a.pff>\n  df2extract.mjs extract <a.pff> <outdir>\n" +
        "  df2extract.mjs trn <f.trn>\n" +
        "  df2extract.mjs 3di <f.3di> [out.glb] [--lod n] [--scale f]"
    );
    process.exit(1);
  }

  if (cmd === "trn") {
    console.log(JSON.stringify(parseTrn(readFileSync(file, "latin1")), null, 2));
    return;
  }

  if (cmd === "3di") {
    const { parse3di, toGlb, describe3di, UNITS_PER_METER } = await import("./file3di.mjs");
    // Positional destructuring can't tell "out.glb" from "--lod": walk the
    // arguments, consuming flag values, so `3di f.3di --lod 2` describes LOD 2
    // instead of writing a GLB literally named "--lod".
    let out = null;
    let lod = 0;
    let scale = null;
    const rest = process.argv.slice(4);
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a === "--lod") lod = Number(rest[++i]);
      else if (a === "--scale") scale = Number(rest[++i]);
      else if (!a.startsWith("--") && out === null) out = a;
      else throw new Error(`unexpected argument: ${a}`);
    }
    if (!Number.isInteger(lod) || lod < 0) throw new Error(`--lod needs a whole number, got ${lod}`);
    if (scale !== null && !(Number.isFinite(scale) && scale > 0))
      throw new Error(`--scale needs a positive number, got ${scale}`);

    const model = parse3di(readFileSync(file));
    console.log(describe3di(model));
    if (out) {
      // Default: model units are 1/256 m (UNITS_PER_METER — the calibrated
      // measurement lives in file3di.mjs), so the GLB comes out in meters.
      const s = scale ?? 1 / UNITS_PER_METER;
      mkdirSync(dirname(resolve(out)), { recursive: true });
      writeFileSync(out, toGlb(model, { lod, scale: s }));
      console.log(`wrote ${out} (lod ${lod}, scale ${s})`);
    }
    return;
  }

  const buf = readFileSync(file);
  const pff = parsePff(buf);
  console.log(
    `${basename(file)}: ${pff.sig} records=${pff.recordCount} tableOffset=${pff.recordOffset}`
  );
  for (const e of pff.entries) {
    console.log(
      `  ${e.name.padEnd(16)} off=${String(e.fileOffset).padStart(9)} ` +
        `size=${String(e.fileSize).padStart(9)}${e.deleted ? " [DELETED]" : ""}`
    );
  }

  if (cmd === "extract") {
    if (!outdir) throw new Error("extract needs an <outdir>");
    mkdirSync(outdir, { recursive: true });
    const root = resolve(outdir);
    let n = 0;
    let skipped = 0;
    for (const e of pff.entries) {
      if (e.deleted) continue;

      // Entry names come from 16 bytes of an UNTRUSTED archive, and this tool
      // exists to unpack third-party community archives. Without this check a
      // name like "../../.zshrc" writes wherever it likes.
      const dest = resolve(root, e.name);
      if (dest !== root && !dest.startsWith(root + sep)) {
        console.warn(`  ! refusing "${e.name}" — escapes ${outdir}`);
        skipped++;
        continue;
      }
      // Truncated or corrupt records would otherwise write silently short files.
      if (e.fileOffset + e.fileSize > buf.length) {
        console.warn(
          `  ! refusing "${e.name}" — extends past end of archive ` +
            `(offset ${e.fileOffset} + size ${e.fileSize} > ${buf.length})`
        );
        skipped++;
        continue;
      }

      writeFileSync(dest, buf.subarray(e.fileOffset, e.fileOffset + e.fileSize));
      n++;
    }
    console.log(`Extracted ${n} files -> ${outdir}${skipped ? ` (${skipped} refused)` : ""}`);
  } else if (cmd !== "list") {
    throw new Error(`unknown command: ${cmd}`);
  }
}

// Run as CLI only when invoked directly. pathToFileURL, not string concatenation:
// import.meta.url percent-encodes, so a path containing a space or any non-ASCII
// character never matched and the tool exited 0 having done nothing at all.
// main() is async (the 3di command lazy-imports its module), so failures must be
// caught here or they surface as unhandled rejections instead of a clean message.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
