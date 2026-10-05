import { normalizePath } from "@mini-nest/common/internal/path";
import type { Route, RouteMatch } from "./route.js";

function routeSignature(route: Route): string {
  return `${route.method} ${route.path.replace(/:[^/]+/g, ":")}`;
}

function compareSpecificity(first: Route, second: Route): number {
  const sharedLength = Math.min(first.segments.length, second.segments.length);
  for (let index = 0; index < sharedLength; index++) {
    const firstIsParameter = first.segments[index]!.startsWith(":");
    const secondIsParameter = second.segments[index]!.startsWith(":");
    const difference = Number(firstIsParameter) - Number(secondIsParameter);
    if (difference) return difference;
  }
  return 0;
}

export class Router {
  private readonly routes: Route[] = [];
  private readonly signatures = new Set<string>();
  private prefixSegments: string[] = [];

  setGlobalPrefix(prefix: string): void {
    this.prefixSegments = normalizePath(prefix).split("/").filter(Boolean);
  }

  register(routes: Route[]): void {
    const pendingSignatures = new Set<string>();
    for (const route of routes) {
      const signature = routeSignature(route);
      if (this.signatures.has(signature) || pendingSignatures.has(signature)) {
        throw new Error(`Duplicate route: ${route.method} ${route.path}`);
      }
      pendingSignatures.add(signature);
    }

    for (const signature of pendingSignatures) this.signatures.add(signature);
    this.routes.push(...routes);
    this.routes.sort(compareSpecificity);
  }

  match(method: string, path: string): RouteMatch | undefined {
    const segments = normalizePath(path).split("/").filter(Boolean);
    const matchesPrefix = this.prefixSegments.every(
      (segment, index) => segments[index] === segment,
    );
    if (!matchesPrefix) return undefined;

    const localSegments = segments.slice(this.prefixSegments.length);
    const route = this.routes.find(
      (candidate) =>
        (candidate.method === method || candidate.method === "ALL") &&
        candidate.segments.length === localSegments.length &&
        candidate.segments.every(
          (segment, index) => segment.startsWith(":") || segment === localSegments[index],
        ),
    );
    return route ? { route, segments: localSegments } : undefined;
  }
}
