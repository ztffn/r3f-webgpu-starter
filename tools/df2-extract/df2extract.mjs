#!/usr/bin/env node
// df2-extract — Phase 0 asset pipeline (seed).
//
// Currently implements the VALIDATED parts: PFF3/PFF2 archive unpack and .trn
// manifest parsing. Verified against real DF-era terrain archives — see
// docs/06-asset-extraction-findings.md and docs/02-asset-format-specification.md §1/§5.
//
// Remaining Phase 0 work (not yet here): PCX (8-bit RLE) / TGA decoders, JPEG
// passthrough, and the grassHeightField bake (detail_map × detail_elev strip).
//
// No dependencies — Node built-ins only. Runs on plain `node`.
//
// Usage:
//   node df2extract.mjs list    <archive.pff>
//   node df2extract.mjs extract <archive.pff> <outdir>
//   node df2extract.mjs trn     <file.trn>

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const SIG_PFF3 = 0x33464650; // 'PFF3'
const SIG_PFF2 = 0x32464650; // 'PFF2'

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
  if (headerSize !== 20 || recordSize !== 32)
    throw new Error(`Unexpected headerSize=${headerSize} recordSize=${recordSize}`);

  const entries = [];
  for (let i = 0; i < recordCount; i++) {
    const o = recordOffset + i * recordSize;
    const deleted = dv.getUint32(o, true);
    const fileOffset = dv.getUint32(o + 4, true);
    const fileSize = dv.getUint32(o + 8, true);
    const fileModified = dv.getUint32(o + 12, true);
    let name = "";
    for (let k = 0; k < 15; k++) {
      const c = buf[o + 16 + k];
      if (c === 0) break;
      name += String.fromCharCode(c);
    }
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
function main() {
  const [cmd, file, outdir] = process.argv.slice(2);
  if (!cmd || !file) {
    console.error(
      "usage:\n  df2extract.mjs list <a.pff>\n  df2extract.mjs extract <a.pff> <outdir>\n  df2extract.mjs trn <f.trn>"
    );
    process.exit(1);
  }

  if (cmd === "trn") {
    console.log(JSON.stringify(parseTrn(readFileSync(file, "latin1")), null, 2));
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
    let n = 0;
    for (const e of pff.entries) {
      if (e.deleted) continue;
      writeFileSync(join(outdir, e.name), buf.subarray(e.fileOffset, e.fileOffset + e.fileSize));
      n++;
    }
    console.log(`Extracted ${n} files -> ${outdir}`);
  } else if (cmd !== "list") {
    throw new Error(`unknown command: ${cmd}`);
  }
}

// Run as CLI only when invoked directly.
if (import.meta.url === `file://${process.argv[1]}`) main();
