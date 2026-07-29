import { launch } from "./browser.mjs";
const V = JSON.parse(process.argv[2]);
const b = await launch();
const page = await b.newPage({ viewport:{width:600,height:420} });
await page.goto("http://127.0.0.1:4180/", { waitUntil:"load" });
await page.waitForFunction(() => window.__ready === true, { timeout: 30000 });
let base = null;
for (const v of V) {
  const r = await page.evaluate((o) => window.__run(o), v);
  if (base === null) base = r.msPerFrame;
  const delta = r.msPerFrame - base;
  console.log(`${v.name.padEnd(16)} ${r.msPerFrame.toFixed(1).padStart(7)} ms/frame   grass cost ${delta>=0?"+":""}${delta.toFixed(1)} ms   calls=${r.drawCalls} tris=${(r.triangles/1000).toFixed(0)}k`);
}
await b.close();
