import { RequestMethod, type ControllerOptions, type VersionValue } from "../interfaces.js";
import {
  controllers,
  redirects,
  responseHeaders,
  routes,
  statuses,
  versions,
  type HttpMethod,
} from "../internal/route-metadata.js";
import { normalizePath } from "../internal/path.js";

function paths(value: string | string[]): string[] {
  const entries = typeof value === "string" ? [value] : value;
  if (!entries.length || entries.some((entry) => typeof entry !== "string")) {
    throw new Error("Route paths must be a string or a nonempty array of strings.");
  }
  return entries.map(normalizePath);
}

export function Controller(
  prefixOrOptions: string | string[] | ControllerOptions = "",
): ClassDecorator {
  const options: ControllerOptions =
    typeof prefixOrOptions === "string" || Array.isArray(prefixOrOptions)
      ? { path: prefixOrOptions }
      : { ...prefixOrOptions };
  const normalized = paths(options.path ?? "");
  return (target) => {
    controllers.set(target, { ...options, path: normalized });
  };
}

function handler(target: object, descriptor: PropertyDescriptor): Function {
  if (typeof target === "function" || typeof descriptor.value !== "function") {
    throw new Error("Route decorators require instance methods.");
  }
  return descriptor.value;
}

function route(method: HttpMethod, path: string | string[]): MethodDecorator {
  const normalized = paths(path);
  return (target, _key, descriptor) => {
    const value = handler(target, descriptor);
    if (routes.has(value)) throw new Error("A handler may have only one route decorator.");
    routes.set(value, { method, paths: normalized });
  };
}

export function RequestMapping(
  metadata: { path?: string | string[]; method?: RequestMethod } = {},
): MethodDecorator {
  const method = RequestMethod[metadata.method ?? RequestMethod.GET];
  if (typeof method !== "string") throw new Error("Invalid request method.");
  return route(method as HttpMethod, metadata.path ?? "");
}

export const Get = (path: string | string[] = "") => route("GET", path);
export const Post = (path: string | string[] = "") => route("POST", path);
export const Put = (path: string | string[] = "") => route("PUT", path);
export const Patch = (path: string | string[] = "") => route("PATCH", path);
export const Delete = (path: string | string[] = "") => route("DELETE", path);
export const Options = (path: string | string[] = "") => route("OPTIONS", path);
export const Head = (path: string | string[] = "") => route("HEAD", path);
export const All = (path: string | string[] = "") => route("ALL", path);
export const Search = (path: string | string[] = "") => route("SEARCH", path);

export function HttpCode(status: number): MethodDecorator {
  if (!Number.isInteger(status) || status < 200 || status > 599) {
    throw new Error("@HttpCode requires an integer from 200 to 599.");
  }
  return (target, _key, descriptor) => {
    statuses.set(handler(target, descriptor), status);
  };
}

export function Header(name: string, value: string | (() => string)): MethodDecorator {
  if (
    !/^[!#$%&'*+.^_`|~\w-]+$/.test(name) ||
    (typeof value !== "string" && typeof value !== "function")
  ) {
    throw new Error("@Header requires a valid header name and a string or value factory.");
  }
  if (typeof value === "string" && /[\r\n]/.test(value)) throw new Error("Invalid header value.");
  return (target, _key, descriptor) => {
    const method = handler(target, descriptor);
    const entries = responseHeaders.get(method) ?? new Map();
    entries.set(name, value);
    responseHeaders.set(method, entries);
  };
}

export function Redirect(url = "", statusCode = 302): MethodDecorator {
  if (!Number.isInteger(statusCode) || statusCode < 300 || statusCode > 399) {
    throw new Error("@Redirect requires a redirect status.");
  }
  return (target, _key, descriptor) => {
    redirects.set(handler(target, descriptor), { url, statusCode });
  };
}

export function Version(version: VersionValue): MethodDecorator {
  return (target, _key, descriptor) => {
    versions.set(handler(target, descriptor), version);
  };
}
