# Compatibility baseline

Reference: NestJS **12.1.2**, pinned exactly in the conformance workspace's dev dependencies.
The shared fixture in `packages/conformance/src/fixture.ts` currently verifies GET JSON and
POST JSON echo (status, Content-Type and body) using both `app.fetch` and the Node
transport against NestJS + Express. This is not proof of full compatibility.

## Accepted architecture decisions

- Fetch-native transport boundary; framework packages have no external runtime dependencies.
- Nest-style legacy decorators; explicit `@Inject` works without reflection.
  Reading existing design-type metadata is accepted for a future phase, not implemented.
- HTTP request/response facades with `.raw` are planned, not yet implemented.
- Promise-first interceptors are the future default; RxJS interop is deferred.
- Runtime baseline: Node 22+, Bun 1.3+, Deno 2+. CI exercises Node 22/24 and
  current Bun/Deno releases. Exact oldest Bun/Deno releases are not yet certified.
- Routes are case-sensitive; repeated/trailing slashes normalize. Configurable
  case sensitivity is planned.
- npm workspaces; packages use `@mini-nest/*`. No Nx/Turborepo or SSG.

## Current deviations and pending work

| Area           | Current behavior                                                                                                         | Planned phase |
| -------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------- |
| DI             | Class providers and explicit constructor `@Inject(Class)` only; every provider must be `@Injectable`                     | 1-2           |
| Metadata       | No automatic `design:paramtypes` lookup, Reflector or custom metadata API                                                | 1             |
| Modules        | Static modules, own-provider exports only; no dynamic/global modules, re-exports or forwardRef                           | 2             |
| Container      | Single DI container; no ModuleGraph/Injector split, app.get, application context or scopes                               | 2, 6          |
| Initialization | Eager construction/registration in create; no init lifecycle or configuration freeze                                     | 2-3           |
| Factory        | Requires explicit adapter for listen; no options overload or lazy default Node adapter                                   | 3             |
| Adapter        | Contract v1: listen(handler, port, hostname); native server exists only after listen                                     | 3             |
| Request        | @Req returns Web Request; undecorated handlers receive the legacy context argument                                       | 3             |
| Query          | Repeated keys keep the last value, not arrays                                                                            | 3             |
| Routing        | Linear matcher; literals and named params only; no GET fallback for HEAD, automatic OPTIONS, 405, wildcard or versioning | 3             |
| Errors         | JSON `{error}` rather than Nest statusCode/message/error; no HttpException family                                        | 1, 3          |
| Body           | JSON/text only; empty body is undefined; 1 MiB transport-only limit, no limit through app.fetch                          | 3             |
| Response       | No binary/stream serialization, StreamableFile, response facade, header or redirect decorators                           | 3             |
| Node transport | Buffered bodies, fixed localhost request origin, no client metadata/abort propagation or shutdown deadline               | 3, 5          |
| Enhancers      | No middleware, guards, pipes, interceptors or exception filters                                                          | 4             |
| Lifecycle      | No Nest lifecycle hooks, logger abstraction or automatic shutdown hooks                                                  | 2, 5          |
| Platforms      | Node adapter only; Bun/Deno CI checks portable execution with node:http, not native serve adapters                       | 5             |
| Testing        | Vite+ Vitest plus shared conformance fixture; no Nest testing module API                                                 | 7             |

Third-party `@nestjs/*` integrations, Express/Fastify plugins, microservices,
GraphQL, WebSockets, MVC and multipart uploads are outside this initial scope.

Internal common metadata/path subpaths are workspace implementation details,
not public contracts. Only core may import them. Existing `Application.register`
and `RequestContext` are prototype extensions, not NestJS compatibility promises.
