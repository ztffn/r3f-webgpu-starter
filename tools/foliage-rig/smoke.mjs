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
const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(`error: ${m.text()}`);
});

await page.goto(url, { waitUntil: "load", timeout: 120000 });
await page.waitForFunction(() => window.__perf !== undefined, null, { timeout: 180000 });

// Settle on DRAW CALLS AND TRIANGLES together, over enough polls to have seen real
// frames. A fixed wall-clock poll is not enough on its own: a ground-level frame here can
// take 900 ms, so a 2 s poll observes two or three frames, and chunk building — budgeted
// at a few ms PER FRAME — advances almost not at all between polls. Two consecutive
// identical readings then look settled while the world is still filling in, which is how
// a first pass produced a run reporting 25 draw calls against another run's 103 for the
// same scene. Triangles move whenever a chunk lands even if the call count happens not to,
// so requiring both to hold for four polls is what makes a comparison trustworthy.
let previousDraws = null;
let previousTriangles = null;
let stable = 0;
const deadline = Date.now() + 300000;
while (Date.now() < deadline && stable < 4) {
  await page.waitForTimeout(2000);
  const sample = await page.evaluate(() => ({
    draws: window.__perf?.drawCalls ?? 0,
    triangles: window.__perf?.triangles ?? 0,
    pending: window.__foliage?.pendingBuckets ?? 0,
  }));
  const held =
    sample.draws === previousDraws &&
    sample.triangles === previousTriangles &&
    sample.pending === 0;
  stable = held ? stable + 1 : 0;
  previousDraws = sample.draws;
  previousTriangles = sample.triangles;
}

const foliage = await page.evaluate(() => window.__foliage ?? null);
const perf = await page.evaluate(() => window.__perf ?? null);
// `settled: false` means the numbers below are a half-built world. Do not compare them.
console.log(JSON.stringify({ settled: stable >= 4, foliage, perf, errors: errors.slice(0, 8) }));
if (shot) await page.screenshot({ path: shot });
await browser.close();
