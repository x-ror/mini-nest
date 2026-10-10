# nestjs-adapter-bun

Native `Bun.serve` HTTP adapter for [NestJS](https://nestjs.com): real Nest on Bun, without Express or Fastify.

```sh
npm install nestjs-adapter-bun
```

```ts
import { NestFactory } from "@nestjs/core";
import { BunHttpAdapter } from "nestjs-adapter-bun";
import { AppModule } from "./app.module.js";

const app = await NestFactory.create(AppModule, new BunHttpAdapter());
await app.listen(3000);
```

Routing, middleware, guards, pipes, interceptors and exception filters are
Nest's own. CORS, cookies, trusted proxies, static files, body parsers,
`@Sse()`, uploads, versioning and views behave like Nest's Express adapter,
checked by a conformance suite against Express.

The supported baseline is NestJS 12.1.2. See the
[repository README](https://github.com/x-ror/nest-native-adapters#readme) for
the compatibility matrix, migration notes from Express, and known deviations.
