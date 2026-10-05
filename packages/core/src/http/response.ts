const BODYLESS_STATUSES = new Set([204, 205, 304]);

export function createResponse(value: unknown, status: number): Response {
  if (BODYLESS_STATUSES.has(status)) return new Response(null, { status });
  if (value instanceof Response) return value;
  if (value === undefined) return new Response(null, { status });
  if (typeof value === "string") {
    return new Response(value, {
      status,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  return Response.json(value, {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export function createErrorResponse(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

export function omitResponseBody(response: Response): Response {
  return new Response(null, {
    status: response.status,
    headers: response.headers,
  });
}
