import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { IoAdapter } from "@nestjs/platform-socket.io";
import { Server as Engine } from "@socket.io/bun-engine";
import { Server, type ServerOptions } from "socket.io";
import { bunAdapterOf, type BunHttpAdapter } from "./index.js";

const CLIENT_FILE = /^socket\.io(\.esm)?(\.min|\.msgpack\.min)?\.js(\.map)?$/;

/**
 * Socket.IO for applications on `BunHttpAdapter`, sharing the HTTP port through
 * Socket.IO's Bun engine. Gateways, namespaces, rooms and clients are plain
 * Socket.IO; register it with `app.useWebSocketAdapter(new BunIoAdapter(app))`.
 */
export class BunIoAdapter extends IoAdapter {
  private readonly http: BunHttpAdapter;
  constructor(app: { getHttpAdapter(): unknown }) {
    super(app as ConstructorParameters<typeof IoAdapter>[0]);
    this.http = bunAdapterOf(app, "BunIoAdapter");
  }
  override createIOServer(port: number, options?: ServerOptions): Server {
    // A separate port gets Socket.IO's own server, as on any other platform.
    if (port !== 0) return super.createIOServer(port, options) as Server;
    const io = new Server(options);
    const path = `${(options?.path ?? "/socket.io").replace(/\/$/, "")}/`;
    const engine = new Engine({
      path,
      ...(options?.cors && { cors: options.cors as object }),
      ...(options?.pingInterval && { pingInterval: options.pingInterval }),
      ...(options?.pingTimeout && { pingTimeout: options.pingTimeout }),
      ...(options?.maxHttpBufferSize && { maxHttpBufferSize: options.maxHttpBufferSize }),
    });
    io.bind(engine as unknown as Parameters<Server["bind"]>[0]);
    const { websocket, idleTimeout } = engine.handler();
    const clientDist =
      options?.serveClient === false
        ? undefined
        : join(
            dirname(createRequire(import.meta.url).resolve("socket.io/package.json")),
            "client-dist",
          );
    this.http.addSocketTransport({
      idleTimeout,
      websocket: websocket as never,
      handle: (request, pathname, server) => {
        if (pathname === path) return engine.handleRequest(request, server as never);
        if (!clientDist || !pathname.startsWith(path)) return null;
        // Like Socket.IO on Node, serve the browser client next to the endpoint.
        const file = pathname.slice(path.length);
        return CLIENT_FILE.test(file) ? new Response(Bun.file(join(clientDist, file))) : null;
      },
    });
    return io;
  }
}
