import { AbstractHttpAdapter } from "@nestjs/core";
import { LegacyRouteConverter } from "@nestjs/core/internal";
import {
  HttpException,
  RequestMethod,
  type NestApplicationOptions,
  type VersioningOptions,
} from "@nestjs/common";
import { NativeRouter, type Handler, type Next } from "./router.js";
import { createRequest, parseRequestBody, type NativeRequest } from "./request.js";
import { NativeResponse } from "./response.js";

export { NativeResponse } from "./response.js";
export type { NativeRequest } from "./request.js";
export interface NativeAdapterOptions {
  bodyLimit?: number;
  shutdownTimeout?: number;
}
type ErrorHandler = (
  error: unknown,
  req: NativeRequest,
  res: NativeResponse,
  next: Next,
) => unknown;

export abstract class NativeHttpAdapter<TServer> extends AbstractHttpAdapter<
  TServer,
  NativeRequest,
  NativeResponse
> {
  private readonly router = new NativeRouter();
  private errorHandler?: ErrorHandler;
  private notFound: Handler = (req, res) =>
    res.status(404).json({
      statusCode: 404,
      message: `Cannot ${req.method} ${req.url}`,
      error: "Not Found",
    });
  private shuttingDown = false;
  private return503OnClosing = false;

  constructor(protected readonly adapterOptions: NativeAdapterOptions = {}) {
    super();
    const options = adapterOptions;
    if (
      options.bodyLimit !== undefined &&
      (!Number.isSafeInteger(options.bodyLimit) || options.bodyLimit <= 0)
    ) {
      throw new Error("bodyLimit must be a positive integer.");
    }
    if (
      options.shutdownTimeout !== undefined &&
      (!Number.isSafeInteger(options.shutdownTimeout) || options.shutdownTimeout < 0)
    ) {
      throw new Error("shutdownTimeout must be a nonnegative integer.");
    }
    const instance: Record<string, unknown> = { use: this.use.bind(this) };
    for (const method of [
      "get",
      "post",
      "put",
      "patch",
      "delete",
      "head",
      "options",
      "all",
      "search",
      "query",
      "propfind",
      "proppatch",
      "mkcol",
      "copy",
      "move",
      "lock",
      "unlock",
    ]) {
      instance[method] = (path: string, callback: Handler) => {
        this.router.route(method.toUpperCase(), path, callback);
      };
    }
    this.setInstance(instance);
  }

  use(...args: (string | Handler | Handler[])[]): this {
    const path = typeof args[0] === "string" ? (args.shift() as string) : "/";
    for (const handler of args.flat()) {
      if (typeof handler !== "function") throw new Error("Middleware must be a function.");
      this.router.use(path, handler);
    }
    return this;
  }
  readonly fetch = async (raw: Request, info?: { ip?: string }): Promise<Response> => {
    const request = createRequest(raw, info?.ip);
    const response = new NativeResponse(request.method);
    if (this.shuttingDown && this.return503OnClosing)
      return new Response("Service Unavailable", { status: 503 });
    try {
      await this.router.run(request, response, this.notFound);
    } catch (error) {
      if (response.headersSent) {
        console.error("Request failed after response was sent", error);
      } else if (this.errorHandler) {
        await this.errorHandler(error, request, response, () => {});
      } else {
        console.error("Unhandled native adapter error", error);
        response
          .status(error instanceof HttpException ? error.getStatus() : 500)
          .json(
            error instanceof HttpException
              ? error.getResponse()
              : { statusCode: 500, message: "Internal server error" },
          );
      }
    }
    return response.done;
  };
  getRequestHostname(request: NativeRequest): string {
    return request.hostname;
  }
  getRequestMethod(request: NativeRequest): string {
    return request.method;
  }
  getRequestUrl(request: NativeRequest): string {
    return request.originalUrl;
  }
  status(response: NativeResponse, code: number): NativeResponse {
    return response.status(code);
  }
  reply(response: NativeResponse, body: unknown, code?: number): NativeResponse {
    if (code !== undefined) response.status(code);
    return response.send(body);
  }
  end(response: NativeResponse, message?: string): NativeResponse {
    return response.end(message);
  }
  redirect(response: NativeResponse, code: number, url: string): NativeResponse {
    return response.redirect(code, url);
  }
  isHeadersSent(response: NativeResponse): boolean {
    return response.headersSent;
  }
  getHeader(response: NativeResponse, name: string) {
    return response.getHeader(name);
  }
  setHeader(response: NativeResponse, name: string, value: string): NativeResponse {
    return response.setHeader(name, value);
  }
  appendHeader(response: NativeResponse, name: string, value: string): NativeResponse {
    return response.appendHeader(name, value);
  }
  setErrorHandler(handler: ErrorHandler): void {
    this.errorHandler = handler;
  }
  setNotFoundHandler(handler: Handler): void {
    this.notFound = handler;
  }
  registerParserMiddleware(_prefix?: string, rawBody = false): void {
    this.use(async (req, _res, next) => {
      await parseRequestBody(req, this.adapterOptions.bodyLimit ?? 100 * 1024, rawBody);
      next();
    });
  }
  createMiddlewareFactory(method: RequestMethod) {
    return (path: string, callback: Function) => {
      this.router.route(
        RequestMethod[method] ?? "ALL",
        this.normalizePath(path),
        (req, res, next) => callback(req, res, next),
      );
    };
  }
  normalizePath(path: string): string {
    const converted = LegacyRouteConverter.tryConvert(path);
    return converted.length > 1 ? converted.replace(/\/$/, "") : converted;
  }
  enableCors(): never {
    throw new Error("CORS configuration is not implemented by native adapters yet.");
  }
  useStaticAssets(): never {
    throw new Error("Static assets require a separate integration.");
  }
  useBodyParser(): never {
    throw new Error("Custom body parsers are not implemented; configure bodyLimit on the adapter.");
  }
  setBaseViewsDir(): never {
    throw new Error("MVC rendering is not supported by native adapters.");
  }
  setViewEngine(): never {
    throw new Error("MVC rendering is not supported by native adapters.");
  }
  render(): never {
    throw new Error("MVC rendering is not supported by native adapters.");
  }
  applyVersionFilter(_handler: Function, _version: unknown, _options: VersioningOptions): never {
    throw new Error("Only URI versioning is currently supported.");
  }
  beforeClose(): void {
    this.shuttingDown = true;
  }
  protected validateApplicationOptions(options: NestApplicationOptions): void {
    if (options.httpsOptions) throw new Error("HTTPS is not implemented by native adapters yet.");
    this.return503OnClosing = options.return503OnClosing ?? false;
  }
}
