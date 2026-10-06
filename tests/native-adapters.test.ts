import "reflect-metadata";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { get as httpsGet } from "node:https";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { NestFactory } from "@nestjs/core";
import {
  Controller,
  Get,
  Module,
  VERSION_NEUTRAL,
  Version,
  VersioningType,
  type INestApplication,
  type VersioningOptions,
} from "@nestjs/common";
import { ExpressAdapter } from "@nestjs/platform-express";
import { NodeHttpAdapter, NativeResponse, type NativeRequest } from "nestjs-adapter-node";
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

const apps: INestApplication[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("native Nest adapters", () => {
  it("matches real Nest on Express for supported behavior", async () => {
    await compareAdapters(new NodeHttpAdapter(), new ExpressAdapter());
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
    expect(() => adapter.render()).toThrow("MVC");
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
});
