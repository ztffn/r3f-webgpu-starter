// Shared Playwright launch for the grass rig drivers.
//
// The executable path used to be a hardcoded Linux container path, duplicated in
// drive.mjs and perf.mjs, so the rig could not run on the machine this project is
// developed on. Resolution order: CHROME_PATH, then Playwright's own bundled
// browser (omitting executablePath entirely).

import { chromium } from "playwright-core";

/** Force software rasterisation so results are comparable across machines. */
export const SWIFTSHADER_ARGS = [
  "--no-sandbox",
  "--use-gl=angle",
  "--use-angle=swiftshader",
  "--disable-features=WebGPU",
];

export async function launch({ args = SWIFTSHADER_ARGS } = {}) {
  const executablePath = process.env.CHROME_PATH;
  try {
    return await chromium.launch(executablePath ? { executablePath, args } : { args });
  } catch (err) {
    throw new Error(
      `could not launch Chromium: ${err.message}\n` +
        `Set CHROME_PATH to a Chrome/Chromium binary, or install Playwright's own ` +
        `with: npx playwright install chromium`
    );
  }
}
