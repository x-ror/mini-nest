import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const allowedDependencies = {
  common: [],
  core: ["@mini-nest/common"],
  "platform-node": ["@mini-nest/common"],
};

for (const [name, allowed] of Object.entries(allowedDependencies)) {
  const manifest = JSON.parse(await readFile(`packages/${name}/package.json`, "utf8"));
  const config = JSON.parse(await readFile(`packages/${name}/tsconfig.json`, "utf8"));
  const dependencies = Object.keys(manifest.dependencies ?? {});
  assert.deepEqual(
    dependencies.sort(),
    [...allowed].sort(),
    `${name}: unexpected runtime dependencies`,
  );
  assert.deepEqual(
    Object.keys(manifest.optionalDependencies ?? {}),
    [],
    `${name}: optional runtime dependencies`,
  );
  assert.deepEqual(Object.keys(manifest.peerDependencies ?? {}), [], `${name}: peer dependencies`);
  const references = (config.references ?? []).map((reference) => reference.path);
  assert.deepEqual(
    references,
    name === "common" ? [] : ["../common"],
    `${name}: invalid project references`,
  );
}
console.log("Package dependency and project-reference boundaries verified.");
