#!/usr/bin/env node

/**
 * Prepares the authored first-person hands + weapons rig for the browser.
 *
 * Reads the gitignored Blender export (`_tempAssets/3d/FPHands/export/`, ~150 MB of
 * uncompressed GLB) and writes Draco-compressed geometry with KTX2 UASTC+Zstd textures
 * into `public/assets/weapons/`, plus an `index.json` manifest the runtime reads.
 * Validates every weapon against the documented clip vocabulary and optic/muzzle
 * conventions, so a bad re-export fails HERE rather than as a silent missing animation.
 */

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import sharp from "sharp";
import draco3d from "draco3d";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS, KHRTextureBasisu } from "@gltf-transform/extensions";
import { dedup, draco, getTextureColorSpace, prune, weld } from "@gltf-transform/functions";

const run = promisify(execFile);

/**
 * The rig's ten weapon keys and the segment vocabulary each one actually ships.
 *
 * Copied from CODING_AGENT_NOTES.txt and then VERIFIED against the exported files by
 * this script — the notes are the author's intent, the GLB is the truth, and the two
 * disagreeing is exactly the failure this table exists to catch.
 */
const WEAPON_SEGMENTS = {
  carbine: ["shoot", "reload_fast", "reload_slow", "weapon_down", "weapon_up", "idle", "melee"],
  ak: ["shoot", "reload_fast", "reload_slow", "weapon_down", "weapon_up", "idle", "melee"],
  smg: ["shoot", "reload_fast", "reload_slow", "weapon_down", "weapon_up", "idle", "melee"],
  pistol: ["shoot", "reload_fast", "reload_slow", "weapon_down", "weapon_up", "idle", "melee"],
  fiftycal: ["shoot", "reload_fast", "reload_slow", "weapon_down", "weapon_up", "idle", "melee"],
  sniper: ["shoot", "chamber_round", "reload", "weapon_down", "weapon_up", "idle", "melee"],
  lmg: ["shoot", "reload", "reload_alt", "weapon_down", "weapon_up", "idle", "melee"],
  grenadelauncher: ["shoot", "reload", "weapon_down", "weapon_up", "idle", "melee"],
  shotgun: [
    "shoot",
    "pump",
    "reload_single_shell",
    "reload_complete",
    "weapon_down",
    "weapon_up",
    "idle",
    "melee",
  ],
  knife: [
    "idle",
    "attack_slice1",
    "attack_slice2",
    "attack_stab1",
    "attack_stab2",
    "weapon_down",
    "weapon_up",
  ],
};

/**
 * Segments the game actually drives. Missing one of these is fatal; anything else in
 * the documented vocabulary above is reported and recorded, not enforced.
 *
 * The distinction is not pedantry. Two shipped files are already incomplete on the
 * WEAPON side while the hands carry every clip: lmg.glb has no `reload_alt`, and
 * shotgun.glb has none of `pump`, `reload_single_shell` or `reload_complete`. That is
 * the exporter gap CODING_AGENT_NOTES describes under SOURCE OF TRUTH. Refusing the
 * whole bake over clips nothing calls yet would block the nine good weapons on two
 * unused animations, so the manifest records what is genuinely there instead.
 */
const CORE_SEGMENTS = ["idle", "weapon_up", "weapon_down"];

/** The one clip a weapon is useless without — its primary action. */
const PRIMARY_ACTION = { knife: "attack_slice1" };

/** The bone every weapon root parents onto. Its absence is fatal, not a warning. */
const ATTACH_BONE = "R_wrist";

/** The hands armature node name — and, in a WEAPON file, the marker of a bad export. */
const HANDS_ARMATURE = "Hands_Armature";

/**
 * Measured, not preferred, and the SAME PAIR as tools/vegetation/ktx2.mjs.
 *
 * That file's audit is what established them — ETC1S was rejected there on a 0.569% alpha
 * cutoff flip — and its comment says to re-read the audit before changing the quality
 * level. Deliberately duplicated rather than imported: that module pulls in a TypeScript
 * helper, and this script runs under a bare `node` with no strip-types flag. If you retune
 * one, retune both.
 */
const UASTC_QUALITY = 2;
const ZSTD_LEVEL = 18;

/**
 * Max texture edge. First-person weapons sit close to the camera but each occupies a
 * modest screen area, and only ONE weapon is ever resident, so this trades authored
 * texel density for a per-equip download. Raise it with `--size` and re-read the
 * reported totals rather than assuming.
 */
const DEFAULT_TEXTURE_SIZE = 1024;

function parseArgs(argv) {
  const args = {
    source: "_tempAssets/3d/FPHands/export",
    out: "public/assets/weapons",
    size: DEFAULT_TEXTURE_SIZE,
    only: null,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const [flag, inline] = argv[i].split("=");
    const value = inline ?? argv[++i];
    if (flag === "--source") args.source = value;
    else if (flag === "--out") args.out = value;
    else if (flag === "--size") args.size = Number(value);
    else if (flag === "--only") args.only = value.split(",");
    else throw new Error(`unknown flag ${flag}`);
  }
  if (!Number.isFinite(args.size) || args.size < 64) throw new Error(`bad --size ${args.size}`);
  return args;
}

async function createIo() {
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  io.registerDependencies({
    "draco3d.encoder": await draco3d.createEncoderModule(),
    "draco3d.decoder": await draco3d.createDecoderModule(),
  });
  return io;
}

/**
 * Re-encode one texture as KTX2 UASTC+Zstd at or below `size`.
 *
 * `--genmipmap` is used here and is FORBIDDEN in tools/vegetation/ktx2.mjs — the
 * difference is real, not an inconsistency. That bake supplies a coverage-preserving
 * chain because its atlases are alpha-TESTED and a box filter thins the silhouette.
 * These are opaque or alpha-BLENDED, where a box filter is simply correct.
 */
async function encodeTexture(image, mimeType, srgb, size) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "df2-fphands-"));
  try {
    const input = path.join(dir, "in.png");
    const output = path.join(dir, "out.ktx2");
    const pipeline = sharp(Buffer.from(image));
    const meta = await pipeline.metadata();
    // Block compression wants a multiple of 4 on each edge; round DOWN so a texture
    // never grows, and keep aspect so authored UVs stay valid.
    const scale = Math.min(1, size / Math.max(meta.width, meta.height));
    const fit = (value) => Math.max(4, Math.floor((value * scale) / 4) * 4);
    const width = fit(meta.width);
    const height = fit(meta.height);
    await pipeline.resize(width, height, { fit: "fill" }).png({ compressionLevel: 0 }).toFile(input);
    await run("toktx", [
      "--t2",
      "--encode",
      "uastc",
      "--uastc_quality",
      String(UASTC_QUALITY),
      "--zcmp",
      String(ZSTD_LEVEL),
      "--genmipmap",
      "--assign_oetf",
      srgb ? "srgb" : "linear",
      output,
      input,
    ]);
    return { data: new Uint8Array(await fs.readFile(output)), width, height, mimeType };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function compressTextures(document, size) {
  document.createExtension(KHRTextureBasisu).setRequired(true);
  for (const texture of document.getRoot().listTextures()) {
    const image = texture.getImage();
    if (!image) continue;
    const srgb = getTextureColorSpace(document, texture) === "srgb";
    const encoded = await encodeTexture(image, texture.getMimeType(), srgb, size);
    texture.setImage(encoded.data).setMimeType("image/ktx2");
    const uri = texture.getURI();
    if (uri) texture.setURI(uri.replace(/\.\w+$/, ".ktx2"));
  }
}

/**
 * Remove every scene root that is not the weapon.
 *
 * sniper.glb ships a second full copy of the hands (armature, skinned mesh and 8.31 MB
 * of arm textures) alongside the rifle — no other weapon file does. The runtime parents
 * the loaded scene onto R_wrist, so shipping that copy would hang a second pair of arms
 * in bind pose off the player's wrist. Dropping it here keeps the runtime free of a
 * per-file special case, and `prune` then reclaims the orphaned mesh, skin and textures.
 */
function stripNonWeaponRoots(document, key) {
  const scene = document.getRoot().getDefaultScene() ?? document.getRoot().listScenes()[0];
  const removed = [];
  for (const node of scene.listChildren()) {
    if (node.getName() !== HANDS_ARMATURE) continue;
    removed.push(node.getName());
    // Collect the subtree BEFORE disposing anything: dispose() re-parents a node's
    // children rather than removing them, so disposing the armature alone leaves 49 arm
    // bones and the skinned mesh alive. detach() is weaker still — it only unlinks from
    // the scene, and `prune` then correctly declines to remove bones that a live Skin
    // still cites. That combination is what shipped the arm textures the first time.
    const subtree = [];
    node.traverse((child) => subtree.push(child));
    for (const child of subtree) child.dispose();
  }
  // The Skin holds its own references to the joints and the inverse-bind accessor, so
  // it outlives its skeleton and keeps the mesh reachable. Drop any skin left boneless.
  for (const skin of document.getRoot().listSkins()) {
    if (skin.listJoints().length === 0) skin.dispose();
  }
  if (removed.length > 0) {
    console.warn(
      `  ! ${key}: dropped stray root(s) ${removed.join(", ")} — the hands ship in hands.glb`
    );
  }
  return removed;
}

/**
 * Weld, dedup, prune and Draco-compress, clearing orphaned extension properties midway.
 *
 * The extra step is load-bearing. Disposing a Material does NOT dispose the extension
 * properties hanging off it, so the `KHR_materials_specular` node belonging to the
 * stripped hands material outlives it and keeps `armsmoothness` reachable — through any
 * number of prune passes, because from prune's side the texture genuinely still has a
 * parent. Measured: without this, 0.82 MB of arm texture ships in every sniper build.
 */
async function optimise(document) {
  await document.transform(weld(), dedup(), prune());
  for (const texture of document.getRoot().listTextures()) {
    for (const parent of texture.listParents()) {
      if (parent.propertyType === "Root") continue;
      const owners = parent.listParents().filter((owner) => owner.propertyType !== "Root");
      if (owners.length === 0) parent.dispose();
    }
  }
  await document.transform(prune(), draco());
}

/**
 * Re-read what was written and assert the weapon file carries no hands.
 *
 * The first version of the strip above looked like it worked — the log said the root was
 * dropped and the scene listed only the weapon — while the bones, the skinned mesh and
 * 2.18 MB of compressed arm textures all still shipped. Checking the SOURCE document
 * cannot see that; only the output file can.
 */
async function assertNoHands(io, outPath, key) {
  const written = await io.read(outPath);
  const strays = written
    .getRoot()
    .listNodes()
    .filter((node) => /^(Hands_Mesh|[LR]_(wrist|elbow|arm|palm))$/.test(node.getName()))
    .map((node) => node.getName());
  const armTextures = written
    .getRoot()
    .listTextures()
    .filter((texture) => /^arm/i.test(texture.getName() ?? ""))
    .map((texture) => texture.getName());
  if (strays.length > 0 || armTextures.length > 0) {
    throw new Error(
      `${key}.glb still carries hands data after the strip: ` +
        `${[...strays, ...armTextures].join(", ")}`
    );
  }
}

/**
 * Describe the optic lens, if the weapon has one.
 *
 * The runtime derives the PiP anchor and the lens UV frame from this geometry rather
 * than from hardcoded constants, so this records what the bake SAW: a weapon whose lens
 * silently stopped exporting shows up as `optic: null` in the manifest instead of as a
 * scope that renders nothing.
 */
function describeOptic(document) {
  const lens = document
    .getRoot()
    .listNodes()
    .find((node) => /(_Lens|_Glass)$/.test(node.getName()) && node.getMesh());
  if (!lens) return null;
  const primitive = lens.getMesh().listPrimitives()[0];
  const position = primitive.getAttribute("POSITION");
  const min = position.getMinNormalized([]);
  const max = position.getMaxNormalized([]);
  const span = max.map((value, index) => value - min[index]);
  const flattest = span.indexOf(Math.min(...span));
  const radial = span.filter((_, index) => index !== flattest);
  return {
    node: lens.getName(),
    vertices: position.getCount(),
    // Local-space centre and radius of the glass disc. The optical axis is the flattest
    // axis; a lens is a disc, so the other two spans agree and their half-span is the
    // radius the eyebox and reticle are scaled against.
    centre: max.map((value, index) => (value + min[index]) / 2),
    axis: ["x", "y", "z"][flattest],
    radius: Math.max(...radial) / 2,
    planar: span[flattest] === 0,
  };
}

async function prepareWeapon(io, key, sourcePath, outPath, size) {
  const document = await io.read(sourcePath);
  stripNonWeaponRoots(document, key);

  const clips = document.getRoot().listAnimations().map((animation) => animation.getName());
  const documented = WEAPON_SEGMENTS[key];
  const required = [...CORE_SEGMENTS, PRIMARY_ACTION[key] ?? "shoot"];
  const missingCore = required.filter((segment) => !clips.includes(segment));
  if (missingCore.length > 0) {
    throw new Error(
      `${key}.glb is missing core clip(s): ${missingCore.join(", ")} (has: ${clips.join(", ")})`
    );
  }
  const present = documented.filter((segment) => clips.includes(segment));
  const missing = documented.filter((segment) => !clips.includes(segment));
  if (missing.length > 0) {
    console.warn(
      `  ! ${key}: documented but NOT exported: ${missing.join(", ")} — ` +
        `the hands carry these clips, the weapon does not, so nothing may drive them`
    );
  }
  // Every clip must start at zero. The export pipeline needs a manual binary rebase step
  // after Blender writes absolute NLA keyframe times; skipping it produces clips that
  // play at the right speed but start seconds into a timeline that does not exist.
  // That symptom reads as "wrong duration" and cost the asset author real time, so the
  // check lives here where it is cheap and unambiguous.
  const unrebased = [];
  for (const animation of document.getRoot().listAnimations()) {
    let earliest = Infinity;
    for (const sampler of animation.listSamplers()) {
      const input = sampler.getInput();
      if (input) earliest = Math.min(earliest, input.getMinNormalized([])[0]);
    }
    if (Number.isFinite(earliest) && earliest > 1e-6) {
      unrebased.push(`${animation.getName()} starts at ${earliest.toFixed(3)}s`);
    }
  }
  if (unrebased.length > 0) {
    throw new Error(`${key}.glb keyframes were never rebased to zero: ${unrebased.join("; ")}`);
  }

  const optic = describeOptic(document);
  const muzzle = document
    .getRoot()
    .listNodes()
    .some((node) => node.getName() === "muzzlemesh");
  if (!muzzle && key !== "knife") {
    throw new Error(`${key}.glb has no node named exactly "muzzlemesh"`);
  }
  const wristGoal = document
    .getRoot()
    .listNodes()
    .find((node) => /_l_wrist_goal$/i.test(node.getName()));

  await compressTextures(document, size);
  await optimise(document);
  await io.write(outPath, document);
  await assertNoHands(io, outPath, key);
  const bytes = (await fs.stat(outPath)).size;
  return {
    key,
    file: path.basename(outPath),
    bytes,
    segments: present,
    missingSegments: missing,
    clips,
    optic,
    muzzleFlash: muzzle,
    leftWristGoal: wristGoal?.getName() ?? null,
  };
}

async function prepareHands(io, sourcePath, outPath, size) {
  const document = await io.read(sourcePath);
  const bone = document
    .getRoot()
    .listNodes()
    .find((node) => node.getName() === ATTACH_BONE);
  if (!bone) throw new Error(`hands.glb has no "${ATTACH_BONE}" bone; nothing could attach to it`);

  const clips = document.getRoot().listAnimations().map((animation) => animation.getName());
  // Same split as the weapons: a missing core clip leaves a weapon unusable and is
  // fatal, while a missing optional one is recorded so the runtime never asks for it.
  const missingCore = [];
  const missing = [];
  for (const [key, segments] of Object.entries(WEAPON_SEGMENTS)) {
    const required = new Set([...CORE_SEGMENTS, PRIMARY_ACTION[key] ?? "shoot"]);
    for (const segment of segments) {
      const name = `hand_${key}_${segment}`;
      if (clips.includes(name)) continue;
      (required.has(segment) ? missingCore : missing).push(name);
    }
  }
  if (missingCore.length > 0) {
    throw new Error(`hands.glb is missing core clip(s): ${missingCore.join(", ")}`);
  }
  if (missing.length > 0) console.warn(`  ! hands: missing optional clip(s): ${missing.join(", ")}`);

  await compressTextures(document, size);
  await optimise(document);
  await io.write(outPath, document);
  return { file: path.basename(outPath), bytes: (await fs.stat(outPath)).size, clips };
}

async function main() {
  const args = parseArgs(process.argv);
  const source = path.resolve(args.source);
  const out = path.resolve(args.out);
  try {
    await fs.access(source);
  } catch {
    throw new Error(
      `source rig not found at ${source}. It is gitignored and not present in every ` +
        `checkout; pass --source, or skip this step and keep the committed output.`
    );
  }
  await fs.mkdir(out, { recursive: true });
  const io = await createIo();

  const keys = (args.only ?? Object.keys(WEAPON_SEGMENTS)).filter((key) => {
    if (WEAPON_SEGMENTS[key]) return true;
    throw new Error(`unknown weapon key "${key}"`);
  });

  console.log(`preparing hands + ${keys.length} weapon(s) at <=${args.size}px -> ${out}`);
  const handsSource = path.join(source, "hands.glb");
  const handsBefore = (await fs.stat(handsSource)).size;
  const hands = await prepareHands(io, handsSource, path.join(out, "hands.glb"), args.size);
  console.log(
    `  hands.glb  ${(handsBefore / 1e6).toFixed(1)} -> ${(hands.bytes / 1e6).toFixed(2)} MB  ` +
      `(${hands.clips.length} clips)`
  );

  const weapons = {};
  let totalBefore = handsBefore;
  let totalAfter = hands.bytes;
  for (const key of keys) {
    const weaponSource = path.join(source, "weapons", `${key}.glb`);
    const before = (await fs.stat(weaponSource)).size;
    const result = await prepareWeapon(io, key, weaponSource, path.join(out, `${key}.glb`), args.size);
    weapons[key] = result;
    totalBefore += before;
    totalAfter += result.bytes;
    console.log(
      `  ${key.padEnd(16)} ${(before / 1e6).toFixed(1).padStart(5)} -> ` +
        `${(result.bytes / 1e6).toFixed(2).padStart(5)} MB  ` +
        `optic=${result.optic ? result.optic.node : "none"}`
    );
  }

  const manifest = {
    generated: "npm run prepare:fphands",
    attachBone: ATTACH_BONE,
    hands: { file: hands.file, bytes: hands.bytes, clips: hands.clips.length },
    weapons: Object.fromEntries(
      Object.entries(weapons).map(([key, value]) => [
        key,
        {
          file: value.file,
          bytes: value.bytes,
          segments: value.segments,
          missingSegments: value.missingSegments,
          optic: value.optic,
          muzzleFlash: value.muzzleFlash,
          leftWristGoal: value.leftWristGoal,
        },
      ])
    ),
  };
  await fs.writeFile(path.join(out, "index.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(
    `\ntotal ${(totalBefore / 1e6).toFixed(1)} -> ${(totalAfter / 1e6).toFixed(1)} MB ` +
      `(${(100 - (totalAfter / totalBefore) * 100).toFixed(0)}% smaller)`
  );
  const withOptic = Object.entries(weapons).filter(([, value]) => value.optic);
  console.log(
    `optics: ${withOptic.map(([key, value]) => `${key} (${value.optic.node})`).join(", ") || "none"}`
  );
}

main().catch((error) => {
  console.error(`prepare-fphands failed: ${error.message}`);
  process.exitCode = 1;
});
