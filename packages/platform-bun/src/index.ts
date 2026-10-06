import { EventEmitter } from "node:events";
import type { AddressInfo } from "node:net";
import type { NestApplicationOptions, WebSocketAdapter } from "@nestjs/common";
import { NativeHttpAdapter } from "@shared";

export { NativeResponse } from "@shared";

export type { NativeAdapterOptions, NativeRequest } from "@shared";

interface SocketData {
  gateway: BunWsGateway;
  onMessage?: (message: string | Buffer) => void;
  onClose?: () => void;
}
/** The client passed to gateway handlers: Bun's native server-side socket. */
export type BunSocket = Bun.ServerWebSocket<SocketData>;
/** The value injected by `@WebSocketServer()`. */
export class BunWsGateway {
  readonly clients = new Set<BunSocket>();
  onConnection?: (client: BunSocket) => void;
  constructor(readonly path: string) {}
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
  private readonly gateways: Map<string, BunWsGateway>;
  constructor(app: { getHttpAdapter(): unknown }) {
    const adapter = app.getHttpAdapter();
    if (!(adapter instanceof BunHttpAdapter))
      throw new Error("BunWsAdapter requires an application created with BunHttpAdapter.");
    this.gateways = adapter.gateways;
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
    client.data.onClose = callback as () => void;
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
    client.data.onMessage = (raw) => {
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

export class BunServerFacade extends EventEmitter {
  native?: Bun.Server<SocketData>;
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
  /** WebSocket gateways by path, registered by `BunWsAdapter`. */
  readonly gateways = new Map<string, BunWsGateway>();
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
      this.httpServer.native = Bun.serve<SocketData>({
        port: numericPort,
        hostname: typeof hostnameOrCallback === "string" ? hostnameOrCallback : "0.0.0.0",
        // Bun reads key, cert, ca and passphrase; other Node TLS options are ignored.
        tls: this.tls as Bun.TLSOptions | undefined,
        fetch: (request, server) => {
          if (this.gateways.size && request.headers.get("upgrade")?.toLowerCase() === "websocket") {
            const gateway = this.gateways.get(new URL(request.url).pathname);
            if (gateway && server.upgrade(request, { data: { gateway } })) return undefined;
          }
          return this.fetch(request, { ip: server.requestIP(request)?.address });
        },
        websocket: {
          open(socket) {
            socket.data.gateway.clients.add(socket);
            socket.data.gateway.onConnection?.(socket);
          },
          message(socket, message) {
            socket.data.onMessage?.(message);
          },
          close(socket) {
            socket.data.gateway.clients.delete(socket);
            socket.data.onClose?.();
          },
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
  getType(): string {
    return "native-bun";
  }
}
