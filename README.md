# mini-nest

A NestJS-style backend framework with a fetch-native core, thin runtime adapters
and no external framework runtime dependencies. **Phase 0 foundation** of
`Nestjs alternative architecture plan.txt` is implemented; this is not a
drop-in NestJS replacement. The compatibility reference is NestJS **12.1.2**.
See [DEVIATIONS.md](DEVIATIONS.md) for accepted decisions and current limitations.

## Development

Node.js 22+ and npm are required. TypeScript 7 compiles legacy decorators without
emitted design-type metadata.

Install workspace dependencies with `npm install` to bootstrap the local Vite+
CLI (or `vp install` if Vite+ is already installed globally).

```sh
npx vp run dev
npx vp run check
npx vp run test
npx vp run build
npx vp run start
```

Vite+ owns the development toolchain: `vp pack` bundles libraries and the backend,
`vp pack --watch --on-success` rebuilds/restarts the example, `vp test` runs Vitest,
and `vp check` combines Oxfmt, Oxlint and TypeScript 7 type checking. There is no
ESLint, Babel or tsc-watch configuration/dependency. `npm run` wrappers remain
available for the same tasks.

`npx vp run fmt` formats sources/configuration/docs; `npx vp run typecheck` checks
types without emitting artifacts. TypeScript project references still describe
the dependency graph, while packaging emits JavaScript, declarations and source maps.

```sh
curl http://127.0.0.1:3000/hello
curl -X POST http://127.0.0.1:3000/hello/echo \
  -H 'Content-Type: application/json' -d '{"message":"Hi"}'
```

## Workspace architecture

```text
packages/common/          Public decorators/types, adapter contract, internal metadata
packages/core/            Application, NestFactory, di/, http/, routing/
packages/platform-node/   NodeAdapter and node:http transport
packages/conformance/     Same fixture using mini-nest and real NestJS decorators
examples/                 Backend example
tests/                    Unit and HTTP regression tests
```

`common` has no dependencies. `core` and `platform-node` depend only on `common`.
Core has no Node imports, and the platform does not import core.
DI cannot import HTTP/routing. TypeScript project references, Oxlint import
boundaries and manifest checks enforce these rules. The internal common subpaths
are reserved for core and must not be imported by application code.

The custom Oxlint plugin imports only Vite+'s plugin API. `vp run check` also
verifies package manifests and runs negative import probes against the actual
linter, cleaning up their temporary fixture files afterward.

Packages are private workspaces for now; publishing is not configured. NestJS,
Express, RxJS and reflect-metadata are **development-only conformance dependencies**.
Importing framework packages does not load or install reflection APIs.

## Example API

```ts
import { Controller, Get, Inject, Injectable, Module } from "@mini-nest/common";
import { NestFactory } from "@mini-nest/core";
import { NodeAdapter } from "@mini-nest/platform-node";

@Injectable()
class HelloService {
  hello() {
    return { message: "Hello!" };
  }
}

@Controller("hello")
class HelloController {
  constructor(@Inject(HelloService) private readonly service: HelloService) {}

  @Get()
  hello() {
    return this.service.hello();
  }
}

@Module({ controllers: [HelloController], providers: [HelloService] })
class AppModule {}

const app = await NestFactory.create(AppModule, new NodeAdapter());
await app.listen(3000);
```

Use `@mini-nest/common` for decorators, `@mini-nest/core` for bootstrap and
`@mini-nest/platform-node` for the adapter. The former root `mini-nest` imports
have been replaced by these workspace entry points.

Providers currently use explicit constructor `@Inject(Class)` and `@Injectable`.
Missing injection on required constructor arguments is a bootstrap error.
Module imports share singletons; only exported providers are visible to importers.
Optional/defaulted dependencies must also be decorated to request injection.

HTTP supports method decorators, `@HttpCode`, `@Body`, `@Req`, `@Query`, `@Param`,
literal paths, named params and global prefixes. POST defaults to 201. Object
results become JSON, strings text/html, undefined an empty response; Web Response
and async handlers are supported. Node bodies/responses are currently buffered.

Without an adapter, `app.fetch` works directly:

```ts
const app = await NestFactory.create(AppModule);
export default { fetch: app.fetch };
```

This is the serverless boundary, not platform-specific deployment packaging.

## Compatibility and runtime checks

`vp run test` runs the regression suite on TypeScript sources, packages the workspaces,
then compares the shared
GET/POST fixture through mini-nest fetch, Node transport and NestJS + Express.
Conformance compares status, Content-Type and body, excluding transport-specific
headers such as Date, ETag and Content-Length.

After building, the same conformance program can run on other installed runtimes:

```sh
bun packages/conformance/dist/smoke.js
deno run --allow-net --allow-env --allow-read --allow-sys --node-modules-dir=manual packages/conformance/dist/smoke.js
```

CI runs the full Node suite on Node 22/24 and the shared conformance program on
current Bun/Deno. These use Node compatibility APIs; native Bun/Deno adapters,
runtime-specific suites and earliest supported-version certification are deferred.

Next phases follow the architecture document: common contracts/metadata, then
ModuleGraph + Injector + Container and lifecycle, then HTTP facades, router,
pipeline and adapter v2. Existing behavior remains unchanged except that serialized JSON now includes
`charset=utf-8` in Content-Type to match the reference. Known incompatibilities
are recorded in DEVIATIONS.md.
