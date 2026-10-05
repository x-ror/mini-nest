import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

const aliases = Object.fromEntries(["adapter-common", "platform-node", "platform-bun"].map((name) => [
  `@nest-native/${name}`, fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url)),
]));

export default defineConfig({
  resolve: { alias: aliases },
  test: { include: ["tests/**/*.test.ts"], environment: "node", restoreMocks: true },
  lint: {
    ignorePatterns: ["**/dist/**", "**/node_modules/**"],
    options: { typeAware: true, typeCheck: true },
  },
  fmt: { semi: true, singleQuote: false, ignorePatterns: ["**/dist/**", "**/node_modules/**"] },
  pack: [
    ...["adapter-common", "platform-node", "platform-bun"].map((name) => ({
      name, entry: { index: `packages/${name}/src/index.ts` },
      outDir: `packages/${name}/dist`, tsconfig: `packages/${name}/tsconfig.json`,
      platform: "node" as const, fixedExtension: false, dts: true, sourcemap: true,
      deps: { neverBundle: [/^@nest-native\//, /^@nestjs\//] },
    })),
    {
      name: "example", entry: { server: "examples/server.ts", bun: "examples/bun.ts" },
      outDir: "dist", tsconfig: "tsconfig.app.json", platform: "node",
      fixedExtension: false, alias: aliases, deps: { alwaysBundle: [/^@nest-native\//] },
      dts: false, sourcemap: true,
    },
    {
      name: "conformance",
      entry: { smoke: "packages/conformance/src/smoke.ts", bun: "packages/conformance/src/bun.ts" },
      outDir: "packages/conformance/dist", tsconfig: "packages/conformance/tsconfig.json",
      platform: "node", fixedExtension: false,
      deps: { neverBundle: [/^@nest-native\//, /^@nestjs\//, "reflect-metadata"] },
      dts: false, sourcemap: true,
    },
  ],
  run: { tasks: { "package-check": { command: "node scripts/check-packages.mjs", cache: false } } },
});
