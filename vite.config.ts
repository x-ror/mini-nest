import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const aliases = {
  "@mini-nest/common/internal/metadata": source("./packages/common/src/internal/metadata.ts"),
  "@mini-nest/common/internal/path": source("./packages/common/src/internal/path.ts"),
  "@mini-nest/common": source("./packages/common/src/index.ts"),
  "@mini-nest/core": source("./packages/core/src/index.ts"),
  "@mini-nest/platform-node": source("./packages/platform-node/src/index.ts"),
};

export default defineConfig({
  resolve: { alias: aliases },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    restoreMocks: true,
  },
  lint: {
    ignorePatterns: ["**/dist/**", "**/node_modules/**"],
    jsPlugins: [{ name: "architecture", specifier: "./scripts/boundary-plugin.mjs" }],
    rules: { "architecture/boundaries": "error" },
    options: { typeAware: true, typeCheck: true },
  },
  fmt: {
    semi: true,
    singleQuote: false,
    ignorePatterns: ["**/dist/**", "**/node_modules/**"],
  },
  pack: [
    {
      name: "common",
      entry: {
        index: "packages/common/src/index.ts",
        "internal/metadata": "packages/common/src/internal/metadata.ts",
        "internal/path": "packages/common/src/internal/path.ts",
      },
      outDir: "packages/common/dist",
      tsconfig: "packages/common/tsconfig.json",
      platform: "neutral",
      fixedExtension: false,
      dts: true,
      sourcemap: true,
    },
    {
      name: "core",
      entry: { index: "packages/core/src/index.ts" },
      outDir: "packages/core/dist",
      tsconfig: "packages/core/tsconfig.json",
      platform: "neutral",
      fixedExtension: false,
      deps: { neverBundle: [/^@mini-nest\//] },
      dts: true,
      sourcemap: true,
    },
    {
      name: "platform-node",
      entry: { index: "packages/platform-node/src/index.ts" },
      outDir: "packages/platform-node/dist",
      tsconfig: "packages/platform-node/tsconfig.json",
      platform: "node",
      fixedExtension: false,
      deps: { neverBundle: [/^@mini-nest\//] },
      dts: true,
      sourcemap: true,
    },
    {
      name: "example",
      entry: { server: "examples/server.ts" },
      outDir: "dist",
      tsconfig: "tsconfig.app.json",
      platform: "node",
      fixedExtension: false,
      alias: aliases,
      deps: { alwaysBundle: [/^@mini-nest\//] },
      dts: false,
      sourcemap: true,
    },
    {
      name: "conformance",
      entry: {
        smoke: "packages/conformance/src/smoke.ts",
        "nest-reference": "packages/conformance/src/nest-reference.ts",
      },
      outDir: "packages/conformance/dist",
      tsconfig: "packages/conformance/tsconfig.json",
      platform: "node",
      fixedExtension: false,
      deps: { neverBundle: [/^@mini-nest\//, /^@nestjs\//, "reflect-metadata"] },
      dts: false,
      sourcemap: true,
    },
  ],
  run: {
    tasks: {
      boundaries: {
        command: ["node scripts/check-packages.mjs", "node scripts/check-boundaries.mjs"],
        cache: false,
      },
    },
  },
});
