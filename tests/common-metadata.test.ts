import { describe, it } from "vite-plus/test";
import assert from "node:assert/strict";
import {
  All,
  Body,
  Catch,
  Controller,
  Global,
  Header,
  Headers,
  HttpCode,
  Inject,
  Injectable,
  Ip,
  Module,
  Optional,
  Param,
  Query,
  Redirect,
  Req,
  Res,
  Scope,
  UseFilters,
  UseGuards,
  UseInterceptors,
  UsePipes,
  Version,
  VERSION_NEUTRAL,
  applyDecorators,
  createParamDecorator,
  forwardRef,
  SetMetadata,
  BadRequestException,
  type PipeTransform,
  type ExecutionContext,
} from "@mini-nest/common";
import { Reflector, NestFactory, Application } from "@mini-nest/core";
import {
  caughtExceptions,
  controllers,
  enhancers,
  globalModules,
  injections,
  modules,
  optionalInjections,
  optionalProperties,
  parameters,
  propertyInjections,
  providerOptions,
  redirects,
  responseHeaders,
  routes,
  statuses,
  versions,
} from "@mini-nest/common/internal/metadata";

describe("phase 1 decorator metadata", () => {
  it("records dynamic module/provider contracts without evaluating factories or forward references", () => {
    let evaluated = false;
    const token = Symbol("value");
    const reference = forwardRef(() => {
      evaluated = true;
      return Feature;
    });
    @Injectable({ scope: Scope.REQUEST })
    class Service {
      @Optional()
      @Inject(token)
      optional?: unknown;

      constructor(@Optional() @Inject("config") readonly config?: object) {}
    }
    @Global()
    @Module({
      imports: [reference],
      providers: [
        Service,
        { provide: token, useValue: 42 },
        { provide: "config", useFactory: async () => ({ enabled: true }) },
        { provide: "alias", useExisting: token },
        { provide: "class", useClass: Service },
      ],
      exports: [token, "alias"],
    })
    class Feature {}
    assert.equal(evaluated, false);
    assert.equal(globalModules.has(Feature), true);
    assert.equal(modules.get(Feature)?.providers?.length, 5);
    assert.equal(providerOptions.get(Service)?.scope, Scope.REQUEST);
    assert.equal(injections.get(Service)?.get(0), "config");
    assert.equal(optionalInjections.get(Service)?.has(0), true);
    assert.equal(propertyInjections.get(Service.prototype)?.get("optional"), token);
    assert.equal(optionalProperties.get(Service.prototype)?.has("optional"), true);
  });

  it("records controller, multi-path routing, headers, redirects and versions", () => {
    @Controller({ path: ["v1", "v2"], version: VERSION_NEUTRAL, host: "example.test" })
    class Api {
      @All(["first", "second"])
      @HttpCode(202)
      @Header("X-Mode", "demo")
      @Redirect("/target", 307)
      @Version(["1", "2"])
      handler(this: void) {}
    }
    assert.deepEqual(controllers.get(Api)?.path, ["/v1", "/v2"]);
    assert.deepEqual(routes.get(Api.prototype.handler), {
      method: "ALL",
      paths: ["/first", "/second"],
    });
    assert.equal(statuses.get(Api.prototype.handler), 202);
    assert.equal(responseHeaders.get(Api.prototype.handler)?.get("X-Mode"), "demo");
    assert.deepEqual(redirects.get(Api.prototype.handler), { url: "/target", statusCode: 307 });
    assert.deepEqual(versions.get(Api.prototype.handler), ["1", "2"]);
  });

  it("records parameter data, schemas, pipes, custom factories and passthrough", () => {
    class PassPipe implements PipeTransform {
      transform(value: unknown) {
        return value;
      }
    }
    const pipe = new PassPipe();
    const schema = {
      "~standard": {
        version: 1 as const,
        vendor: "test",
        validate: (value: unknown) => ({ value }),
      },
    };
    const factory = (field: string, context: ExecutionContext) =>
      context.switchToHttp().getRequest<Record<string, unknown>>()[field];
    const User = createParamDecorator(factory);
    class Api {
      handler(
        @Body("name", pipe) _name: unknown,
        @Query({ schema, pipes: [PassPipe] }) _query: unknown,
        @Param("id", PassPipe) _id: unknown,
        @Headers("authorization") _authorization: unknown,
        @Ip() _ip: unknown,
        @Res({ passthrough: true }) _response: unknown,
        @Req() _request: unknown,
        @User("user", pipe) _user: unknown,
      ) {}
    }
    const entries = parameters.get(Api.prototype)?.get("handler");
    assert.equal(entries?.length, 8);
    assert.deepEqual(entries?.find((entry) => entry.index === 0)?.pipes, [pipe]);
    assert.equal(entries?.find((entry) => entry.index === 1)?.schema, schema);
    assert.equal(entries?.find((entry) => entry.index === 5)?.passthrough, true);
    assert.equal(entries?.find((entry) => entry.index === 7)?.factory, factory);
    assert.equal(entries?.find((entry) => entry.index === 7)?.data, "user");
  });

  it("records enhancer levels, ordering and caught exception classes", () => {
    class Guard {
      canActivate() {
        return true;
      }
    }
    class Pipe {
      transform(value: unknown) {
        return value;
      }
    }
    class Interceptor {
      intercept() {
        return Promise.resolve("ok");
      }
    }
    @Catch(BadRequestException)
    class Filter {
      catch() {}
    }
    @UseGuards(Guard)
    class Api {
      @UseGuards(new Guard())
      @UsePipes(Pipe)
      @UseInterceptors(Interceptor)
      @UseFilters(Filter)
      handler(this: void) {}
    }
    assert.deepEqual(enhancers.get(Api)?.guards, [Guard]);
    assert.equal(enhancers.get(Api.prototype.handler)?.guards.length, 1);
    assert.deepEqual(enhancers.get(Api.prototype.handler)?.pipes, [Pipe]);
    assert.deepEqual(enhancers.get(Api.prototype.handler)?.interceptors, [Interceptor]);
    assert.deepEqual(caughtExceptions.get(Filter), [BadRequestException]);
  });

  it("runs parameter enhancers and validates invalid decorator targets", () => {
    let decorated = 0;
    const Custom = createParamDecorator(
      () => "value",
      [
        () => {
          decorated++;
        },
      ],
    );
    class Api {
      handler(@Custom() _value: unknown) {}
    }
    assert.equal(decorated, 1);
    assert.ok(Api);
    assert.throws(() => Header("Invalid Header", "x"), /valid header/);
    assert.throws(() => Header("X-Test", "x\r\nInjected: true"), /Invalid header/);
    assert.throws(() => Redirect("/", 200), /redirect status/);
    assert.throws(() => UseGuards({} as never), /canActivate/);
    assert.throws(() => Module({ invalid: [] } as never), /Invalid @Module/);
    assert.throws(() => Res()(Api, undefined, 0), /instance methods/);
  });

  it("keeps advanced runtime features explicit until their implementation phases", async () => {
    @Module({ providers: [{ provide: "config", useValue: {} }] })
    class FutureModule {}
    await assert.rejects(NestFactory.create(FutureModule), /require phase 2/);
    @Controller()
    class FutureController {
      @All()
      @UseGuards({ canActivate: () => true })
      handler(this: void) {}
    }
    assert.throws(() => new Application().register(new FutureController()), /metadata-only/);
    @UseGuards({ canActivate: () => true })
    class GuardedBase {}
    @Controller()
    class InheritedGuard extends GuardedBase {
      @All()
      handler() {}
    }
    assert.throws(() => new Application().register(new InheritedGuard()), /metadata-only/);
  });
});

describe("custom metadata and Reflector", () => {
  it("supports class/method metadata, inheritance, overrides and falsy values", () => {
    @SetMetadata("roles", ["class"])
    class Base {
      @SetMetadata("roles", ["method"])
      @SetMetadata("enabled", false)
      handler(this: void) {}
    }
    class Child extends Base {}
    const reflector = new Reflector();
    assert.deepEqual(reflector.get("roles", Child), ["class"]);
    assert.deepEqual(reflector.getAll("roles", [Base.prototype.handler, Base]), [
      ["method"],
      ["class"],
    ]);
    assert.deepEqual(reflector.getAllAndOverride("roles", [Base.prototype.handler, Base]), [
      "method",
    ]);
    assert.equal(reflector.getAllAndOverride("enabled", [Base.prototype.handler, Base]), false);
    assert.deepEqual(reflector.getAllAndMerge("roles", [Base.prototype.handler, Base]), [
      "method",
      "class",
    ]);
    assert.deepEqual(reflector.getAllAndMerge("absent", [Base]), []);
    assert.equal(reflector.get("absent", Base), undefined);
  });

  it("merges object metadata without modifying originals", () => {
    const first = { read: true, mode: "first" };
    const second = { write: true, mode: "second" };
    @SetMetadata("policy", first)
    class A {}
    @SetMetadata("policy", second)
    class B {}
    assert.deepEqual(new Reflector().getAllAndMerge("policy", [A, B]), {
      read: true,
      write: true,
      mode: "second",
    });
    assert.equal(first.mode, "first");
  });

  it("supports typed decorators with transforms, unique keys and composition", () => {
    const Roles = Reflector.createDecorator<string[]>();
    const Other = Reflector.createDecorator<string[]>();
    const Count = Reflector.createDecorator<string[], number>({
      transform: (roles) => roles.length,
    });
    const Composed = () => applyDecorators(Roles(["admin"]), Count(["one", "two"]));
    @Composed()
    class Admin {}
    assert.notEqual(Roles.KEY, Other.KEY);
    const roles: string[] = new Reflector().get(Roles, Admin);
    const count: number = new Reflector().get(Count, Admin);
    assert.deepEqual(roles, ["admin"]);
    assert.equal(count, 2);
  });
});
