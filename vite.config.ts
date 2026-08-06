import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: true, // expose on the network (useful for testing on other devices)
    port: 3000,
    // The account API lives on the game server (one process, one deploy), which in
    // development is a different port. Proxying keeps /auth and /api SAME-ORIGIN in
    // dev exactly as they are in production, so there is no CORS configuration that
    // exists only for development and no cookie/credential behaviour that differs
    // between the two. DF2_SERVER_ORIGIN overrides the target.
    proxy: {
      "/auth": { target: process.env.DF2_SERVER_ORIGIN ?? "http://localhost:2567", changeOrigin: true },
      "/api": { target: process.env.DF2_SERVER_ORIGIN ?? "http://localhost:2567", changeOrigin: true },
    },
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
