import { Body, Controller, Get, Inject, Injectable, Module, Post } from "@mini-nest/common";
import { NestFactory } from "@mini-nest/core";
import { NodeAdapter } from "@mini-nest/platform-node";

@Injectable()
class HelloService {
  private requests = 0;

  hello() {
    return { message: "Hello from mini-nest!", requests: ++this.requests };
  }
}

@Controller("/hello")
class HelloController {
  constructor(@Inject(HelloService) private readonly service: HelloService) {}

  @Get()
  hello() {
    return this.service.hello();
  }

  @Post("/echo")
  echo(@Body() body: unknown) {
    return { received: body };
  }
}

@Module({ controllers: [HelloController], providers: [HelloService] })
class AppModule {}

async function bootstrap() {
  const app = await NestFactory.create(AppModule, new NodeAdapter());
  await app.listen(3000, "127.0.0.1");
  console.log("Listening on http://127.0.0.1:3000");
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void app.close().catch((error: unknown) => {
        console.error("Shutdown failed", error);
        process.exitCode = 1;
      });
    });
  }
}

void bootstrap().catch((error: unknown) => {
  console.error("Bootstrap failed", error);
  process.exitCode = 1;
});
