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
Run `pnpm run build` before packing or publishing either adapter; only `dist/` is shipped. Packages are not published to npm yet. Supported baseline:
NestJS **12.1.2**, Node.js 22+, current Bun. Other Nest versions are not yet verified.
Neither adapter uses Express or Fastify. Express is a test-only reference.

## Compatibility matrix

| Capability                                           | Node adapter  | Bun adapter   | Notes                                                           |
| ---------------------------------------------------- | ------------- | ------------- | --------------------------------------------------------------- |
| Nest baseline                                        | Verified      | Verified      | NestJS 12.1.2; other versions are unverified                    |
| Runtime                                              | Node.js 22+   | Current Bun   | Bun uses `Bun.serve`                                            |
| Routing, middleware, guards, pipes, interceptors, DI | Supported     | Supported     | Shared adapter implementation                                   |
| JSON and nested URL-encoded bodies                   | Supported     | Supported     | Parsed body limit defaults to 100 KiB                           |
| Multipart forms                                      | Supported     | Supported     | Files are native `File` values on `@Body()`                     |
| CORS and static assets                               | Basic support | Basic support | Not a replacement for dedicated integrations/CDNs               |
| Nest `@Sse()`                                        | Supported     | Supported     | Observable `MessageEvent` stream; not arbitrary response writes |
| TLS / HTTPS                                          | Not supported | Not supported | Terminate TLS at a reverse proxy                                |
| WebSockets, Multer decorators, MVC                   | Not supported | Not supported | Use a different Nest platform adapter if required               |

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
wildcards, query strings (repeated keys become arrays), global prefixes, URI
versioning, Nest middleware, JSON, nested URL-encoded and multipart form bodies,
raw bodies, status/headers/cookies/redirects, HEAD/no-content responses,
`StreamableFile`, Nest `@Sse()` routes returning Observables, and Nest's standard
request pipeline. Repeated form fields become arrays, bracket notation creates
nested objects/arrays, and multipart file fields are exposed as native `File`
values on `@Body()`. Route matching is case-sensitive.

The default parsed-body limit is 100 KiB; configure `new NodeHttpAdapter({
bodyLimit: 1024 * 1024 })` or the same option on Bun. `shutdownTimeout` defaults
to 5000 ms, after which outstanding connections are forcibly closed.

These are **not drop-in Express plugin adapters**. `@Req()` exposes a
`NativeRequest` with `.raw` (a web `Request`) and Nest's usual data fields.
`@Res()` exposes `NativeResponse` with `status`, `json`, `send`, `end`,
`setHeader`, `getHeader`, and `redirect`, not a Node `ServerResponse`.
No Express-specific middleware APIs, Multer-compatible file decorators,
arbitrary direct response writes, WebSocket upgrades, MVC, configurable body
parsers, HTTPS, or non-URI versioning are provided yet. `@Sse()` streams Nest
`MessageEvent` values as `text/event-stream`; it is not a general-purpose
streaming response API. Basic static file serving and CORS are supported through
the adapter middleware API with origin/preflight handling. Unsupported adapter
configuration throws instead of silently doing nothing. Do not assume browser
cross-origin access is enabled.

### Migrating from Express or Fastify

The controllers and Nest providers can generally stay unchanged, but audit all
transport-specific code before replacing the platform adapter:

- Change adapter construction to `new NodeHttpAdapter()` or
  `new BunHttpAdapter()`. Do not install Express/Fastify platform plugins.
- Treat `@Req()` as `NativeRequest`; its `.raw` is a Web `Request`, not an
  Express `Request`, Fastify request, or Node `IncomingMessage`.
- Treat `@Res()` as `NativeResponse`. `res.status(...).json(...)` and
  `res.setHeader(...)` are available, but Express/Fastify APIs, direct Node
  writes, response events, and plugin-specific methods are not.
- Replace Multer `@UploadedFile()` / `@UploadedFiles()` flows with
  `@Body()` multipart fields, where uploaded files are Web `File` objects.
  Uploads are memory-backed and bounded by `bodyLimit`.
- Register static assets and CORS through the adapter API and test any
  framework-specific options; these implementations intentionally provide a
  smaller feature set than the corresponding Express/Fastify integrations.
- Terminate HTTPS at a reverse proxy and do not trust forwarded headers unless
  the application implements a trusted-proxy policy.

If the application depends on WebSockets, Multer decorators, Fastify plugins,
Express middleware, direct response writes, or Nest MVC, retain the existing
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

The adapters serve plain HTTP. Terminate TLS at a reverse proxy such as Nginx,
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
`{ bodyLimit: 1024 * 1024 }`. The adapters currently do not interpret
`X-Forwarded-*` headers: `@Req().protocol` and `@Req().ip` reflect the
application-side HTTP connection, not the original client connection. Do not
use forwarded headers for security decisions unless a trusted-proxy policy is
implemented by your application. These adapters do not support WebSocket
upgrades or arbitrary direct response writes, even when the proxy can proxy
them.

The Node adapter exposes its real HTTP server through `getHttpServer()`.
The Bun adapter exposes a small event/address facade for Nest's listen lifecycle,
with the actual Bun server at `.native`; it is not a Node server or a WebSocket
adapter. Fetch response streaming is supported for files, but arbitrary Node
response events and manual `write()` calls are not.

### Operational notes

- Multipart uploads are parsed into in-memory native `File` values and are
  subject to `bodyLimit`; the adapter does not spool uploaded files to disk.
- Static files are read into memory for each request. Restrict the configured
  root to trusted public assets; use a dedicated static server or CDN for large
  files or high-volume delivery.
- For SSE behind Nginx, keep response buffering disabled for the SSE location
  and set `proxy_read_timeout` to match the expected idle interval. The adapter
  sends `X-Accel-Buffering: no`, but proxy configuration controls end-to-end
  behavior.
- `shutdownTimeout` defaults to 5000 ms. When it expires, outstanding Node
  connections or Bun requests may be forcibly closed; choose a timeout long
  enough for in-flight requests and SSE shutdown.

### Benchmarks

The benchmark exercises the same real Nest fixture over loopback for a native
adapter and the Nest/Express reference. It supports a JSON GET, a parameterized
route with repeated query fields, a JSON POST, or a round-robin mix of all
three. The benchmark server runs in a separate child process from the load
generator to avoid making the server share the client's event loop. It includes
Nest's routing, DI, and fixture middleware, but does not model remote clients,
uploads, static-file workloads, SSE, or reverse-proxy overhead:

```sh
pnpm bench          # NodeHttpAdapter on Node
pnpm bench:express  # Nest/Express on Node
pnpm bench:bun      # BunHttpAdapter on Bun
```

The defaults are three runs, each with 2 seconds of warmup, 10 seconds of
measurement, and 32 concurrent clients. Configure with `BENCH_RUNS`,
`BENCH_WARMUP_MS`, `BENCH_DURATION_MS`, and `BENCH_CONCURRENCY`. Select
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
