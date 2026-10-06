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

// Prototype-free like new NullObject(), but stays a fast-mode V8 object:
// several times cheaper to fill, iterate and JSON.stringify.
export const NullObject = function () {} as unknown as new <T = unknown>() => Record<string, T>;
NullObject.prototype = Object.create(null);

function decodeQueryPart(text: string): string {
  if (!text.includes("%") && !text.includes("+")) return text;
  const spaced = text.replaceAll("+", " ");
  try {
    return decodeURIComponent(spaced);
  } catch {
    return spaced;
  }
}

// Repeated keys become arrays; keys without "=" get an empty string.
export function parseQuery(search: string): Record<string, string | string[]> {
  const result = new NullObject<string | string[]>();
  for (let start = 0; start < search.length;) {
    let end = search.indexOf("&", start);
    if (end === -1) end = search.length;
    if (end > start) {
      const equals = search.indexOf("=", start);
      const split = equals !== -1 && equals < end ? equals : end;
      const key = decodeQueryPart(search.slice(start, split));
      const value = split === end ? "" : decodeQueryPart(search.slice(split + 1, end));
      const previous = result[key];
      if (previous === undefined) result[key] = value;
      else if (typeof previous === "string") result[key] = [previous, value];
      else previous.push(value);
    }
    start = end + 1;
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
    const child = nextPart === "" || /^\d+$/.test(nextPart) ? [] : new NullObject();
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
          : new NullObject();
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
        : new NullObject();
  object[part] = child;
  assignFormValue(child, rest, value);
}

function nestedFormObject(
  entries: Iterable<[string, FormDataEntryValue]>,
): Record<string, unknown> {
  const result = new NullObject();
  for (const [key, value] of entries) assignFormValue(result, formFieldPath(key), value);
  return result;
}

export function createRequest(raw: Request, ip?: string): NativeRequest {
  // `Request.url` is already an absolute, normalized URL; slicing avoids a reparse.
  const full = raw.url;
  const hostStart = full.indexOf("://") + 3;
  const pathStart = full.indexOf("/", hostStart);
  const url = pathStart === -1 ? "/" : full.slice(pathStart);
  const queryStart = url.indexOf("?");
  return {
    raw,
    ip,
    method: raw.method,
    url,
    originalUrl: url,
    path: queryStart === -1 ? url : url.slice(0, queryStart),
    hostname: full
      .slice(hostStart, pathStart === -1 ? undefined : pathStart)
      .replace(/^.*@|:\d*$/g, ""),
    protocol: full.slice(0, hostStart - 3),
    headers: Object.fromEntries(raw.headers),
    params: new NullObject(),
    query: queryStart === -1 ? new NullObject() : parseQuery(url.slice(queryStart + 1)),
  };
}

export type BodyReader = (request: NativeRequest, limit: number) => Promise<Buffer> | Buffer | null;

export async function readWebBody(
  body: ReadableStream<Uint8Array>,
  limit: number,
): Promise<Buffer> {
  const reader = body.getReader();
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
  return Buffer.concat(chunks, size);
}

export function isParsedMethod(method: string): boolean {
  return method !== "GET" && method !== "HEAD";
}

export async function parseRequestBody(
  request: NativeRequest,
  limit: number,
  rawBody: boolean,
  read: BodyReader,
): Promise<void> {
  const contentType = request.headers["content-type"];
  const type = contentType?.split(";")[0]?.trim().toLowerCase();
  if (
    type !== "application/json" &&
    !type?.endsWith("+json") &&
    type !== "application/x-www-form-urlencoded" &&
    type !== "multipart/form-data"
  )
    return;
  const bytes = await read(request, limit);
  if (bytes === null) return;
  if (rawBody) request.rawBody = bytes;
  if (!bytes.length && type !== "multipart/form-data") {
    request.body = {};
    return;
  }
  if (type === "multipart/form-data") {
    try {
      const formData = await new Response(bytes as unknown as BodyInit, {
        headers: { "content-type": contentType! },
      }).formData();
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
