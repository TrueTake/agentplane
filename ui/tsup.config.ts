import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    charts: "src/charts.ts",
    editor: "src/editor.ts",
  },
  format: ["cjs", "esm"],
  dts: true,
  treeshake: true,
  splitting: true,
  external: ["react", "react-dom", "@getcatalystiq/agent-plane", "swr", "react-markdown", "recharts"],
  outDir: "dist",
  clean: true,
});
