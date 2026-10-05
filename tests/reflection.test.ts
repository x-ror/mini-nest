import { it } from "vite-plus/test";
import assert from "node:assert/strict";
import { Controller, Get, Inject, Injectable, Module, Body } from "@mini-nest/common";
import { NestFactory } from "@mini-nest/core";
import { parameterMetatypes, propertyInjections } from "@mini-nest/common/internal/metadata";

it("works without reflection APIs and uses optional design metadata with explicit-token precedence", async () => {
  assert.equal("getMetadata" in Reflect, false);
  @Injectable()
  class Inferred {
    name = "inferred";
  }
  @Injectable()
  class Explicit {
    name = "explicit";
  }
  class Dto {}
  const originals = new Map<string, unknown>();
  const metadata = new WeakMap<object, Map<string, unknown>>();
  const set = (target: object, key: string, value: unknown) => {
    const entries = metadata.get(target) ?? new Map();
    entries.set(key, value);
    metadata.set(target, entries);
  };
  Object.defineProperty(Reflect, "getMetadata", {
    configurable: true,
    value: (key: string, target: object, property?: string | symbol) =>
      property === undefined
        ? metadata.get(target)?.get(key)
        : originals.get(`${key}:${String(property)}`),
  });
  try {
    @Controller()
    class Api {
      constructor(
        readonly inferred: Inferred,
        @Inject(Explicit) readonly explicit: Explicit,
      ) {}
      @Get()
      handler() {
        return [this.inferred.name, this.explicit.name];
      }
    }
    set(Api, "design:paramtypes", [Inferred, Inferred]);
    @Module({ controllers: [Api], providers: [Inferred, Explicit] })
    class Root {}
    const app = await NestFactory.create(Root);
    assert.deepEqual(await (await app.fetch(new Request("http://localhost/"))).json(), [
      "inferred",
      "explicit",
    ]);
    class Properties {
      service?: Inferred;
      handler(_body: Dto) {}
    }
    originals.set("design:type:service", Inferred);
    originals.set("design:paramtypes:handler", [Dto]);
    Inject()(Properties.prototype, "service");
    Body()(Properties.prototype, "handler", 0);
    assert.equal(propertyInjections.get(Properties.prototype)?.get("service"), Inferred);
    assert.deepEqual(parameterMetatypes.get(Properties.prototype)?.get("handler"), [Dto]);
  } finally {
    Reflect.deleteProperty(Reflect, "getMetadata");
  }
  assert.equal("getMetadata" in Reflect, false);
});
