import { defineConfig } from "vite";
export default defineConfig({
  build: { outDir: "dist", emptyOutDir: true, target: "esnext",
    lib: { entry: "src/rig.js", formats: ["es"], fileName: "rig" },
    rollupOptions: { output: { codeSplitting: false } } },
});
