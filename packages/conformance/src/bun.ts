import { ExpressAdapter } from "@nestjs/platform-express";
import { Module } from "@nestjs/common";
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from "@nestjs/websockets";
import { BunHttpAdapter, BunWsAdapter } from "nestjs-adapter-bun";
import { BunIoAdapter } from "nestjs-adapter-bun/socket.io";
import { io as connect } from "socket.io-client";
import type { Server, Socket } from "socket.io";
import assert from "node:assert/strict";
import { NestFactory } from "@nestjs/core";
import { compareAdapters, startFixture } from "./compare.js";
import { FixtureModule } from "./fixture.js";

await compareAdapters(new BunHttpAdapter(), new ExpressAdapter());

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
  @WebSocketServer() server!: Server;
  @SubscribeMessage("joinRoom")
  join(@ConnectedSocket() client: Socket, @MessageBody() room: string) {
    void client.join(room);
    client.emit("joinedRoom", room);
  }
  @SubscribeMessage("chatToServer")
  chat(@MessageBody() payload: { room: string; message: string }) {
    this.server.to(payload.room).emit("chatToClient", payload);
  }
}
@Module({ imports: [FixtureModule], providers: [ChatGateway] })
class ChatModule {}

const chatApp = await NestFactory.create(ChatModule, new BunHttpAdapter(), { logger: false });
chatApp.useWebSocketAdapter(new BunIoAdapter(chatApp));
try {
  await chatApp.listen(0, "127.0.0.1");
  const base = await chatApp.getUrl();
  // Polling first, then upgrade to WebSocket: the default client behaviour.
  for (const transports of [["polling", "websocket"], ["websocket"], ["polling"]]) {
    const member = connect(`${base}/chat`, { transports, forceNew: true });
    const outsider = connect(`${base}/chat`, { transports, forceNew: true });
    try {
      let leaked = false;
      outsider.on("chatToClient", () => (leaked = true));
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`Socket.IO timed out (${transports.join()})`)),
          5000,
        );
        member.on("connect_error", reject);
        member.on("connect", () => member.emit("joinRoom", "general"));
        member.on("joinedRoom", () =>
          outsider.emit("chatToServer", { room: "general", message: "hi" }),
        );
        member.on("chatToClient", (payload: unknown) => {
          clearTimeout(timer);
          assert.deepEqual(payload, { room: "general", message: "hi" });
          resolve();
        });
      });
      assert.equal(leaked, false);
    } finally {
      member.close();
      outsider.close();
    }
  }
  assert.equal((await fetch(`${base}/api`)).status, 200);
  const client = await fetch(`${base}/socket.io/socket.io.js`);
  assert.equal(client.status, 200);
  assert.match(await client.text(), /Socket\.IO/);
  assert.equal((await fetch(`${base}/socket.io/package.json`)).status, 404);
} finally {
  await chatApp.close();
}
console.log(
  "native-bun: initialization, native server, listen failure, WebSockets, Socket.IO, and close lifecycle passed.",
);
