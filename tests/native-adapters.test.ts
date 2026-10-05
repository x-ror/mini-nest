import "reflect-metadata";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { NestFactory } from "@nestjs/core";
import { VersioningType, type INestApplication } from "@nestjs/common";
import { ExpressAdapter } from "@nestjs/platform-express";
import { NodeHttpAdapter, NativeResponse } from "nestjs-adapter-node";
import { BunHttpAdapter } from "nestjs-adapter-bun";
import { compareAdapters, startFixture } from "../packages/conformance/src/compare.js";
import { FixtureModule, GreetingService } from "../packages/conformance/src/fixture.js";

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
    adapter.enableCors({ origin: "*", credentials: true, methods: ["GET", "POST"], allowedHeaders: ["content-type", "x-auth"] });
    expect(() => adapter.useBodyParser()).toThrow("Custom body parsers");
    expect(() => adapter.render()).toThrow("MVC");
    expect(() =>
      adapter.applyVersionFilter(() => {}, "1", { type: VersioningType.HEADER, header: "version" }),
    ).toThrow("URI");
    expect(() => adapter.initHttpServer({ httpsOptions: {} })).toThrow("HTTPS");
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
      app.useStaticAssets(staticDir, { prefix: "/assets" });
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
});
