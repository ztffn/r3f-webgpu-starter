// Encodes a coverage-preserving mip chain into a KTX2 file, and audits what comes back.
//
// The format choice is measured, not preferred: UASTC with Zstd supercompression flips
// 0.000% of pixels across the runtime alpha cutoff, while ETC1S flips 0.569% and thins
// coverage — the direction docs/08 §8 invariant 6 forbids, because a silhouette that
// thins at range hands free vision to whoever backs off. Raw UASTC is 18x the download
// of the PNG it replaces, so `--zcmp` is mandatory rather than an optimisation.

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { encodePng } from "../../src/foliage/impostorPng.ts";

const run = promisify(execFile);

/**
 * UASTC quality level. 2 is the encoder's middle setting.
 *
 * Raised from the default because the atlas IS the far tier's silhouette; the audit in
 * `ktx2Alpha` is what proves a given level is safe, so change this and re-read it.
 */
const UASTC_QUALITY = 2;

/** Zstd level. 18 is near the top of the useful range and costs bake time, not runtime. */
const ZSTD_LEVEL = 18;

/**
 * Write `levels` as one KTX2 file at `outPath`.
 *
 * The mip chain is SUPPLIED, never generated: `--genmipmap` would run the encoder's own
 * box filter over alpha and undo the coverage solve that alphaMips.ts exists to perform.
 * `--assign_oetf linear` because the bake writes linear values, matching the NoColorSpace
 * the runtime texture is created with.
 */
export async function encodeKtx2(outPath, levels) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "df2-ktx2-"));
  try {
    const files = [];
    for (let i = 0; i < levels.length; i += 1) {
      const file = path.join(dir, `l${String(i).padStart(2, "0")}.png`);
      await fs.writeFile(file, await encodePng(levels[i]));
      files.push(file);
    }
    await run("toktx", [
      "--t2",
      "--encode",
      "uastc",
      "--uastc_quality",
      String(UASTC_QUALITY),
      "--zcmp",
      String(ZSTD_LEVEL),
      "--assign_oetf",
      "linear",
      "--mipmap",
      "--levels",
      String(levels.length),
      outPath,
      ...files,
    ]);
    return (await fs.stat(outPath)).size;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/**
 * Decode level 0 back out of a KTX2 and return its pixels, so the audit measures what
 * SHIPS rather than what was encoded.
 *
 * The distinction is the same one that let the authored trees skip the coverage test: a
 * check that runs on the source cannot see what the pipeline did to it afterwards.
 */
export async function ktx2Alpha(ktxPath, width, height) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "df2-ktx2-audit-"));
  try {
    const out = path.join(dir, "l0.raw");
    // Transcode to plain RGBA and extract RAW rather than PNG: `ktx extract` picks an
    // indexed-palette PNG for sparse atlases, which the project's decoder does not read,
    // and a raw buffer needs no decoder at all. The bytes carry the UASTC error, which is
    // the term that could move the silhouette.
    await run("ktx", ["extract", "--transcode", "rgba8", "--level", "0", "--raw", ktxPath, out]);
    const data = new Uint8Array(await fs.readFile(out));
    const expected = width * height * 4;
    if (data.length !== expected) {
      throw new Error(`${ktxPath}: expected ${expected} bytes from extract, got ${data.length}`);
    }
    return { data, width, height };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
