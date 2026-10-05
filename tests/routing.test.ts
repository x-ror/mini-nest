import { it } from "vite-plus/test";
import assert from "node:assert/strict";
import { All, Controller, Get, Param } from "@mini-nest/common";
import { Application } from "@mini-nest/core";

const request = (path: string) => new Request(`http://localhost${path}`);

it("expands controller and method path arrays and handles @All", async () => {
  @Controller(["a", "b"])
  class MultiController {
    @All(["one", "two"])
    handler(@Param() params: object) {
      return params;
    }
  }
  const app = new Application().register(new MultiController());
  for (const prefix of ["a", "b"]) {
    for (const path of ["one", "two"]) {
      for (const method of ["GET", "PUT", "DELETE"]) {
        const response = await app.fetch(
          new Request(`http://localhost/${prefix}/${path}`, { method }),
        );
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), {});
      }
    }
  }
});

it("discovers inherited routes and parameter decorators without invoking getters", async () => {
  class BaseController {
    @Get("items/:id")
    item(@Param("id") id: string) {
      return { id };
    }

    get notAHandler() {
      throw new Error("Route discovery must not invoke getters");
    }
  }

  @Controller("api")
  class ChildController extends BaseController {}

  const app = new Application().register(new ChildController());
  const response = await app.fetch(request("/api/items/42"));
  assert.deepEqual(await response.json(), { id: "42" });
});

it("does not register decorated base methods hidden by undecorated overrides", async () => {
  class BaseController {
    @Get("hidden")
    handler() {
      return "base";
    }
  }

  @Controller()
  class ChildController extends BaseController {
    override handler() {
      return "child";
    }
  }

  const app = new Application().register(new ChildController());
  assert.equal((await app.fetch(request("/hidden"))).status, 404);
});

it("rejects equivalent parameter routes without partially registering a controller", async () => {
  @Controller()
  class ExistingController {
    @Get("items/:id")
    item() {
      return "existing";
    }
  }

  @Controller()
  class ConflictingController {
    @Get("pending")
    pending() {
      return "must not be registered";
    }

    @Get("items/:name")
    item() {
      return "conflict";
    }
  }

  const app = new Application().register(new ExistingController());
  assert.throws(() => app.register(new ConflictingController()), /Duplicate route/);
  assert.equal((await app.fetch(request("/pending"))).status, 404);
  assert.equal(await (await app.fetch(request("/items/1"))).text(), "existing");
});

it("rejects invalid and repeated parameter names", () => {
  @Controller()
  class InvalidController {
    @Get(":bad-name")
    handler() {}
  }

  @Controller()
  class RepeatedController {
    @Get(":id/:id")
    handler() {}
  }

  const app = new Application();
  assert.throws(() => app.register(new InvalidController()), /Invalid route parameters/);
  assert.throws(() => app.register(new RepeatedController()), /Invalid route parameters/);
});

it("prefers static segments regardless of controller registration order", async () => {
  @Controller()
  class ParameterController {
    @Get(":group/items/:id")
    item() {
      return "parameter";
    }
  }

  @Controller()
  class StaticController {
    @Get("current/items/:id")
    item() {
      return "static";
    }
  }

  for (const controllers of [
    [new ParameterController(), new StaticController()],
    [new StaticController(), new ParameterController()],
  ]) {
    const app = new Application();
    for (const controller of controllers) app.register(controller);
    assert.equal(await (await app.fetch(request("/current/items/1"))).text(), "static");
  }
});
