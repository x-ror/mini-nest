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
  nested forms, custom parsers, MVC/static files, HTTPS, CORS, and non-URI
  versioning remain outside the initial implementation.
- `path-to-regexp` is a deliberate routing dependency; maintaining a custom
  path grammar would add unnecessary compatibility risk.
- Middleware path normalization uses Nest's internal `LegacyRouteConverter`,
  just like its Express adapter; this is a version-sensitive integration point.
- Redirects always return a plain-text body, rather than Express's optional
  Accept-negotiated HTML redirect page.
- Performance claims require separate benchmarks. Deno is no longer a target.
