# nest-native-adapters

Experimental native HTTP adapters for **real NestJS**: `node:http` on Node.js and
`Bun.serve` on Bun. This is not an alternative Nest core. Nest owns modules, DI,
decorators, guards, pipes, interceptors, exception filters, and application lifecycle.

## Packages

| Package               | Role                                     |
| --------------------- | ---------------------------------------- |
| `nestjs-adapter-node` | `NodeHttpAdapter`, backed by `node:http` |
| `nestjs-adapter-bun`  | `BunHttpAdapter`, backed by `Bun.serve`  |

The two adapters include shared router, request parsing, and response code in their builds.
`shared/` is internal source, not a separate npm package.
Run `pnpm run build` before packing or publishing either adapter; only `dist/` is shipped. Packages are not published to npm yet; see Releasing below. Supported baseline:
NestJS **12.1.2**, Node.js 22+, current Bun. Other Nest versions are not yet verified.
Neither adapter uses Express or Fastify. Express is a test-only reference and
Fastify a benchmark-only one.

## Compatibility matrix

| Capability                                           | Node adapter | Bun adapter   | Notes                                                        |
| ---------------------------------------------------- | ------------ | ------------- | ------------------------------------------------------------ |
| Nest baseline                                        | Verified     | Verified      | NestJS 12.1.2; other versions are unverified                 |
| Runtime                                              | Node.js 22+  | Current Bun   | Bun uses `Bun.serve`                                         |
| Routing, middleware, guards, pipes, interceptors, DI | Supported    | Supported     | Shared adapter implementation                                |
| JSON and nested URL-encoded bodies                   | Supported    | Supported     | Parsed body limit defaults to 100 KiB                        |
| Multipart forms                                      | Supported    | Supported     | Files are native `File` values on `@Body()`                  |
| CORS                                                 | Supported    | Supported     | Same options and headers as `cors` (Express)                 |
| Trusted proxies (`X-Forwarded-*`)                    | Supported    | Supported     | Express's `trust proxy`: `ip`, `ips`, `protocol`, `hostname` |
| Cookies                                              | Supported    | Supported     | Nest's cookie API, `res.cookie()`, `cookie-parser`           |
| Static assets                                        | Supported    | Supported     | `express.static` options, validators and byte ranges         |
| Text, raw and custom-type bodies                     | Supported    | Supported     | Opt in with `app.useBodyParser(...)`                         |
| Header, media-type and custom versioning             | Supported    | Supported     | Same per-handler matching as Nest's Express adapter          |
| Nest `@Sse()`                                        | Supported    | Supported     | Observable `MessageEvent` stream                             |
| Streamed responses with `res.write()`                | Supported    | Supported     | Chunked; headers are sent on the first write                 |
| Response events (`res.on("finish")`)                 | Supported    | Not supported | Forwarded to Node's `ServerResponse`                         |
| TLS / HTTPS                                          | Supported    | Untested      | Nest `httpsOptions`; Bun reads key, cert, ca and passphrase  |
| WebSocket gateways                                   | Supported    | Supported     | Node: Nest's `WsAdapter`; Bun: `BunWsAdapter`                |
| Socket.IO gateways                                   | Supported    | Not supported | Automatic on Node; under Bun use the Node adapter            |
| File upload interceptors                             | Supported    | Supported     | `FileInterceptor` and friends; memory storage only           |
| MVC (`@Render()`)                                    | Supported    | Supported     | Express-compatible engines (`ejs`, `pug`, `hbs`)             |

## Usage

```ts
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { NodeHttpAdapter } from "nestjs-adapter-node";
import { AppModule } from "./app.js";

const app = await NestFactory.create(AppModule, new NodeHttpAdapter());
await app.listen(3000);
```

For Bun, replace `NodeHttpAdapter` with `BunHttpAdapter` from
`nestjs-adapter-bun` and run the application using Bun.
Actual Nest requires `reflect-metadata`; the previous no-reflection framework
experiment has been retired. Explicit `@Inject()` remains usable.

## Current scope

Supported: HTTP routing with `path-to-regexp` 8 syntax, named parameters and
wildcards, query strings (repeated keys become arrays), global prefixes, URI,
header, media-type and custom versioning, Nest middleware, JSON, nested URL-encoded and multipart form bodies,
raw bodies, status/headers/cookies/redirects, HEAD/no-content responses,
`StreamableFile`, Nest `@Sse()` routes returning Observables, and Nest's standard
request pipeline. Repeated form fields become arrays, bracket notation creates
nested objects/arrays, and multipart file fields are exposed as native `File`
values on `@Body()`. Route matching is case-sensitive.

Text, raw and extra JSON/URL-encoded media types are opt-in:
`app.useBodyParser("text")`, `app.useBodyParser("raw", { limit: "1mb" })` or
`app.useBodyParser("json", { type: "application/vnd.api+json" })`. `type` takes
exact media types, `text/*`-style prefixes or `*/*`.

The default parsed-body limit is 100 KiB; configure `new NodeHttpAdapter({
bodyLimit: 1024 * 1024 })` or the same option on Bun. `shutdownTimeout` defaults
to 5000 ms, after which outstanding connections are forcibly closed.

These are **not drop-in Express plugin adapters**. `@Req()` exposes a
`NativeRequest` with `.raw` (a web `Request`) and Nest's usual data fields.
`@Res()` exposes `NativeResponse` with `status`, `json`, `send`, `write`, `end`,
`setHeader`, `getHeader`, and `redirect`, not a Node `ServerResponse`.
No Express-specific middleware APIs are provided. `@Render()` works with
Express-compatible view engines: `app.setBaseViewsDir(dir)` (default `./views`)
and `app.setViewEngine("ejs")`, or pass `{ extension, render }` with any
`(path, options, callback)` function. Express `app.locals` and view caching
settings are not provided. `@Sse()` streams Nest
`MessageEvent` values as `text/event-stream`. `app.useStaticAssets()` serves
files like `express.static()` (see Static files below). Unsupported adapter
configuration throws instead of silently doing nothing. Do not assume browser
cross-origin access is enabled: call `app.enableCors()` as on Express.

### CORS

`app.enableCors(options)` and `NestFactory.create(..., { cors })` take Nest's
`CorsOptions` or a `CorsOptionsDelegate` and behave like the `cors` package
that Nest's Express adapter installs. The conformance suite compares a dozen
configurations header by header against Express.

- Options are merged over the `cors` defaults (any origin, `GET,HEAD,PUT,PATCH,POST,DELETE`,
  status `204`). An `origin` that is present but `undefined` overrides the
  default, so `{ origin: process.env.CORS_ORIGIN }` with the variable unset
  turns CORS **off** instead of allowing every origin. Static options are read
  once by `enableCors()`; later changes to the object have no effect.
- `origin` may be `*`, `true` (reflect the request origin), a string, a
  `RegExp`, an array of those, or a callback. The callback also runs for
  requests without an `Origin` header and receives `undefined`; an error it
  passes becomes a 500 response, as on Express.
- `methods`, `allowedHeaders` (alias `headers`) and `exposedHeaders` take
  strings or arrays. An empty `methods` or `exposedHeaders` (`""` or `[]`) and
  `allowedHeaders: []` send no header. Without `allowedHeaders`, or with
  `allowedHeaders: ""` (unset, as in `cors`), the requested headers are
  reflected and `Access-Control-Request-Headers` is added to `Vary`.
- `credentials`, `maxAge`, `preflightContinue` and `optionsSuccessStatus` are
  honored. Every `OPTIONS` request is answered as a preflight unless
  `preflightContinue` is set, in which case it reaches the `@Options()` route
  with the CORS headers already set.
- A delegate may call back with no options to get the defaults. Static options
  are compiled once; only delegates and origin callbacks run per request.

> **Warning:** `origin: true` reflects any origin. Combined with
> `credentials: true` (or its alias `allowCredentials: true`), any website can
> make credentialed requests and read the responses. Use an allowlist for
> credentialed APIs.

Differences from Express: a `204` preflight carries no `Content-Length`
header, as RFC 9110 requires; `methods: undefined` sends no
`Access-Control-Allow-Methods` and `optionsSuccessStatus: undefined` falls back
to `204`, where `cors` fails the preflight with a 500; and
`allowCredentials: true` is accepted as an alias of `credentials: true`.

Earlier releases of these adapters behaved differently. Review CORS
configurations when upgrading:

- a missing or `undefined` `origin`, and `origin: true`, sent `*`;
- a `CorsOptionsDelegate` was ignored, so every origin got `*`;
- the origin callback was skipped for requests without an `Origin` header;
- `methods`, `allowedHeaders` and `exposedHeaders` only took arrays, and
  string values were ignored; the default methods included `OPTIONS`;
- only `OPTIONS` requests with `Access-Control-Request-Method` were treated
  as preflights, always answered `204`, ignoring `preflightContinue` and
  `optionsSuccessStatus`;
- without an `Access-Control-Request-Headers` header, a fixed list of allowed
  headers was sent, and `Vary` was overwritten instead of appended.

### Cookies

Nest's own cookie support works unchanged on both adapters: `@Cookies()`,
`@SignedCookies()`, `httpAdapter.setCookie()` / `clearCookie()` and the
`cookies: { secret }` application option. The decorators parse the `Cookie`
header themselves, so they need no middleware.

Like Express, the adapters do not fill `req.cookies` or `req.signedCookies`.
To use them in middleware and guards, install `cookie-parser` as on Express:
`app.use(cookieParser(secret))`. It works unchanged, including `j:` JSON
cookies and signed cookies, and `@SignedCookies()` falls back to its result
when `cookies.secret` is not configured. Signatures use the same
`s:value.signature` format everywhere, so give both the same secret.

For `@Res()` handlers migrated from Express, `NativeResponse` offers
`res.cookie(name, value, options)` and `res.clearCookie(name, options)` with
Express semantics:

- objects become `j:`-prefixed JSON and other values are stringified;
- `maxAge` is in **milliseconds** and also sets `Expires`, while `null` leaves
  it out (Nest's `httpAdapter.setCookie()` takes `maxAge` in seconds);
- `null` `domain`, `expires`, `priority` and `sameSite` are left out (also
  when `false`), `sameSite: true` means `Strict`, and a falsy `path` sends an
  empty `Path=`, which browsers treat like Express's missing Path;
- `signed: true` uses the secret `cookie-parser` set, as Express does, and
  otherwise `cookies.secret`.

Cookies are serialized by Nest, so invalid names, values or attributes throw a
`TypeError`, and `sameSite: "none"` or `partitioned` require `secure: true`.
Express's `encode` option is not supported and throws.

```ts
@Get("login")
login(@Res() res: NativeResponse) {
  res
    .cookie("session", token, { httpOnly: true, secure: true, maxAge: 86_400_000 })
    .cookie("theme", "dark")
    .json({ ok: true });
}

@Get("me")
me(@Cookies("theme") theme: string, @SignedCookies("uid") uid?: string) {
  return { theme, uid };
}
```

### Migrating from Express or Fastify

The controllers and Nest providers can generally stay unchanged, but audit all
transport-specific code before replacing the platform adapter:

- Change adapter construction to `new NodeHttpAdapter()` or
  `new BunHttpAdapter()`. Do not install Express/Fastify platform plugins.
- Treat `@Req()` as `NativeRequest`; its `.raw` is a Web `Request` (built on
  first access on Node, so only touch it when you need it), not an
  Express `Request`, Fastify request, or Node `IncomingMessage`.
- Treat `@Res()` as `NativeResponse`. `res.status(...).json(...)` and
  `res.setHeader(...)`, and `res.write(...)` are available, and on Node
  `res.on(...)` forwards to the underlying response. Other Express/Fastify
  APIs and plugin-specific methods are not.
- Keep `@UploadedFile()` / `@UploadedFiles()` and import `FileInterceptor`,
  `FilesInterceptor`, `FileFieldsInterceptor` or `AnyFilesInterceptor` from the
  adapter package instead of `@nestjs/platform-express`. Files have Multer's
  memory-storage shape (`originalname`, `mimetype`, `size`, `buffer`). Multer
  options (disk storage, `fileFilter`, per-file limits) are not supported;
  uploads are held in memory and bounded by the adapter's `uploadLimit`, which
  defaults to `bodyLimit`. Without an interceptor, files stay on `@Body()` as
  Web `File` objects.
- Keep `app.enableCors(...)` as is; the options and resulting headers match
  the `cors` package. Keep `cookie-parser` if middleware or guards read
  `req.cookies`; `res.cookie()` and `res.clearCookie()` behave as on Express.
  Nest's `@Cookies()` and `@SignedCookies()` need no middleware.
- Keep `app.useStaticAssets(root, options)`: it takes `express.static()`
  options, including `maxAge` in milliseconds.
- Pass Nest `httpsOptions` for native HTTPS, or terminate TLS at a reverse
  proxy. Keep `app.set("trust proxy", ...)` as is, or pass the same value as
  the `trustProxy` adapter option.

If the application depends on Multer disk storage, Fastify plugins,
Express middleware, retain the existing
platform adapter for that application.

Example SSE endpoint:

```ts
import { Controller, Sse } from "@nestjs/common";
import { interval, map, take } from "rxjs";

@Controller()
export class EventsController {
  @Sse("events")
  events() {
    return interval(1000).pipe(
      take(3),
      map((count) => ({ data: { count } })),
    );
  }
}
```

### TLS behind a reverse proxy

The adapters serve HTTPS directly when Nest `httpsOptions` are given (verified
on Node; untested on Bun). Otherwise terminate TLS at a reverse proxy such as Nginx,
and keep the application listener reachable only from that proxy (for example,
bind to `127.0.0.1` or a private container network). Configure the proxy's
request-body limit to match the adapter's `bodyLimit`; the default parsed-body
limit is 100 KiB.

Example Nginx configuration for an app listening on `127.0.0.1:3000`:

```nginx
server {
    listen 80;
    server_name example.com;
    return 301 https://example.com$request_uri;
}

server {
    listen 443 ssl;
    server_name example.com;

    ssl_certificate     /etc/letsencrypt/live/example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/example.com/privkey.pem;
    client_max_body_size 1m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

If using the `1m` proxy limit, configure the adapter with
`{ bodyLimit: 1024 * 1024 }`.

### Static files

`app.useStaticAssets(root, options)` behaves like `express.static()`, which
Nest's Express adapter uses, and the conformance suite compares four option
sets header by header against it:

- `ETag` and `Last-Modified` validators, with `If-None-Match` /
  `If-Modified-Since` answered `304` and failed `If-Match` /
  `If-Unmodified-Since` answered `412`;
- single byte ranges answered `206` (several ranges, a malformed header or a
  stale `If-Range` send the whole file, as in `send`), and unsatisfiable ones
  `416`;
- `Cache-Control: public, max-age=…` from `maxAge` in **milliseconds** or a
  duration such as `"1d"`, plus `immutable`;
- dotfiles hidden by default (`dotfiles: "allow" | "deny" | "ignore"`), a `301`
  redirect for a directory requested without its trailing slash, `index`,
  `extensions`, `setHeaders`, `fallthrough`, `etag`, `lastModified`,
  `cacheControl` and `acceptRanges`;
- the `prefix` is matched per path segment, case-insensitively, like an
  Express mount path: `/assets` serves `/assets/app.js` but not `/assetsapp.js`.

Content types come from a built-in table that matches Express for common web
files; other extensions are sent as `application/octet-stream`. Files are
streamed from disk. On Bun, a full file sent although the request had a
`Range` header goes out without `Content-Length` when it is larger than 1 MiB,
because Bun would otherwise apply the range itself.

Earlier releases read `maxAge` in seconds, sent no validators and buffered
whole files; `maxAge` now follows Express (milliseconds), so multiply old
values by 1000.

### Trusted proxies

By default the adapters ignore `X-Forwarded-*` headers: `req.ip`, `@Ip()`,
`req.protocol` and `req.hostname` describe the connection to the
application, as on Express. Behind a reverse proxy, tell the adapter which
hops to trust, with the same values as Express's `trust proxy` setting:

```ts
new NodeHttpAdapter({ trustProxy: "loopback" }); // or BunHttpAdapter
// or, as on Express, after creating the app:
app.set("trust proxy", 1);
```

| Value                       | Trusts                                                                    |
| --------------------------- | ------------------------------------------------------------------------- |
| `false` (default), `0`      | nothing                                                                   |
| `true`                      | every hop; only when nothing else can reach the app                       |
| a number `n`                | the nearest `n` hops                                                      |
| a string or array           | addresses, CIDR or netmask ranges, `loopback`, `linklocal`, `uniquelocal` |
| `(address, hop) => boolean` | whatever the function accepts; hop 0 is the socket peer                   |

With a trusted socket peer, `req.ip` becomes the nearest untrusted
`X-Forwarded-For` entry, `req.ips` lists the trusted chain farthest first,
`req.protocol` follows `X-Forwarded-Proto`, and `req.hostname` follows
`X-Forwarded-Host`. The results match Express for the cases in the
conformance suite. Invalid values, including a `/0` range, throw when the
adapter is created or the setting is applied, so the app fails at startup as
on Express; `null`, `false` and `""` trust nothing. `app.set()` accepts any
setting like Express, but only `trust proxy` has an effect: `x-powered-by` is
accepted silently (these adapters never send that header), and other settings
log a warning that they are ignored.

> **Warning:** trust only the proxies in front of the application. With
> `true` or a hop count larger than the real proxy chain, any client can set
> its own `req.ip` through `X-Forwarded-For`.

The Node adapter exposes its real HTTP server through `getHttpServer()`.
The Bun adapter exposes a small event/address facade for Nest's listen lifecycle,
with the actual Bun server at `.native`; it is not a Node server. Response
events are only available on Node.

### WebSockets

On Node the adapter's server is a real `http.Server`, so Nest's own adapter
from `@nestjs/platform-ws` works unchanged:

```ts
import { WsAdapter } from "@nestjs/platform-ws";
app.useWebSocketAdapter(new WsAdapter(app));
```

On Bun use the bundled adapter, which runs on Bun's native WebSockets and
shares the HTTP port:

```ts
import { BunHttpAdapter, BunWsAdapter } from "nestjs-adapter-bun";
const app = await NestFactory.create(AppModule, new BunHttpAdapter());
app.useWebSocketAdapter(new BunWsAdapter(app));
```

`BunWsAdapter` uses the same `{ "event": ..., "data": ... }` JSON messages as
`WsAdapter`. Gateways are matched by `@WebSocketGateway({ path })`; separate
ports and namespaces are not supported, and `@ConnectedSocket()` is Bun's
`ServerWebSocket`.

### Socket.IO

With `NodeHttpAdapter` nothing is needed beyond installing
`@nestjs/platform-socket.io`: Nest attaches Socket.IO to the adapter's
`http.Server` by itself, as it does with Express. This also holds when the
application runs under Bun, so `NodeHttpAdapter` is the way to use Socket.IO
on the Bun runtime.

`BunHttpAdapter` does not support Socket.IO or `@nestjs/platform-ws`: both need
a Node HTTP server, which `Bun.serve` does not provide. Starting such an
application fails with an error that says so, rather than serving 404s.

All WebSocket integrations need `@nestjs/websockets` installed in the application.
Other integrations can share the Bun server through
`BunHttpAdapter#addSocketTransport`.

### Operational notes

- Multipart uploads are parsed into in-memory native `File` values and are
  subject to `bodyLimit`; the adapter does not spool uploaded files to disk.
- Static files are read from disk as they are sent, not buffered. Restrict
  the configured root to public assets; a CDN still suits high-volume delivery.
- For SSE behind Nginx, keep response buffering disabled for the SSE location
  and set `proxy_read_timeout` to match the expected idle interval. The adapter
  sends `X-Accel-Buffering: no`, but proxy configuration controls end-to-end
  behavior.
- `app.close()` stops accepting connections and waits for in-flight
  requests, which still get their responses. `shutdownTimeout` (default
  5000 ms) bounds that wait: when it expires, remaining connections are
  closed. Nest's `forceCloseConnections: true` closes them at once. A client
  that disconnects from an `@Sse()` stream unsubscribes its Observable. The
  conformance suite checks all of this on Node and Bun.

### Benchmarks

The benchmark exercises the same real Nest fixture over loopback for a native
adapter and the Nest/Express reference. It supports a JSON GET, a parameterized
route with repeated query fields, a JSON POST, or a round-robin mix of all
three. The benchmark server runs separately from multiple load-generator processes.
Clients use persistent HTTP connections and synchronize measurement start after
warmup to reduce client event-loop contention and process-start skew. It
includes Nest's routing, DI, and fixture middleware, but does not model remote
clients, uploads, static-file workloads, SSE, or reverse-proxy overhead:

```sh
pnpm bench          # NodeHttpAdapter on Node
pnpm bench:express  # Nest/Express on Node
pnpm bench:fastify  # Nest/Fastify on Node
pnpm bench:bun               # BunHttpAdapter on Bun, Node load generators
pnpm bench:bun-node-adapter  # NodeHttpAdapter on Bun, Node load generators
```

The defaults are three runs, each with 2 seconds of warmup, 10 seconds of
measurement, and 32 total concurrent clients split across four client
processes. Configure with `BENCH_RUNS`, `BENCH_WARMUP_MS`, `BENCH_DURATION_MS`,
`BENCH_CONCURRENCY`, and `BENCH_CLIENT_PROCESSES`. Select
`BENCH_WORKLOAD=json|route|post|mixed`; default is `json`. Output includes each
run's request rate, failures, mean latency, and approximate percentile upper
bounds from a logarithmic histogram, plus mean throughput and standard
deviation across runs. Run each mode on an otherwise idle machine and compare
the same workload, runtime version, and environment. This harness is a
reproducible local baseline, not a production load test or evidence of a
performance advantage.

## Development

```sh
pnpm install
pnpm run check
pnpm run test
pnpm run test:bun
pnpm bench
pnpm run dev
```

`dev` watches the Node example; `vp run build` builds both example entrypoints.
Run `bun dist/bun.js` for the Bun example. Both expose `/hello/world` on port 3000.
Dependency versions live in `pnpm-workspace.yaml` catalogs. The pnpm version is pinned
in `package.json`.
Vite+ handles builds, watch, formatting, Oxlint, type checks, and Vitest.
TypeScript 7 is retained. No ESLint, Babel, or tsc-watch.

Conformance checks execute the same real Nest module on each native adapter and
Nest/Express. This is a compatibility baseline, not full framework conformance
or evidence of a performance advantage. The former alternative-core prototype
is retained only in Git history; its phases no longer describe this project's
roadmap.

Repository: <https://github.com/x-ror/nest-native-adapters>

## Releasing

Both packages share one version, recorded in `CHANGELOG.md`.

1. Set the same `version` in `packages/platform-node/package.json` and
   `packages/platform-bun/package.json`, and move the changelog's
   Unreleased entries under that version.
2. Push a tag `v<version>`. The Release workflow builds, runs the full
   check, test and Bun suites, checks that the tag matches both packages and
   that a license is set, then publishes both packages to npm with
   provenance. It needs an `NPM_TOKEN` secret in a GitHub environment named
   `npm`.

## License

[0BSD](LICENSE): use, copy, modify and distribute for any purpose, with or
without attribution.
