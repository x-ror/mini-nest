import type { HttpMethod } from "@mini-nest/common/internal/metadata";
import type { RequestContext, RouteParams } from "../http/request-context.js";

export interface Route {
  method: HttpMethod;
  path: string;
  segments: string[];
  status: number;
  handler(context: RequestContext, params: RouteParams): unknown;
}

export interface RouteMatch {
  route: Route;
  segments: string[];
}

export function decodeRouteParams(match: RouteMatch): RouteParams {
  const params: RouteParams = Object.create(null);
  match.route.segments.forEach((segment, index) => {
    if (segment.startsWith(":")) {
      params[segment.slice(1)] = decodeURIComponent(match.segments[index]!);
    }
  });
  return params;
}
