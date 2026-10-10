import "reflect-metadata";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { get as httpsGet } from "node:https";
import { join } from "node:path";
import { inspect } from "node:util";
import cookieParser from "cookie-parser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { NestFactory } from "@nestjs/core";
import { CookieSigner } from "@nestjs/core/helpers/cookies/cookie-signer.js";
import {
  Body,
  Controller,
  Logger,
  Get,
  Module,
  Post,
  Render,
  UploadedFile,
  UploadedFiles,
  UseInterceptors,
  VERSION_NEUTRAL,
  Version,
  VersioningType,
  type INestApplication,
  type NestInterceptor,
  type Type,
  type VersioningOptions,
} from "@nestjs/common";
import {
  ExpressAdapter,
  FileInterceptor as ExpressFileInterceptor,
  FilesInterceptor as ExpressFilesInterceptor,
} from "@nestjs/platform-express";
import { WsAdapter } from "@nestjs/platform-ws";
import { MessageBody, SubscribeMessage, WebSocketGateway } from "@nestjs/websockets";
import { io as connect } from "socket.io-client";
import { WebSocket } from "ws";
import {
  FileInterceptor,
  FilesInterceptor,
  NodeHttpAdapter,
  NativeResponse,
  type NativeRequest,
  type UploadedFileData,
} from "nestjs-adapter-node";
import { BunHttpAdapter } from "nestjs-adapter-bun";
import { compareAdapters, startFixture } from "../packages/conformance/src/compare.js";
import { FixtureModule, GreetingService } from "../packages/conformance/src/fixture.js";

@Controller("versioned")
class VersionedController {
  @Get()
  @Version(["2", "3"])
  current() {
    return { handler: "new" };
  }
  @Get()
  @Version(VERSION_NEUTRAL)
  fallback() {
    return { handler: "default" };
  }
}
@Module({ controllers: [VersionedController] })
class VersionedModule {}

@WebSocketGateway({ path: "/ws" })
class EchoGateway {
  @SubscribeMessage("echo")
  echo(@MessageBody() data: unknown) {
    return { event: "echo", data };
  }
}
@Module({ imports: [FixtureModule], providers: [EchoGateway] })
class GatewayModule {}

@WebSocketGateway({ namespace: "chat" })
class ChatGateway {
  @SubscribeMessage("ping")
  ping(@MessageBody() data: unknown) {
    return { event: "pong", data };
  }
}
@Module({ imports: [FixtureModule], providers: [ChatGateway] })
class ChatModule {}

function uploadModule(interceptors: {
  FileInterceptor: (field: string) => Type<NestInterceptor>;
  FilesInterceptor: (field: string, maxCount?: number) => Type<NestInterceptor>;
}) {
  const describeFile = (file: UploadedFileData) => ({
    fieldname: file.fieldname,
    originalname: file.originalname,
    mimetype: file.mimetype,
    size: file.size,
    text: file.buffer.toString(),
  });
  @Controller("upload")
  class UploadController {
    @Post("one")
    @UseInterceptors(interceptors.FileInterceptor("avatar"))
    one(@UploadedFile() file: UploadedFileData, @Body() body: Record<string, unknown>) {
      return { file: file && describeFile(file), body: { ...body } };
    }
    @Post("many")
    @UseInterceptors(interceptors.FilesInterceptor("docs", 2))
    many(@UploadedFiles() files: UploadedFileData[], @Body() body: Record<string, unknown>) {
      return { files: files.map(describeFile), body: { ...body } };
    }
  }
  @Module({ controllers: [UploadController] })
  class UploadModule {}
  return UploadModule;
}

@Controller("pages")
class PagesController {
  @Get("hello")
  @Render("hello")
  hello() {
    return { name: "Ada" };
  }
  @Get("missing")
  @Render("missing")
  missing() {
    return {};
  }
}
@Module({ controllers: [PagesController] })
class PagesModule {}

const apps: INestApplication[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("native Nest adapters", () => {
  it("matches real Nest on Express for supported behavior", async () => {
    await compareAdapters(
      () => new NodeHttpAdapter(),
      () => new ExpressAdapter(),
    );
  });
  it("supports initialization without listen and repeated close", async () => {
    const adapter = new NodeHttpAdapter();
    const app = await NestFactory.create(FixtureModule, adapter, { logger: false });
    apps.push(app);
    await app.init();
    const service = app.get(GreetingService);
    expect(service.initialized).toBe(true);
    expect(adapter.getHttpServer().listening).toBe(false);
    const result = await adapter.fetch(new Request("http://localhost/api"));
    expect(await result.json()).toEqual({ message: "real Nest DI" });
    await app.close();
    expect(service.destroyed).toBe(true);
    await app.close();
  });
  it("supports global prefixes and asynchronous middleware", async () => {
    const app = await NestFactory.create(FixtureModule, new NodeHttpAdapter(), { logger: false });
    apps.push(app);
    app.setGlobalPrefix("v1");
    app.use((_req: unknown, res: NativeResponse, next: () => void) => {
      setTimeout(() => {
        res.setHeader("x-async", "yes");
        next();
      }, 1);
    });
    await app.listen(0, "127.0.0.1");
    const result = await fetch(`${await app.getUrl()}/v1/api`);
    expect(result.status).toBe(200);
    expect(result.headers.get("x-async")).toBe("yes");
    expect((await fetch(`${await app.getUrl()}/api`)).status).toBe(404);
  });
  it("parses nested URL-encoded and multipart forms with repeated fields and native files", async () => {
    const app = await NestFactory.create(FixtureModule, new NodeHttpAdapter(), { logger: false });
    apps.push(app);
    await app.listen(0, "127.0.0.1");
    const base = await app.getUrl();

    const urlEncoded = await fetch(`${base}/api/echo`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "user[name]=Ada&tags[]=one&tags[]=two",
    });
    expect(await urlEncoded.json()).toEqual({
      user: { name: "Ada" },
      tags: ["one", "two"],
    });
    const unsafeField = await fetch(`${base}/api/echo`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "__proto__[polluted]=yes",
    });
    expect(unsafeField.status).toBe(400);
    expect(Object.prototype).not.toHaveProperty("polluted");

    const form = new FormData();
    form.append("user[name]", "Ada");
    form.append("tags[]", "one");
    form.append("tags[]", "two");
    form.append("upload", new Blob(["hello"]), "hello.txt");
    const multipart = await fetch(`${base}/api/form`, { method: "POST", body: form });
    expect(multipart.status).toBe(201);
    expect(await multipart.json()).toEqual({
      body: { user: { name: "Ada" }, tags: ["one", "two"], upload: {} },
      upload: { name: "hello.txt", size: 5, type: "application/octet-stream" },
    });
    const oversized = new FormData();
    oversized.append("payload", "x".repeat(110 * 1024));
    const tooLarge = await fetch(`${base}/api/echo`, { method: "POST", body: oversized });
    expect(tooLarge.status).toBe(413);
    await tooLarge.arrayBuffer();
  });
  it("streams Nest @Sse() Observable events as an event-stream response", async () => {
    const adapter = new NodeHttpAdapter();
    adapter.enableCors({ origin: "https://example.com" });
    const app = await NestFactory.create(FixtureModule, adapter, { logger: false });
    apps.push(app);
    await app.listen(0, "127.0.0.1");
    const response = await fetch(`${await app.getUrl()}/api/events`, {
      headers: { origin: "https://example.com" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("cache-control")).toContain("no-cache");
    expect(response.headers.get("access-control-allow-origin")).toBe("https://example.com");
    expect(response.body).not.toBeNull();
    const body = await response.text();
    expect(body).toContain('data: {"index":0}');
    expect(body).toContain('data: {"index":1}');
  });
  it("responds with 503 while shutting down when configured and remains idempotent on close", async () => {
    const adapter = new NodeHttpAdapter();
    const app = await NestFactory.create(FixtureModule, adapter, {
      logger: false,
      return503OnClosing: true,
    });
    apps.push(app);
    await app.init();
    adapter.beforeClose();
    const result = await adapter.fetch(new Request("http://localhost/api"));
    expect(result.status).toBe(503);
    await expect(app.close()).resolves.toBeUndefined();
    await expect(app.close()).resolves.toBeUndefined();
  });
  it("routes middleware next(error) through Nest's exception layer", async () => {
    const app = await NestFactory.create(FixtureModule, new NodeHttpAdapter(), { logger: false });
    apps.push(app);
    app.use((_req: unknown, _res: unknown, next: (error: Error) => void) =>
      next(new Error("failure")),
    );
    await app.listen(0, "127.0.0.1");
    const result = await fetch(`${await app.getUrl()}/api`);
    expect(result.status).toBe(500);
    expect(await result.json()).toEqual({ statusCode: 500, message: "Internal server error" });
  });
  it("rejects listen failures rather than hanging", async () => {
    const first = await startFixture(new NodeHttpAdapter());
    apps.push(first);
    const port = new URL(await first.getUrl()).port;
    const second = await NestFactory.create(FixtureModule, new NodeHttpAdapter(), {
      logger: false,
    });
    apps.push(second);
    await expect(second.listen(Number(port), "127.0.0.1")).rejects.toMatchObject({
      code: "EADDRINUSE",
    });
    // Other listen errors reject too: a socket path in a missing directory, a bad host.
    for (const [target, code] of [
      [() => second.listen(join(process.cwd(), "missing-dir", "app.sock")), /^(ENOENT|EACCES)$/],
      [() => second.listen(0, "256.0.0.1"), /^(ENOTFOUND|EAI_AGAIN|EADDRNOTAVAIL)$/],
    ] as const) {
      await expect(target()).rejects.toMatchObject({ code: expect.stringMatching(code) });
    }
  });
  it("survives clients that abort an upload and keeps serving", async () => {
    const failures: unknown[] = [];
    const record = (error: unknown) => failures.push(error);
    process.on("unhandledRejection", record).on("uncaughtException", record);
    try {
      const app = await startFixture(new NodeHttpAdapter());
      apps.push(app);
      const { hostname, port } = new URL(await app.getUrl());
      for (let attempt = 0; attempt < 5; attempt++) {
        await new Promise<void>((resolve) => {
          const upload = httpRequest({
            hostname,
            port,
            method: "POST",
            path: "/api/echo",
            headers: { "content-type": "application/json", "content-length": "1000" },
          });
          upload.on("error", () => resolve());
          upload.on("close", () => resolve());
          upload.write('{"partial":');
          setTimeout(() => upload.destroy(), 20);
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
      const after = await fetch(`${await app.getUrl()}/api`);
      expect(after.status).toBe(200);
      await after.arrayBuffer();
    } finally {
      process.off("unhandledRejection", record).off("uncaughtException", record);
    }
    expect(failures).toEqual([]);
  });
  it("trusts proxies like Express's trust proxy setting", async () => {
    // Validated up front instead of failing per request.
    // Validated up front, with proxy-addr's rules: /0 would trust every address.
    for (const invalid of [
      "not-an-ip",
      "10.0.0.0/33",
      "10.0.0.0/0",
      "10.0.0.0/0.0.0.0",
      "10.0.0.0/255.0.255.0",
      "::/0",
      "::1/129",
      -1,
      1.5,
      {},
    ]) {
      expect(() => new NodeHttpAdapter({ trustProxy: invalid as never })).toThrow(TypeError);
    }
    // Like Express, other falsy values trust nothing.
    for (const off of [null, "", false, 0]) {
      expect(() => new NodeHttpAdapter({ trustProxy: off as never })).not.toThrow();
    }
    // Unknown settings are accepted like Express, with a warning instead of an exit.
    const warnings: unknown[] = [];
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation((message) => {
      warnings.push(message);
    });
    const adapter = new NodeHttpAdapter();
    expect(adapter.set("json spaces", 2)).toBe(adapter);
    expect(adapter.disable("x-powered-by")).toBe(adapter);
    expect(warnings).toEqual([
      'app.set("json spaces") has no effect on the native adapters and is ignored.',
    ]);
    warn.mockRestore();

    // The fetch path (Bun) takes the socket address from the server.
    const fetchAdapter = new NodeHttpAdapter({ trustProxy: "loopback" });
    const fetchApp = await NestFactory.create(FixtureModule, fetchAdapter, { logger: false });
    apps.push(fetchApp);
    await fetchApp.init();
    const headers = {
      "x-forwarded-for": "198.51.100.1, 203.0.113.7",
      "x-forwarded-proto": "https",
      "x-forwarded-host": "app.example:8443",
    };
    const viaProxy = await fetchAdapter.fetch(
      new Request("http://localhost/api/client", { headers }),
      { ip: "127.0.0.1" },
    );
    expect(await viaProxy.json()).toEqual({
      ip: "203.0.113.7",
      decoratorIp: "203.0.113.7",
      ips: ["203.0.113.7"],
      protocol: "https",
      hostname: "app.example",
    });
    const direct = await fetchAdapter.fetch(
      new Request("http://localhost/api/client", { headers }),
      { ip: "198.51.100.9" },
    );
    expect(await direct.json()).toEqual({
      ip: "198.51.100.9",
      decoratorIp: "198.51.100.9",
      ips: [],
      protocol: "http",
      hostname: "localhost",
    });

    // A trust function that throws fails the request through Nest (500), not fetch() itself.
    const throwing = new NodeHttpAdapter({
      trustProxy: () => {
        throw new Error("trust failed");
      },
    });
    const throwingApp = await NestFactory.create(FixtureModule, throwing, { logger: false });
    apps.push(throwingApp);
    await throwingApp.init();
    const failed = await throwing.fetch(new Request("http://localhost/api/client"));
    expect(failed.status).toBe(500);
    expect((await throwing.fetch(new Request("http://localhost/api"))).status).toBe(200);

    // Dual-stack listeners report IPv4 peers as ::ffff:127.0.0.1, which still matches "loopback".
    const mapped = await fetchAdapter.fetch(
      new Request("http://localhost/api/client", { headers }),
      { ip: "::ffff:127.0.0.1" },
    );
    expect(await mapped.json()).toMatchObject({ ip: "203.0.113.7", protocol: "https" });

    // app.set("trust proxy", ...) after creation applies to the Node path too.
    const configured = await NestFactory.create(FixtureModule, new NodeHttpAdapter(), {
      logger: false,
    });
    apps.push(configured);
    (configured as unknown as NodeHttpAdapter).set("trust proxy", 1);
    await configured.listen(0, "127.0.0.1");
    const hop = await fetch(`${await configured.getUrl()}/api/client`, { headers });
    expect(await hop.json()).toMatchObject({ ip: "203.0.113.7", ips: ["203.0.113.7"] });
  });
  it("supports CORS preflight and static file serving and rejects other unsupported capabilities explicitly", async () => {
    const adapter = new NodeHttpAdapter();
    adapter.enableCors({
      origin: "*",
      credentials: true,
      methods: ["GET", "POST"],
      allowedHeaders: ["content-type", "x-auth"],
    });
    expect(() => adapter.useBodyParser("xml" as "json")).toThrow("Unsupported body parser");
    expect(() => new BunHttpAdapter().initHttpServer({})).toThrow("Bun runtime");
    expect(() => new NodeHttpAdapter({ bodyLimit: -1 })).toThrow("bodyLimit");
    expect(() => new NodeHttpAdapter({ shutdownTimeout: -1 })).toThrow("shutdownTimeout");

    const app = await NestFactory.create(FixtureModule, adapter, { logger: false });
    apps.push(app);
    const staticDir = join(process.cwd(), "tmp-static");
    try {
      await mkdir(staticDir, { recursive: true });
      await writeFile(join(staticDir, "index.html"), "<h1>hello</h1>");
      await writeFile(join(staticDir, "app.js"), "console.log('static');");
      adapter.useStaticAssets(staticDir, { prefix: "/assets" });
      await app.listen(0, "127.0.0.1");
      const base = await app.getUrl();
      const preflight = await fetch(`${base}/api`, {
        method: "OPTIONS",
        headers: {
          origin: "https://example.com",
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type, x-auth",
        },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
      expect(preflight.headers.get("access-control-allow-methods")).toContain("POST");
      const response = await fetch(`${base}/api`, {
        headers: { origin: "https://example.com" },
      });
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      expect(response.headers.get("access-control-allow-credentials")).toBe("true");
      const assetsIndex = await fetch(`${base}/assets/`);
      expect(assetsIndex.status).toBe(200);
      expect(await assetsIndex.text()).toContain("hello");
      const assetsJs = await fetch(`${base}/assets/app.js`);
      expect(assetsJs.status).toBe(200);
      expect(await assetsJs.text()).toContain("console.log");
    } finally {
      await rm(staticDir, { recursive: true, force: true });
    }
  });
  it("streams large static files with validators, ranges and Express maxAge units", async () => {
    const dir = join(process.cwd(), "tmp-static-large");
    const size = 2 * 1024 * 1024 + 7;
    const bytes = Buffer.alloc(size, 0);
    for (let i = 0; i < size; i++) bytes[i] = i % 251;
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "big.bin"), bytes);
      const adapter = new NodeHttpAdapter();
      const app = await NestFactory.create(FixtureModule, adapter, { logger: false });
      apps.push(app);
      adapter.useStaticAssets(dir, { prefix: "/files", maxAge: 60_000 });
      await app.listen(0, "127.0.0.1");
      const base = await app.getUrl();
      for (const get of [
        (path: string, headers?: Record<string, string>) => fetch(`${base}${path}`, { headers }),
        (path: string, headers?: Record<string, string>) =>
          adapter.fetch(new Request(`http://localhost${path}`, { headers })),
      ]) {
        const full = await get("/files/big.bin");
        expect(full.status).toBe(200);
        // maxAge is in milliseconds, as on Express.
        expect(full.headers.get("cache-control")).toBe("public, max-age=60");
        expect(full.headers.get("content-length")).toBe(String(size));
        expect(Buffer.from(await full.arrayBuffer()).equals(bytes)).toBe(true);
        const part = await get("/files/big.bin", { range: "bytes=1048576-1048585" });
        expect(part.status).toBe(206);
        expect(part.headers.get("content-range")).toBe(`bytes 1048576-1048585/${size}`);
        expect(Buffer.from(await part.arrayBuffer()).equals(bytes.subarray(1048576, 1048586))).toBe(
          true,
        );
        // A range the server ignores (two ranges) still sends the whole file.
        const ignored = await get("/files/big.bin", { range: "bytes=0-1,10-11" });
        expect(ignored.status).toBe(200);
        expect((await ignored.arrayBuffer()).byteLength).toBe(size);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("fails closed for CORS allowlists and rejects absolute static paths", async () => {
    const adapter = new NodeHttpAdapter();
    adapter.enableCors({
      origin: [/^https:\/\/.*\.trusted\.example$/, "https://exact.example"],
      credentials: true,
    });
    const app = await NestFactory.create(FixtureModule, adapter, { logger: false });
    apps.push(app);
    const staticDir = join(process.cwd(), "tmp-static-cors");
    try {
      await mkdir(staticDir, { recursive: true });
      await writeFile(join(staticDir, "index.html"), "<h1>hello</h1>");
      adapter.useStaticAssets(staticDir, { prefix: "/assets" });
      await app.listen(0, "127.0.0.1");
      const base = await app.getUrl();
      const evil = await fetch(`${base}/api`, { headers: { origin: "https://evil.example" } });
      expect(evil.headers.get("access-control-allow-origin")).toBeNull();
      expect(evil.headers.get("vary")).toBe("Origin");
      const regexHit = await fetch(`${base}/api`, {
        headers: { origin: "https://app.trusted.example" },
      });
      expect(regexHit.headers.get("access-control-allow-origin")).toBe(
        "https://app.trusted.example",
      );
      const exactHit = await fetch(`${base}/api`, { headers: { origin: "https://exact.example" } });
      expect(exactHit.headers.get("access-control-allow-origin")).toBe("https://exact.example");
      const escape = await fetch(`${base}/assets/${encodeURIComponent("C:")}/Windows/win.ini`);
      expect(escape.status).toBe(404);
      const escapeRaw = await fetch(`${base}/assets/D:/secrets/file`);
      expect(escapeRaw.status).toBe(404);
    } finally {
      await rm(staticDir, { recursive: true, force: true });
    }

    const callbackAdapter = new NodeHttpAdapter();
    callbackAdapter.enableCors({
      origin: (origin, cb) => cb(null, origin === "https://cb.example"),
    });
    const callbackApp = await NestFactory.create(FixtureModule, callbackAdapter, { logger: false });
    apps.push(callbackApp);
    await callbackApp.listen(0, "127.0.0.1");
    const callbackBase = await callbackApp.getUrl();
    const allowed = await fetch(`${callbackBase}/api`, {
      headers: { origin: "https://cb.example" },
    });
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://cb.example");
    const denied = await fetch(`${callbackBase}/api`, {
      headers: { origin: "https://no.example" },
    });
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();
  });
  it("follows the cors package for delegates, preflightContinue, origin callbacks and aliases", async () => {
    const delegated = new NodeHttpAdapter();
    delegated.enableCors((req: NativeRequest, cb) => {
      const mode = req.headers["x-cors"];
      if (mode === "error") return cb(new Error("delegate failed"), {});
      if (mode === "defaults") return (cb as (error: null) => void)(null);
      if (mode === "off") return cb(null, { origin: false });
      cb(null, { origin: true, preflightContinue: true });
    });
    const delegatedApp = await NestFactory.create(FixtureModule, delegated, { logger: false });
    apps.push(delegatedApp);
    await delegatedApp.listen(0, "127.0.0.1");
    const delegatedBase = await delegatedApp.getUrl();
    const preflight = { origin: "https://x.example", "access-control-request-method": "GET" };

    // preflightContinue: the preflight gets CORS headers and still reaches @Options().
    const continued = await fetch(`${delegatedBase}/api/options`, {
      method: "OPTIONS",
      headers: preflight,
    });
    expect(continued.status).toBe(200);
    expect(continued.headers.get("access-control-allow-origin")).toBe("https://x.example");
    expect(continued.headers.get("access-control-allow-methods")).toBe(
      "GET,HEAD,PUT,PATCH,POST,DELETE",
    );
    expect(await continued.json()).toEqual({ options: true });
    // origin: false turns CORS off for the request, so OPTIONS is routed normally.
    const disabled = await fetch(`${delegatedBase}/api/options`, {
      method: "OPTIONS",
      headers: { ...preflight, "x-cors": "off" },
    });
    expect(disabled.status).toBe(200);
    expect(disabled.headers.get("access-control-allow-origin")).toBeNull();
    expect(disabled.headers.get("access-control-allow-methods")).toBeNull();
    expect(await disabled.json()).toEqual({ options: true });
    // A delegate that calls back without options gets the cors defaults.
    const defaults = await fetch(`${delegatedBase}/api`, {
      headers: { origin: "https://x.example", "x-cors": "defaults" },
    });
    expect(defaults.status).toBe(200);
    expect(defaults.headers.get("access-control-allow-origin")).toBe("*");
    const failed = await fetch(`${delegatedBase}/api`, { headers: { "x-cors": "error" } });
    expect(failed.status).toBe(500);
    await failed.arrayBuffer();

    // Like cors, the origin callback also runs for requests without an Origin header.
    const seen: (string | undefined)[] = [];
    const callback = new NodeHttpAdapter();
    callback.enableCors({
      origin: (origin, cb) => {
        seen.push(origin);
        cb(null, origin === "https://cb.example");
      },
    });
    const callbackApp = await NestFactory.create(FixtureModule, callback, { logger: false });
    apps.push(callbackApp);
    await callbackApp.listen(0, "127.0.0.1");
    const sameOrigin = await fetch(`${await callbackApp.getUrl()}/api`);
    expect(sameOrigin.status).toBe(200);
    expect(sameOrigin.headers.get("access-control-allow-origin")).toBeNull();
    expect(seen).toEqual([undefined]);

    // An unset origin (e.g. a missing environment variable) fails closed, as in cors.
    const unset = new NodeHttpAdapter();
    unset.enableCors({ origin: process.env.NEST_NATIVE_UNSET_CORS_ORIGIN, credentials: true });
    const aliases = new NodeHttpAdapter();
    aliases.enableCors({ origin: ["https://a.example"], allowCredentials: true, headers: "x-a" });
    for (const adapter of [unset, aliases]) {
      const app = await NestFactory.create(FixtureModule, adapter, { logger: false });
      apps.push(app);
      await app.init();
    }
    const evil = await unset.fetch(
      new Request("http://localhost/api", { headers: { origin: "https://evil.example" } }),
    );
    expect(evil.headers.get("access-control-allow-origin")).toBeNull();
    expect(evil.headers.get("access-control-allow-credentials")).toBeNull();
    expect(evil.headers.get("vary")).toBeNull();
    const aliased = await aliases.fetch(
      new Request("http://localhost/api/options", {
        method: "OPTIONS",
        headers: { origin: "https://a.example", "access-control-request-headers": "x-b" },
      }),
    );
    expect(aliased.status).toBe(204);
    expect(aliased.headers.get("access-control-allow-credentials")).toBe("true");
    expect(aliased.headers.get("access-control-allow-headers")).toBe("x-a");
    expect(aliased.headers.get("vary")).toBe("Origin");

    // Boxed String origins must not fall back to "allow everything".
    for (const origin of [
      new String("https://trusted.example"),
      [new String("https://trusted.example")],
    ]) {
      const boxed = new NodeHttpAdapter();
      boxed.enableCors({ origin: origin as string, credentials: true });
      const app = await NestFactory.create(FixtureModule, boxed, { logger: false });
      apps.push(app);
      await app.init();
      const response = await boxed.fetch(
        new Request("http://localhost/api", { headers: { origin: "https://evil.example" } }),
      );
      expect(response.headers.get("access-control-allow-origin")).toBe(
        Array.isArray(origin) ? null : "https://trusted.example",
      );
    }
  });
  it("appends Vary fields like the vary package", () => {
    const response = new NativeResponse("GET");
    response.setHeader("vary", "");
    response.vary("Origin");
    expect(response.getHeader("vary")).toBe("Origin");
    response.vary(["origin", "Accept-Encoding"]).vary("Access-Control-Request-Headers");
    expect(response.getHeader("vary")).toBe(
      "Origin, Accept-Encoding, Access-Control-Request-Headers",
    );
    response.vary("*").vary("Origin");
    expect(response.getHeader("vary")).toBe("*");
    expect(() => response.vary("bad field")).toThrow("Invalid Vary field name");
  });
  it("writes cookies with Express's res.cookie() and res.clearCookie() semantics", async () => {
    const before = Date.now();
    const response = new NativeResponse("GET")
      .cookie("visits", 5)
      .cookie("remember", true)
      .cookie("nothing", null)
      .cookie("sid", "x", { maxAge: null, domain: null, priority: null, sameSite: false })
      .cookie("strict", "y", { sameSite: true })
      .cookie("ttl", "z", { maxAge: 90_000, httpOnly: true })
      .clearCookie("gone", { maxAge: 5000, path: "/api" });
    const [visits, remember, nothing, sid, strict, ttl, gone] = response.getHeader(
      "set-cookie",
    ) as string[];
    expect([visits, remember, nothing, sid, strict, gone]).toEqual([
      "visits=5; Path=/",
      "remember=true; Path=/",
      "nothing=j%3Anull; Path=/",
      "sid=x; Path=/",
      "strict=y; Path=/; SameSite=Strict",
      "gone=; Path=/api; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    ]);
    expect(ttl).toMatch(/^ttl=z; Path=\/; Max-Age=90; Expires=[^;]+; HttpOnly$/);
    const expires = Date.parse(/Expires=([^;]+)/.exec(ttl!)![1]!);
    expect(expires).toBeGreaterThanOrEqual(before + 89_000);
    expect(expires).toBeLessThanOrEqual(Date.now() + 90_000);
    // Express passes a non-numeric maxAge on, and its serializer rejects it too.
    expect(() => response.cookie("nan", "x", { maxAge: Number.NaN })).toThrow(TypeError);
    expect(() => response.cookie("bad;name", "x")).toThrow("Invalid cookie name");
    expect(() => response.cookie("signed", "x", { signed: true })).toThrow("no cookie secret");
    expect(() => response.cookie("custom", "x", { encode: String } as never)).toThrow("encode");
    // Express omits Path for a falsy path; an empty Path= is equivalent for browsers.
    const quirks = new NativeResponse("GET")
      .cookie("empty", "v", { path: "" })
      .cookie("off", "v", { path: false })
      .cookie("inherited", "v", Object.create({ path: "/x", maxAge: 1000 }) as object);
    expect(quirks.getHeader("set-cookie")).toEqual([
      "empty=v; Path=",
      "off=v; Path=",
      "inherited=v; Path=/",
    ]);

    // signed: true uses the cookies.secret application option when cookie-parser is absent.
    const adapter = new NodeHttpAdapter();
    const app = await NestFactory.create(FixtureModule, adapter, {
      logger: false,
      cookies: { secret: ["current-secret", "previous-secret"] },
    });
    apps.push(app);
    await app.init();
    const signed = await adapter.fetch(new Request("http://localhost/api/cookies/express-signed"));
    expect(signed.status).toBe(200);
    const [token, prefs, stale] = signed.headers.getSetCookie();
    const unsign = (header: string | undefined) =>
      new CookieSigner("current-secret").unsign(
        decodeURIComponent(header!.split(";")[0]!.split("=")[1]!),
      );
    expect(unsign(token)).toBe("user-42");
    expect(unsign(prefs)).toBe('j:{"theme":"dark"}');
    expect(unsign(stale)).toBe("");
    expect(stale).toContain("; Path=/api; Expires=Thu, 01 Jan 1970 00:00:00 GMT");
  });
  it("keeps request cookies to cookie-parser, as Express does, and never exposes the secret", async () => {
    const plain = new NodeHttpAdapter();
    const plainApp = await NestFactory.create(FixtureModule, plain, { logger: false });
    apps.push(plainApp);
    await plainApp.init();
    // Without cookie-parser nothing populates req.cookies, and reading it does not throw.
    const untouched = await plain.fetch(
      new Request("http://localhost/api/cookies/parser", { headers: { cookie: "a=1" } }),
    );
    expect(await untouched.json()).toEqual({
      cookies: null,
      signedCookies: null,
      secret: "undefined",
    });

    // cookie-parser runs (it skips requests whose req.cookies is already set) and its
    // secret serves @SignedCookies() and res.cookie({ signed: true }) without cookies.secret.
    const adapter = new NodeHttpAdapter();
    const app = await NestFactory.create(FixtureModule, adapter, { logger: false });
    apps.push(app);
    app.use(cookieParser("parser-secret"));
    app.use((req: NativeRequest, _res: NativeResponse, next: () => void) => {
      req.cookies = { ...req.cookies, injected: "yes" };
      next();
    });
    await app.listen(0, "127.0.0.1");
    const base = await app.getUrl();
    const signedToken = new CookieSigner("parser-secret").sign("user-42");
    const cookie = [
      `token=${encodeURIComponent(signedToken)}`,
      `prefs=${encodeURIComponent('j:{"theme":"dark"}')}`,
    ].join("; ");
    const parsed = await fetch(`${base}/api/cookies/parser`, { headers: { cookie } });
    expect(await parsed.json()).toEqual({
      cookies: { prefs: { theme: "dark" }, injected: "yes" },
      signedCookies: { token: "user-42" },
      secret: "string",
    });
    const read = await fetch(`${base}/api/cookies/read`, { headers: { cookie } });
    expect(read.status).toBe(200);
    expect((await read.json()).token).toBe("user-42");
    const tampered = await fetch(`${base}/api/cookies/read`, {
      headers: { cookie: "token=s:user-42.forged" },
    });
    expect(tampered.status).toBe(200);
    expect((await tampered.json()).token).toBeNull();
    const written = await fetch(`${base}/api/cookies/express-signed`);
    expect(written.status).toBe(200);
    const [tokenCookie] = written.headers.getSetCookie();
    expect(decodeURIComponent(tokenCookie!.split(";")[0]!)).toBe(`token=${signedToken}`);

    // Neither the request nor the response carries the cookie secret in a visible field.
    const dumps: string[] = [];
    const secretApp = await NestFactory.create(FixtureModule, new NodeHttpAdapter(), {
      logger: false,
      cookies: { secret: "top-secret-value" },
    });
    apps.push(secretApp);
    secretApp.use((req: NativeRequest, res: NativeResponse, next: () => void) => {
      dumps.push(inspect(req, { depth: 3 }), inspect(res, { depth: 3 }));
      // Node's facades wrap circular IncomingMessage/ServerResponse objects, so
      // JSON.stringify only succeeds on the fetch path.
      if (req.headers["x-fetch-path"] === "1") {
        dumps.push(JSON.stringify(req), JSON.stringify(res));
      }
      next();
    });
    await secretApp.listen(0, "127.0.0.1");
    await (await fetch(`${await secretApp.getUrl()}/api`)).arrayBuffer();
    const fetchAdapter = secretApp.getHttpAdapter() as unknown as NodeHttpAdapter;
    await (
      await fetchAdapter.fetch(
        new Request("http://localhost/api", { headers: { "x-fetch-path": "1" } }),
      )
    ).arrayBuffer();
    expect(dumps).toHaveLength(6);
    for (const dump of dumps) expect(dump).not.toContain("top-secret-value");
  });
  it("preserves multiple cookies and omits bodies for HEAD and 204", async () => {
    const adapter = new NodeHttpAdapter();
    const response = new NativeResponse("GET");
    adapter.setCookie(response, "a", "1");
    adapter.setCookie(response, "b", "2");
    response.json({ yes: true });
    expect((await response.done).headers.getSetCookie()).toHaveLength(2);
    const head = new NativeResponse("HEAD").send({ yes: true });
    expect(await (await head.done).text()).toBe("");
    const empty = new NativeResponse("GET").status(204).send("ignored");
    expect(await (await empty.done).text()).toBe("");
  });
  it("supports hasHeader and removeHeader for Express-style middleware such as helmet", () => {
    const response = new NativeResponse("GET").setHeader("X-Powered-By", "x");
    expect(response.hasHeader("x-powered-by")).toBe(true);
    response.removeHeader("X-POWERED-BY");
    expect(response.hasHeader("x-powered-by")).toBe(false);
    expect(response.getHeader("x-powered-by")).toBeUndefined();
  });
  it("parses query strings into prototype-free objects", async () => {
    const adapter = new NodeHttpAdapter();
    let query: unknown;
    adapter.use((req: { query: unknown }, res: NativeResponse) => {
      query = req.query;
      res.end();
    });
    await adapter.fetch(
      new Request("http://localhost/?a=1&a=2&b=x+y%21&flag&&bad=%E0%A4%A&__proto__=p&c=d=e"),
    );
    expect("toString" in (query as object)).toBe(false);
    expect({ ...(query as object) }).toEqual({
      a: ["1", "2"],
      b: "x y!",
      flag: "",
      bad: "%E0%A4%A",
      ["__proto__"]: "p",
      c: "d=e",
    });
  });
  it("answers 500 instead of hanging when a response header is invalid", async () => {
    const app = await NestFactory.create(FixtureModule, new NodeHttpAdapter(), { logger: false });
    apps.push(app);
    app.use((_req: unknown, res: NativeResponse) => {
      res.setHeader("x-bad", "a\r\nb: c");
      res.json({ never: true });
    });
    await app.listen(0, "127.0.0.1");
    const result = await fetch(`${await app.getUrl()}/api`, { signal: AbortSignal.timeout(2000) });
    expect(result.status).toBe(500);
    expect(result.headers.get("x-bad")).toBeNull();
  });
  it("selects handlers by header, media type and custom versioning", async () => {
    const cases: { options: VersioningOptions; send: Record<string, string>; search: string }[] = [
      {
        options: { type: VersioningType.HEADER, header: "X-Api-Version" },
        send: { "x-api-version": "3" },
        search: "",
      },
      {
        options: { type: VersioningType.MEDIA_TYPE, key: "v=" },
        send: { accept: "application/json;v=2" },
        search: "",
      },
      {
        options: {
          type: VersioningType.CUSTOM,
          extractor: (req: unknown) => (req as NativeRequest).query.v as string,
        },
        send: {},
        search: "?v=2",
      },
    ];
    for (const { options, send, search } of cases) {
      const app = await NestFactory.create(VersionedModule, new NodeHttpAdapter(), {
        logger: false,
      });
      apps.push(app);
      app.enableVersioning(options);
      await app.listen(0, "127.0.0.1");
      const url = `${await app.getUrl()}/versioned`;
      expect(await (await fetch(url + search, { headers: send })).json()).toEqual({
        handler: "new",
      });
      // Unknown or missing versions fall through to the VERSION_NEUTRAL handler.
      const other = await fetch(url + (search && "?v=9"), {
        headers: { "x-api-version": "9", accept: "application/json;v=9" },
      });
      expect(await other.json()).toEqual({ handler: "default" });
      expect(await (await fetch(url)).json()).toEqual({ handler: "default" });
    }
  });
  it("serves HTTPS when Nest httpsOptions are given", async () => {
    const dir = join(process.cwd(), ".tmp-tls");
    await mkdir(dir, { recursive: true });
    try {
      execFileSync(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-days",
          "1",
          "-subj",
          "/CN=localhost",
        ].concat(["-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem")]),
        { stdio: "ignore" },
      );
      const app = await NestFactory.create(FixtureModule, new NodeHttpAdapter(), {
        logger: false,
        httpsOptions: {
          key: await readFile(join(dir, "key.pem")),
          cert: await readFile(join(dir, "cert.pem")),
        },
      });
      apps.push(app);
      app.use((req: NativeRequest, res: NativeResponse) => res.json({ protocol: req.protocol }));
      await app.listen(0, "127.0.0.1");
      const { port } = app.getHttpServer().address() as { port: number };
      const body = await new Promise<string>((resolve, reject) => {
        httpsGet({ host: "127.0.0.1", port, path: "/", rejectUnauthorized: false }, (res) => {
          let text = "";
          res.on("data", (chunk) => (text += chunk)).on("end", () => resolve(text));
        }).on("error", reject);
      });
      expect(JSON.parse(body)).toEqual({ protocol: "https" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("supports custom body parsers, direct writes and response events", async () => {
    const app = await NestFactory.create(FixtureModule, new NodeHttpAdapter(), { logger: false });
    apps.push(app);
    const parsers = app as unknown as { useBodyParser(type: string, options?: object): void };
    parsers.useBodyParser("text", { type: "text/*" });
    parsers.useBodyParser("raw", { limit: "1kb" });
    parsers.useBodyParser("json", { type: "application/x-custom", limit: 16 });
    let finished = 0;
    app.use("/stream", (_req: unknown, res: NativeResponse) => {
      res.on("finish", () => finished++);
      res.status(201).setHeader("content-type", "text/plain");
      res.write("one,");
      setTimeout(() => {
        res.write("two,");
        res.end("three");
      }, 5);
    });
    await app.listen(0, "127.0.0.1");
    const base = await app.getUrl();
    const post = (type: string, body: string) =>
      fetch(`${base}/api/echo`, { method: "POST", headers: { "content-type": type }, body });

    expect(await (await post("text/csv", "a,b")).text()).toBe("a,b");
    const binary = await post("application/octet-stream", "bytes");
    expect(binary.headers.get("content-type")).toBe("application/octet-stream");
    expect(await binary.text()).toBe("bytes");
    expect((await post("application/octet-stream", "x".repeat(2000))).status).toBe(413);
    expect(await (await post("application/x-custom", '{"a":1}')).json()).toEqual({ a: 1 });
    expect((await post("application/x-custom", JSON.stringify({ a: "x".repeat(32) }))).status).toBe(
      413,
    );
    expect(await (await post("application/json", '{"b":2}')).json()).toEqual({ b: 2 });

    const stream = await fetch(`${base}/stream`);
    expect(stream.status).toBe(201);
    expect(await stream.text()).toBe("one,two,three");
    expect((await fetch(`${base}/stream`, { method: "HEAD" })).status).toBe(201);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(finished).toBe(2);
  });
  it("shares its HTTP server with Nest's WebSocket adapter", async () => {
    const app = await NestFactory.create(GatewayModule, new NodeHttpAdapter(), { logger: false });
    apps.push(app);
    app.useWebSocketAdapter(new WsAdapter(app));
    await app.listen(0, "127.0.0.1");
    const base = await app.getUrl();
    const socket = new WebSocket(`${base.replace("http", "ws")}/ws`);
    const reply = await new Promise<string>((resolve, reject) => {
      socket.on("open", () => socket.send(JSON.stringify({ event: "echo", data: { n: 1 } })));
      socket.on("message", (data: Buffer) => resolve(data.toString()));
      socket.on("error", reject);
    });
    socket.close();
    expect(JSON.parse(reply)).toEqual({ event: "echo", data: { n: 1 } });
    expect((await fetch(`${base}/api`)).status).toBe(200);
  });
  it("works with Nest's default Socket.IO adapter without extra setup", async () => {
    const app = await NestFactory.create(ChatModule, new NodeHttpAdapter(), { logger: false });
    apps.push(app);
    await app.listen(0, "127.0.0.1");
    const base = await app.getUrl();
    const socket = connect(`${base}/chat`, { forceNew: true });
    try {
      const reply = await new Promise((resolve, reject) => {
        socket.on("connect_error", reject);
        socket.on("connect", () => socket.emit("ping", { n: 1 }));
        socket.on("pong", resolve);
      });
      expect(reply).toEqual({ n: 1 });
    } finally {
      socket.close();
    }
    expect((await fetch(`${base}/socket.io/socket.io.js`)).status).toBe(200);
    expect((await fetch(`${base}/api`)).status).toBe(200);
  });
  it("handles uploads like Nest's Multer interceptors", async () => {
    const native = await NestFactory.create(
      uploadModule({ FileInterceptor, FilesInterceptor }),
      new NodeHttpAdapter({ uploadLimit: 1024 * 1024 }),
      { logger: false },
    );
    const express = await NestFactory.create(
      uploadModule({
        FileInterceptor: ExpressFileInterceptor,
        FilesInterceptor: ExpressFilesInterceptor,
      }),
      new ExpressAdapter(),
      { logger: false },
    );
    apps.push(native, express);
    await Promise.all([native.listen(0, "127.0.0.1"), express.listen(0, "127.0.0.1")]);
    const requests: [string, () => FormData][] = [
      [
        "one",
        () => {
          const form = new FormData();
          form.append("title", "Profile");
          // Larger than the default 100 KiB body limit, so `uploadLimit` must apply.
          form.append("avatar", new Blob(["a".repeat(200_000)], { type: "image/png" }), "me.png");
          return form;
        },
      ],
      ["one", () => new FormData()],
      [
        "many",
        () => {
          const form = new FormData();
          form.append("docs", new Blob(["first"], { type: "text/plain" }), "a.txt");
          form.append("docs", new Blob(["second"], { type: "text/plain" }), "b.txt");
          form.append("note", "two files");
          return form;
        },
      ],
      [
        "many",
        () => {
          const form = new FormData();
          for (const name of ["a", "b", "c"]) form.append("docs", new Blob([name]), `${name}.txt`);
          return form;
        },
      ],
      [
        "one",
        () => {
          const form = new FormData();
          form.append("other", new Blob(["x"]), "x.txt");
          return form;
        },
      ],
    ];
    for (const [path, form] of requests) {
      const [actual, expected] = await Promise.all(
        [native, express].map(async (app) => {
          const response = await fetch(`${await app.getUrl()}/upload/${path}`, {
            method: "POST",
            body: form(),
          });
          const body = (await response.json()) as { message?: string };
          return { status: response.status, body: response.ok ? body : undefined };
        }),
      );
      expect(actual).toEqual(expected);
    }
  });
  it("renders views with Express-compatible engines", async () => {
    const dir = join(process.cwd(), ".tmp-views");
    await mkdir(join(dir, "node_modules", "tiny-engine"), { recursive: true });
    try {
      // A stand-in for ejs/pug/hbs: any module exporting Express's `__express`.
      await writeFile(
        join(dir, "node_modules", "tiny-engine", "index.js"),
        `const { readFile } = require("node:fs");
         exports.__express = (path, options, done) =>
           readFile(path, "utf8", (error, text) =>
             done(error, text && text.replace(/{{(\\w+)}}/g, (_, key) => options[key])));`,
      );
      await writeFile(join(dir, "hello.tiny-engine"), "<h1>Hello {{name}}</h1>");
      await writeFile(join(dir, "hello.txt"), "Hi {{name}}");
      type Views = { setBaseViewsDir(dir: string): void; setViewEngine(engine: unknown): void };

      const byName = await NestFactory.create(PagesModule, new NodeHttpAdapter(), {
        logger: false,
      });
      apps.push(byName);
      (byName as unknown as Views).setBaseViewsDir(dir);
      (byName as unknown as Views).setViewEngine("tiny-engine");
      await byName.listen(0, "127.0.0.1");
      const page = await fetch(`${await byName.getUrl()}/pages/hello`);
      expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(await page.text()).toBe("<h1>Hello Ada</h1>");
      expect((await fetch(`${await byName.getUrl()}/pages/missing`)).status).toBe(500);

      const byFunction = await NestFactory.create(PagesModule, new NodeHttpAdapter(), {
        logger: false,
      });
      apps.push(byFunction);
      (byFunction as unknown as Views).setBaseViewsDir(dir);
      (byFunction as unknown as Views).setViewEngine({
        extension: "txt",
        render: (
          path: string,
          options: { name: string },
          done: (e: unknown, html: string) => void,
        ) =>
          void readFile(path, "utf8").then((text) =>
            done(null, text.replace("{{name}}", options.name)),
          ),
      });
      await byFunction.listen(0, "127.0.0.1");
      expect(await (await fetch(`${await byFunction.getUrl()}/pages/hello`)).text()).toBe("Hi Ada");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
