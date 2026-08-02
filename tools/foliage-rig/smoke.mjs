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

let previous = null;
let stable = 0;
const deadline = Date.now() + 240000;
while (Date.now() < deadline && stable < 3) {
  await page.waitForTimeout(2000);
  const draws = await page.evaluate(() => window.__perf?.drawCalls ?? 0);
  const pending = await page.evaluate(() => window.__foliage?.pendingBuckets ?? 0);
  stable = draws === previous && pending === 0 ? stable + 1 : 0;
  previous = draws;
}

const foliage = await page.evaluate(() => window.__foliage ?? null);
const perf = await page.evaluate(() => window.__perf ?? null);
console.log(JSON.stringify({ settled: stable >= 3, foliage, perf, errors: errors.slice(0, 8) }));
if (shot) await page.screenshot({ path: shot });
await browser.close();
