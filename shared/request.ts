import { BadRequestException, PayloadTooLargeException } from "@nestjs/common";
import type { CookieSigner } from "@nestjs/core/helpers/cookies/cookie-signer.js";
import { parseCookieHeader } from "@nestjs/core/helpers/cookies/parse-cookie-header.js";

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
  /** The `Cookie` header, parsed on first access (no `cookie-parser` needed). */
  readonly cookies: Record<string, string>;
  /**
   * Cookies whose signature verifies against the `cookies.secret` application
   * option, unsigned. Throws when no secret is configured.
   */
  readonly signedCookies: Record<string, string>;
}

/** Shared lazy `cookies` / `signedCookies` getters for the request facades. */
export abstract class CookieRequest {
  abstract readonly headers: Record<string, string>;
  protected abstract readonly cookieSigner: CookieSigner | undefined;
  private parsedCookies?: Record<string, string>;
  private parsedSignedCookies?: Record<string, string>;

  get cookies(): Record<string, string> {
    return (this.parsedCookies ??= parseCookieHeader(this.headers.cookie));
  }
  get signedCookies(): Record<string, string> {
    if (this.parsedSignedCookies) return this.parsedSignedCookies;
    const signer = this.cookieSigner;
    if (!signer) {
      throw new Error(
        "Cannot read signed cookies: no cookie secret is configured. " +
          'Pass "cookies: { secret }" to NestFactory.create().',
      );
    }
    const signed = new NullObject<string>();
    const cookies = this.cookies;
    for (const name in cookies) {
      const value = signer.unsign(cookies[name]!);
      if (value !== undefined) signed[name] = value;
    }
    return (this.parsedSignedCookies = signed);
  }
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

// Bun's native `Headers#toJSON` is several times cheaper than iterating entries.
function headersObject(headers: Headers): Record<string, string> {
  const native = headers as Headers & { toJSON?: () => Record<string, string> };
  return native.toJSON ? native.toJSON() : Object.fromEntries(headers);
}

/** Request facade over a fetch `Request`; URL parts are sliced without a reparse. */
class FetchRequest extends CookieRequest implements NativeRequest {
  readonly method: string;
  readonly url: string;
  readonly originalUrl: string;
  readonly path: string;
  readonly hostname: string;
  readonly protocol: string;
  readonly headers: Record<string, string>;
  params = new NullObject<string | string[]>();
  query: Record<string, string | string[]>;
  body?: unknown;
  rawBody?: Buffer;

  constructor(
    readonly raw: Request,
    readonly ip: string | undefined,
    protected readonly cookieSigner: CookieSigner | undefined,
  ) {
    super();
    // `Request.url` is already an absolute, normalized URL; slicing avoids a reparse.
    const full = raw.url;
    const hostStart = full.indexOf("://") + 3;
    const pathStart = full.indexOf("/", hostStart);
    const url = pathStart === -1 ? "/" : full.slice(pathStart);
    const queryStart = url.indexOf("?");
    this.method = raw.method;
    this.url = url;
    this.originalUrl = url;
    this.path = queryStart === -1 ? url : url.slice(0, queryStart);
    this.hostname = full
      .slice(hostStart, pathStart === -1 ? undefined : pathStart)
      .replace(/^.*@|:\d*$/g, "");
    this.protocol = full.slice(0, hostStart - 3);
    this.headers = headersObject(raw.headers);
    this.query = queryStart === -1 ? new NullObject() : parseQuery(url.slice(queryStart + 1));
  }
}

export function createRequest(
  raw: Request,
  ip?: string,
  cookieSigner?: CookieSigner,
): NativeRequest {
  return new FetchRequest(raw, ip, cookieSigner);
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

export type BodyKind = "json" | "urlencoded" | "multipart" | "text" | "raw";

export function mediaType(contentType: string | undefined): string | undefined {
  return contentType?.split(";")[0]?.trim().toLowerCase();
}

/** What the built-in parser handles when no custom parser claimed the body. */
export function defaultBodyKind(type: string | undefined): BodyKind | undefined {
  if (type === "application/json" || type?.endsWith("+json")) return "json";
  if (type === "application/x-www-form-urlencoded") return "urlencoded";
  if (type === "multipart/form-data") return "multipart";
  return undefined;
}

export async function parseRequestBody(
  request: NativeRequest,
  kind: BodyKind,
  limit: number,
  rawBody: boolean,
  read: BodyReader,
): Promise<void> {
  const bytes = await read(request, limit);
  if (bytes === null) return;
  if (rawBody) request.rawBody = bytes;
  if (kind === "raw") {
    request.body = bytes;
    return;
  }
  if (kind === "text") {
    request.body = bytes.toString("utf8");
    return;
  }
  if (!bytes.length && kind !== "multipart") {
    request.body = {};
    return;
  }
  if (kind === "multipart") {
    try {
      const formData = await new Response(bytes as unknown as BodyInit, {
        headers: { "content-type": request.headers["content-type"]! },
      }).formData();
      request.body = nestedFormObject(formData.entries());
      return;
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException("Invalid multipart form data");
    }
  }
  const text = bytes.toString("utf8");
  if (kind === "urlencoded") {
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
