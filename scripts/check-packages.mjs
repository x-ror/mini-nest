import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

for (const name of ["adapter-common", "platform-node", "platform-bun"]) {
  const manifest = JSON.parse(await readFile(`packages/${name}/package.json`, "utf8"));
  assert.equal(manifest.name, `@nest-native/${name}`);
  assert.ok(manifest.peerDependencies["@nestjs/common"]);
  assert.ok(manifest.peerDependencies["@nestjs/core"]);
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    assert.ok(
      dependency === "path-to-regexp" || dependency === "@nest-native/adapter-common",
      `${name}: unexpected dependency ${dependency}`,
    );
  }
}
console.log("Native adapter package boundaries passed.");
