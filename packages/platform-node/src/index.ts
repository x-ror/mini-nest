import { createServer, type Server } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { NestApplicationOptions } from "@nestjs/common";
import { NativeHttpAdapter } from "@nest-native/adapter-common";

export type { NativeAdapterOptions, NativeRequest, NativeResponse } from "@nest-native/adapter-common";

export class NodeHttpAdapter extends NativeHttpAdapter<Server> {
  private forceCloseConnections = false;

  initHttpServer(options: NestApplicationOptions): void {
    this.validateApplicationOptions(options);
    this.forceCloseConnections = options.forceCloseConnections ?? false;
    this.httpServer = createServer((incoming, outgoing) => {
      void (async () => {
        const headers = new Headers();
        for (let i = 0; i < incoming.rawHeaders.length; i += 2) {
          headers.append(incoming.rawHeaders[i]!, incoming.rawHeaders[i + 1]!);
        }
        const controller = new AbortController();
        outgoing.once("close", () => {
          if (!outgoing.writableFinished) controller.abort();
        });
        const method = incoming.method ?? "GET";
        const origin = `http://${headers.get("host") ?? "localhost"}`;
        const init: RequestInit & { duplex?: "half" } = { method, headers, signal: controller.signal };
        if (method !== "GET" && method !== "HEAD") {
          init.body = Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
          init.duplex = "half";
        }
        const response = await this.fetch(new Request(new URL(incoming.url ?? "/", origin), init),
          { ip: incoming.socket.remoteAddress });
        outgoing.statusCode = response.status;
        response.headers.forEach((value, name) => {
          if (name !== "set-cookie") outgoing.setHeader(name, value);
        });
        const cookies = response.headers.getSetCookie();
        if (cookies.length) outgoing.setHeader("set-cookie", cookies);
        if (!response.body) { outgoing.end(); return; }
        await pipeline(Readable.fromWeb(response.body), outgoing);
      })().catch((error: unknown) => {
        console.error("Node HTTP transport failed", error);
        if (outgoing.headersSent) { outgoing.destroy(error instanceof Error ? error : undefined); return; }
        outgoing.statusCode = 500;
        outgoing.setHeader("content-type", "application/json; charset=utf-8");
        outgoing.end(JSON.stringify({ statusCode: 500, message: "Internal server error" }));
      });
    });
  }

  listen(port: string | number, callback?: () => void): Server;
  listen(port: string | number, hostname: string, callback?: () => void): Server;
  listen(port: string | number, hostnameOrCallback?: string | (() => void), callback?: () => void): Server {
    if (typeof hostnameOrCallback === "string") return this.httpServer.listen(port, hostnameOrCallback, callback);
    return this.httpServer.listen(port, hostnameOrCallback);
  }
  async close(): Promise<void> {
    if (!this.httpServer?.listening) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => this.httpServer.closeAllConnections(), this.options.shutdownTimeout ?? 5000);
      timer.unref();
      this.httpServer.close((error) => { clearTimeout(timer); error ? reject(error) : resolve(); });
      if (this.forceCloseConnections) this.httpServer.closeAllConnections();
    });
  }
  getType(): string { return "native-node"; }
}
