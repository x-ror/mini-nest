import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

const packageAliases = Object.fromEntries(
  ["platform-node", "platform-bun"].map((name) => [
    `nestjs-adapter-${name.replace("platform-", "")}`,
    fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url)),
  ]),
);

const sharedAliases = {
  "@shared": fileURLToPath(new URL("./shared/index.ts", import.meta.url)),
};
const aliases = { ...packageAliases, ...sharedAliases };

export default defineConfig({
  resolve: { alias: aliases },
  test: { include: ["tests/**/*.test.ts"], environment: "node", restoreMocks: true },
  lint: {
    ignorePatterns: ["**/dist/**", "**/node_modules/**"],
    options: { typeAware: true, typeCheck: true },
  },
  fmt: { semi: true, singleQuote: false, ignorePatterns: ["**/dist/**", "**/node_modules/**"] },
  pack: [
    ...["platform-node", "platform-bun"].map((name) => ({
      name,
      entry: { index: `packages/${name}/src/index.ts` },
      outDir: `packages/${name}/dist`,
      tsconfig: "tsconfig.build.json",
      platform: "node" as const,
      fixedExtension: false,
      alias: sharedAliases,
      dts: true,
      sourcemap: true,
      deps: { neverBundle: [/^nestjs-adapter-/, /^@nestjs\//, "path-to-regexp"] },
    })),
    {
      name: "example",
      entry: { server: "examples/server.ts", bun: "examples/bun.ts" },
      outDir: "dist",
      tsconfig: "tsconfig.app.json",
      platform: "node",
      fixedExtension: false,
      alias: aliases,
      deps: {
        alwaysBundle: [/^nestjs-adapter-/],
        neverBundle: [/^@nestjs\//, "rxjs", "reflect-metadata", "path-to-regexp"],
      },
      dts: false,
      sourcemap: true,
    },
    {
      name: "conformance",
      entry: {
        smoke: "packages/conformance/src/smoke.ts",
        bun: "packages/conformance/src/bun.ts",
        benchmark: "packages/conformance/src/benchmark.ts",
      },
      outDir: "packages/conformance/dist",
      tsconfig: "packages/conformance/tsconfig.json",
      platform: "node",
      fixedExtension: false,
      deps: {
        neverBundle: [
          /^nestjs-adapter-/,
          /^@nestjs\//,
          /^@?socket\.io/,
          "reflect-metadata",
          "rxjs",
        ],
      },
      dts: false,
      sourcemap: true,
    },
  ],
  run: { tasks: { "package-check": { command: "node scripts/check-packages.mjs", cache: false } } },
});
