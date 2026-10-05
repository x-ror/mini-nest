import type { RequestHandler } from "@mini-nest/common";
import { normalizePath } from "@mini-nest/common/internal/path";
import { decodeRouteParams } from "../routing/route.js";
import type { Router } from "../routing/router.js";
import { parseBody, type RequestContext, type RouteParams } from "./request-context.js";
import { createErrorResponse, createResponse, omitResponseBody } from "./response.js";

export function createRequestHandler(router: Router): RequestHandler {
  return async (request) => {
    const path = normalizePath(new URL(request.url).pathname);
    const match = router.match(request.method, path);
    if (!match) return createErrorResponse(404, "Not Found");

    let context: RequestContext;
    let params: RouteParams;
    try {
      params = decodeRouteParams(match);
      context = { request, body: await parseBody(request) };
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof URIError) {
        return createErrorResponse(400, "Bad Request");
      }
      console.error(`Request parsing failed: ${request.method} ${path}`, error);
      return createErrorResponse(500, "Internal Server Error");
    }

    try {
      const value = await match.route.handler(context, params);
      const response = createResponse(value, match.route.status);
      return request.method === "HEAD" ? omitResponseBody(response) : response;
    } catch (error) {
      console.error(`Request failed: ${request.method} ${path}`, error);
      return createErrorResponse(500, "Internal Server Error");
    }
  };
}
