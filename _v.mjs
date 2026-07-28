import { chromium } from "playwright-core";
import { readFileSync } from "node:fs";
const F="/tmp/claude-0/-home-user-r3f-webgpu-starter/fbed761b-7f11-5a71-a40f-fc94191e3c28/scratchpad/artifact";
const b=await chromium.launch({executablePath:"/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args:["--no-sandbox","--use-gl=angle","--use-angle=swiftshader","--disable-features=WebGPU"]});
const page=await b.newPage({viewport:{width:1000,height:620}});
const errs=[]; page.on("pageerror",e=>errs.push(e.stack||String(e)));
await page.setContent(`<!doctype html><html><head><meta charset="utf-8"></head><body>${readFileSync(`${F}/gmile-viewer.html`,"utf8")}</body></html>`,{waitUntil:"load"});
await page.waitForTimeout(14000);
console.log("BOOT:",JSON.stringify(await page.evaluate(()=>({done:document.getElementById("boot").classList.contains("done"),canopy:document.getElementById("v-canopy").textContent}))));
await page.evaluate(()=>document.getElementById("b-ground").click());
await page.waitForTimeout(12000);
console.log("AGL:",await page.evaluate(()=>document.getElementById("t-agl").textContent));
await page.screenshot({path:`${F}/final_ground.png`, timeout:180000, animations:"disabled"});
console.log("shot ok; ERRORS:",errs.length);
await b.close();
