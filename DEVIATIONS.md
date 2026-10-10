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
  supported. Forwarded headers are interpreted only through Express's
  `trust proxy` semantics (`trustProxy` option or `app.set("trust proxy")`),
  off by default; Express's `req.secure`, `req.host` and `req.subdomains` are
  not provided. Multipart files are
  native `File` values in `@Body()`. Static files follow `express.static()`
  (serve-static and send), except that content types come from a built-in
  table of common web types, and on Bun a full response to a request with a
  `Range` header is sent without `Content-Length` above 1 MiB. CORS mirrors the `cors` package used by
  Nest's Express adapter (option merging, headers, `Vary`, preflight
  handling), except that a `204` preflight omits `Content-Length`,
  `methods: undefined` and `optionsSuccessStatus: undefined` do not fail the
  preflight, static options are read once, and the `allowCredentials` alias of
  earlier releases is still accepted.
  Cookies use Nest 12's own API: `@Cookies()`, `@SignedCookies()`,
  `setCookie()`/`clearCookie()` and `cookies.secret` work unchanged. As on
  Express, `req.cookies` and `req.signedCookies` are left to `cookie-parser`,
  which works unchanged. `res.cookie()`/`res.clearCookie()` follow Express,
  except that they can also sign with `cookies.secret`, a falsy `path` sends
  an empty `Path=` instead of none, Nest's serializer rejects
  `sameSite: "none"` and `partitioned` without `secure`, and the `encode`
  option throws. `res.vary()` skips empty entries where `vary` throws.
- `path-to-regexp` is a deliberate routing dependency; maintaining a custom
  path grammar would add unnecessary compatibility risk.
- Middleware path normalization uses Nest's internal `LegacyRouteConverter`,
  just like its Express adapter, and `res.cookie()` signs `cookie-parser`
  secrets with Nest's `@nestjs/core/helpers/cookies/cookie-signer.js` so the
  format stays byte-identical to Nest's; these are version-sensitive
  integration points.
- Redirects always return a plain-text body, rather than Express's optional
  Accept-negotiated HTML redirect page.
- Performance claims require separate benchmarks. Deno is no longer a target.

## Roadmap

### Phase 1: harden the supported baseline

- [x] lock in lifecycle behavior for `close()`, shutdown timeout, and connection aborts
- [x] add explicit regression coverage for repeated close, 503-on-closing, and listen failures
- [x] keep the Node/Bun conformance matrix aligned with Nest 12.1.2 and the documented API contract
- [x] interpret `X-Forwarded-*` headers through Express's `trust proxy` semantics

### Phase 2: expand supported real-world integrations

- [x] multipart/form-data and nested form parsing
- [x] static asset handling, `CORS` with `cors`-package parity, and cookies
- [x] HTTPS/TLS deployment guidance via a reverse proxy, without pretending to be a native HTTPS adapter
- [x] Nest `@Sse()` Observable streaming

### Phase 3: production readiness

- [x] add a reproducible local benchmark harness against Nest/Express
- [x] document operational caveats for proxying, TLS termination, streaming, uploads, and body-size limits
- [x] document the compatibility matrix and migration notes for Express/Fastify users
