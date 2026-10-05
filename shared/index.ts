import { readFile, stat } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
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
  enableCors(options: Record<string, unknown> = {}): void {
    const originOption = options.origin ?? "*";
    const methods = Array.isArray(options.methods)
      ? options.methods.map((value) => String(value))
      : ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE", "OPTIONS"];
    const allowedHeaders = Array.isArray(options.allowedHeaders)
      ? options.allowedHeaders.map((value) => String(value))
      : ["Content-Type", "Authorization", "X-Requested-With", "X-Auth"];
    const exposedHeaders = Array.isArray(options.exposedHeaders)
      ? options.exposedHeaders.map((value) => String(value))
      : [];
    const credentials = options.credentials === true || options.allowCredentials === true;
    const maxAge = options.maxAge;

    const resolveOrigin = (requestOrigin?: string): string => {
      if (requestOrigin === undefined) return originOption === true ? "*" : "*";
      if (originOption === true || originOption === "*") return "*";
      if (typeof originOption === "string") return originOption;
      if (Array.isArray(originOption))
        return originOption.includes(requestOrigin) ? requestOrigin : "*";
      if (typeof originOption === "function") return String(originOption(requestOrigin));
      return requestOrigin;
    };

    this.use((req, res, next) => {
      const requestOrigin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
      const allowOrigin = resolveOrigin(requestOrigin);
      if (requestOrigin) res.setHeader("vary", "Origin");
      if (allowOrigin) res.setHeader("access-control-allow-origin", allowOrigin);
      if (credentials) res.setHeader("access-control-allow-credentials", "true");
      if (exposedHeaders.length) {
        res.setHeader("access-control-expose-headers", exposedHeaders.join(", "));
      }
      const isPreflight =
        req.method === "OPTIONS" &&
        typeof req.headers["access-control-request-method"] === "string";
      if (isPreflight) {
        const requestedHeaders =
          typeof req.headers["access-control-request-headers"] === "string"
            ? req.headers["access-control-request-headers"]
            : allowedHeaders.join(", ");
        res.setHeader("access-control-allow-methods", methods.join(", "));
        res.setHeader("access-control-allow-headers", requestedHeaders);
        if (typeof maxAge === "number") res.setHeader("access-control-max-age", String(maxAge));
        res.status(204).end();
        return;
      }
      next();
    });
  }
  useStaticAssets(
    root: string | { root?: string; prefix?: string; index?: string; maxAge?: number },
    options: { prefix?: string; index?: string; maxAge?: number } = {},
  ): this {
    const resolvedRoot = typeof root === "string" ? root : (root.root ?? process.cwd());
    const resolvedOptions = typeof root === "string" ? options : { ...root, ...options };
    const prefix = resolvedOptions.prefix ?? "/";
    const indexName = resolvedOptions.index ?? "index.html";
    const rootPath = resolve(resolvedRoot);
    const fileExtensionContentType = (filePath: string): string => {
      const extension = extname(filePath).toLowerCase();
      switch (extension) {
        case ".html":
          return "text/html; charset=utf-8";
        case ".css":
          return "text/css; charset=utf-8";
        case ".js":
          return "application/javascript; charset=utf-8";
        case ".json":
          return "application/json; charset=utf-8";
        case ".svg":
          return "image/svg+xml";
        case ".txt":
          return "text/plain; charset=utf-8";
        case ".png":
          return "image/png";
        case ".jpg":
        case ".jpeg":
          return "image/jpeg";
        case ".webp":
          return "image/webp";
        case ".gif":
          return "image/gif";
        case ".ico":
          return "image/x-icon";
        default:
          return "application/octet-stream";
      }
    };
    this.use(async (req, res, next) => {
      if (req.method !== "GET" && req.method !== "HEAD") return next();
      const normalizedPrefix = prefix === "/" ? "/" : prefix.replace(/\/+$/, "");
      if (normalizedPrefix !== "/" && !req.path.startsWith(normalizedPrefix)) return next();
      const rawPath =
        normalizedPrefix === "/" ? req.path : req.path.slice(normalizedPrefix.length) || "/";
      const safePath = rawPath === "/" ? indexName : rawPath.replace(/^\/+/, "");
      const targetPath = resolve(rootPath, safePath);
      const relativeToRoot = relative(rootPath, targetPath);
      if (relativeToRoot.startsWith("..") || relativeToRoot === "..") return next();
      try {
        const stats = await stat(targetPath);
        const filePath = stats.isDirectory() ? resolve(targetPath, indexName) : targetPath;
        const fileStats = await stat(filePath);
        if (!fileStats.isFile()) return next();
        const bytes = await readFile(filePath);
        if (typeof resolvedOptions.maxAge === "number")
          res.setHeader("cache-control", `public, max-age=${resolvedOptions.maxAge}`);
        res.setHeader("content-type", fileExtensionContentType(filePath));
        if (req.method === "HEAD") return res.status(200).end();
        res.status(200).send(bytes);
      } catch {
        return next();
      }
    });
    return this;
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
