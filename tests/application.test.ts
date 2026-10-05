import { describe, it, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import {
  Body,
  Controller,
  Get,
  Head,
  HttpCode,
  Inject,
  Injectable,
  Module,
  Param,
  Post,
  Query,
  Req,
} from "@mini-nest/common";
import { Application, NestFactory, type RequestContext } from "@mini-nest/core";
import { NodeAdapter } from "@mini-nest/platform-node";

@Injectable()
class CounterService {
  calls = 0;
}

@Module({ providers: [CounterService], exports: [CounterService] })
class CounterModule {}

@Controller("api")
class TestController {
  constructor(@Inject(CounterService) readonly counter: CounterService) {}

  @Get("hello")
  hello(@Query("q") query: string | undefined) {
    return { calls: ++this.counter.calls, query };
  }

  @Post("echo")
  echo(@Body() body: unknown) {
    return body;
  }

  @Post("selected")
  @HttpCode(202)
  selected(@Body("message") message: unknown, @Req() request: Request) {
    return { message, method: request.method };
  }

  @Get("items/:id")
  item(@Param("id") id: string, @Query() query: Record<string, string>) {
    return { id, query };
  }

  @Get("items/current")
  current() {
    return { current: true };
  }

  @Head("hello")
  head() {
    return "body omitted";
  }

  @Get("failure")
  fail() {
    throw new Error("private detail");
  }

  @Get("serialization")
  unserializable() {
    return 1n;
  }

  @Get("empty")
  empty() {}

  @Get("text")
  text() {
    return "hello";
  }

  @Post("no-content")
  @HttpCode(204)
  noContent() {
    return { ignored: true };
  }
}

@Module({ imports: [CounterModule], controllers: [TestController] })
class AppModule {}

const request = (path: string, init?: RequestInit) => new Request(`http://localhost${path}`, init);
const jsonRequest = (path: string, body: unknown) =>
  request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("Application", () => {
  it("constructs controllers, resolves exported singleton providers and preserves state", async () => {
    const app = await NestFactory.create(AppModule);
    assert.deepEqual(await (await app.fetch(request("/api/hello/?q=world"))).json(), {
      calls: 1,
      query: "world",
    });
    assert.deepEqual(await (await app.fetch(request("/api//hello?q=again"))).json(), {
      calls: 2,
      query: "again",
    });
  });

  it("awaits handlers and parses JSON values with Nest's default POST status", async () => {
    const app = await NestFactory.create(AppModule);
    for (const body of [{ hello: "world" }, null, [1, 2], false, 42, "text"]) {
      const response = await app.fetch(jsonRequest("/api/echo", body));
      assert.equal(response.status, 201);
      // String return values are text, not JSON.
      if (typeof body === "string") assert.equal(await response.text(), body);
      else assert.deepEqual(await response.json(), body);
    }
    const response = await app.fetch(jsonRequest("/api/selected", { message: "hi" }));
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { message: "hi", method: "POST" });
  });

  it("rejects malformed JSON but accepts empty bodies", async () => {
    const app = await NestFactory.create(AppModule);
    const invalid = await app.fetch(
      request("/api/echo", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      }),
    );
    assert.equal(invalid.status, 400);
    const empty = await app.fetch(request("/api/echo", { method: "POST" }));
    assert.equal(empty.status, 201);
    assert.equal(await empty.text(), "");
  });

  it("extracts route parameters, prioritizes static routes and applies global prefixes", async () => {
    const app = await NestFactory.create(AppModule);
    app.setGlobalPrefix("v1");
    assert.deepEqual(await (await app.fetch(request("/v1/api/items/a%20b?q=ok"))).json(), {
      id: "a b",
      query: { q: "ok" },
    });
    assert.deepEqual(await (await app.fetch(request("/v1/api/items/current"))).json(), {
      current: true,
    });
    assert.equal((await app.fetch(request("/v1/api/items/%XX"))).status, 400);
    assert.equal((await app.fetch(request("/api/hello"))).status, 404);
  });

  it("returns 404 for missing routes and wrong methods", async () => {
    const app = await NestFactory.create(AppModule);
    for (const req of [
      request("/missing"),
      request("/api/hello", { method: "POST" }),
      request("/api/echo"),
    ]) {
      assert.equal((await app.fetch(req)).status, 404);
    }
  });

  it("logs handler and serialization errors without exposing details", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const app = await NestFactory.create(AppModule);
      for (const path of ["/api/failure", "/api/serialization"]) {
        const response = await app.fetch(request(path));
        assert.equal(response.status, 500);
        assert.deepEqual(await response.json(), { error: "Internal Server Error" });
      }
      assert.equal(log.mock.calls.length, 2);
    } finally {
      log.mockRestore();
    }
  });

  it("handles text, empty, HEAD and 204 responses", async () => {
    const app = await NestFactory.create(AppModule);
    assert.equal(await (await app.fetch(request("/api/text"))).text(), "hello");
    assert.equal(await (await app.fetch(request("/api/empty"))).text(), "");
    assert.equal(await (await app.fetch(request("/api/hello", { method: "HEAD" }))).text(), "");
    const response = await app.fetch(jsonRequest("/api/no-content", {}));
    assert.equal(response.status, 204);
    assert.equal(await response.text(), "");
  });

  it("keeps manually registered RequestContext handlers usable", async () => {
    @Controller()
    class Manual {
      @Get()
      handler({ request }: RequestContext) {
        return { method: request.method };
      }
    }
    const app = new Application().register(new Manual());
    assert.deepEqual(await (await app.fetch(request("/"))).json(), { method: "GET" });
    assert.throws(() => app.register(new Manual()), /Duplicate route/);
    assert.throws(() => app.register({}), /@Controller/);
  });

  it("requires an adapter to listen, but not to handle requests", async () => {
    const app = await NestFactory.create(AppModule);
    await assert.rejects(app.listen(0), /requires an HTTP adapter/);
    assert.throws(() => app.getHttpServer(), /requires an HTTP adapter/);
    await app.close();
  });

  it("serves actual HTTP through NodeAdapter, enforces body limits and can restart", async () => {
    const app = await NestFactory.create(AppModule, new NodeAdapter());
    const server = await app.listen(0, "127.0.0.1");
    try {
      assert.equal(app.getHttpServer(), server);
      await assert.rejects(app.listen(0), /already listening/);
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const base = `http://127.0.0.1:${address.port}`;
      const response = await fetch(`${base}/api/echo`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"live":true}',
      });
      assert.equal(response.status, 201);
      assert.deepEqual(await response.json(), { live: true });
      const large = await fetch(`${base}/api/echo`, {
        method: "POST",
        body: "x".repeat(1024 * 1024 + 1),
      });
      assert.equal(large.status, 413);
    } finally {
      await app.close();
    }
    assert.throws(() => app.getHttpServer(), /not listening/);
    await app.listen(0, "127.0.0.1");
    await app.close();
  });
});
