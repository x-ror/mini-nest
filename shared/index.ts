import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { extname, relative, resolve } from "node:path";
import { AbstractHttpAdapter } from "@nestjs/core";
import { LegacyRouteConverter } from "@nestjs/core/internal";
import {
  HttpException,
  RequestMethod,
  VERSION_NEUTRAL,
  VersioningType,
  type NestApplicationOptions,
  type VersioningOptions,
} from "@nestjs/common";
import { NativeRouter, type Fail, type Handler, type Next } from "./router.js";
import {
  createRequest,
  defaultBodyKind,
  isParsedMethod,
  mediaType,
  parseRequestBody,
  readWebBody,
  type BodyKind,
  type NativeRequest,
} from "./request.js";
import { NativeResponse } from "./response.js";

export { NativeResponse } from "./response.js";
export {
  AnyFilesInterceptor,
  FileFieldsInterceptor,
  FileInterceptor,
  FilesInterceptor,
  type UploadedFileData,
} from "./uploads.js";
export { NullObject, parseQuery } from "./request.js";
export type { NativeRequest } from "./request.js";
export type { ResponseBody } from "./response.js";
export interface NativeAdapterOptions {
  bodyLimit?: number;
  /** Limit for multipart bodies (file uploads); defaults to `bodyLimit`. */
  uploadLimit?: number;
  shutdownTimeout?: number;
}
/** Express's view engine signature: `(path, options, callback)`. */
export type ViewRenderer = (
  path: string,
  options: object,
  callback: (error: unknown, html?: string) => void,
) => void;
type VersionValue = Parameters<AbstractHttpAdapter["applyVersionFilter"]>[1];
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
  private viewsDirs = [resolve("views")];
  private viewEngine?: { extension: string; render?: ViewRenderer };
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
      options.uploadLimit !== undefined &&
      (!Number.isSafeInteger(options.uploadLimit) || options.uploadLimit <= 0)
    ) {
      throw new Error("uploadLimit must be a positive integer.");
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
  readonly fetch = (raw: Request, info?: { ip?: string }): Promise<Response> => {
    const request = createRequest(raw, info?.ip);
    const response = new NativeResponse(request.method);
    this.dispatch(request, response);
    return response.done;
  };
  /** Runs one request through the router; never throws. */
  protected dispatch(request: NativeRequest, response: NativeResponse): void {
    if (this.shuttingDown && this.return503OnClosing) {
      response
        .status(503)
        .setHeader("content-type", "text/plain; charset=utf-8")
        .end("Service Unavailable");
      return;
    }
    this.router.run(request, response, this.notFound, this.fail);
  }
  private readonly fail: Fail = (error, request, response) => {
    if (response.headersSent) {
      console.error("Request failed after response was sent", error);
      return;
    }
    try {
      if (this.errorHandler) {
        const handled = this.errorHandler(error, request, response, () => {});
        if (typeof (handled as PromiseLike<unknown> | undefined)?.then === "function") {
          (handled as PromiseLike<unknown>).then(undefined, (failure: unknown) =>
            this.failSafe(failure, response),
          );
        }
        return;
      }
      console.error("Unhandled native adapter error", error);
      response
        .status(error instanceof HttpException ? error.getStatus() : 500)
        .json(
          error instanceof HttpException
            ? error.getResponse()
            : { statusCode: 500, message: "Internal server error" },
        );
    } catch (failure) {
      this.failSafe(failure, response);
    }
  };
  private failSafe(error: unknown, response: NativeResponse): void {
    console.error("Native adapter error handling failed", error);
    if (response.headersSent) return;
    try {
      response.status(500).json({ statusCode: 500, message: "Internal server error" });
    } catch (failure) {
      console.error("Native adapter could not send an error response", failure);
    }
  }
  /** Reads the request body, or returns null when the request has none. */
  protected readBody(request: NativeRequest, limit: number): Promise<Buffer> | Buffer | null {
    const body = request.raw.body;
    return body ? readWebBody(body, limit) : null;
  }
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
    this.use(
      this.bodyParser(defaultBodyKind, this.adapterOptions.bodyLimit ?? 100 * 1024, rawBody),
    );
  }
  /**
   * Adds a parser ahead of the built-in one, e.g. `app.useBodyParser("text")` or
   * `app.useBodyParser("json", { limit: "5mb", type: "application/vnd.api+json" })`.
   */
  useBodyParser(
    kind: Exclude<BodyKind, "multipart">,
    rawBody = false,
    options: { limit?: number | string; type?: string | string[] } = {},
  ): this {
    const defaults = {
      json: "application/json",
      urlencoded: "application/x-www-form-urlencoded",
      text: "text/plain",
      raw: "application/octet-stream",
    };
    if (!(kind in defaults)) throw new Error(`Unsupported body parser type: ${String(kind)}`);
    const size = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i.exec(
      String(options.limit ?? this.adapterOptions.bodyLimit ?? 100 * 1024),
    );
    if (!size) throw new Error(`Invalid body parser limit: ${String(options.limit)}`);
    const limit = Math.floor(
      Number(size[1]) * 1024 ** ["b", "kb", "mb", "gb"].indexOf((size[2] ?? "b").toLowerCase()),
    );
    // Entries are exact media types, "type/*" prefixes or "*/*".
    const types = ([] as string[]).concat(options.type ?? defaults[kind]).map((type) => {
      const lower = type.toLowerCase();
      return lower === "*/*" ? "" : lower.endsWith("/*") ? lower.slice(0, -1) : lower;
    });
    const claims = (type: string | undefined): BodyKind | undefined =>
      type !== undefined &&
      types.some((entry) =>
        entry.endsWith("/") || !entry ? type.startsWith(entry) : type === entry,
      )
        ? kind
        : undefined;
    return this.use(this.bodyParser(claims, limit, rawBody));
  }
  private bodyParser(
    kindOf: (type: string | undefined) => BodyKind | undefined,
    limit: number,
    rawBody: boolean,
  ): Handler {
    const read = this.readBody.bind(this);
    const uploadLimit = this.adapterOptions.uploadLimit ?? limit;
    return (req, _res, next) => {
      // A body set by an earlier parser is left alone.
      if (!isParsedMethod(req.method) || req.body !== undefined) return next();
      const kind = kindOf(mediaType(req.headers["content-type"]));
      if (kind === undefined) return next();
      return parseRequestBody(
        req,
        kind,
        kind === "multipart" ? uploadLimit : limit,
        rawBody,
        read,
      ).then(() => next());
    };
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
  setBaseViewsDir(path: string | string[]): this {
    this.viewsDirs = ([] as string[]).concat(path);
    return this;
  }
  /**
   * Takes an Express-compatible engine: a module name such as "ejs", "pug" or
   * "hbs" (anything exporting `__express`), or the extension and function itself.
   */
  setViewEngine(engine: string | { extension: string; render: ViewRenderer }): this {
    this.viewEngine = typeof engine === "string" ? { extension: engine } : { ...engine };
    return this;
  }
  async render(response: NativeResponse, view: string, options: unknown): Promise<void> {
    const engine = this.viewEngine;
    if (!engine) throw new Error("No view engine is set; call app.setViewEngine(...) first.");
    const name = extname(view) ? view : `${view}.${engine.extension}`;
    const file = this.viewsDirs.map((dir) => resolve(dir, name)).find((path) => existsSync(path));
    if (!file) throw new Error(`Failed to lookup view "${view}" in ${this.viewsDirs.join(", ")}`);
    engine.render ??= this.loadViewEngine(engine.extension);
    const html = await new Promise<string>((done, fail) =>
      engine.render!(file, (options ?? {}) as object, (error, output) =>
        error ? fail(error) : done(output ?? ""),
      ),
    );
    response.send(html);
  }
  // Engines belong to the application, so they are resolved from its views and
  // working directories rather than from this package.
  private loadViewEngine(name: string): ViewRenderer {
    for (const dir of [...this.viewsDirs, process.cwd()]) {
      let loaded: { __express?: ViewRenderer; default?: { __express?: ViewRenderer } };
      try {
        loaded = createRequire(resolve(dir, "views.js"))(name);
      } catch {
        continue;
      }
      const renderer = loaded.__express ?? loaded.default?.__express;
      if (renderer) return renderer;
      throw new Error(`Module "${name}" does not provide an Express view engine (__express).`);
    }
    throw new Error(`View engine "${name}" is not installed.`);
  }
  applyVersionFilter(
    handler: Function,
    version: VersionValue,
    options: VersioningOptions,
  ): (req: NativeRequest, res: NativeResponse, next: () => void) => Function {
    const run = handler as ReturnType<typeof this.applyVersionFilter>;
    if (version === VERSION_NEUTRAL || options.type === VersioningType.URI) return run;
    const wanted = Array.isArray(version) ? version : [version];
    let extract: (request: NativeRequest) => string | string[] | undefined;
    if (options.type === VersioningType.CUSTOM) {
      extract = (request) => options.extractor(request);
    } else if (options.type === VersioningType.HEADER) {
      const header = options.header.toLowerCase();
      extract = (request) => request.headers[header];
    } else if (options.type === VersioningType.MEDIA_TYPE) {
      const key = options.key;
      extract = (request) => {
        for (const range of (request.headers.accept ?? "").split(",")) {
          for (const parameter of range.split(";").slice(1)) {
            const trimmed = parameter.trim();
            if (trimmed.startsWith(key)) return trimmed.slice(key.length);
          }
        }
        return undefined;
      };
    } else {
      throw new Error("Unsupported versioning options");
    }
    // Like Nest's Express adapter, each handler is checked on its own, so the
    // highest version across separate handlers is not selected automatically.
    return (request, response, next) => {
      const found = extract(request);
      const matches =
        found === undefined
          ? wanted.includes(VERSION_NEUTRAL)
          : ([] as string[]).concat(found).some((candidate) => wanted.includes(candidate));
      return matches ? run(request, response, next) : (next() as unknown as Function);
    };
  }
  beforeClose(): void {
    this.shuttingDown = true;
  }
  protected validateApplicationOptions(options: NestApplicationOptions): void {
    this.return503OnClosing = options.return503OnClosing ?? false;
  }
}
