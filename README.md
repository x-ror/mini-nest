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
`StreamableFile`, and Nest's standard request pipeline. Repeated form fields
become arrays, bracket notation creates nested objects/arrays, and multipart
file fields are exposed as native `File` values on `@Body()`. Route matching is
case-sensitive.

The default parsed-body limit is 100 KiB; configure `new NodeHttpAdapter({
bodyLimit: 1024 * 1024 })` or the same option on Bun. `shutdownTimeout` defaults
to 5000 ms, after which outstanding connections are forcibly closed.

These are **not drop-in Express plugin adapters**. `@Req()` exposes a
`NativeRequest` with `.raw` (a web `Request`) and Nest's usual data fields.
`@Res()` exposes `NativeResponse` with `status`, `json`, `send`, `end`,
`setHeader`, `getHeader`, and `redirect`, not a Node `ServerResponse`.
No Express-specific middleware APIs, Multer-compatible file decorators,
SSE/direct response writes, WebSocket upgrades, MVC, configurable body parsers,
HTTPS, or non-URI versioning are provided yet. Basic static file serving and
CORS are supported through the adapter middleware API with origin/preflight
handling. Unsupported adapter configuration throws instead of silently doing
nothing. Do not assume browser cross-origin access is enabled.

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
upgrades or SSE/direct response writes, even when the proxy can proxy them.

The Node adapter exposes its real HTTP server through `getHttpServer()`.
The Bun adapter exposes a small event/address facade for Nest's listen lifecycle,
with the actual Bun server at `.native`; it is not a Node server or a WebSocket
adapter. Fetch response streaming is supported for files, but arbitrary Node
response events are not.

## Development

```sh
pnpm install
pnpm run check
pnpm run test
pnpm run test:bun
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
or evidence of a performance advantage. Benchmarks and production hardening
remain future work. The former alternative-core prototype is retained only in
Git history; its phases no longer describe this project's roadmap.

Repository: <https://github.com/x-ror/nest-native-adapters>
