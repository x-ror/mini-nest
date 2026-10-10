import { createReadStream, openAsBlob, type Stats } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { StreamableFile } from "@nestjs/common";
import type { NativeRequest } from "./request.js";
import type { NativeResponse } from "./response.js";
import type { Handler, Next } from "./router.js";

/**
 * The options of `express.static()` (serve-static and send) that these
 * adapters implement, plus Nest's `prefix`. `maxAge` is in milliseconds or a
 * duration string such as `"1d"`, as on Express.
 */
export interface StaticAssetsOptions {
  prefix?: string;
  /** Index file name(s) for directory requests; `false` disables them. Default `index.html`. */
  index?: string | string[] | false;
  maxAge?: number | string;
  maxage?: number | string;
  immutable?: boolean;
  etag?: boolean;
  lastModified?: boolean;
  cacheControl?: boolean;
  acceptRanges?: boolean;
  /** `ignore` (default) and `deny` hide paths with a segment starting with a dot. */
  dotfiles?: "allow" | "deny" | "ignore";
  /** Redirect a directory requested without a trailing slash. Default `true`. */
  redirect?: boolean;
  /** Pass misses and client errors to the next handler. Default `true`. */
  fallthrough?: boolean;
  /** Extensions to try when a path without one is not found, e.g. `["html"]`. */
  extensions?: string[] | false;
  /** Called before the default headers are set, like serve-static's `setHeaders`. */
  setHeaders?: (res: NativeResponse, path: string, stat: Stats) => void;
}

const MAX_MAXAGE = 60 * 60 * 24 * 365 * 1000;
const FULL_BODY_IN_MEMORY = 1024 * 1024;
const UP_PATH = /(?:^|[\\/])\.\.(?:[\\/]|$)/;
const BYTES_RANGE = /^ *bytes=/;

/** The content types mime-types 3 (used by send) gives these extensions. */
const CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  cjs: "application/node",
  json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8",
  webmanifest: "application/manifest+json; charset=utf-8",
  jsonld: "application/ld+json",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  yaml: "text/yaml; charset=utf-8",
  yml: "text/yaml; charset=utf-8",
  xml: "application/xml",
  svg: "image/svg+xml",
  png: "image/png",
  apng: "image/apng",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/vnd.microsoft.icon",
  bmp: "image/bmp",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  eot: "application/vnd.ms-fontobject",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  wav: "audio/wav",
  pdf: "application/pdf",
  zip: "application/zip",
  gz: "application/gzip",
  tar: "application/x-tar",
  wasm: "application/wasm",
};

/** An error shaped like http-errors, which Nest's exception filter answers with its status. */
function httpError(status: number, message: string, headers?: Record<string, string>) {
  return Object.assign(new Error(message), { status, statusCode: status, expose: true, headers });
}
const MESSAGES: Record<number, string> = {
  400: "Bad Request",
  403: "Forbidden",
  404: "Not Found",
  412: "Precondition Failed",
  416: "Range Not Satisfiable",
  500: "Internal Server Error",
};

/** `ms`-style durations, as accepted by send's `maxAge`. */
function parseMaxAge(value: number | string | undefined): number {
  let milliseconds: number;
  if (typeof value === "string") {
    const match =
      /^(-?\d*\.?\d+)\s*(ms|msecs?|milliseconds?|s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?|w|weeks?|y|yrs?|years?)?$/i.exec(
        value.trim(),
      );
    if (!match) milliseconds = Number.NaN;
    else {
      const unit = (match[2] ?? "ms").toLowerCase();
      const scale =
        unit.startsWith("ms") || unit.startsWith("milli")
          ? 1
          : unit.startsWith("s")
            ? 1000
            : unit.startsWith("m")
              ? 60_000
              : unit.startsWith("h")
                ? 3_600_000
                : unit.startsWith("d")
                  ? 86_400_000
                  : unit.startsWith("w")
                    ? 604_800_000
                    : 31_557_600_000;
      milliseconds = Number(match[1]) * scale;
    }
  } else milliseconds = Number(value ?? 0);
  return Number.isNaN(milliseconds) ? 0 : Math.min(Math.max(0, milliseconds), MAX_MAXAGE);
}

/** send's token list parser for If-Match / If-None-Match. */
function parseTokenList(value: string): string[] {
  const list: string[] = [];
  let start = 0;
  let end = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 0x20) {
      if (start === end) start = end = i + 1;
    } else if (code === 0x2c) {
      if (start !== end) list.push(value.slice(start, end));
      start = end = i + 1;
    } else end = i + 1;
  }
  if (start !== end) list.push(value.slice(start, end));
  return list;
}

const parseHttpDate = (value: string | undefined): number =>
  typeof value === "string" ? Date.parse(value) : Number.NaN;

type Range = { start: number; end: number };

/** range-parser 1.3 with `combine: true`: -2 is malformed, -1 unsatisfiable. */
function parseRange(size: number, header: string): Range[] | -1 | -2 {
  const equals = header.indexOf("=");
  if (equals === -1) return -2;
  const ranges: (Range & { index: number })[] = [];
  const parts = header.slice(equals + 1).split(",");
  for (const part of parts) {
    const dash = part.indexOf("-");
    if (dash === -1) return -2;
    const startText = part.slice(0, dash).trim();
    const endText = part.slice(dash + 1).trim();
    const position = (text: string) => (/^\d+$/.test(text) ? Number(text) : Number.NaN);
    let start = position(startText);
    let end = position(endText);
    if (startText.length === 0) {
      start = size - end;
      end = size - 1;
    } else if (endText.length === 0) {
      end = size - 1;
    }
    if (end > size - 1) end = size - 1;
    if (Number.isNaN(start) || Number.isNaN(end)) return -2;
    if (start > end || start < 0) continue;
    ranges.push({ start, end, index: ranges.length });
  }
  if (!ranges.length) return -1;
  const ordered = [...ranges].sort((a, b) => a.start - b.start);
  let j = 0;
  for (let i = 1; i < ordered.length; i++) {
    const range = ordered[i]!;
    const current = ordered[j]!;
    if (range.start > current.end + 1) ordered[++j] = range;
    else if (range.end > current.end) {
      current.end = range.end;
      current.index = Math.min(current.index, range.index);
    }
  }
  ordered.length = j + 1;
  return ordered.sort((a, b) => a.index - b.index).map(({ start, end }) => ({ start, end }));
}

/** The `fresh` package: whether a conditional GET can be answered with 304. */
function isFresh(req: NativeRequest, res: NativeResponse): boolean {
  const modifiedSince = req.headers["if-modified-since"];
  const noneMatch = req.headers["if-none-match"];
  if (!modifiedSince && !noneMatch) return false;
  const cacheControl = req.headers["cache-control"];
  if (cacheControl && /(?:^|,)\s*?no-cache\s*?(?:,|$)/.test(cacheControl)) return false;
  if (noneMatch) {
    if (noneMatch === "*") return true;
    const etag = res.getHeader("etag") as string | undefined;
    if (!etag) return false;
    return parseTokenList(noneMatch).some(
      (match) => match === etag || match === `W/${etag}` || `W/${match}` === etag,
    );
  }
  const lastModified = res.getHeader("last-modified") as string | undefined;
  return Boolean(lastModified) && parseHttpDate(lastModified) <= parseHttpDate(modifiedSince);
}

function isPreconditionFailure(req: NativeRequest, res: NativeResponse): boolean {
  const match = req.headers["if-match"];
  if (match) {
    const etag = res.getHeader("etag") as string | undefined;
    return (
      !etag ||
      (match !== "*" &&
        parseTokenList(match).every(
          (token) => token !== etag && token !== `W/${etag}` && `W/${token}` !== etag,
        ))
    );
  }
  const unmodifiedSince = parseHttpDate(req.headers["if-unmodified-since"]);
  if (!Number.isNaN(unmodifiedSince)) {
    const lastModified = parseHttpDate(res.getHeader("last-modified") as string | undefined);
    return Number.isNaN(lastModified) || lastModified > unmodifiedSince;
  }
  return false;
}

function isRangeFresh(req: NativeRequest, res: NativeResponse): boolean {
  const ifRange = req.headers["if-range"];
  if (!ifRange) return true;
  if (ifRange.includes('"')) {
    const etag = res.getHeader("etag") as string | undefined;
    return Boolean(etag && ifRange.includes(etag));
  }
  return (
    parseHttpDate(res.getHeader("last-modified") as string | undefined) <= parseHttpDate(ifRange)
  );
}

/** The escape-html package. */
const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]!);

/** The encodeurl package: percent-encodes what is not allowed in a URL, keeping valid escapes. */
const encodeUrl = (url: string) =>
  url.replace(
    /(?:[^\x21\x23-\x3B\x3D\x3F-\x5F\x61-\x7A\x7C\x7E]|%(?:[^0-9A-Fa-f]|[0-9A-Fa-f][^0-9A-Fa-f]|$))+/g,
    (match) => encodeURI(match),
  );

const htmlDocument = (title: string, body: string) =>
  `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>${title}</title>\n</head>\n<body>\n<pre>${body}</pre>\n</body>\n</html>\n`;

/**
 * `express.static()` for the native adapters: conditional GET (ETag,
 * Last-Modified, 304/412), single byte ranges (206/416, If-Range), dotfile
 * handling, directory redirects and streamed bodies, following serve-static 2
 * and send 1. The prefix is matched per path segment, case-insensitively, like
 * an Express mount path.
 */
export function serveStatic(root: string, options: StaticAssetsOptions = {}): Handler {
  const rootPath = resolve(root);
  const prefix = (options.prefix ?? "/").replace(/\/+$/, "") || "/";
  const prefixLower = prefix.toLowerCase();
  const index =
    options.index === false ? [] : ([] as string[]).concat(options.index ?? "index.html");
  const maxAge = parseMaxAge(options.maxAge ?? options.maxage);
  const etagEnabled = options.etag !== false;
  const lastModifiedEnabled = options.lastModified !== false;
  const cacheControlEnabled = options.cacheControl !== false;
  const acceptRanges = options.acceptRanges !== false;
  const dotfiles = options.dotfiles ?? "ignore";
  const redirect = options.redirect !== false;
  const fallthrough = options.fallthrough !== false;
  const extensions = options.extensions ? options.extensions : [];

  return (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      if (fallthrough) return next();
      res.status(405).setHeader("allow", "GET, HEAD").setHeader("content-length", "0").end();
      return;
    }
    // Mounted like Express: "/assets" and "/assets/..." match, "/assetsx" does not.
    let path = req.path;
    if (prefix !== "/") {
      const lower = path.toLowerCase();
      if (lower === prefixLower) path = "";
      else if (lower.startsWith(`${prefixLower}/`)) path = path.slice(prefix.length);
      else return next();
    }
    let fileFound = false;
    const fail = (status: number, headers?: Record<string, string>): void => {
      // Like serve-static: before a file is found, misses and client errors fall through.
      if (fallthrough && !fileFound && status < 500) return next();
      next(httpError(status, MESSAGES[status] ?? "Error", headers));
    };
    void handle(path, req, res, fail, () => (fileFound = true), next).catch(next);
  };

  async function handle(
    path: string,
    req: NativeRequest,
    res: NativeResponse,
    fail: (status: number, headers?: Record<string, string>) => void,
    found: () => void,
    next: Next,
  ): Promise<void> {
    let decoded: string;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      return fail(400);
    }
    if (decoded.includes("\0")) return fail(400);
    const relativePath = decoded ? normalize(`.${sep}${decoded}`) : decoded;
    if (UP_PATH.test(relativePath)) return fail(403);
    const parts = relativePath.split(sep);
    if (parts.some((part) => part.length > 1 && part[0] === ".") && dotfiles !== "allow") {
      return fail(dotfiles === "deny" ? 403 : 404);
    }
    const target = normalize(join(rootPath, relativePath));
    // Defense in depth: the target must stay inside the root.
    if (
      target !== rootPath &&
      !target.startsWith(rootPath.endsWith(sep) ? rootPath : rootPath + sep)
    ) {
      return fail(403);
    }
    const trailingSlash = path.endsWith("/");

    const statOrError = async (file: string): Promise<Stats | NodeJS.ErrnoException> => {
      try {
        return await stat(file);
      } catch (error) {
        return error as NodeJS.ErrnoException;
      }
    };
    const statError = (error: NodeJS.ErrnoException): void => {
      if (["ENOENT", "ENOTDIR", "ENAMETOOLONG"].includes(error.code ?? "")) return fail(404);
      next(error);
    };

    if (index.length && trailingSlash) {
      let lastError: NodeJS.ErrnoException | undefined;
      for (const name of index) {
        const candidate = join(target, name);
        const result = await statOrError(candidate);
        if (result instanceof Error) {
          lastError = result;
          continue;
        }
        if (result.isDirectory()) continue;
        found();
        return send(candidate, result, req, res, fail);
      }
      return lastError ? statError(lastError) : fail(404);
    }

    const result = await statOrError(target);
    if (result instanceof Error) {
      if (result.code === "ENOENT" && !extname(target) && !target.endsWith(sep)) {
        for (const extension of extensions) {
          const candidate = `${target}.${extension}`;
          const extra = await statOrError(candidate);
          if (extra instanceof Error || extra.isDirectory()) continue;
          found();
          return send(candidate, extra, req, res, fail);
        }
      }
      return statError(result);
    }
    if (result.isDirectory()) {
      if (!redirect || trailingSlash) return fail(404);
      const query = req.originalUrl.indexOf("?");
      const pathname = query === -1 ? req.originalUrl : req.originalUrl.slice(0, query);
      const location = encodeUrl(
        `${pathname.replace(/^\/+/, "/")}/${query === -1 ? "" : req.originalUrl.slice(query)}`,
      );
      const document = htmlDocument("Redirecting", `Redirecting to ${escapeHtml(location)}`);
      res
        .status(301)
        .setHeader("content-type", "text/html; charset=UTF-8")
        .setHeader("content-length", String(Buffer.byteLength(document)))
        .setHeader("content-security-policy", "default-src 'none'")
        .setHeader("x-content-type-options", "nosniff")
        .setHeader("location", location)
        .end(document);
      return;
    }
    if (trailingSlash) return fail(404);
    found();
    return send(target, result, req, res, fail);
  }

  async function send(
    file: string,
    stats: Stats,
    req: NativeRequest,
    res: NativeResponse,
    fail: (status: number, headers?: Record<string, string>) => void,
  ): Promise<void> {
    options.setHeaders?.(res, file, stats);
    if (acceptRanges && !res.hasHeader("accept-ranges")) res.setHeader("accept-ranges", "bytes");
    if (cacheControlEnabled && !res.hasHeader("cache-control")) {
      res.setHeader(
        "cache-control",
        `public, max-age=${Math.floor(maxAge / 1000)}${options.immutable ? ", immutable" : ""}`,
      );
    }
    if (lastModifiedEnabled && !res.hasHeader("last-modified")) {
      res.setHeader("last-modified", stats.mtime.toUTCString());
    }
    if (etagEnabled && !res.hasHeader("etag")) {
      res.setHeader("etag", `W/"${stats.size.toString(16)}-${stats.mtime.getTime().toString(16)}"`);
    }
    if (!res.hasHeader("content-type")) {
      res.setHeader(
        "content-type",
        CONTENT_TYPES[extname(file).slice(1).toLowerCase()] ?? "application/octet-stream",
      );
    }

    const headers = req.headers;
    if (
      headers["if-match"] ||
      headers["if-unmodified-since"] ||
      headers["if-none-match"] ||
      headers["if-modified-since"]
    ) {
      if (isPreconditionFailure(req, res)) return fail(412);
      const status = res.statusCode;
      if (((status >= 200 && status < 300) || status === 304) && isFresh(req, res)) {
        for (const name of [
          "content-encoding",
          "content-language",
          "content-length",
          "content-range",
          "content-type",
        ]) {
          res.removeHeader(name);
        }
        res.status(304).end();
        return;
      }
    }

    let offset = 0;
    let length = stats.size;
    const rangeHeader = headers.range;
    if (acceptRanges && rangeHeader && BYTES_RANGE.test(rangeHeader)) {
      let ranges = parseRange(length, rangeHeader);
      if (!isRangeFresh(req, res)) ranges = -2;
      if (ranges === -1) {
        const contentRange = `bytes */${length}`;
        res.setHeader("content-range", contentRange);
        return fail(416, { "Content-Range": contentRange });
      }
      if (ranges !== -2 && ranges.length === 1) {
        const range = ranges[0]!;
        res.status(206).setHeader("content-range", `bytes ${range.start}-${range.end}/${length}`);
        offset = range.start;
        length = range.end - range.start + 1;
      }
    }
    res.setHeader("content-length", String(length));
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    // A file-backed Blob reads lazily, keeps its length on Bun and slices ranges cheaply.
    const blob = await openAsBlob(file);
    if (rangeHeader && res.statusCode === 200) {
      // Bun applies Range to file-backed bodies itself, even when the full file is
      // the right answer (If-Range stale, several ranges, acceptRanges: false).
      // Small files go out from memory; larger ones stream (on Bun, without Content-Length).
      if (length <= FULL_BODY_IN_MEMORY) res.send(new Uint8Array(await blob.arrayBuffer()));
      else res.send(new StreamableFile(createReadStream(file)));
      return;
    }
    res.send(blob.slice(offset, offset + length));
  }
}
