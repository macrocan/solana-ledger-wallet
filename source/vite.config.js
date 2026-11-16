import { defineConfig } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import { viteSingleFile } from "vite-plugin-singlefile";

export default defineConfig({
  base: "./",
  plugins: [
    nodePolyfills({ globals: { Buffer: true, process: true, global: true } }),
    // Inline every JS/CSS asset into dist/index.html: one file, no external fetches at runtime.
    viteSingleFile({ removeViteModuleLoader: true }),
  ],
  build: {
    target: "es2022",
    sourcemap: false,
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
  server: { host: "127.0.0.1" },
});
