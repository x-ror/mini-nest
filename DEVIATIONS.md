# Compatibility boundaries

The project has pivoted from an alternative framework to native adapters for
actual NestJS. Its old architecture plan and implementation survive in Git
history, not active workspace packages.

- NestJS 12.1.2 is the verified peer baseline. No Nest core behavior is reimplemented.
- Node and Bun share a fetch-compatible request/response facade. They do not
  provide Express/Fastify objects or pretend to support their plugins.
- Bun uses `Bun.serve`, not `node:http` running under Bun. Its native server is
  wrapped only for Nest's event/address listen contract.
- Requests and responses use the supported fields/APIs documented in README.
  Express plugins, Multer options beyond memory storage, WebSocket namespaces, and response
  events on Bun remain outside the implementation. Nest `@Sse()` Observable
  routes, `res.write()` streaming, opt-in text/raw body parsers, all Nest
  versioning types, and native HTTPS via `httpsOptions` (untested on Bun) are
  supported. Forwarded headers are not interpreted by the adapter. Multipart files are
  native `File` values in `@Body()`. Basic static file serving, CORS headers,
  and preflight handling are supported through the adapter middleware API.
- `path-to-regexp` is a deliberate routing dependency; maintaining a custom
  path grammar would add unnecessary compatibility risk.
- Middleware path normalization uses Nest's internal `LegacyRouteConverter`,
  just like its Express adapter; this is a version-sensitive integration point.
- Redirects always return a plain-text body, rather than Express's optional
  Accept-negotiated HTML redirect page.
- Performance claims require separate benchmarks. Deno is no longer a target.

## Roadmap

### Phase 1: harden the supported baseline

- lock in lifecycle behavior for `close()`, shutdown timeout, and connection aborts
- add explicit regression coverage for repeated close, 503-on-closing, and listen failures
- keep the Node/Bun conformance matrix aligned with Nest 12.1.2 and the documented API contract

### Phase 2: expand supported real-world integrations

- [x] multipart/form-data and nested form parsing
- [x] static asset handling and `CORS`
- [x] HTTPS/TLS deployment guidance via a reverse proxy, without pretending to be a native HTTPS adapter
- [x] Nest `@Sse()` Observable streaming

### Phase 3: production readiness

- [x] add a reproducible local benchmark harness against Nest/Express
- [x] document operational caveats for proxying, TLS termination, streaming, uploads, and body-size limits
- [x] document the compatibility matrix and migration notes for Express/Fastify users
