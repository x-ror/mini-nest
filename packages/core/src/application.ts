import type { HttpAdapter } from "@mini-nest/common";
import { createRequestHandler } from "./http/request-handler.js";
import { discoverControllerRoutes } from "./routing/controller-routes.js";
import { Router } from "./routing/router.js";

export type { RequestContext } from "./http/request-context.js";

export class Application<TServer = unknown> {
  private readonly router = new Router();
  readonly fetch = createRequestHandler(this.router);

  constructor(private readonly adapter?: HttpAdapter<TServer>) {}

  setGlobalPrefix(prefix: string): this {
    this.router.setGlobalPrefix(prefix);
    return this;
  }

  register(controller: object): this {
    this.router.register(discoverControllerRoutes(controller));
    return this;
  }

  async listen(port: number, hostname?: string): Promise<TServer> {
    return this.requireAdapter("listen()").listen(this.fetch, port, hostname);
  }

  getHttpServer(): TServer {
    return this.requireAdapter("getHttpServer()").getHttpServer();
  }

  async close(): Promise<void> {
    await this.adapter?.close();
  }

  private requireAdapter(operation: string): HttpAdapter<TServer> {
    if (!this.adapter) {
      throw new Error(`${operation} requires an HTTP adapter. Pass one to NestFactory.create().`);
    }
    return this.adapter;
  }
}
