import { Readable } from "node:stream";
import { PassThrough } from "node:stream";
import { STATUS_CODES } from "node:http";
import { StreamableFile } from "@nestjs/common";

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

export class NativeResponse {
  statusCode = 200;
  readonly headers = new Headers();
  headersSent = false;
  readonly done: Promise<Response>;
  readonly raw: NativeSseResponse;
  private complete!: (response: Response) => void;

  constructor(private readonly method: string) {
    this.done = new Promise((resolve) => {
      this.complete = resolve;
    });
    this.raw = new NativeSseResponse((statusCode, headers) => {
      if (this.headersSent) return;
      this.status(statusCode);
      if (headers) {
        for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
      }
      const body =
        this.method === "HEAD" || [204, 205, 304].includes(statusCode)
          ? null
          : (Readable.toWeb(this.raw) as unknown as BodyInit);
      this.finish(body);
    });
  }

  status(code: number): this {
    this.statusCode = code;
    return this;
  }
  setHeader(name: string, value: string | number | readonly string[]): this {
    this.headers.delete(name);
    for (const entry of Array.isArray(value) ? value : [value])
      this.headers.append(name, String(entry));
    return this;
  }
  header(name: string, value: string): this {
    return this.setHeader(name, value);
  }
  getHeader(name: string): string | string[] | undefined {
    return name.toLowerCase() === "set-cookie"
      ? this.headers.getSetCookie()
      : (this.headers.get(name) ?? undefined);
  }
  getHeaders(): Record<string, string | string[]> {
    const result: Record<string, string | string[]> = {};
    this.headers.forEach((value, name) => {
      result[name] = value;
    });
    const cookies = this.headers.getSetCookie();
    if (cookies.length) result["set-cookie"] = cookies;
    return result;
  }
  appendHeader(name: string, value: string): this {
    this.headers.append(name, value);
    return this;
  }
  json(value: unknown): this {
    const text = JSON.stringify(value);
    if (!this.headers.has("content-type"))
      this.headers.set("content-type", "application/json; charset=utf-8");
    return this.end(text);
  }
  send(value?: unknown): this {
    if (value instanceof StreamableFile) {
      const metadata = value.getHeaders();
      if (!this.headers.has("content-type")) this.headers.set("content-type", metadata.type);
      if (metadata.disposition) this.setHeader("content-disposition", metadata.disposition);
      if (metadata.length !== undefined)
        this.headers.set("content-length", String(metadata.length));
      return this.finish(
        Readable.toWeb(value.getStream()) as unknown as ReadableStream<Uint8Array>,
      );
    }
    if (value instanceof Uint8Array) {
      if (!this.headers.has("content-type"))
        this.headers.set("content-type", "application/octet-stream");
      return this.finish(new Uint8Array(value));
    }
    if (value !== null && typeof value === "object") return this.json(value);
    if (value === undefined || value === null) return this.end();
    if (!this.headers.has("content-type"))
      this.headers.set("content-type", "text/html; charset=utf-8");
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
    this.headers.set("location", typeof statusOrUrl === "string" ? statusOrUrl : (url ?? "/"));
    this.headers.set("content-type", "text/plain; charset=utf-8");
    return this.end(
      `${STATUS_CODES[this.statusCode] ?? "Redirect"}. Redirecting to ${this.headers.get("location")}`,
    );
  }
  end(message?: string): this {
    return this.finish(message ?? null);
  }
  write(): never {
    throw new Error("Direct response writes are not supported; use Nest's @Sse() decorator.");
  }
  on(): never {
    throw new Error("Node response events are not supported by the fetch response facade.");
  }

  private finish(body: BodyInit | null): this {
    if (this.headersSent) throw new Error("Response was already sent.");
    if (this.statusCode === 204 || this.statusCode === 304) {
      this.headers.delete("content-type");
      this.headers.delete("content-length");
      this.headers.delete("transfer-encoding");
    }
    const omit = this.method === "HEAD" || [204, 205, 304].includes(this.statusCode);
    const response = new Response(omit ? null : body, {
      status: this.statusCode,
      headers: this.headers,
    });
    this.headersSent = true;
    this.complete(response);
    return this;
  }
}
