import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { RequestHandler } from "@mini-nest/common";

const MAX_BODY_BYTES = 1024 * 1024;

async function readBody(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
): Promise<Buffer<ArrayBuffer> | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of incoming) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      outgoing.writeHead(413, { "content-type": "application/json", connection: "close" });
      outgoing.end(JSON.stringify({ error: "Payload Too Large" }));
      return null;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function createRequest(incoming: IncomingMessage, body: Buffer<ArrayBuffer>): Request {
  const headers = new Headers();
  for (let i = 0; i < incoming.rawHeaders.length; i += 2) {
    headers.append(incoming.rawHeaders[i]!, incoming.rawHeaders[i + 1]!);
  }
  const method = incoming.method ?? "GET";
  // Use a fixed origin; routing must not depend on untrusted Host headers.
  const url = new URL(incoming.url ?? "/", "http://localhost");
  return new Request(url, {
    method,
    headers,
    body: ["GET", "HEAD"].includes(method) ? undefined : body,
  });
}

async function writeResponse(
  outgoing: ServerResponse,
  response: Response,
  method: string,
): Promise<void> {
  outgoing.statusCode = response.status;
  response.headers.forEach((value, name) => {
    if (name !== "set-cookie") outgoing.setHeader(name, value);
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length) outgoing.setHeader("set-cookie", cookies);
  outgoing.end(method === "HEAD" ? undefined : Buffer.from(await response.arrayBuffer()));
}

async function dispatch(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  handler: RequestHandler,
): Promise<void> {
  const body = await readBody(incoming, outgoing);
  if (body === null) return;

  const request = createRequest(incoming, body);
  const response = await handler(request);
  await writeResponse(outgoing, response, request.method);
}

function handleTransportError(outgoing: ServerResponse, error: unknown): void {
  console.error("HTTP transport failed", error);
  if (outgoing.headersSent) {
    outgoing.destroy();
    return;
  }
  outgoing.writeHead(500, { "content-type": "application/json" });
  outgoing.end(JSON.stringify({ error: "Internal Server Error" }));
}

export function createHttpServer(handler: RequestHandler) {
  return createServer((incoming, outgoing) => {
    void dispatch(incoming, outgoing, handler).catch((error: unknown) =>
      handleTransportError(outgoing, error),
    );
  });
}
