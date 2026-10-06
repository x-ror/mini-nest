import { Readable } from "node:stream";
import { PassThrough } from "node:stream";
import { STATUS_CODES } from "node:http";
import { StreamableFile } from "@nestjs/common";
import { NullObject } from "./request.js";

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
export type ResponseBody = string | Uint8Array | Readable | null;

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

  constructor(protected readonly method: string) {}

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
