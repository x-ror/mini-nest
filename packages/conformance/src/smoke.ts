import assert from "node:assert/strict";
import * as common from "@mini-nest/common";
import { NestFactory } from "@mini-nest/core";
import { NodeAdapter } from "@mini-nest/platform-node";
import { createFixture } from "./fixture.js";

interface ResponseSnapshot {
  status: number;
  contentType: string | null;
  body: unknown;
}

async function snapshot(response: Response): Promise<ResponseSnapshot> {
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    body: await response.json(),
  };
}

assert.equal("getMetadata" in Reflect, false, "mini-nest must not load reflect-metadata");
const app = await NestFactory.create(createFixture(common), new NodeAdapter());
const server = await app.listen(0, "127.0.0.1");

try {
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const { createReference } = await import("./nest-reference.js");
  const reference = await createReference();
  try {
    const { verifyCommonContracts } = await import("./common-contracts.js");
    verifyCommonContracts();
    const cases: Array<{ path: string; init?: RequestInit }> = [
      { path: "/hello" },
      {
        path: "/hello/echo",
        init: {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ value: "same fixture" }),
        },
      },
    ];
    for (const { path, init } of cases) {
      const responses: Response[] = [
        await app.fetch(new Request(`http://localhost${path}`, init)),
        await fetch(`http://127.0.0.1:${address.port}${path}`, init),
        await reference.fetch(path, init),
      ];
      const snapshots: ResponseSnapshot[] = await Promise.all(responses.map(snapshot));
      assert.deepEqual(snapshots[0], snapshots[2], `${path}: fetch handler differs from NestJS`);
      assert.deepEqual(snapshots[1], snapshots[2], `${path}: Node transport differs from NestJS`);
    }
    console.log("NestJS 12.1.2 conformance: shared GET/POST fixture passed.");
  } finally {
    await reference.close();
  }
} finally {
  await app.close();
}
