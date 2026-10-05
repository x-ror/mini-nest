import {
  controllers,
  enhancers,
  parameters,
  redirects,
  responseHeaders,
  routes,
  statuses,
  versions,
} from "@mini-nest/common/internal/metadata";
import { normalizePath } from "@mini-nest/common/internal/path";
import { Scope } from "@mini-nest/common";
import { resolveArgument } from "../http/request-context.js";
import type { Route } from "./route.js";

function validateRouteParams(path: string, segments: string[]): void {
  const names = segments.filter((segment) => segment.startsWith(":"));
  const hasInvalidName = names.some((name) => !/^:[A-Za-z_]\w*$/.test(name));
  const hasDuplicateName = new Set(names).size !== names.length;
  if (hasInvalidName || hasDuplicateName) {
    throw new Error(`Invalid route parameters: ${path}`);
  }
}

function discoverPrototypeRoutes(
  controller: object,
  prototype: object,
  prefixes: string[],
  seen: Set<PropertyKey>,
): Route[] {
  const discovered: Route[] = [];
  for (const name of Reflect.ownKeys(prototype)) {
    if (seen.has(name)) continue;
    seen.add(name);

    const method: unknown = Object.getOwnPropertyDescriptor(prototype, name)?.value;
    if (typeof method !== "function") continue;
    const metadata = routes.get(method);
    if (!metadata) continue;

    const entries = parameters.get(prototype)?.get(name) ?? [];
    if (
      enhancers.has(method) ||
      responseHeaders.has(method) ||
      redirects.has(method) ||
      versions.has(method)
    ) {
      throw new Error(
        "Headers, redirects, versioning and enhancers are metadata-only until phases 3-4.",
      );
    }
    if (
      entries.some(
        (entry) =>
          entry.pipes.length ||
          entry.schema !== undefined ||
          !["body", "request", "query", "param"].includes(entry.source),
      )
    ) {
      throw new Error(
        "Extended parameter decorators and pipes are metadata-only until phases 3-4.",
      );
    }
    for (const prefix of prefixes) {
      for (const routePath of metadata.paths) {
        const path = normalizePath(`${prefix}/${routePath}`);
        const segments = path.split("/").filter(Boolean);
        validateRouteParams(path, segments);
        discovered.push({
          method: metadata.method,
          path,
          segments,
          status: statuses.get(method) ?? (metadata.method === "POST" ? 201 : 200),
          handler: (context, params) => {
            const args: unknown[] = entries.length ? [] : [context];
            for (const entry of entries) {
              args[entry.index] = resolveArgument(entry, context, params);
            }
            return method.apply(controller, args);
          },
        });
      }
    }
  }
  return discovered;
}

export function discoverControllerRoutes(controller: object): Route[] {
  const options = controllers.get(controller.constructor);
  if (options === undefined) {
    throw new Error("Registered instances must have a @Controller decorator.");
  }
  if (
    options.host !== undefined ||
    options.version !== undefined ||
    (options.scope !== undefined && options.scope !== Scope.DEFAULT) ||
    options.durable
  ) {
    throw new Error("Controller options and enhancers are metadata-only until later phases.");
  }
  let controllerType: object | null = controller.constructor;
  while (controllerType && controllerType !== Function.prototype) {
    if (enhancers.has(controllerType)) {
      throw new Error("Controller enhancers are metadata-only until phase 4.");
    }
    controllerType = Object.getPrototypeOf(controllerType);
  }
  const prefixes = typeof options.path === "string" ? [options.path] : (options.path ?? [""]);

  const discovered: Route[] = [];
  const seen = new Set<PropertyKey>();
  let prototype: object | null = Object.getPrototypeOf(controller);
  while (prototype && prototype !== Object.prototype) {
    discovered.push(...discoverPrototypeRoutes(controller, prototype, prefixes, seen));
    prototype = Object.getPrototypeOf(prototype);
  }
  return discovered;
}
