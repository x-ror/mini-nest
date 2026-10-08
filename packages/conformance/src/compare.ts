import assert from "node:assert/strict";
import { NestFactory, type AbstractHttpAdapter } from "@nestjs/core";
import { VersioningType, type INestApplication } from "@nestjs/common";
import { COOKIE_SECRET, FixtureModule } from "./fixture.js";

export async function startFixture(adapter: AbstractHttpAdapter): Promise<INestApplication> {
  const app = await NestFactory.create(FixtureModule, adapter, {
    logger: false,
    rawBody: true,
    abortOnError: false,
    cookies: { secret: COOKIE_SECRET },
  });
  app.enableVersioning({ type: VersioningType.URI });
  app.enableCors({
    origin: [/\.allowed\.example$/, "https://exact.example"],
    credentials: true,
    exposedHeaders: ["x-example", "x-middleware"],
    maxAge: 300,
  });
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
  ["/api", { headers: { origin: "https://a.allowed.example" } }],
  ["/api", { headers: { origin: "https://evil.example" } }],
  [
    "/api/echo",
    {
      method: "OPTIONS",
      headers: {
        origin: "https://exact.example",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type, x-auth",
      },
    },
  ],
  [
    "/api/echo",
    {
      method: "OPTIONS",
      headers: { origin: "https://evil.example", "access-control-request-method": "POST" },
    },
  ],
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
  ["/api/cookies/express"],
  ["/api/cookies/signed"],
  ["/api/cookies/read", { headers: { cookie: 'theme=dark; quoted="a b"; theme=light; bare' } }],
  ["/api/cookies/read", { headers: { cookie: "token=s:user-42.tampered; theme=%E2%9C%93" } }],
  ["/api/file"],
  ["/api/events"],
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

/** Express (`cookie`) and Nest (`serializeCookie`) order attributes differently. */
function normalizeSetCookie(header: string): string {
  const [pair, ...attributes] = header.split(";").map((part) => part.trim());
  return [pair, ...attributes.sort()].join("; ");
}

async function snapshot(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    middleware: response.headers.get("x-middleware"),
    customHeader: response.headers.get("x-example"),
    location: response.headers.get("location"),
    // Express redirects negotiate an HTML page (`Vary: Accept`); ours are plain text (DEVIATIONS.md).
    vary: response.headers.get("vary")?.replace(/,\s*Accept$/, "") ?? null,
    cors: [
      "access-control-allow-origin",
      "access-control-allow-credentials",
      "access-control-allow-methods",
      "access-control-allow-headers",
      "access-control-expose-headers",
      "access-control-max-age",
    ].map((name) => response.headers.get(name)),
    cookies: response.headers.getSetCookie().map(normalizeSetCookie),
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
    // A signed cookie round-trips between both adapters: Nest signs it the same way.
    const [signedByAdapter, signedByReference] = await Promise.all([
      fetch(`${base}/api/cookies/signed`),
      fetch(`${referenceBase}/api/cookies/signed`),
    ]);
    await Promise.all([signedByAdapter.arrayBuffer(), signedByReference.arrayBuffer()]);
    const signedPair = signedByAdapter.headers.getSetCookie()[0]!.split(";")[0]!;
    assert.equal(signedPair, signedByReference.headers.getSetCookie()[0]!.split(";")[0]);
    const [readByAdapter, readByReference] = await Promise.all([
      snapshot(`${base}/api/cookies/read`, { headers: { cookie: signedPair } }),
      snapshot(`${referenceBase}/api/cookies/read`, { headers: { cookie: signedPair } }),
    ]);
    assert.deepEqual(readByAdapter, readByReference, `${adapter.getType()}: signed cookie read`);
    assert.equal((JSON.parse(readByAdapter.body) as { token: string }).token, "user-42");
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
