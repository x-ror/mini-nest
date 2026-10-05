import {
  controllers,
  injectable,
  injections,
  modules,
  parameters,
  routes,
  statuses,
  type HttpMethod,
  type ModuleMetadata,
  type ParameterMetadata,
  type Type,
} from "./internal/metadata.js";
import { normalizePath } from "./internal/path.js";

export function Module(metadata: ModuleMetadata) {
  return (target: Type): void => {
    modules.set(target, {
      imports: [...(metadata.imports ?? [])],
      controllers: [...(metadata.controllers ?? [])],
      providers: [...(metadata.providers ?? [])],
      exports: [...(metadata.exports ?? [])],
    });
  };
}

export function Injectable(): ClassDecorator {
  return (target) => {
    injectable.add(target);
  };
}

export function Inject(token: Type): ParameterDecorator {
  return (target, property, index) => {
    if (property !== undefined || typeof target !== "function") {
      throw new Error("@Inject requires a constructor parameter.");
    }
    if (typeof token !== "function") {
      throw new Error("@Inject requires a class token.");
    }
    const entries = injections.get(target) ?? new Map<number, Type>();
    if (entries.has(index)) {
      throw new Error("A constructor parameter may have only one @Inject decorator.");
    }
    entries.set(index, token);
    injections.set(target, entries);
  };
}

export function Controller(prefix = ""): ClassDecorator {
  return (target) => {
    controllers.set(target, normalizePath(prefix));
  };
}

function route(method: HttpMethod, path: string): MethodDecorator {
  return (target, _key, descriptor) => {
    if (typeof target === "function" || typeof descriptor.value !== "function") {
      throw new Error("Route decorators require instance methods.");
    }
    if (routes.has(descriptor.value)) {
      throw new Error("A handler may have only one route decorator.");
    }
    routes.set(descriptor.value, { method, path: normalizePath(path) });
  };
}

export const Get = (path = "") => route("GET", path);
export const Post = (path = "") => route("POST", path);
export const Put = (path = "") => route("PUT", path);
export const Patch = (path = "") => route("PATCH", path);
export const Delete = (path = "") => route("DELETE", path);
export const Options = (path = "") => route("OPTIONS", path);
export const Head = (path = "") => route("HEAD", path);

export function HttpCode(status: number): MethodDecorator {
  if (!Number.isInteger(status) || status < 200 || status > 599) {
    throw new Error("@HttpCode requires an integer from 200 to 599.");
  }
  return (_target, _key, descriptor) => {
    if (typeof descriptor.value !== "function") {
      throw new Error("@HttpCode requires a method.");
    }
    statuses.set(descriptor.value, status);
  };
}

function parameter(source: ParameterMetadata["source"], key?: string): ParameterDecorator {
  return (target, property, index) => {
    if (property === undefined || typeof target === "function") {
      throw new Error("Request parameter decorators require instance methods.");
    }
    const metadata = parameters.get(target) ?? new Map();
    const entries: ParameterMetadata[] = metadata.get(property) ?? [];
    if (entries.some((entry) => entry.index === index)) {
      throw new Error("A parameter may have only one request decorator.");
    }
    entries.push({ index, source, key });
    metadata.set(property, entries);
    parameters.set(target, metadata);
  };
}

export const Body = (key?: string) => parameter("body", key);
export const Req = () => parameter("request");
export const Query = (key?: string) => parameter("query", key);
export const Param = (key?: string) => parameter("param", key);
