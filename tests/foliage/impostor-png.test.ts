import assert from "node:assert/strict";
import test from "node:test";
import { decodePng, encodePng } from "../../src/foliage/impostorPng.ts";

test("PNG roundtrip is byte-exact, including RGB under zero alpha", async () => {
  // The whole reason the codec exists: canvas decode premultiplies and would zero the
  // RGB of transparent texels, pulling a dark fringe into filtered silhouette edges.
  const width = 37; // deliberately not a power of two
  const height = 23;
  const data = new Uint8Array(width * height * 4);
  let state = 0x12345678;
  for (let i = 0; i < data.length; i += 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    data[i] = state & 0xff;
  }
  // Force some fully transparent texels with non-zero RGB — the case canvas destroys.
  for (let i = 0; i < 40; i += 4) {
    data[i + 3] = 0;
    data[i] = 200;
  }
  const encoded = await encodePng({ data, width, height });
  const decoded = await decodePng(encoded);
  assert.equal(decoded.width, width);
  assert.equal(decoded.height, height);
  assert.deepEqual(decoded.data, data);
});

test("decoder rejects what it cannot faithfully read", async () => {
  await assert.rejects(() => decodePng(new Uint8Array([1, 2, 3, 4])), /not a PNG/);
});
