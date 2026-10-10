import { ExpressAdapter } from "@nestjs/platform-express";
import { Module } from "@nestjs/common";
import { MessageBody, SubscribeMessage, WebSocketGateway } from "@nestjs/websockets";
import { BunHttpAdapter, BunWsAdapter } from "nestjs-adapter-bun";
import { NodeHttpAdapter } from "nestjs-adapter-node";
import { io as connect } from "socket.io-client";
import assert from "node:assert/strict";
import { NestFactory } from "@nestjs/core";
import { compareAdapters, startFixture } from "./compare.js";
import { checkLifecycle } from "./lifecycle.js";
import { FixtureModule } from "./fixture.js";

await compareAdapters(
  () => new BunHttpAdapter(),
  () => new ExpressAdapter(),
);

await checkLifecycle("native-bun", (options) => new BunHttpAdapter(options));

const adapter = new BunHttpAdapter();
const app = await NestFactory.create(FixtureModule, adapter, {
  logger: false,
  abortOnError: false,
});
try {
  await app.init();
  assert.equal(adapter.getHttpServer().address(), null);
  assert.equal((await adapter.fetch(new Request("http://localhost/api"))).status, 200);
  const multipart = new FormData();
  multipart.append("user[name]", "Ada");
  multipart.append("tags[]", "one");
  multipart.append("tags[]", "two");
  multipart.append("upload", new Blob(["hello"], { type: "text/plain" }), "hello.txt");
  const formResponse = await adapter.fetch(
    new Request("http://localhost/api/form", { method: "POST", body: multipart }),
  );
  assert.equal(formResponse.status, 201);
  const parsedForm = (await formResponse.json()) as {
    body: unknown;
    upload: { name: string; size: number; type: string };
  };
  assert.deepEqual(parsedForm.body, {
    user: { name: "Ada" },
    tags: ["one", "two"],
    upload: {},
  });
  assert.equal(parsedForm.upload.name, "hello.txt");
  assert.equal(parsedForm.upload.size, 5);
  assert.match(parsedForm.upload.type, /^text\/plain/);
  const sseResponse = await adapter.fetch(new Request("http://localhost/api/events"));
  assert.equal(sseResponse.status, 200);
  assert.equal(sseResponse.headers.get("content-type"), "text/event-stream");
  const sseBody = await sseResponse.text();
  assert.match(sseBody, /data: \{"index":0\}/);
  assert.match(sseBody, /data: \{"index":1\}/);
  await app.listen(0, "127.0.0.1");
  assert.ok(adapter.getHttpServer().native);
  const liveSseResponse = await fetch(`${await app.getUrl()}/api/events`);
  assert.equal(liveSseResponse.headers.get("content-type"), "text/event-stream");
  assert.match(await liveSseResponse.text(), /data: \{"index":1\}/);
  const second = await NestFactory.create(FixtureModule, new BunHttpAdapter(), { logger: false });
  try {
    await assert.rejects(second.listen(adapter.getHttpServer().address()!.port, "127.0.0.1"));
  } finally {
    await second.close();
  }
} finally {
  await app.close();
}
await app.close();
assert.equal(adapter.getHttpServer().address(), null);
const fresh = await startFixture(new BunHttpAdapter());
await fresh.close();

@WebSocketGateway({ path: "/ws" })
class EchoGateway {
  @SubscribeMessage("echo")
  echo(@MessageBody() data: unknown) {
    return { event: "echo", data };
  }
}
@Module({ imports: [FixtureModule], providers: [EchoGateway] })
class GatewayModule {}

const realtime = await NestFactory.create(GatewayModule, new BunHttpAdapter(), { logger: false });
realtime.useWebSocketAdapter(new BunWsAdapter(realtime));
try {
  await realtime.listen(0, "127.0.0.1");
  const base = await realtime.getUrl();
  const socket = new WebSocket(`${base.replace("http", "ws")}/ws`);
  const reply = await new Promise<string>((resolve, reject) => {
    socket.onopen = () => {
      socket.send("not json");
      socket.send(JSON.stringify({ event: "unknown" }));
      socket.send(JSON.stringify({ event: "echo", data: { n: 1 } }));
    };
    socket.onmessage = (event) => resolve(String(event.data));
    socket.onerror = () => reject(new Error("WebSocket connection failed"));
  });
  socket.close();
  assert.deepEqual(JSON.parse(reply), { event: "echo", data: { n: 1 } });
  assert.equal((await fetch(`${base}/api`)).status, 200);
  assert.equal((await fetch(`${base}/ws`)).status, 404);
} finally {
  await realtime.close();
}

@WebSocketGateway({ namespace: "chat" })
class ChatGateway {
  @SubscribeMessage("ping")
  ping(@MessageBody() data: unknown) {
    return { event: "pong", data };
  }
}
@Module({ imports: [FixtureModule], providers: [ChatGateway] })
class ChatModule {}

// Socket.IO needs a Node HTTP server, so on Bun.serve it must fail at startup, not silently.
const unsupported = await NestFactory.create(ChatModule, new BunHttpAdapter(), {
  logger: false,
  abortOnError: false,
});
await assert.rejects(unsupported.init(), /use NodeHttpAdapter/);

// The Node adapter under Bun is the supported way: Nest's default Socket.IO setup just works.
const chatApp = await NestFactory.create(ChatModule, new NodeHttpAdapter(), { logger: false });
try {
  await chatApp.listen(0, "127.0.0.1");
  const base = await chatApp.getUrl();
  for (const transports of [["polling", "websocket"], ["websocket"]]) {
    const socket = connect(`${base}/chat`, { transports, forceNew: true });
    try {
      const reply = await new Promise((resolve, reject) => {
        setTimeout(() => reject(new Error(`Socket.IO timed out (${transports.join()})`)), 5000);
        socket.on("connect_error", reject);
        socket.on("connect", () => socket.emit("ping", { n: 1 }));
        socket.on("pong", resolve);
      });
      assert.deepEqual(reply, { n: 1 });
    } finally {
      socket.close();
    }
  }
  assert.equal((await fetch(`${base}/socket.io/socket.io.js`)).status, 200);
  assert.equal((await fetch(`${base}/api`)).status, 200);
} finally {
  await chatApp.close();
}
console.log(
  "native-bun: initialization, native server, listen failure, WebSockets, Socket.IO, and close lifecycle passed.",
);
