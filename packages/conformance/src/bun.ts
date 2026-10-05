import { ExpressAdapter } from "@nestjs/platform-express";
import { BunHttpAdapter } from "nestjs-adapter-bun";
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
console.log(
  "native-bun: initialization, native server, listen failure, and close lifecycle passed.",
);
