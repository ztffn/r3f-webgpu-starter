import { chromium } from "playwright-core";
const OUT="/tmp/claude-0/-home-user-r3f-webgpu-starter/fbed761b-7f11-5a71-a40f-fc94191e3c28/scratchpad/preview";
const b=await chromium.launch({executablePath:"/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args:["--no-sandbox","--use-gl=angle","--use-angle=swiftshader","--disable-features=WebGPU"]});
const page=await b.newPage({viewport:{width:1280,height:760}});
const errs=[]; page.on("pageerror",e=>errs.push(String(e)));
await page.goto("http://127.0.0.1:3000/",{waitUntil:"networkidle",timeout:45000});
await page.waitForTimeout(14000);
// zoom all the way in to ground level
for(let i=0;i<40;i++){ await page.mouse.move(640,430); await page.mouse.wheel(0,-700); await page.waitForTimeout(90); }
await page.waitForTimeout(4000);
await page.screenshot({path:`${OUT}/grass_closeup.png`});
console.log("ERRORS:",errs.length);
await b.close();
