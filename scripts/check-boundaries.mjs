import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFile, unlink } from "node:fs/promises";
import path from "node:path";

const forbiddenImports = [
  ["packages/core/src", 'import http from "node:http";'],
  ["packages/common/src", 'import { Application } from "@mini-nest/core";'],
  ["packages/platform-node/src", 'import { NestFactory } from "@mini-nest/core";'],
  ["packages/core/src/di", 'import { parseBody } from "../http/request-context.js";'],
  ["examples", 'import { modules } from "@mini-nest/common/internal/metadata";'],
  ["packages/core/src", 'const transport = import("node:http");'],
];

for (const [index, [directory, source]] of forbiddenImports.entries()) {
  const filename = path.join(directory, `boundary-check-${index}.fixture.ts`);
  await writeFile(filename, source, { flag: "wx" });
  try {
    const result = spawnSync("node_modules/.bin/vp", ["lint", filename], { encoding: "utf8" });
    if (result.error) throw result.error;
    assert.notEqual(result.status, 0, `${filename}: forbidden import was not rejected`);
    assert.match(`${result.stdout}${result.stderr}`, /architecture.*boundaries/);
  } finally {
    await unlink(filename);
  }
}
console.log("Oxlint rejects forbidden layer imports.");
