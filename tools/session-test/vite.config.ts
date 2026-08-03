// Serves the session-test harness on its own port so it never disturbs the
// main app on :3000. Root is this directory; imports reach back into ../../src,
// which is why `fs.allow` has to include the repository root.

import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  server: {
    host: true,
    port: 3100,
    fs: { allow: [repositoryRoot] },
  },
  // Rapier's compat build ships base64 WASM and initialises asynchronously, so
  // it needs no plugin — but it must not be pre-bundled into a CJS shim.
  optimizeDeps: { exclude: ["@dimforge/rapier3d-compat"] },
});
