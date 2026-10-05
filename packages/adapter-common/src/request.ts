import { BadRequestException, PayloadTooLargeException } from "@nestjs/common";

export interface NativeRequest {
  raw: Request;
  method: string;
  url: string;
  originalUrl: string;
  path: string;
  hostname: string;
  protocol: string;
  ip?: string;
  headers: Record<string, string>;
  params: Record<string, string | string[]>;
  query: Record<string, string | string[]>;
  body?: unknown;
  rawBody?: Buffer;
}

function queryObject(values: URLSearchParams): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = Object.create(null);
  for (const [key, value] of values) {
    const previous = result[key];
    result[key] = previous === undefined ? value :
      Array.isArray(previous) ? [...previous, value] : [previous, value];
  }
  return result;
}

export function createRequest(raw: Request, ip?: string): NativeRequest {
  const url = new URL(raw.url);
  return {
    raw, ip, method: raw.method, url: `${url.pathname}${url.search}`,
    originalUrl: `${url.pathname}${url.search}`, path: url.pathname, hostname: url.hostname,
    protocol: url.protocol.slice(0, -1), headers: Object.fromEntries(raw.headers),
    params: Object.create(null), query: queryObject(url.searchParams),
  };
}

export async function parseRequestBody(request: NativeRequest, limit: number, rawBody: boolean): Promise<void> {
  if (request.method === "GET" || request.method === "HEAD" || !request.raw.body) return;
  const type = request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase();
  if (type !== "application/json" && !type?.endsWith("+json") &&
    type !== "application/x-www-form-urlencoded") return;
  const reader = request.raw.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new PayloadTooLargeException();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = Buffer.concat(chunks);
  if (rawBody) request.rawBody = bytes;
  if (!size) { request.body = {}; return; }
  const text = bytes.toString("utf8");
  if (type === "application/x-www-form-urlencoded") {
    request.body = queryObject(new URLSearchParams(text));
    return;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object") throw new SyntaxError("JSON body must be an object or array");
    request.body = parsed;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new BadRequestException("Invalid JSON request body");
  }
}
