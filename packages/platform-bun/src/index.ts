import { EventEmitter } from "node:events";
import type { AddressInfo } from "node:net";
import type { NestApplicationOptions } from "@nestjs/common";
import { NativeHttpAdapter } from "@nest-native/adapter-common";

export type {
  NativeAdapterOptions,
  NativeRequest,
  NativeResponse,
} from "@nest-native/adapter-common";

export class BunServerFacade extends EventEmitter {
  native?: Bun.Server<undefined>;
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
  private forceCloseConnections = false;
  initHttpServer(options: NestApplicationOptions): void {
    if (typeof Bun === "undefined") throw new Error("BunHttpAdapter requires the Bun runtime.");
    this.validateApplicationOptions(options);
    this.forceCloseConnections = options.forceCloseConnections ?? false;
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
      this.httpServer.native = Bun.serve({
        port: numericPort,
        hostname: typeof hostnameOrCallback === "string" ? hostnameOrCallback : "0.0.0.0",
        fetch: (request, server) => this.fetch(request, { ip: server.requestIP(request)?.address }),
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
