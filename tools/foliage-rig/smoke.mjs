// Headless smoke test for the foliage layer.
//
// No GPU in this container: three falls back to WebGL2 on SwiftShader, so frame TIMES are
// meaningless (docs/08 §10). Draw-call and triangle counts are exact, and — the reason
// this exists — a TSL graph that does not compile fails loudly here.
//
// Samples only once the counts have SETTLED. Terrain chunk building and foliage cell
// building are both budgeted per frame, so an early sample reports a half-built world and
// two runs sampled at different moments are not comparable.

import { chromium } from "playwright-core";

const url = process.argv[2];
const shot = process.argv[3];
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH,
  args: ["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader"],
});
const page = await browser.newPage({
  viewport: {
    width: Number(process.env.RIG_WIDTH ?? 800),
    height: Number(process.env.RIG_HEIGHT ?? 500),
  },
});
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(`error: ${m.text()}`);
});

await page.goto(url, { waitUntil: "load", timeout: 120000 });
await page.waitForFunction(() => window.__perf !== undefined, null, { timeout: 180000 });

// Wait on the world's OWN completion signal, not on a count that has stopped moving.
//
// Stability is not completion here and inferring one from the other produced two wrong
// comparisons before this was fixed. Chunk building is budgeted per FRAME, so at one
// frame per second it advances ~6 ms per SECOND: the draw-call count can sit unchanged
// for ten seconds with a third of the chunk window still missing. A grass-on/grass-off
// pair taken that way read 175 draw calls against 244 — two different amounts of world,
// not two configurations.
//
// `window.__terrain.pendingChunks` and `window.__foliage.pendingBuckets` are published by
// the builders themselves and go to zero only when there is nothing left to build.
let clear = 0;
const deadline = Date.now() + 900000;
let last = null;
while (Date.now() < deadline && clear < 2) {
  await page.waitForTimeout(2000);
  last = await page.evaluate(() => ({
    chunks: window.__terrain?.pendingChunks ?? 0,
    buckets: window.__foliage?.pendingBuckets ?? 0,
    draws: window.__perf?.drawCalls ?? 0,
  }));
  clear = last.chunks === 0 && last.buckets === 0 ? clear + 1 : 0;
}
const stable = clear >= 2 ? 4 : 0;

const foliage = await page.evaluate(() => window.__foliage ?? null);
const perf = await page.evaluate(() => window.__perf ?? null);
// `settled: false` means the numbers below are a half-built world. Do not compare them.
console.log(JSON.stringify({ settled: stable >= 4, pending: last, foliage, perf, errors: errors.slice(0, 8) }));
if (shot) await page.screenshot({ path: shot });
await browser.close();
