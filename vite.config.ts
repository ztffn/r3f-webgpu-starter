import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: true, // expose on the network (useful for testing on other devices)
    port: 3000,
  },
  build: {
    // three/webgpu is ~1.5 MB of the bundle on its own. Splitting it out means a
    // change to app code invalidates only the small chunk, so a returning visitor
    // re-downloads kilobytes instead of megabytes. This comment used to claim the
    // split existed when no chunking was configured at all.
    rollupOptions: {
      output: {
        manualChunks: (id: string) =>
          id.includes("node_modules/three") ? "three" : undefined,
      },
    },
    chunkSizeWarningLimit: 1600,
  },
});
