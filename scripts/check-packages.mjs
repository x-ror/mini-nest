import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";

// `--release <version>`: also require what npm publishing needs.
const releaseIndex = process.argv.indexOf("--release");
const release = releaseIndex === -1 ? undefined : process.argv[releaseIndex + 1];

const versions = new Set();
for (const name of ["platform-node", "platform-bun"]) {
  const directory = `packages/${name}`;
  const manifest = JSON.parse(await readFile(`${directory}/package.json`, "utf8"));
  assert.equal(manifest.name, `nestjs-adapter-${name.replace("platform-", "")}`);
  assert.ok(manifest.peerDependencies["@nestjs/common"]);
  assert.ok(manifest.peerDependencies["@nestjs/core"]);
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    assert.ok(dependency === "path-to-regexp", `${name}: unexpected dependency ${dependency}`);
  }
  for (const field of ["description", "repository", "homepage", "bugs", "engines", "keywords"]) {
    assert.ok(manifest[field], `${name}: package.json needs "${field}"`);
  }
  assert.equal(manifest.repository.directory, directory, `${name}: repository.directory`);
  assert.deepEqual(manifest.files, ["dist"], `${name}: only dist/ is published`);
  assert.equal(manifest.publishConfig?.access, "public", `${name}: publishConfig.access`);
  await access(`${directory}/README.md`);
  versions.add(manifest.version);
  if (release !== undefined) {
    assert.equal(manifest.version, release, `${name}: version does not match the release tag`);
    assert.ok(manifest.license, `${name}: package.json needs "license" before publishing`);
    await access(`${directory}/LICENSE`).catch(() =>
      assert.fail(`${name}: a LICENSE file is required to publish`),
    );
  }
}
assert.equal(versions.size, 1, "Both adapters must share one version");
console.log("Native adapter package boundaries passed.");
