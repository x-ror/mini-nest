import { Readable } from "node:stream";
import { PassThrough } from "node:stream";
import { STATUS_CODES } from "node:http";
import { StreamableFile, type CookieSerializeOptions } from "@nestjs/common";
import { AbstractHttpAdapter } from "@nestjs/core";
import { CookieSigner } from "@nestjs/core/helpers/cookies/cookie-signer.js";
import { NullObject, type NativeRequest } from "./request.js";

class NativeSseResponse extends PassThrough {
  statusCode = 200;

  constructor(private readonly commit: (statusCode: number, headers?: OutgoingHeaders) => void) {
    super();
  }

  writeHead(statusCode: number, headers?: OutgoingHeaders): this {
    this.statusCode = statusCode;
    this.commit(statusCode, headers);
    return this;
  }

  flushHeaders(): void {
    this.commit(this.statusCode);
  }
}

type OutgoingHeaders = Record<string, number | string | readonly string[]>;
export type ResponseBody = string | Uint8Array | Readable | Blob | null;
/** Express `res.cookie()` options: `maxAge` is in **milliseconds** here. */
export interface ResponseCookieOptions extends Omit<
  CookieSerializeOptions,
  "maxAge" | "expires" | "domain" | "priority" | "sameSite" | "path"
> {
  /** Lifetime in milliseconds, as in Express; also sets `Expires`. `null` is ignored. */
  maxAge?: number | string | null;
  expires?: Date | null;
  domain?: string | null;
  /** A falsy path sends an empty `Path=`, which browsers treat like no Path (Express omits it). */
  path?: string | false | null;
  priority?: CookieSerializeOptions["priority"] | null;
  /** `true` means `strict`, as in Express; `false` omits the attribute. */
  sameSite?: CookieSerializeOptions["sameSite"] | boolean | null;
  /** Express's custom value encoder is not supported and throws. */
  encode?: never;
}

/** Writes `Set-Cookie` headers; the adapter (Nest's `setCookie()`) in practice. */
export interface CookieWriter {
  setCookie(
    response: NativeResponse,
    name: string,
    value: string,
    options?: CookieSerializeOptions,
  ): unknown;
}

/**
 * For responses created outside an adapter: Nest's own `setCookie()` with no
 * signer, so serialization rules and error messages are exactly Nest's.
 */
const detachedCookieWriter: CookieWriter = {
  setCookie: (response, name, value, options) =>
    AbstractHttpAdapter.prototype.setCookie.call(
      {
        appendHeader: (target: NativeResponse, header: string, text: string) =>
          target.appendHeader(header, text),
      },
      response,
      name,
      value,
      options,
    ),
};

export class NativeResponse {
  statusCode = 200;
  headersSent = false;
  // Lowercase header names; multiple values are kept as arrays.
  protected readonly headerValues = new NullObject<string | string[]>();
  private sse?: NativeSseResponse;
  private streaming = false;
  private response?: Response;
  private pending?: Promise<Response>;
  private complete?: (response: Response) => void;

  // True private fields: the adapter (and its cookie secret) and the request
  // never show up when a response is logged, inspected or serialized.
  readonly #cookies: CookieWriter;
  readonly #request: NativeRequest | undefined;

  constructor(
    protected readonly method: string,
    cookies: CookieWriter = detachedCookieWriter,
    request?: NativeRequest,
  ) {
    this.#cookies = cookies;
    this.#request = request;
  }

  /** The fetch `Response`; only meaningful for the fetch transport. */
  get done(): Promise<Response> {
    return (this.pending ??= this.response
      ? Promise.resolve(this.response)
      : new Promise((resolve) => {
          this.complete = resolve;
        }));
  }
  /** Node-style writable behind `write()` and Nest's `@Sse()` support. */
  get raw(): NativeSseResponse {
    return (this.sse ??= new NativeSseResponse((statusCode, headers) => {
      if (this.headersSent) return;
      this.status(statusCode);
      if (headers) {
        for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
      }
      this.finish(this.sse!);
    }));
  }

  status(code: number): this {
    this.statusCode = code;
    return this;
  }
  setHeader(name: string, value: string | number | readonly string[]): this {
    this.headerValues[name.toLowerCase()] =
      typeof value === "string" ? value : Array.isArray(value) ? value.map(String) : String(value);
    return this;
  }
  header(name: string, value: string): this {
    return this.setHeader(name, value);
  }
  getHeader(name: string): string | string[] | undefined {
    const key = name.toLowerCase();
    const value = this.headerValues[key];
    if (key === "set-cookie") return value === undefined ? [] : ([] as string[]).concat(value);
    return Array.isArray(value) ? value.join(", ") : value;
  }
  hasHeader(name: string): boolean {
    return this.headerValues[name.toLowerCase()] !== undefined;
  }
  removeHeader(name: string): void {
    delete this.headerValues[name.toLowerCase()];
  }
  getHeaders(): Record<string, string | string[]> {
    return { ...this.headerValues };
  }
  appendHeader(name: string, value: string): this {
    const key = name.toLowerCase();
    const previous = this.headerValues[key];
    this.headerValues[key] =
      previous === undefined ? value : ([] as string[]).concat(previous, value);
    return this;
  }
  /**
   * Adds fields to `Vary` like the `vary` package that Express and `cors` use:
   * case-insensitive de-duplication, and `*` absorbs everything. Unlike
   * `vary`, empty entries in a comma-separated field are skipped, not rejected.
   */
  vary(field: string | readonly string[]): this {
    const fields = typeof field === "string" ? parseVary(field) : [...field];
    for (const entry of fields) {
      if (!HEADER_NAME.test(entry)) throw new TypeError(`Invalid Vary field name: ${entry}`);
    }
    const current = this.headerValues.vary;
    const header = current === undefined ? "" : ([] as string[]).concat(current).join(", ");
    if (header === "*") return this;
    const present = parseVary(header.toLowerCase());
    if (fields.includes("*") || present.includes("*")) {
      this.headerValues.vary = "*";
      return this;
    }
    let value = header;
    for (const entry of fields) {
      const lower = entry.toLowerCase();
      if (present.includes(lower)) continue;
      present.push(lower);
      value = value ? `${value}, ${entry}` : entry;
    }
    if (value) this.headerValues.vary = value;
    return this;
  }
  /**
   * Express's `res.cookie()`: objects become `j:` JSON, other values are
   * stringified, `maxAge` is in milliseconds (and also sets `Expires`), and
   * `null`/`false` attributes are left out. `signed: true` uses the secret
   * `cookie-parser` put on the request, as Express does, and otherwise the
   * `cookies.secret` application option. Serialization goes through Nest's
   * `setCookie()`, which rejects invalid names, values and attributes.
   */
  cookie(
    name: string,
    value: string | number | boolean | bigint | object | null | undefined,
    options: ResponseCookieOptions = {},
  ): this {
    // Own properties only, like Express's `{ ...options }`.
    const { maxAge, expires, domain, path, priority, sameSite, encode, ...rest } = { ...options };
    if (encode !== undefined) {
      throw new TypeError(`Cookie "${name}": the "encode" option is not supported.`);
    }
    const attributes: CookieSerializeOptions = rest;
    // Express omits Path for a falsy path; an empty `Path=` means the same to
    // browsers (RFC 6265 5.2.4), and Nest's serializer always writes Path.
    if (path != null) attributes.path = path ? String(path) : "";
    if (domain) attributes.domain = String(domain);
    if (expires) attributes.expires = expires;
    if (priority) attributes.priority = priority;
    if (sameSite) attributes.sameSite = sameSite === true ? "strict" : sameSite;
    if (maxAge != null) {
      const milliseconds = Number(maxAge);
      // Like Express, a non-numeric maxAge is passed on and rejected by the serializer.
      if (Number.isNaN(milliseconds)) attributes.maxAge = milliseconds;
      else {
        attributes.expires = new Date(Date.now() + milliseconds);
        attributes.maxAge = Math.floor(milliseconds / 1000);
      }
    }
    let text = typeof value === "object" ? `j:${JSON.stringify(value)}` : String(value);
    const parserSecret = this.#request?.secret;
    if (attributes.signed && typeof parserSecret === "string" && parserSecret) {
      text = new CookieSigner(parserSecret).sign(text);
      attributes.signed = false;
    }
    this.#cookies.setCookie(this, name, text, attributes);
    return this;
  }
  /**
   * Express's `res.clearCookie()`: sends the cookie with an empty value and an
   * expired date. `path` and `domain` must match the ones it was set with.
   */
  clearCookie(name: string, options: ResponseCookieOptions = {}): this {
    return this.cookie(name, "", { ...options, maxAge: undefined, expires: new Date(1) });
  }
  json(value: unknown): this {
    const text = JSON.stringify(value);
    this.headerValues["content-type"] ??= "application/json; charset=utf-8";
    return this.finish(text ?? null);
  }
  send(value?: unknown): this {
    const headers = this.headerValues;
    if (value instanceof StreamableFile) {
      const metadata = value.getHeaders();
      headers["content-type"] ??= metadata.type;
      if (metadata.disposition) this.setHeader("content-disposition", metadata.disposition);
      if (metadata.length !== undefined) headers["content-length"] = String(metadata.length);
      return this.finish(value.getStream());
    }
    // A Blob (e.g. from fs.openAsBlob) keeps its size, so Bun can send Content-Length.
    if (value instanceof Blob) {
      headers["content-type"] ??= value.type || "application/octet-stream";
      headers["content-length"] ??= String(value.size);
      return this.finish(value);
    }
    if (value instanceof Uint8Array) {
      headers["content-type"] ??= "application/octet-stream";
      return this.finish(value);
    }
    if (value !== null && typeof value === "object") return this.json(value);
    if (value === undefined || value === null) return this.end();
    headers["content-type"] ??= "text/html; charset=utf-8";
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      typeof value === "bigint"
    )
      return this.end(String(value));
    throw new TypeError("Unsupported response body type.");
  }
  redirect(statusOrUrl: number | string, url?: string): this {
    this.statusCode = typeof statusOrUrl === "number" ? statusOrUrl : 302;
    const location = typeof statusOrUrl === "string" ? statusOrUrl : (url ?? "/");
    this.headerValues.location = location;
    this.headerValues["content-type"] = "text/plain; charset=utf-8";
    return this.end(`${STATUS_CODES[this.statusCode] ?? "Redirect"}. Redirecting to ${location}`);
  }
  end(message?: string | Uint8Array): this {
    if (this.streaming) {
      this.raw.end(message);
      return this;
    }
    return this.finish(message ?? null);
  }
  /** Starts a streamed response with the current status and headers on first use. */
  write(chunk: string | Uint8Array): boolean {
    if (!this.streaming) this.finish(this.raw);
    return this.raw.write(chunk);
  }
  on(_event: string, _listener: (...args: any[]) => void): this {
    throw new Error("Response events are only available on the Node adapter.");
  }
  once(event: string, listener: (...args: any[]) => void): this {
    return this.on(event, listener);
  }

  /** Sends the response; the default produces a fetch `Response` for `done`. */
  protected commit(body: ResponseBody): void {
    const headers = new Headers();
    for (const name in this.headerValues) {
      const value = this.headerValues[name]!;
      if (typeof value === "string") headers.set(name, value);
      else for (const entry of value) headers.append(name, entry);
    }
    this.response = new Response(
      body instanceof Readable ? (Readable.toWeb(body) as unknown as BodyInit) : (body as BodyInit),
      { status: this.statusCode, headers },
    );
    this.complete?.(this.response);
  }

  private finish(body: ResponseBody): this {
    if (this.headersSent) throw new Error("Response was already sent.");
    const status = this.statusCode;
    const headers = this.headerValues;
    const streamed = body !== null && body === this.sse;
    if (status === 204 || status === 304) {
      delete headers["content-type"];
      delete headers["content-length"];
      delete headers["transfer-encoding"];
    }
    if (this.method === "HEAD" || status === 204 || status === 205 || status === 304) {
      // Nothing will read the stream: release a file, or discard direct writes.
      if (body === this.sse) this.sse?.resume();
      else if (body instanceof Readable) body.destroy();
      body = null;
    } else if (body !== null && headers["content-length"] === undefined) {
      if (typeof body === "string") headers["content-length"] = String(Buffer.byteLength(body));
      else if (body instanceof Uint8Array) headers["content-length"] = String(body.byteLength);
    }
    try {
      this.commit(body);
    } catch (error) {
      // Typically an invalid header: drop them all so an error response can be sent.
      for (const name in headers) delete headers[name];
      throw error;
    }
    this.headersSent = true;
    this.streaming = streamed;
    return this;
  }
}

/** RFC 9110 field-name token, as checked by the `vary` package. */
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** Comma-separated header fields, trimmed, without empty entries. */
function parseVary(header: string): string[] {
  const fields: string[] = [];
  for (const part of header.split(",")) {
    const field = part.trim();
    if (field) fields.push(field);
  }
  return fields;
}
