import type * as Common from "@mini-nest/common";

type FixtureDecorators = Pick<
  typeof Common,
  "Get" | "Post" | "Body" | "Inject" | "Injectable" | "Module"
> & {
  Controller: (prefix: string) => ClassDecorator;
};

export function createFixture(decorators: FixtureDecorators) {
  const { Controller, Get, Post, Body, Inject, Injectable, Module } = decorators;

  @Injectable()
  class GreetingService {
    greeting() {
      return { message: "Hello from the same application" };
    }
  }

  @Controller("hello")
  class GreetingController {
    constructor(@Inject(GreetingService) private readonly service: GreetingService) {}

    @Get()
    hello() {
      return this.service.greeting();
    }

    @Post("echo")
    echo(@Body() body: unknown) {
      return { received: body };
    }
  }

  @Module({ controllers: [GreetingController], providers: [GreetingService] })
  class AppModule {}

  return AppModule;
}
