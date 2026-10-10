import { EventEmitter } from "node:events";
import type { AddressInfo } from "node:net";
import {
  PayloadTooLargeException,
  type NestApplicationOptions,
  type WebSocketAdapter,
} from "@nestjs/common";
import { NativeHttpAdapter, type NativeRequest } from "@shared";

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

const OWNER = Symbol("socketTransport");
type AnySocket = Bun.ServerWebSocket<any>;

/**
 * A WebSocket integration that shares the adapter's `Bun.serve` instance, such
 * as `BunWsAdapter`.
 */
export interface BunSocketTransport {
  /**
   * Answers or upgrades (through `server.upgrade`) a request it owns. Returning
   * `null` leaves the request to the next transport and then to HTTP routing.
   */
  handle(
    request: Request,
    pathname: string,
    server: {
      upgrade(request: Request, options?: { headers?: HeadersInit; data?: object }): boolean;
    },
  ): Response | undefined | null | Promise<Response | undefined>;
  websocket: {
    open?(socket: AnySocket): void;
    message(socket: AnySocket, message: string | Buffer): void;
    close?(socket: AnySocket, code: number, reason: string): void;
  };
  /** Seconds an idle connection may stay open; the largest value wins. */
  idleTimeout?: number;
}

/** The client passed to gateway handlers: Bun's native server-side socket. */
export type BunSocket = Bun.ServerWebSocket<unknown>;
/** The value injected by `@WebSocketServer()`. */
export class BunWsGateway {
  readonly clients = new Set<BunSocket>();
  onConnection?: (client: BunSocket) => void;
  constructor(readonly path: string) {}
}
interface SocketState {
  gateway: BunWsGateway;
  onMessage?: (message: string | Buffer) => void;
  onClose?: () => void;
}
interface MessageHandler {
  message: unknown;
  callback: (...args: any[]) => unknown;
}
interface Subscribable {
  subscribe(observer: { next: (value: unknown) => void; error: (error: unknown) => void }): unknown;
}

/**
 * Nest WebSocket adapter on Bun's native WebSockets, sharing the HTTP port.
 * Speaks the same `{ event, data }` JSON messages as Nest's `WsAdapter`.
 */
export class BunWsAdapter implements WebSocketAdapter<BunWsGateway, BunSocket> {
  private readonly gateways = new Map<string, BunWsGateway>();
  // Kept outside `socket.data` so application code is free to use that field.
  private readonly sockets = new WeakMap<BunSocket, SocketState>();
  constructor(app: { getHttpAdapter(): unknown }) {
    const sockets = this.sockets;
    const adapter = app.getHttpAdapter();
    if (!(adapter instanceof BunHttpAdapter))
      throw new Error("BunWsAdapter requires an application created with BunHttpAdapter.");
    adapter.addSocketTransport({
      handle: (request, pathname, server) => {
        const gateway = this.gateways.get(pathname);
        if (!gateway || request.headers.get("upgrade")?.toLowerCase() !== "websocket") return null;
        return server.upgrade(request, { data: { gateway } })
          ? undefined
          : new Response("WebSocket upgrade failed", { status: 400 });
      },
      websocket: {
        open(socket) {
          const gateway = (socket.data as { gateway: BunWsGateway }).gateway;
          socket.data = undefined;
          sockets.set(socket, { gateway });
          gateway.clients.add(socket);
          gateway.onConnection?.(socket);
        },
        message(socket, message) {
          sockets.get(socket)?.onMessage?.(message);
        },
        close(socket) {
          const state = sockets.get(socket);
          state?.gateway.clients.delete(socket);
          state?.onClose?.();
        },
      },
    });
  }
  create(port: number, options: { path?: string; namespace?: string } = {}): BunWsGateway {
    if (port !== 0) throw new Error("BunWsAdapter gateways share the HTTP port; omit the port.");
    if (options.namespace) throw new Error("BunWsAdapter does not support namespaces.");
    const path = options.path ?? "/";
    const gateway = this.gateways.get(path) ?? new BunWsGateway(path);
    this.gateways.set(path, gateway);
    return gateway;
  }
  bindClientConnect(server: BunWsGateway, callback: Function): void {
    server.onConnection = callback as (client: BunSocket) => void;
  }
  bindClientDisconnect(client: BunSocket, callback: Function): void {
    this.sockets.get(client)!.onClose = callback as () => void;
  }
  bindMessageHandlers(
    client: BunSocket,
    handlers: MessageHandler[],
    transform: (data: any) => Subscribable,
  ): void {
    const byEvent = new Map(handlers.map((handler) => [handler.message, handler]));
    const observer = {
      next: (response: unknown): void => {
        if (response === undefined || response === null || client.readyState !== 1) return;
        try {
          client.send(JSON.stringify(response));
        } catch (error) {
          console.error("WebSocket response could not be sent", error);
        }
      },
      error: (error: unknown): void => console.error("WebSocket handler failed", error),
    };
    this.sockets.get(client)!.onMessage = (raw) => {
      // Malformed frames and unknown events are client input, so they are dropped quietly.
      let message: { event?: unknown; data?: unknown } | null;
      try {
        message = JSON.parse(String(raw));
      } catch {
        return;
      }
      const handler = byEvent.get(message?.event);
      if (!handler) return;
      try {
        transform(handler.callback(message!.data, message!.event)).subscribe(observer);
      } catch (error) {
        observer.error(error);
      }
    };
  }
  close(server: BunWsGateway): void {
    for (const client of server.clients) client.close();
    this.gateways.delete(server.path);
  }
  // Nest calls this on shutdown; gateways are already closed one by one above.
  dispose(): void {}
}

const NODE_SERVER_REQUIRED =
  "BunHttpAdapter serves through Bun.serve, which has no Node 'request' or 'upgrade' events. " +
  "Socket.IO and @nestjs/platform-ws need a Node HTTP server: use NodeHttpAdapter (it also runs " +
  "under Bun), or BunWsAdapter for plain WebSockets on BunHttpAdapter.";

export class BunServerFacade extends EventEmitter {
  native?: Bun.Server<any>;
  // Integrations that hook a Node server would otherwise attach here and never
  // receive anything, so they fail at startup instead.
  private guard(event: string | symbol): void {
    if (event === "request" || event === "upgrade") throw new Error(NODE_SERVER_REQUIRED);
  }
  override on(event: string | symbol, listener: (...args: any[]) => void): this {
    this.guard(event);
    return super.on(event, listener);
  }
  override addListener(event: string | symbol, listener: (...args: any[]) => void): this {
    this.guard(event);
    return super.addListener(event, listener);
  }
  /** Present only so Socket.IO treats this as a server and reaches the guard above. */
  listen(): never {
    throw new Error(NODE_SERVER_REQUIRED);
  }
  get listening(): boolean {
    return this.native !== undefined;
  }
  address(): AddressInfo | null {
    if (!this.native) return null;
    const address = this.native.hostname;
    const port = this.native.port;
    if (address === undefined || port === undefined)
      throw new Error("Expected a TCP Bun server address.");
    return {
      address,
      port,
      family: address.includes(":") ? "IPv6" : "IPv4",
    };
  }
}

export class BunHttpAdapter extends NativeHttpAdapter<BunServerFacade> {
  private readonly transports: BunSocketTransport[] = [];
  /** Registers a WebSocket integration; call before `listen()`. */
  addSocketTransport(transport: BunSocketTransport): void {
    this.transports.push(transport);
  }
  private forceCloseConnections = false;
  private tls?: NestApplicationOptions["httpsOptions"];
  initHttpServer(options: NestApplicationOptions): void {
    if (typeof Bun === "undefined") throw new Error("BunHttpAdapter requires the Bun runtime.");
    this.validateApplicationOptions(options);
    this.forceCloseConnections = options.forceCloseConnections ?? false;
    this.tls = options.httpsOptions;
    this.httpServer = new BunServerFacade();
  }
  listen(port: string | number, callback?: () => void): BunServerFacade;
  listen(port: string | number, hostname: string, callback?: () => void): BunServerFacade;
  listen(
    port: string | number,
    hostnameOrCallback?: string | (() => void),
    callback?: () => void,
  ): BunServerFacade {
    const done = typeof hostnameOrCallback === "function" ? hostnameOrCallback : callback;
    try {
      if (this.httpServer.listening) throw new Error("Bun server is already listening.");
      const numericPort = typeof port === "number" ? port : /^\d+$/.test(port) ? Number(port) : NaN;
      if (!Number.isInteger(numericPort) || numericPort < 0 || numericPort > 65535) {
        throw new Error("BunHttpAdapter requires a TCP port between 0 and 65535.");
      }
      const transports = this.transports;
      // The upgrade tags a socket with its transport; remembering it here leaves
      // `socket.data` free for the transport and the application to replace.
      const owners = new WeakMap<AnySocket, BunSocketTransport["websocket"]>();
      this.httpServer.native = Bun.serve<any>({
        port: numericPort,
        hostname: typeof hostnameOrCallback === "string" ? hostnameOrCallback : "0.0.0.0",
        // Bun reads key, cert, ca and passphrase; other Node TLS options are ignored.
        tls: this.tls as Bun.TLSOptions | undefined,
        idleTimeout:
          Math.max(0, ...transports.map((transport) => transport.idleTimeout ?? 0)) || undefined,
        fetch: (request, server) => {
          if (transports.length) {
            const url = request.url;
            const start = url.indexOf("/", url.indexOf("://") + 3);
            const end = url.indexOf("?", start);
            const pathname = start === -1 ? "/" : url.slice(start, end === -1 ? undefined : end);
            for (const transport of transports) {
              const result = transport.handle(request, pathname, {
                // Tag the socket so its events go back to the transport that upgraded it.
                upgrade: (target, options) =>
                  server.upgrade(target, {
                    ...options,
                    data: { ...options?.data, [OWNER]: transport },
                  } as never),
              });
              if (result !== null) return result;
            }
          }
          return this.fetch(request, { ip: server.requestIP(request)?.address });
        },
        websocket: {
          open: (socket) => {
            const owner = (socket.data as { [OWNER]: BunSocketTransport })[OWNER].websocket;
            owners.set(socket, owner);
            owner.open?.(socket);
          },
          message: (socket, message) => owners.get(socket)?.message(socket, message),
          close: (socket, code, reason) => owners.get(socket)?.close?.(socket, code, reason),
        },
        error: (error) => {
          console.error("Bun HTTP transport failed", error);
          return Response.json(
            { statusCode: 500, message: "Internal server error" },
            { status: 500 },
          );
        },
      });
    } catch (error) {
      this.httpServer.emit("error", error);
      return this.httpServer;
    }
    done?.();
    return this.httpServer;
  }
  async close(): Promise<void> {
    const server = this.httpServer?.native;
    if (!server) return;
    const timer = setTimeout(() => {
      void server.stop(true);
    }, this.adapterOptions.shutdownTimeout ?? 5000);
    try {
      await server.stop(this.forceCloseConnections);
    } finally {
      clearTimeout(timer);
      this.httpServer.native = undefined;
    }
  }
  // Bun reads a whole body natively far faster than a stream reader loop; the
  // declared length lets the limit be enforced up front.
  protected override readBody(
    request: NativeRequest,
    limit: number,
  ): Promise<Buffer> | Buffer | null {
    const declared = request.headers["content-length"];
    if (declared === undefined || !request.raw.body) return super.readBody(request, limit);
    if (Number(declared) > limit) return Promise.reject(new PayloadTooLargeException());
    return request.raw.arrayBuffer().then((bytes) => Buffer.from(bytes));
  }
  getType(): string {
    return "native-bun";
  }
}
