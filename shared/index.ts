import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { extname, resolve } from "node:path";
import { AbstractHttpAdapter } from "@nestjs/core";
import { LegacyRouteConverter } from "@nestjs/core/internal";
import {
  HttpException,
  Logger,
  RequestMethod,
  VERSION_NEUTRAL,
  VersioningType,
  type NestApplicationOptions,
  type VersioningOptions,
} from "@nestjs/common";
import type {
  CorsOptions,
  CorsOptionsDelegate,
  CustomOrigin,
} from "@nestjs/common/interfaces/external/cors-options.interface.js";
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
import { compileTrust, type TrustFunction, type TrustProxy } from "./proxy.js";
import { serveStatic, type StaticAssetsOptions } from "./static.js";

export { NativeResponse } from "./response.js";
export {
  AnyFilesInterceptor,
  FileFieldsInterceptor,
  FileInterceptor,
  FilesInterceptor,
  type UploadedFileData,
} from "./uploads.js";
export { NullObject, parseQuery } from "./request.js";
export type { StaticAssetsOptions } from "./static.js";
export {
  hostnameOf,
  resolveProxy,
  type ProxyView,
  type TrustFunction,
  type TrustProxy,
} from "./proxy.js";
export type { NativeRequest } from "./request.js";
export type { CookieWriter, ResponseBody, ResponseCookieOptions } from "./response.js";
export interface NativeAdapterOptions {
  bodyLimit?: number;
  /** Limit for multipart bodies (file uploads); defaults to `bodyLimit`. */
  uploadLimit?: number;
  shutdownTimeout?: number;
  /**
   * Express's `trust proxy` setting, which decides when `X-Forwarded-For`,
   * `X-Forwarded-Proto` and `X-Forwarded-Host` replace the socket address,
   * protocol and host. Off by default; `app.set("trust proxy", value)` works too.
   */
  trustProxy?: TrustProxy;
}
/** Express's view engine signature: `(path, options, callback)`. */
export type ViewRenderer = (
  path: string,
  options: object,
  callback: (error: unknown, html?: string) => void,
) => void;
type StaticOrigin = Exclude<NonNullable<CorsOptions["origin"]>, CustomOrigin>;
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
  /** Compiled `trust proxy` setting; undefined trusts no proxy. */
  protected trust: TrustFunction | undefined;

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
    this.trust = compileTrust(options.trustProxy);
    this.setInstance(instance);
  }

  /**
   * Express's `app.set()`, so `app.set("trust proxy", 1)` keeps working after a
   * migration. Like Express, any setting name is accepted. Only `trust proxy`
   * has an effect; `x-powered-by` is silently accepted (these adapters never
   * send that header), and any other setting logs a warning that it is
   * ignored. A call through Nest's app runs in its exception zone, so an
   * invalid `trust proxy` value fails startup, as it does on Express.
   */
  set(setting: string, value: unknown): this {
    if (setting === "trust proxy") {
      this.trust = compileTrust(value as TrustProxy);
    } else if (setting !== "x-powered-by") {
      new Logger(NativeHttpAdapter.name).warn(
        `app.set("${setting}") has no effect on the native adapters and is ignored.`,
      );
    }
    return this;
  }
  /** Express's `app.enable(setting)`; see `set()`. */
  enable(setting: string): this {
    return this.set(setting, true);
  }
  /** Express's `app.disable(setting)`; see `set()`. */
  disable(setting: string): this {
    return this.set(setting, false);
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
    const request = createRequest(raw, info?.ip, this.trust);
    const response = new NativeResponse(request.method, this, request);
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
    // Like Nest's ExpressAdapter: an error body must not go out under a non-JSON
    // type left by middleware (e.g. a static file's text/plain before a 412).
    const contentType = response.getHeader("content-type");
    if (
      typeof contentType === "string" &&
      !isJsonContentType(contentType) &&
      ((body as { statusCode?: unknown } | null)?.statusCode as number) >= 400
    ) {
      new Logger(NativeHttpAdapter.name).warn(
        "Content-Type doesn't match Reply body, you might need a custom ExceptionFilter for non-JSON responses",
      );
      response.setHeader("content-type", "application/json; charset=utf-8");
    }
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
  /**
   * Mirrors the `cors` package that Nest's Express adapter installs: options
   * are merged over its defaults the same way (an explicit `undefined` origin
   * disables CORS), header values, `Vary` handling and preflight behavior
   * match, and a `CorsOptionsDelegate` may call back with no options. Static
   * options are compiled once, so requests take a synchronous path unless a
   * delegate or an origin callback is involved.
   */
  enableCors(options: CorsInput | CorsOptionsDelegate<NativeRequest> = {}): void {
    if (typeof options === "function") {
      this.use((req, res, next) => {
        options(req, (error, resolved) => {
          if (error) return next(error);
          const compiled = compileCors(resolved as CorsInput | undefined);
          handleCors(compiled, req, res, next);
        });
      });
      return;
    }
    const compiled = compileCors(options);
    // Like `cors`, a falsy static origin turns CORS off for every request.
    if (!compiled.origin) return;
    this.use((req, res, next) => handleCors(compiled, req, res, next));
  }
  /**
   * Nest's `app.useStaticAssets(root, options)`, implemented like
   * `express.static()` (serve-static and send); see `StaticAssetsOptions`.
   */
  useStaticAssets(
    root: string | (StaticAssetsOptions & { root?: string }),
    options: StaticAssetsOptions = {},
  ): this {
    const resolvedRoot = typeof root === "string" ? root : (root.root ?? process.cwd());
    const resolvedOptions = typeof root === "string" ? options : { ...root, ...options };
    return this.use(serveStatic(resolvedRoot, resolvedOptions));
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

/** Nest's `CorsOptions` plus the aliases the `cors` package and older releases accepted. */
type CorsInput = CorsOptions & {
  /** Alias of `allowedHeaders`, as in the `cors` package. */
  headers?: string | string[];
  /** @deprecated Accepted by earlier releases of these adapters; use `credentials`. */
  allowCredentials?: boolean;
};

/** The `cors` package defaults, merged under the given options like `Object.assign`. */
const CORS_DEFAULTS = {
  origin: "*",
  methods: "GET,HEAD,PUT,PATCH,POST,DELETE",
  preflightContinue: false,
  optionsSuccessStatus: 204,
} satisfies CorsInput;

/** Header values derived once from an options object. */
interface CompiledCors {
  origin: CorsOptions["origin"];
  credentials: boolean;
  methods?: string;
  /** `undefined` reflects `Access-Control-Request-Headers`, as `cors` does. */
  allowedHeaders?: string;
  exposedHeaders?: string;
  maxAge?: string;
  preflightContinue: boolean;
  optionsSuccessStatus: number;
}

/** `cors` joins arrays with "," and treats empty values as absent. */
function corsList(value: unknown): string | undefined {
  const text = Array.isArray(value) ? value.join(",") : value;
  return typeof text === "string" && text ? text : undefined;
}

function compileCors(options: CorsInput | undefined): CompiledCors {
  const merged: CorsInput = { ...CORS_DEFAULTS, ...options };
  const allowedHeaders = merged.allowedHeaders || merged.headers;
  const maxAge = merged.maxAge;
  return {
    origin: merged.origin,
    credentials: merged.credentials === true || merged.allowCredentials === true,
    methods: corsList(merged.methods),
    allowedHeaders: allowedHeaders ? (corsList(allowedHeaders) ?? "") : undefined,
    exposedHeaders: corsList(merged.exposedHeaders),
    maxAge: typeof maxAge === "number" || maxAge ? String(maxAge) : undefined,
    preflightContinue: Boolean(merged.preflightContinue),
    optionsSuccessStatus: merged.optionsSuccessStatus ?? 204,
  };
}

/** `cors`'s `isString`: boxed `String` objects count as strings too. */
function isString(value: unknown): boolean {
  return typeof value === "string" || value instanceof String;
}

/** `cors`'s `isOriginAllowed`: arrays recurse, strings compare, RegExps test. */
function isOriginAllowed(origin: string | undefined, allowed: StaticOrigin): boolean {
  if (Array.isArray(allowed)) return allowed.some((entry) => isOriginAllowed(origin, entry));
  // Boxed strings never equal a primitive origin, so they deny, exactly as in `cors`.
  if (isString(allowed)) return origin === allowed;
  if (allowed instanceof RegExp) return allowed.test(origin as string);
  return Boolean(allowed);
}

/** Resolves an origin callback, if any, then applies the headers. */
function handleCors(cors: CompiledCors, req: NativeRequest, res: NativeResponse, next: Next): void {
  const origin = cors.origin;
  if (typeof origin !== "function") {
    if (origin) applyCors(cors, origin, req, res, next);
    else next();
    return;
  }
  // As in `cors`, the callback also runs for requests without an Origin header.
  origin(req.headers.origin, (error, allowed) => {
    if (error || !allowed) next(error);
    else applyCors(cors, allowed, req, res, next);
  });
}

function applyCors(
  cors: CompiledCors,
  origin: StaticOrigin,
  req: NativeRequest,
  res: NativeResponse,
  next: Next,
): void {
  try {
    const requestOrigin = req.headers.origin;
    if (isString(origin) && String(origin) === "*") {
      res.setHeader("access-control-allow-origin", "*");
    } else if (isString(origin)) {
      res.setHeader("access-control-allow-origin", String(origin));
      res.vary("Origin");
    } else {
      // Evaluated even without an Origin header, so stateful /g RegExps advance as in `cors`.
      if (isOriginAllowed(requestOrigin, origin) && requestOrigin) {
        res.setHeader("access-control-allow-origin", requestOrigin);
      }
      res.vary("Origin");
    }
    if (cors.credentials) res.setHeader("access-control-allow-credentials", "true");
    if (req.method === "OPTIONS") {
      if (cors.methods) res.setHeader("access-control-allow-methods", cors.methods);
      let allowedHeaders = cors.allowedHeaders;
      if (allowedHeaders === undefined) {
        allowedHeaders = req.headers["access-control-request-headers"];
        res.vary("Access-Control-Request-Headers");
      }
      if (allowedHeaders) res.setHeader("access-control-allow-headers", allowedHeaders);
      if (cors.maxAge) res.setHeader("access-control-max-age", cors.maxAge);
    }
    if (cors.exposedHeaders) res.setHeader("access-control-expose-headers", cors.exposedHeaders);
    if (req.method === "OPTIONS" && !cors.preflightContinue) {
      // `cors` sends Content-Length: 0 so browsers do not wait for a body; it
      // matters for a non-204 optionsSuccessStatus, since every 204 response
      // drops Content-Length as RFC 9110 requires.
      res.status(cors.optionsSuccessStatus).setHeader("content-length", "0").end();
      return;
    }
  } catch (error) {
    next(error);
    return;
  }
  next();
}

/** Nest ExpressAdapter's check: `application/json*` or a `+json` suffix. */
function isJsonContentType(contentType: string): boolean {
  const mediaType = contentType.split(";")[0]!.trim().toLowerCase();
  return mediaType.startsWith("application/json") || mediaType.endsWith("+json");
}
