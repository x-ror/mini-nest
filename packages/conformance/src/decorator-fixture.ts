import type { InjectableOptions, InjectionToken, ForwardReference, Pipe } from "@mini-nest/common";

interface DecoratorAPI {
  Controller: (path: string | string[]) => ClassDecorator;
  Injectable: (options?: InjectableOptions) => ClassDecorator;
  Inject: (token?: InjectionToken | ForwardReference) => PropertyDecorator & ParameterDecorator;
  Optional: () => PropertyDecorator & ParameterDecorator;
  Global: () => ClassDecorator;
  All: (path?: string | string[]) => MethodDecorator;
  Body: (key: string, ...pipes: Pipe[]) => ParameterDecorator;
  Param: (key: string, ...pipes: Pipe[]) => ParameterDecorator;
  Query: (key: string, ...pipes: Pipe[]) => ParameterDecorator;
  Headers: (key?: string) => ParameterDecorator;
  Req: () => ParameterDecorator;
  Res: (options?: { passthrough: boolean }) => ParameterDecorator;
  Ip: () => ParameterDecorator;
  Header: (name: string, value: string) => MethodDecorator;
  Redirect: (url: string, statusCode?: number) => MethodDecorator;
  HttpCode: (statusCode: number) => MethodDecorator;
}

export function decoratorFixture(api: DecoratorAPI) {
  const {
    Controller,
    Injectable,
    Inject,
    Optional,
    Global,
    All,
    Body,
    Param,
    Query,
    Headers,
    Req,
    Res,
    Ip,
    Header,
    Redirect,
    HttpCode,
  } = api;
  @Injectable()
  class Service {
    constructor(@Optional() @Inject("config") readonly config?: unknown) {}
  }
  @Global()
  class GlobalModule {}
  @Controller(["api", "v1"])
  class Api {
    @Inject(Service)
    service?: Service;
    @All(["first", "second"])
    @HttpCode(202)
    @Header("X-Contract", "phase-1")
    @Redirect("/target", 307)
    handler(
      @Body("name") _name: unknown,
      @Param("id") _id: unknown,
      @Query("query") _query: unknown,
      @Headers("authorization") _authorization: unknown,
      @Req() _request: unknown,
      @Res({ passthrough: true }) _response: unknown,
      @Ip() _ip: unknown,
    ) {}
  }
  return { Service, GlobalModule, Api };
}
