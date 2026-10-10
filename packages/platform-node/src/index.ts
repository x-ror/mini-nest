import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createSecureServer } from "node:https";
import { PassThrough, Readable, pipeline } from "node:stream";
import type { TLSSocket } from "node:tls";
import { PayloadTooLargeException, type NestApplicationOptions } from "@nestjs/common";
import {
  NativeHttpAdapter,
  NativeResponse,
  NullObject,
  hostnameOf,
  resolveProxy,
  parseQuery,
  type CookieWriter,
  type NativeRequest,
  type ResponseBody,
  type ProxyView,
  type TrustFunction,
} from "@shared";

export {
  AnyFilesInterceptor,
  FileFieldsInterceptor,
  FileInterceptor,
  FilesInterceptor,
  NativeResponse,
} from "@shared";

export type {
  CookieWriter,
  NativeAdapterOptions,
  NativeRequest,
  ResponseCookieOptions,
  StaticAssetsOptions,
  TrustProxy,
  UploadedFileData,
  ViewRenderer,
} from "@shared";

const EMPTY_BODY = Buffer.alloc(0);

/** Request facade read straight from `IncomingMessage`; costly fields are lazy. */
class NodeRequest implements NativeRequest {
  readonly method: string;
  url: string;
  originalUrl: string;
  path: string;
  params = new NullObject<string | string[]>();
  body?: unknown;
  rawBody?: Buffer;
  private search: string;
  private parsedQuery?: Record<string, string | string[]>;
  private webRequest?: Request;
  private proxyView?: ProxyView;

  constructor(
    readonly incoming: IncomingMessage,
    private readonly outgoing: ServerResponse,
    private readonly trust: TrustFunction | undefined,
  ) {
    this.method = incoming.method ?? "GET";
    let url = incoming.url ?? "/";
    if (url.charCodeAt(0) !== 47) {
      // Absolute-form and asterisk-form targets are rare; let URL sort them out.
      const parsed = new URL(url, "http://localhost");
      url = parsed.pathname + parsed.search;
    }
    const queryStart = url.indexOf("?");
    this.url = url;
    this.originalUrl = url;
    this.path = queryStart === -1 ? url : url.slice(0, queryStart);
    this.search = queryStart === -1 ? "" : url.slice(queryStart + 1);
  }

  get headers(): Record<string, string> {
    return this.incoming.headers as Record<string, string>;
  }
  get hostname(): string {
    const host = this.trust ? this.proxy().host : this.incoming.headers.host;
    return hostnameOf(this.trust ? host : (host ?? "localhost"))!;
  }
  get protocol(): string {
    if (this.trust) return this.proxy().protocol;
    return (this.incoming.socket as TLSSocket).encrypted ? "https" : "http";
  }
  get ip(): string | undefined {
    return this.trust ? this.proxy().ip : this.incoming.socket.remoteAddress;
  }
  get ips(): string[] {
    return this.trust ? this.proxy().ips : [];
  }
  /** Express's `trust proxy` view of this request, computed once (see `resolveProxy`). */
  private proxy(): ProxyView {
    const { headers, socket } = this.incoming;
    return (this.proxyView ??= resolveProxy(
      {
        socketAddress: socket.remoteAddress,
        protocol: (socket as TLSSocket).encrypted ? "https" : "http",
        host: headers.host ?? "localhost",
        forwardedFor: headers["x-forwarded-for"] as string | undefined,
        forwardedProto: headers["x-forwarded-proto"] as string | undefined,
        forwardedHost: headers["x-forwarded-host"] as string | undefined,
      },
      this.trust!,
    ));
  }
  get query(): Record<string, string | string[]> {
    return (this.parsedQuery ??= parseQuery(this.search));
  }
  set query(value: Record<string, string | string[]>) {
    this.parsedQuery = value;
  }
  /** Built on first access; the body is only attached if nothing has read it yet. */
  get raw(): Request {
    if (this.webRequest) return this.webRequest;
    const { incoming, outgoing, method } = this;
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        for (const entry of value) headers.append(name, entry);
      } else {
        headers.set(name, value);
      }
    }
    const controller = new AbortController();
    if (outgoing.destroyed && !outgoing.writableFinished) controller.abort();
    outgoing.once("close", () => {
      if (!outgoing.writableFinished) controller.abort();
    });
    const init: RequestInit & { duplex?: "half" } = {
      method,
      headers,
      signal: controller.signal,
    };
    if (method !== "GET" && method !== "HEAD" && !incoming.readableDidRead) {
      const body = new PassThrough();
      incoming.pipe(body);
      incoming.once("error", (error) => body.destroy(error));
      body.once("close", () => {
        incoming.unpipe(body);
        incoming.resume();
      });
      init.body = Readable.toWeb(body) as ReadableStream<Uint8Array>;
      init.duplex = "half";
    }
    return (this.webRequest = new Request(
      new URL(this.originalUrl, `${this.protocol}://${incoming.headers.host ?? "localhost"}`),
      init,
    ));
  }
}

/** Writes straight to `ServerResponse`, skipping the fetch `Response` round trip. */
class NodeResponse extends NativeResponse {
  constructor(
    method: string,
    private readonly outgoing: ServerResponse,
    cookies: CookieWriter,
    request: NativeRequest,
  ) {
    super(method, cookies, request);
  }
  override on(event: string, listener: (...args: any[]) => void): this {
    this.outgoing.on(event, listener);
    return this;
  }
  override once(event: string, listener: (...args: any[]) => void): this {
    this.outgoing.once(event, listener);
    return this;
  }
  protected override commit(body: ResponseBody): void {
    const outgoing = this.outgoing;
    if (outgoing.destroyed) {
      if (body instanceof Readable) body.destroy();
      return;
    }
    outgoing.writeHead(this.statusCode, this.headerValues);
    if (body instanceof Blob) body = Readable.fromWeb(body.stream() as never);
    if (body instanceof Readable) {
      pipeline(body, outgoing, (error) => {
        if (error && error.code !== "ERR_STREAM_PREMATURE_CLOSE")
          console.error("Node HTTP response stream failed", error);
      });
    } else if (body === null) {
      outgoing.end();
    } else {
      outgoing.end(body);
    }
  }
}

export class NodeHttpAdapter extends NativeHttpAdapter<Server> {
  private forceCloseConnections = false;

  initHttpServer(options: NestApplicationOptions): void {
    this.validateApplicationOptions(options);
    this.forceCloseConnections = options.forceCloseConnections ?? false;
    const listener = (incoming: IncomingMessage, outgoing: ServerResponse): void => {
      const request = new NodeRequest(incoming, outgoing, this.trust);
      this.dispatch(request, new NodeResponse(request.method, outgoing, this, request));
    };
    this.httpServer = options.httpsOptions
      ? createSecureServer(options.httpsOptions, listener)
      : createServer(listener);
  }

  protected override readBody(
    request: NativeRequest,
    limit: number,
  ): Promise<Buffer> | Buffer | null {
    if (!(request instanceof NodeRequest)) return super.readBody(request, limit);
    const incoming = request.incoming;
    const declared = incoming.headers["content-length"];
    if (declared === undefined && incoming.headers["transfer-encoding"] === undefined)
      return EMPTY_BODY;
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      const settle = (error?: unknown): void => {
        incoming.off("data", onData).off("end", onEnd).off("error", settle).off("close", onClose);
        if (error === undefined) {
          resolve(chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks, size));
        } else {
          // Drain what is left so the error response can still be delivered.
          incoming.resume();
          reject(error);
        }
      };
      const onData = (chunk: Buffer): void => {
        size += chunk.length;
        if (size > limit) settle(new PayloadTooLargeException());
        else chunks.push(chunk);
      };
      const onEnd = (): void => settle();
      const onClose = (): void => settle(new Error("Request body was aborted."));
      if (Number(declared) > limit) return settle(new PayloadTooLargeException());
      incoming.on("data", onData).on("end", onEnd).on("error", settle).on("close", onClose);
    });
  }

  listen(port: string | number, callback?: () => void): Server;
  listen(port: string | number, hostname: string, callback?: () => void): Server;
  listen(
    port: string | number,
    hostnameOrCallback?: string | (() => void),
    callback?: () => void,
  ): Server {
    const done = typeof hostnameOrCallback === "function" ? hostnameOrCallback : callback;
    if (typeof port === "string" && !/^\d+$/.test(port)) {
      if (typeof hostnameOrCallback === "string")
        throw new Error("A Unix socket cannot have a hostname.");
      return this.httpServer.listen({ path: port }, done);
    }
    return this.httpServer.listen(
      {
        port: Number(port),
        host: typeof hostnameOrCallback === "string" ? hostnameOrCallback : undefined,
      },
      done,
    );
  }
  async close(): Promise<void> {
    if (!this.httpServer?.listening) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => this.httpServer.closeAllConnections(),
        this.adapterOptions.shutdownTimeout ?? 5000,
      );
      timer.unref();
      this.httpServer.close((error) => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      });
      if (this.forceCloseConnections) this.httpServer.closeAllConnections();
    });
  }
  getType(): string {
    return "native-node";
  }
}
