import { controllers, parameters, routes, statuses } from "@mini-nest/common/internal/metadata";
import { normalizePath } from "@mini-nest/common/internal/path";
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
  prefix: string,
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

    const path = normalizePath(`${prefix}/${metadata.path}`);
    const segments = path.split("/").filter(Boolean);
    validateRouteParams(path, segments);
    const entries = parameters.get(prototype)?.get(name) ?? [];
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
  return discovered;
}

export function discoverControllerRoutes(controller: object): Route[] {
  const prefix = controllers.get(controller.constructor);
  if (prefix === undefined) {
    throw new Error("Registered instances must have a @Controller decorator.");
  }

  const discovered: Route[] = [];
  const seen = new Set<PropertyKey>();
  let prototype: object | null = Object.getPrototypeOf(controller);
  while (prototype && prototype !== Object.prototype) {
    discovered.push(...discoverPrototypeRoutes(controller, prototype, prefix, seen));
    prototype = Object.getPrototypeOf(prototype);
  }
  return discovered;
}
