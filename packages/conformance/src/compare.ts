import assert from "node:assert/strict";
import cookieParser from "cookie-parser";
import { NestFactory, type AbstractHttpAdapter } from "@nestjs/core";
import { VersioningType, type INestApplication } from "@nestjs/common";
import type {
  CorsOptions,
  CorsOptionsDelegate,
} from "@nestjs/common/interfaces/external/cors-options.interface.js";
import { COOKIE_SECRET, FixtureModule } from "./fixture.js";

export interface FixtureOptions {
  /** Pass `cookies: { secret }` to Nest; defaults to true. */
  cookieSecret?: boolean;
  /** Runs before `listen()`, e.g. to enable CORS or install middleware. */
  setup?: (app: INestApplication) => void;
}

export async function startFixture(
  adapter: AbstractHttpAdapter,
  { cookieSecret = true, setup }: FixtureOptions = {},
): Promise<INestApplication> {
  const app = await NestFactory.create(FixtureModule, adapter, {
    logger: false,
    rawBody: true,
    abortOnError: false,
    ...(cookieSecret ? { cookies: { secret: COOKIE_SECRET } } : {}),
  });
  app.enableVersioning({ type: VersioningType.URI });
  try {
    setup?.(app);
    await app.listen(0, "127.0.0.1");
    return app;
  } catch (error) {
    await app.close();
    throw error;
  }
}

type Case = [string, RequestInit?];

const baselineCases: Case[] = [
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
  ["/api/cookies/express"],
  ["/api/cookies/express-edge"],
  ["/api/cookies/signed"],
  ["/api/cookies/parser", { headers: { cookie: "a=1" } }],
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

// `cookie-parser` signs like Nest (`s:value.signature`), so this value verifies on both.
const parserCookie = [
  "plain=1",
  `json=${encodeURIComponent('j:{"theme":"dark"}')}`,
  "badjson=j:{oops",
  "token=s:user-42.tampered",
].join("; ");

const cookieParserCases: Case[] = [
  ["/api/cookies/parser"],
  ["/api/cookies/parser", { headers: { cookie: parserCookie } }],
  ["/api/cookies/read", { headers: { cookie: parserCookie } }],
  ["/api/cookies/express-signed"],
  ["/api/cookies/express-edge"],
  // Nest's setCookie() has no secret here: both adapters fail the same way.
  ["/api/cookies/signed"],
];

const preflight = (
  origin: string | undefined,
  extra: Record<string, string> = {},
): RequestInit => ({
  method: "OPTIONS",
  headers: {
    ...(origin ? { origin } : {}),
    "access-control-request-method": "POST",
    "access-control-request-headers": "x-a, X-B",
    ...extra,
  },
});

const corsCases: Case[] = [
  ["/api"],
  ["/api", { headers: { origin: "https://a.allowed.example" } }],
  ["/api", { headers: { origin: "https://exact.example" } }],
  ["/api", { headers: { origin: "https://evil.example" } }],
  ["/api", { headers: { origin: "https://cb.example" } }],
  ["/api", { headers: { origin: "https://err.example" } }],
  ["/api", { headers: { origin: "https://a.allowed.example", "x-cors": "none" } }],
  ["/api", { headers: { origin: "https://a.allowed.example", "x-cors": "off" } }],
  ["/api", { headers: { origin: "https://a.allowed.example", "x-cors": "error" } }],
  ["/api/options", preflight("https://a.allowed.example")],
  ["/api/options", preflight("https://exact.example")],
  ["/api/options", preflight("https://evil.example")],
  ["/api/options", preflight("https://cb.example")],
  ["/api/options", preflight(undefined)],
  ["/api/options", { method: "OPTIONS" }],
  ["/api/options", preflight("https://a.allowed.example", { "x-cors": "continue" })],
];

const corsDelegate: CorsOptionsDelegate<{ headers: Record<string, string | undefined> }> = (
  req,
  callback,
) => {
  const mode = req.headers["x-cors"];
  if (mode === "error") return callback(new Error("delegate failed"), {});
  if (mode === "none") return (callback as (error: null) => void)(null);
  if (mode === "off") return callback(null, { origin: false });
  if (mode === "continue") return callback(null, { origin: true, preflightContinue: true });
  callback(null, { origin: [/\.allowed\.example$/], credentials: true });
};

const corsConfigurations: [string, CorsOptions | typeof corsDelegate | undefined][] = [
  ["defaults", undefined],
  ["reflect", { origin: true, credentials: true, maxAge: 0 }],
  [
    "allowlist",
    {
      origin: [/\.allowed\.example$/, "https://exact.example"],
      credentials: true,
      exposedHeaders: ["x-example", "x-middleware"],
      maxAge: 300,
    },
  ],
  [
    "fixed",
    {
      origin: "https://exact.example",
      allowedHeaders: "x-a,x-b",
      methods: "GET,POST",
      exposedHeaders: "x-total",
      optionsSuccessStatus: 200,
    },
  ],
  ["undefined origin", { origin: undefined, credentials: true }],
  ["disabled", { origin: false }],
  ["empty lists", { methods: [], allowedHeaders: "", exposedHeaders: [] }],
  ["empty header array", { allowedHeaders: [] }],
  ["headers alias", { headers: ["x-alias"] } as CorsOptions],
  // Boxed strings: cors treats them as strings (fixed value, or never equal in a list).
  ["boxed string", { origin: new String("https://exact.example") as string, credentials: true }],
  ["boxed string list", { origin: [new String("https://exact.example") as string] }],
  ["preflight continue", { origin: "https://exact.example", preflightContinue: true }],
  ["delegate", corsDelegate],
  [
    "origin callback",
    {
      origin: (origin, callback) => {
        if (origin === "https://err.example") return callback(new Error("origin denied"));
        if (origin === "https://cb.example") return callback(null, true);
        // A distinct answer shows that the callback also runs without an Origin header.
        callback(
          null,
          origin === undefined ? "https://no-origin.example" : ["https://exact.example"],
        );
      },
      credentials: true,
    },
  ],
];

const trustCases: Case[] = [
  ["/api/client"],
  ["/api/client", { headers: { "x-forwarded-for": "203.0.113.7" } }],
  ["/api/client", { headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.2" } }],
  [
    "/api/client",
    { headers: { "x-forwarded-for": "198.51.100.1, 203.0.113.7, 10.0.0.2, 127.0.0.1" } },
  ],
  ["/api/client", { headers: { "x-forwarded-for": " , 203.0.113.7 ,, " } }],
  ["/api/client", { headers: { "x-forwarded-for": "2001:db8::1, fc00::5" } }],
  ["/api/client", { headers: { "x-forwarded-for": "203.0.113.7, ::ffff:10.0.0.9" } }],
  ["/api/client", { headers: { "x-forwarded-proto": "https" } }],
  ["/api/client", { headers: { "x-forwarded-proto": "https, http" } }],
  ["/api/client", { headers: { "x-forwarded-proto": " , https" } }],
  ["/api/client", { headers: { "x-forwarded-host": " , b.example" } }],
  ["/api/client", { headers: { "x-forwarded-host": "app.example:8443" } }],
  ["/api/client", { headers: { "x-forwarded-host": "a.example, b.example" } }],
  ["/api/client", { headers: { "x-forwarded-host": "[2001:db8::1]:8443" } }],
];

const trustConfigurations: [string, unknown][] = [
  ["off", false],
  ["all", true],
  ["one hop", 1],
  ["two hops", 2],
  ["zero hops", 0],
  ["loopback", "loopback"],
  ["loopback and private", "loopback, uniquelocal"],
  ["list", ["127.0.0.1", "10.0.0.0/8"]],
  ["netmask", "127.0.0.0/255.0.0.0, 10.0.0.0/255.0.0.0"],
  ["socket not trusted", "uniquelocal"],
  ["function", (address: string | undefined, hop: number) => hop < 3 && address !== "203.0.113.7"],
];

/** Express (`cookie`) and Nest (`serializeCookie`) order attributes differently. */
function normalizeSetCookie(header: string): string {
  const [pair, ...attributes] = header.split(";").map((part) => part.trim());
  const maxAge = attributes.find((attribute) => attribute.startsWith("Max-Age="));
  // With Max-Age, Expires is derived from the clock: check it lies Max-Age from now.
  const stable = attributes.map((attribute) => {
    if (!maxAge || !attribute.startsWith("Expires=")) return attribute;
    const expected = Date.now() + Number(maxAge.slice(8)) * 1000;
    const drift = Math.abs(Date.parse(attribute.slice(8)) - expected);
    return drift <= 5000 ? "Expires=<Max-Age from now>" : attribute;
  });
  return [pair, ...stable.sort()].join("; ");
}

function withoutAccept(vary: string | null): string | null {
  const fields = vary?.split(",").map((field) => field.trim()) ?? [];
  return fields.filter((field) => field && field !== "Accept").join(", ") || null;
}

async function snapshot(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    // 204 responses drop Content-Length here, as RFC 9110 requires (DEVIATIONS.md).
    contentLength:
      init?.method === "OPTIONS" && response.status !== 204
        ? response.headers.get("content-length")
        : null,
    middleware: response.headers.get("x-middleware"),
    customHeader: response.headers.get("x-example"),
    location: response.headers.get("location"),
    // Express redirects negotiate an HTML page (`Vary: Accept`); ours are plain text (DEVIATIONS.md).
    vary: withoutAccept(response.headers.get("vary")),
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

/** Starts the fixture on both adapters, runs `body`, and always closes both. */
async function withPair(
  createAdapter: () => AbstractHttpAdapter,
  createReference: () => AbstractHttpAdapter,
  options: FixtureOptions,
  body: (base: string, referenceBase: string) => Promise<void>,
): Promise<void> {
  const app = await startFixture(createAdapter(), options);
  let reference: INestApplication | undefined;
  try {
    reference = await startFixture(createReference(), options);
    await body(await app.getUrl(), await reference.getUrl());
  } finally {
    await Promise.all([app.close(), reference?.close()]);
  }
}

async function compareCases(
  label: string,
  cases: Case[],
  base: string,
  referenceBase: string,
): Promise<void> {
  for (const [path, init] of cases) {
    const [actual, expected] = await Promise.all([
      snapshot(`${base}${path}`, init),
      snapshot(`${referenceBase}${path}`, init),
    ]);
    const headers = JSON.stringify(init?.headers ?? {});
    assert.deepEqual(actual, expected, `${label}: ${init?.method ?? "GET"} ${path} ${headers}`);
  }
}

export async function compareAdapters(
  createAdapter: () => AbstractHttpAdapter,
  createReference: () => AbstractHttpAdapter,
): Promise<void> {
  const type = createAdapter().getType();
  let comparisons = 0;
  await withPair(createAdapter, createReference, {}, async (base, referenceBase) => {
    await compareCases(type, baselineCases, base, referenceBase);
    comparisons += baselineCases.length;
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
    assert.deepEqual(readByAdapter, readByReference, `${type}: signed cookie read`);
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
  });

  // cookie-parser with its own secret and no `cookies.secret`, as migrated Express apps do.
  await withPair(
    createAdapter,
    createReference,
    { cookieSecret: false, setup: (app) => app.use(cookieParser(COOKIE_SECRET)) },
    async (base, referenceBase) => {
      await compareCases(`${type} cookie-parser`, cookieParserCases, base, referenceBase);
      comparisons += cookieParserCases.length;
      const signed = await fetch(`${base}/api/cookies/express-signed`);
      await signed.arrayBuffer();
      const cookie = signed.headers
        .getSetCookie()
        .map((header) => header.split(";")[0]!)
        .join("; ");
      await compareCases(
        `${type} cookie-parser round trip`,
        [
          ["/api/cookies/parser", { headers: { cookie } }],
          ["/api/cookies/read", { headers: { cookie } }],
        ],
        base,
        referenceBase,
      );
      comparisons += 2;
    },
  );

  for (const [name, value] of trustConfigurations) {
    await withPair(
      createAdapter,
      createReference,
      {
        setup: (app) =>
          (app as unknown as { set(name: string, value: unknown): void }).set("trust proxy", value),
      },
      async (base, referenceBase) => {
        await compareCases(`${type} trust proxy ${name}`, trustCases, base, referenceBase);
        comparisons += trustCases.length;
      },
    );
  }
  for (const [name, options] of corsConfigurations) {
    await withPair(
      createAdapter,
      createReference,
      { setup: (app) => app.enableCors(options as CorsOptions) },
      async (base, referenceBase) => {
        await compareCases(`${type} cors ${name}`, corsCases, base, referenceBase);
        comparisons += corsCases.length;
      },
    );
  }
  console.log(
    `${type}: ${comparisons} Express comparisons (${corsConfigurations.length} CORS and ${trustConfigurations.length} trust proxy configurations, cookie-parser) and parser error cases passed.`,
  );
}
