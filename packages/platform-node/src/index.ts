import { createServer, type Server } from "node:http";
import { PassThrough, Readable } from "node:stream";
import { finished } from "node:stream/promises";
import type { NestApplicationOptions } from "@nestjs/common";
import { NativeHttpAdapter } from "@shared";

export { NativeResponse } from "@shared";

export type { NativeAdapterOptions, NativeRequest } from "@shared";

// Bodies up to this declared size are buffered and written in a single call.
const SMALL_BODY_LIMIT = 64 * 1024;

export class NodeHttpAdapter extends NativeHttpAdapter<Server> {
  private forceCloseConnections = false;

  initHttpServer(options: NestApplicationOptions): void {
    this.validateApplicationOptions(options);
    this.forceCloseConnections = options.forceCloseConnections ?? false;
    this.httpServer = createServer((incoming, outgoing) => {
      void (async () => {
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
        outgoing.once("close", () => {
          if (!outgoing.writableFinished) controller.abort();
        });
        const method = incoming.method ?? "GET";
        const origin = `http://${headers.get("host") ?? "localhost"}`;
        const init: RequestInit & { duplex?: "half" } = {
          method,
          headers,
          signal: controller.signal,
        };
        if (method !== "GET" && method !== "HEAD") {
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
        const response = await this.fetch(new Request(new URL(incoming.url ?? "/", origin), init), {
          ip: incoming.socket.remoteAddress,
        });
        outgoing.statusCode = response.status;
        response.headers.forEach((value, name) => {
          if (name !== "set-cookie") outgoing.setHeader(name, value);
        });
        const cookies = response.headers.getSetCookie();
        if (cookies.length) outgoing.setHeader("set-cookie", cookies);
        if (!response.body) {
          outgoing.end();
          return;
        }
        const length = Number(response.headers.get("content-length"));
        if (length > 0 && length <= SMALL_BODY_LIMIT) {
          const bytes = Buffer.from(await response.arrayBuffer());
          if (!outgoing.destroyed) outgoing.end(bytes);
          return;
        }
        const responseStream = Readable.fromWeb(
          response.body as import("node:stream/web").ReadableStream<Uint8Array>,
        );
        const responseFinished = finished(outgoing, { cleanup: true });
        responseStream.once("error", (error) => outgoing.destroy(error));
        outgoing.once("close", () => {
          if (!outgoing.writableFinished) responseStream.destroy();
        });
        responseStream.pipe(outgoing);
        await responseFinished;
      })().catch((error: unknown) => {
        console.error("Node HTTP transport failed", error);
        if (outgoing.headersSent) {
          outgoing.destroy(error instanceof Error ? error : undefined);
          return;
        }
        outgoing.statusCode = 500;
        outgoing.setHeader("content-type", "application/json; charset=utf-8");
        outgoing.end(JSON.stringify({ statusCode: 500, message: "Internal server error" }));
      });
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
