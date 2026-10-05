import assert from "node:assert/strict";
import { NestFactory, type AbstractHttpAdapter } from "@nestjs/core";
import { VersioningType, type INestApplication } from "@nestjs/common";
import { FixtureModule } from "./fixture.js";

export async function startFixture(adapter: AbstractHttpAdapter): Promise<INestApplication> {
  const app = await NestFactory.create(FixtureModule, adapter, {
    logger: false,
    rawBody: true,
    abortOnError: false,
  });
  app.enableVersioning({ type: VersioningType.URI });
  try {
    await app.listen(0, "127.0.0.1");
    return app;
  } catch (error) {
    await app.close();
    throw error;
  }
}

const cases: [string, RequestInit?][] = [
  ["/api"],
  ["/api/"],
  ["/api/options", { method: "OPTIONS" }],
  ["/v1/api/versioned"],
  ["/api/items/42?tag=a&tag=b"],
  ["/api/items/not-a-number"],
  ["/api/items/%ZZ"],
  ["/api/guarded"],
  ["/api/guarded", { headers: { "x-auth": "yes" } }],
  ["/api/wrapped"],
  ["/api/error"],
  ["/api/empty"],
  ["/api/header"],
  ["/api/manual"],
  ["/api/cookies"],
  ["/api/file"],
  ["/api/redirect", { redirect: "manual" }],
  ["/missing"],
  ["/api", { method: "HEAD" }],
  [
    "/api/echo",
    { method: "POST", headers: { "content-type": "application/json" }, body: '{"hello":"world"}' },
  ],
  [
    "/api/raw",
    { method: "POST", headers: { "content-type": "application/json" }, body: '{"raw":true}' },
  ],
  [
    "/api/echo",
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "tag=a&tag=b",
    },
  ],
];

async function snapshot(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    middleware: response.headers.get("x-middleware"),
    customHeader: response.headers.get("x-example"),
    location: response.headers.get("location"),
    cookies: response.headers.getSetCookie(),
    body: await response.text(),
  };
}

export async function compareAdapters(
  adapter: AbstractHttpAdapter,
  reference: AbstractHttpAdapter,
): Promise<void> {
  const app = await startFixture(adapter);
  let original: INestApplication | undefined;
  try {
    original = await startFixture(reference);
    const base = await app.getUrl();
    const referenceBase = await original.getUrl();
    for (const [path, init] of cases) {
      const [actual, expected] = await Promise.all([
        snapshot(`${base}${path}`, init),
        snapshot(`${referenceBase}${path}`, init),
      ]);
      assert.deepEqual(actual, expected, `${adapter.getType()}: ${init?.method ?? "GET"} ${path}`);
    }
    for (const [body, status] of [
      ["{invalid", 400],
      ["x".repeat(110 * 1024), 413],
    ] as const) {
      const response = await fetch(`${base}/api/echo`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      assert.equal(response.status, status);
      await response.arrayBuffer();
    }
    console.log(
      `${adapter.getType()}: ${cases.length} Express comparisons and parser error cases passed.`,
    );
  } finally {
    await Promise.all([app.close(), original?.close()]);
  }
}
