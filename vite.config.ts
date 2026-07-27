import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: true, // expose on the network (useful for testing on other devices)
    port: 3000,
  },
  // three is large; keep it in its own chunk so app code reloads stay snappy.
  build: {
    chunkSizeWarningLimit: 1500,
  },
});
