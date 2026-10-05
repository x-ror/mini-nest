import {
  All,
  Body,
  Catch,
  Controller,
  Global,
  Header,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Ip,
  Logger,
  Module,
  Optional,
  Param,
  Query,
  Redirect,
  Req,
  Res,
  Scope,
  SetMetadata,
  UseFilters,
  UseGuards,
  UseInterceptors,
  UsePipes,
  VERSION_NEUTRAL,
  applyDecorators,
  createParamDecorator,
  forwardRef,
  type ArgumentsHost,
  type CallHandler,
  type CanActivate,
  type DynamicModule,
  type ExceptionFilter,
  type ExecutionContext,
  type LoggerService,
  type NestInterceptor,
  type PipeTransform,
  type Provider,
} from "@mini-nest/common";
import { Reflector } from "@mini-nest/core";

// Compile-only acceptance examples for the phase 1 public API.
const CONFIG = Symbol("config");
const Roles = Reflector.createDecorator<string[]>();

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}
  canActivate(context: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride(Roles, [
      context.getHandler(),
      context.getClass(),
    ]);
    return roles === undefined || roles.includes("public");
  }
}
export class IdentityPipe implements PipeTransform {
  transform(value: unknown) {
    return value;
  }
}
export class TimingInterceptor implements NestInterceptor {
  async intercept(_context: ExecutionContext, next: CallHandler) {
    return await next.handle();
  }
}
@Catch(HttpException)
export class HttpFilter implements ExceptionFilter<HttpException> {
  catch(exception: HttpException, host: ArgumentsHost) {
    host.switchToHttp().getResponse().status(exception.getStatus()).json(exception.getResponse());
  }
}
const User = createParamDecorator<string>(
  (field, context: ExecutionContext) => context.switchToHttp().getRequest().user?.[field],
);
const Public = () => applyDecorators(SetMetadata("public", true), Roles(["public"]));

@Controller({ path: ["api", "v1"], version: VERSION_NEUTRAL })
@UseGuards(RolesGuard)
export class ContractController {
  constructor(@Optional() @Inject(CONFIG) readonly config?: object) {}
  @Optional()
  @Inject(CONFIG)
  readonly propertyConfig?: object;

  @All(["items/:id", "entries/:id"])
  @Public()
  @HttpCode(HttpStatus.ACCEPTED)
  @Header("X-Contract", "phase-1")
  @Redirect("/target", 307)
  @UsePipes(IdentityPipe)
  @UseInterceptors(TimingInterceptor)
  @UseFilters(HttpFilter)
  handler(
    @Param("id", IdentityPipe) id: string,
    @Body(new IdentityPipe()) body: unknown,
    @Query("q") query: string,
    @Headers("authorization") authorization: string,
    @Ip() ip: string,
    @Req() request: unknown,
    @Res({ passthrough: true }) response: unknown,
    @User("name") user: string,
  ) {
    return { id, body, query, authorization, ip, request, response, user };
  }
}

@Injectable({ scope: Scope.REQUEST })
export class ScopedContract {}
const providers: Provider[] = [
  RolesGuard,
  { provide: CONFIG, useValue: { enabled: true } },
  { provide: "async", useFactory: async (config: object) => config, inject: [CONFIG] },
  { provide: "class", useClass: ScopedContract, scope: Scope.TRANSIENT },
  { provide: "alias", useExisting: CONFIG },
];
@Global()
@Module({ providers, controllers: [ContractController], exports: [CONFIG] })
export class ContractModule {
  static forRoot(): DynamicModule {
    return { module: ContractModule, providers, global: true };
  }
  static forRootAsync(): DynamicModule {
    return {
      module: ContractModule,
      imports: [forwardRef(() => ContractModule)],
      providers: [
        {
          provide: CONFIG,
          useFactory: async () => ({}),
          inject: [{ token: "optional", optional: true }],
        },
      ],
    };
  }
}
export const contractLogger: LoggerService = new Logger("Contract");
