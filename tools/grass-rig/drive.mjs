// Render grass variants through the rig and score each against the metric taken
// from the reference screenshots: columnar grass changes colour ACROSS columns
// far more than UP them, giving mean|d/dx| / mean|d/dy| ~= 1.6.

import { chromium } from "playwright-core";
import { writeFileSync } from "node:fs";

const VARIANTS = JSON.parse(process.argv[2] ?? "[]");
const OUT = process.argv[3] ?? ".";

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--disable-features=WebGPU"],
});
const page = await browser.newPage({ viewport: { width: 600, height: 420 } });
const errs = [];
page.on("pageerror", (e) => errs.push(String(e).split("\n")[0]));

await page.goto("http://127.0.0.1:4180/", { waitUntil: "load" });
await page.waitForFunction(() => window.__ready === true, { timeout: 30000 });

for (const v of VARIANTS) {
  const t0 = Date.now();
  const res = await page.evaluate((o) => window.__run(o), v);
  const ms = Date.now() - t0;
  const b64 = res.dataUrl.split(",")[1];
  const file = `${OUT}/${v.name}.png`;
  writeFileSync(file, Buffer.from(b64, "base64"));
  console.log(
    `${v.name.padEnd(22)} ${res.backend}  ground=${res.groundY.toFixed(1)}m ` +
      `canopy@tgt=${res.target? res.target.canopyAtTarget.toFixed(2):'-'}m clear=${res.target? res.target.sightlineClearance:'-'}  ${ms}ms`
  );
}
console.log("ERRORS:", errs.length);
[...new Set(errs)].slice(0, 3).forEach((e) => console.log("  " + e));
await browser.close();
