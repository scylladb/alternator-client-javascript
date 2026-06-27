import { defineConfig } from "tsup";
import packageJson from "./package.json" with { type: "json" };

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/edge.ts",
    "src/document.ts",
    "src/document-edge.ts",
  ],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2022",
  define: {
    __PACKAGE_VERSION__: JSON.stringify(packageJson.version),
  },
});
