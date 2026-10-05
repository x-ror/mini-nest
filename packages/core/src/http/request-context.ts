import type { ParameterMetadata } from "@mini-nest/common/internal/metadata";

export interface RequestContext {
  request: Request;
  body: unknown;
}

export type RouteParams = Record<string, string>;

function selectProperty(value: unknown, key?: string): unknown {
  if (key === undefined) return value;
  if (typeof value !== "object" || value === null || !Object.hasOwn(value, key)) {
    return undefined;
  }
  return Reflect.get(value, key);
}

export function resolveArgument(
  parameter: ParameterMetadata,
  context: RequestContext,
  params: RouteParams,
): unknown {
  switch (parameter.source) {
    case "request":
      return context.request;
    case "body":
      return selectProperty(context.body, parameter.key);
    case "param":
      return selectProperty(params, parameter.key);
    case "query": {
      const query = new URL(context.request.url).searchParams;
      return parameter.key === undefined
        ? Object.fromEntries(query)
        : (query.get(parameter.key) ?? undefined);
    }
  }
}

export async function parseBody(request: Request): Promise<unknown> {
  if (request.method === "GET" || request.method === "HEAD") return undefined;

  const text = await request.text();
  const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  const isJson = contentType === "application/json" || contentType?.endsWith("+json");

  if (text && isJson) return JSON.parse(text);
  if (contentType === "text/plain") return text;
  return undefined;
}
