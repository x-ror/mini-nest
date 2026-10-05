import "reflect-metadata";
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Injectable,
  Module,
  Options,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Redirect,
  Req,
  Res,
  StreamableFile,
  UseGuards,
  UseInterceptors,
  Version,
  type CallHandler,
  type CanActivate,
  type ExecutionContext,
  type NestInterceptor,
  type NestMiddleware,
  type NestModule,
  type MiddlewareConsumer,
  type OnModuleInit,
  type OnModuleDestroy,
} from "@nestjs/common";
import { map } from "rxjs";
import type { NativeRequest, NativeResponse } from "nestjs-adapter-node";

@Injectable()
export class GreetingService implements OnModuleInit, OnModuleDestroy {
  initialized = false;
  destroyed = false;
  onModuleInit(): void {
    this.initialized = true;
  }
  onModuleDestroy(): void {
    this.destroyed = true;
  }
  message(): string {
    return "real Nest DI";
  }
}
@Injectable()
class AuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    return context.switchToHttp().getRequest<NativeRequest>().headers["x-auth"] === "yes";
  }
}
@Injectable()
class EnvelopeInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler) {
    return next.handle().pipe(map((value: unknown) => ({ data: value })));
  }
}
@Injectable()
class HeaderMiddleware implements NestMiddleware {
  use(_req: NativeRequest, res: NativeResponse, next: () => void): void {
    res.setHeader("x-middleware", "applied");
    next();
  }
}

@Controller("api")
class TestController {
  constructor(@Inject(GreetingService) private readonly greeting: GreetingService) {}
  @Get() index() {
    return { message: this.greeting.message() };
  }
  @Options("options")
  options() {
    return { options: true };
  }
  @Get("versioned")
  @Version("1")
  versioned() {
    return { version: "1" };
  }
  @Get("items/:id") item(@Param("id", ParseIntPipe) id: number, @Query() query: unknown) {
    return { id, query };
  }
  @Post("echo") echo(@Body() body: unknown) {
    return body;
  }
  @Post("form") form(@Body() body: Record<string, unknown>) {
    const upload = body.upload;
    return {
      body,
      upload:
        upload instanceof File ? { name: upload.name, size: upload.size, type: upload.type } : null,
    };
  }
  @Post("raw") raw(@Req() req: NativeRequest) {
    return { raw: req.rawBody?.toString("utf8") };
  }
  @Get("guarded") @UseGuards(AuthGuard) guarded() {
    return { allowed: true };
  }
  @Get("wrapped") @UseInterceptors(EnvelopeInterceptor) wrapped() {
    return { value: 1 };
  }
  @Get("error") error(): never {
    throw new BadRequestException("fixture error");
  }
  @Get("redirect") @Redirect("/api", 307) redirect(): void {}
  @Get("empty") @HttpCode(204) empty() {
    return { ignored: true };
  }
  @Get("header") @Header("x-example", "yes") header() {
    return "hello";
  }
  @Get("manual") manual(@Res() response: NativeResponse) {
    response.status(202).json({ manual: true });
  }
  @Get("cookies") cookies(@Res() response: NativeResponse) {
    response.setHeader("set-cookie", ["a=1; Path=/", "b=2; Path=/"]);
    response.json({ cookies: true });
  }
  @Get("file") file() {
    return new StreamableFile(Buffer.from("native stream"));
  }
}

@Module({
  controllers: [TestController],
  providers: [GreetingService, AuthGuard, EnvelopeInterceptor, HeaderMiddleware],
})
export class FixtureModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(HeaderMiddleware).forRoutes(TestController);
  }
}
