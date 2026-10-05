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
    result[key] =
      previous === undefined
        ? value
        : Array.isArray(previous)
          ? [...previous, value]
          : [previous, value];
  }
  return result;
}

function formFieldPath(key: string): string[] {
  const rootEnd = key.indexOf("[");
  const root = rootEnd === -1 ? key : key.slice(0, rootEnd);
  if (!root) throw new BadRequestException("Invalid form field name");
  const path = [root];
  let offset = root.length;
  while (offset < key.length) {
    if (key[offset] !== "[") throw new BadRequestException("Invalid form field name");
    const end = key.indexOf("]", offset + 1);
    if (end === -1) throw new BadRequestException("Invalid form field name");
    path.push(key.slice(offset + 1, end));
    offset = end + 1;
  }
  if (path.some((part) => ["__proto__", "prototype", "constructor"].includes(part))) {
    throw new BadRequestException("Invalid form field name");
  }
  return path;
}

function assignFormValue(target: unknown, path: string[], value: FormDataEntryValue): void {
  const [part, ...rest] = path;
  if (part === undefined) return;
  const isArray = Array.isArray(target);
  if (part === "") {
    if (!isArray) throw new BadRequestException("Conflicting form field names");
    if (!rest.length) {
      target.push(value);
      return;
    }
    const nextPart = rest[0]!;
    const child = nextPart === "" || /^\d+$/.test(nextPart) ? [] : Object.create(null);
    target.push(child);
    assignFormValue(child, rest, value);
    return;
  }
  if (isArray) {
    if (!/^\d+$/.test(part) || Number(part) > 10_000)
      throw new BadRequestException("Invalid form array index");
    const index = Number(part);
    if (!rest.length) {
      const existing = target[index];
      if (existing === undefined) target[index] = value;
      else if (Array.isArray(existing)) existing.push(value);
      else target[index] = [existing, value];
      return;
    }
    const nextPart = rest[0]!;
    const existing = target[index];
    const child =
      existing && typeof existing === "object"
        ? existing
        : nextPart === "" || /^\d+$/.test(nextPart)
          ? []
          : Object.create(null);
    target[index] = child;
    assignFormValue(child, rest, value);
    return;
  }
  if (target === null || typeof target !== "object")
    throw new BadRequestException("Conflicting form field names");
  const object = target as Record<string, unknown>;
  if (!rest.length) {
    const existing = object[part];
    if (existing === undefined) object[part] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else object[part] = [existing, value];
    return;
  }
  const nextPart = rest[0]!;
  const existing = object[part];
  const child =
    existing && typeof existing === "object"
      ? existing
      : nextPart === "" || /^\d+$/.test(nextPart)
        ? []
        : Object.create(null);
  object[part] = child;
  assignFormValue(child, rest, value);
}

function nestedFormObject(
  entries: Iterable<[string, FormDataEntryValue]>,
): Record<string, unknown> {
  const result: Record<string, unknown> = Object.create(null);
  for (const [key, value] of entries) assignFormValue(result, formFieldPath(key), value);
  return result;
}

export function createRequest(raw: Request, ip?: string): NativeRequest {
  const url = new URL(raw.url);
  return {
    raw,
    ip,
    method: raw.method,
    url: `${url.pathname}${url.search}`,
    originalUrl: `${url.pathname}${url.search}`,
    path: url.pathname,
    hostname: url.hostname,
    protocol: url.protocol.slice(0, -1),
    headers: Object.fromEntries(raw.headers),
    params: Object.create(null),
    query: queryObject(url.searchParams),
  };
}

export async function parseRequestBody(
  request: NativeRequest,
  limit: number,
  rawBody: boolean,
): Promise<void> {
  if (request.method === "GET" || request.method === "HEAD" || !request.raw.body) return;
  const type = request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase();
  if (
    type !== "application/json" &&
    !type?.endsWith("+json") &&
    type !== "application/x-www-form-urlencoded" &&
    type !== "multipart/form-data"
  )
    return;
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
  if (!size && type !== "multipart/form-data") {
    request.body = {};
    return;
  }
  if (type === "multipart/form-data") {
    try {
      const formRequest = new Request(request.raw.url, {
        method: request.method,
        headers: request.raw.headers,
        body: bytes,
      });
      const formData = await formRequest.formData();
      request.body = nestedFormObject(formData.entries());
      return;
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException("Invalid multipart form data");
    }
  }
  const text = bytes.toString("utf8");
  if (type === "application/x-www-form-urlencoded") {
    request.body = nestedFormObject(new URLSearchParams(text));
    return;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object")
      throw new SyntaxError("JSON body must be an object or array");
    request.body = parsed;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new BadRequestException("Invalid JSON request body");
  }
}
