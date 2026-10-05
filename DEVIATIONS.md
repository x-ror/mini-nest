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
  SSE, WebSocket upgrades, Node response events, Express plugins, multipart,
  nested forms, custom parsers, MVC/static files, HTTPS, and non-URI versioning
  remain outside the initial implementation. Basic CORS headers and preflight
  handling are supported through the adapter middleware API.
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
- multipart/form-data and nested form parsing
- static asset handling and `CORS`
- HTTPS/TLS deployment guidance via a reverse proxy, without pretending to be a native HTTPS adapter
- SSE/streaming patterns that fit the native fetch response model

### Phase 3: production readiness
- benchmark the adapters on representative workloads under real traffic
- document operational caveats for proxying, TLS termination, and body-size limits
- ship a clear compatibility matrix and migration notes for Express/Fastify users
