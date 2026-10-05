import { it } from "vite-plus/test";
import assert from "node:assert/strict";
import { Controller, Get, Inject, Injectable, Module } from "@mini-nest/common";
import { NestFactory } from "@mini-nest/core";

it("rejects undecorated modules and unresolved dependencies at bootstrap", async () => {
  class InvalidModule {}
  await assert.rejects(NestFactory.create(InvalidModule), /@Module/);

  @Injectable()
  class MissingService {}
  @Controller()
  class BrokenController {
    constructor(@Inject(MissingService) readonly service: MissingService) {}
  }
  @Module({ controllers: [BrokenController] })
  class BrokenModule {}
  await assert.rejects(NestFactory.create(BrokenModule), /not available/);
});

it("keeps unexported providers private to their module", async () => {
  @Injectable()
  class PrivateService {}
  @Module({ providers: [PrivateService] })
  class PrivateModule {}
  @Controller()
  class Consumer {
    constructor(@Inject(PrivateService) readonly service: PrivateService) {}
  }
  @Module({ imports: [PrivateModule], controllers: [Consumer] })
  class ConsumerModule {}
  await assert.rejects(NestFactory.create(ConsumerModule), /not available/);
});

it("uses one instance of a shared imported provider", async () => {
  let created = 0;
  @Injectable()
  class SharedService {
    constructor() {
      created++;
    }
  }
  @Module({ providers: [SharedService], exports: [SharedService] })
  class SharedModule {}
  @Controller("a")
  class A {
    constructor(@Inject(SharedService) readonly service: SharedService) {}
    @Get()
    get() {
      return created;
    }
  }
  @Controller("b")
  class B {
    constructor(@Inject(SharedService) readonly service: SharedService) {}
  }
  @Module({ imports: [SharedModule], controllers: [A] })
  class AModule {}
  @Module({ imports: [SharedModule], controllers: [B] })
  class BModule {}
  @Module({ imports: [AModule, BModule] })
  class Root {}
  const app = await NestFactory.create(Root);
  assert.equal(created, 1);
  assert.equal(await (await app.fetch(new Request("http://localhost/a"))).json(), 1);
});

it("rejects circular module imports and circular constructor dependencies", async () => {
  class AModule {}
  class BModule {}
  Module({ imports: [BModule] })(AModule);
  Module({ imports: [AModule] })(BModule);
  await assert.rejects(NestFactory.create(AModule), /Circular module import/);

  @Injectable()
  class A {}
  @Injectable()
  class B {}
  Inject(B)(A, undefined, 0);
  Inject(A)(B, undefined, 0);
  @Module({ providers: [A, B] })
  class CircularModule {}
  await assert.rejects(NestFactory.create(CircularModule), /Circular dependency/);
});

it("reports missing @Inject rather than silently injecting undefined", async () => {
  @Injectable()
  class Primitive {
    constructor(readonly name: string) {}
  }
  @Module({ providers: [Primitive] })
  class InvalidModule {}
  await assert.rejects(
    NestFactory.create(InvalidModule),
    /Missing @Inject.*parameter 0.*Primitive/,
  );
});

it("resolves provider chains with explicit parameter indexes and preserves defaults", async () => {
  @Injectable()
  class First {}
  @Injectable()
  class Second {}
  @Injectable()
  class Consumer {
    constructor(
      @Inject(First) readonly first: First,
      readonly label = "default",
      @Inject(Second) readonly second: Second = new Second(),
    ) {}
  }
  @Controller()
  class TestController {
    constructor(@Inject(Consumer) readonly service: Consumer) {}
    @Get()
    get() {
      return {
        first: this.service.first instanceof First,
        second: this.service.second instanceof Second,
        label: this.service.label,
      };
    }
  }
  @Module({ providers: [First, Second, Consumer], controllers: [TestController] })
  class Root {}
  const app = await NestFactory.create(Root);
  assert.deepEqual(await (await app.fetch(new Request("http://localhost/"))).json(), {
    first: true,
    second: true,
    label: "default",
  });
});

it("rejects gaps in required injections and undecorated provider tokens", async () => {
  @Injectable()
  class Service {}
  @Injectable()
  class Gap {
    constructor(
      readonly missing: Service,
      @Inject(Service) readonly provided: Service,
    ) {}
  }
  @Module({ providers: [Service, Gap] })
  class GapModule {}
  await assert.rejects(NestFactory.create(GapModule), /Missing @Inject.*parameter 0/);

  class Undecorated {}
  @Injectable()
  class Consumer {
    constructor(@Inject(Undecorated) readonly service: Undecorated) {}
  }
  @Module({ providers: [Consumer] })
  class InvalidModule {}
  await assert.rejects(NestFactory.create(InvalidModule), /Cannot resolve.*@Injectable/);
});

it("rejects method/property injection and duplicate constructor decorators", () => {
  class Target {
    method(_value: unknown) {}
  }
  assert.throws(() => Inject(Target)(Target.prototype, "method", 0), /constructor parameter/);
  Inject(Target)(Target, undefined, 0);
  assert.throws(() => Inject(Target)(Target, undefined, 0), /only one @Inject/);
});

it("does not install reflection metadata APIs", () => {
  assert.equal("getMetadata" in Reflect, false);
  assert.equal("defineMetadata" in Reflect, false);
});
