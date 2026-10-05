export interface Type<T = any> extends Function {
  new (...args: any[]): T;
}

export interface Abstract<T = any> extends Function {
  prototype: T;
}

export interface ForwardReference<T = any> {
  forwardRef: () => T;
}

export type InjectionToken<T = any> = string | symbol | Type<T> | Abstract<T> | Function;
export enum Scope {
  DEFAULT,
  TRANSIENT,
  REQUEST,
}

export interface ScopeOptions {
  scope?: Scope;
  durable?: boolean;
}
export type InjectableOptions = ScopeOptions;
export interface OptionalFactoryDependency {
  token: InjectionToken;
  optional: boolean;
}
export interface ClassProvider<T = any> extends ScopeOptions {
  provide: InjectionToken;
  useClass: Type<T>;
  inject?: never;
}
export interface ValueProvider<T = any> {
  provide: InjectionToken;
  useValue: T;
  inject?: never;
}
export interface FactoryProvider<T = any> extends ScopeOptions {
  provide: InjectionToken;
  useFactory: (...args: any[]) => T | Promise<T>;
  inject?: Array<InjectionToken | OptionalFactoryDependency>;
}
export interface ExistingProvider<T = any> {
  provide: InjectionToken;
  useExisting: InjectionToken<T>;
}
export type Provider<T = any> =
  | Type<T>
  | ClassProvider<T>
  | ValueProvider<T>
  | FactoryProvider<T>
  | ExistingProvider<T>;
export interface ModuleMetadata {
  imports?: Array<Type | DynamicModule | Promise<DynamicModule> | ForwardReference>;
  controllers?: Type[];
  providers?: Provider[];
  exports?: Array<DynamicModule | InjectionToken | Provider | ForwardReference>;
}
export interface DynamicModule extends ModuleMetadata {
  module: Type;
  global?: boolean;
}

export const VERSION_NEUTRAL = Symbol("VERSION_NEUTRAL");
export type VersionValue = string | typeof VERSION_NEUTRAL | Array<string | typeof VERSION_NEUTRAL>;
export interface VersionOptions {
  version?: VersionValue;
}
export interface ControllerOptions extends ScopeOptions, VersionOptions {
  path?: string | string[];
  host?: string | RegExp | Array<string | RegExp>;
}
export enum RequestMethod {
  GET,
  POST,
  PUT,
  DELETE,
  PATCH,
  ALL,
  OPTIONS,
  HEAD,
  SEARCH,
}
export type ContextType = "http" | "ws" | "rpc";
export interface HttpArgumentsHost {
  getRequest<T = any>(): T;
  getResponse<T = any>(): T;
  getNext<T = any>(): T;
}
export interface WsArgumentsHost {
  getData<T = any>(): T;
  getClient<T = any>(): T;
  getPattern(): string;
}
export interface RpcArgumentsHost {
  getData<T = any>(): T;
  getContext<T = any>(): T;
}
export interface ArgumentsHost {
  getArgs<T extends any[] = any[]>(): T;
  getArgByIndex<T = any>(index: number): T;
  switchToHttp(): HttpArgumentsHost;
  switchToWs(): WsArgumentsHost;
  switchToRpc(): RpcArgumentsHost;
  getType<TContext extends string = ContextType>(): TContext;
}
export interface ExecutionContext extends ArgumentsHost {
  getClass<T = any>(): Type<T>;
  getHandler(): Function;
}
export interface CanActivate {
  canActivate(context: ExecutionContext): boolean | Promise<boolean> | ObservableLike<boolean>;
}
export interface ObservableLike<T> {
  subscribe(observer: {
    next(value: T): void;
    error(error: unknown): void;
    complete(): void;
  }): unknown;
}
export interface StandardSchema {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => unknown;
  };
}
export type Paramtype = "body" | "query" | "param" | "custom";
export interface ArgumentMetadata<Metatype = any> {
  readonly type: Paramtype;
  readonly metatype?: Type<Metatype>;
  readonly data?: string;
  readonly schema?: StandardSchema;
}
export interface PipeTransform<T = any, R = any> {
  transform(value: T, metadata: ArgumentMetadata): R;
}
export type Pipe = Type<PipeTransform> | PipeTransform;
export interface ParameterDecoratorOptions {
  schema?: StandardSchema;
  pipes?: Pipe[];
}
export interface ResponseDecoratorOptions {
  passthrough: boolean;
}
export interface CallHandler<T = any> {
  handle(): Promise<T>;
}
export interface NestInterceptor<T = any, R = any> {
  intercept(context: ExecutionContext, next: CallHandler<T>): R | Promise<R>;
}
export interface ExceptionFilter<T = any> {
  catch(exception: T, host: ArgumentsHost): any;
}
export type CustomParamFactory<TData = any, TOutput = any> = (
  data: TData,
  context: ExecutionContext,
) => TOutput;

export interface OnModuleInit {
  onModuleInit(): any;
}
export interface OnApplicationBootstrap {
  onApplicationBootstrap(): any;
}
export interface OnModuleDestroy {
  onModuleDestroy(): any;
}
export interface BeforeApplicationShutdown {
  beforeApplicationShutdown(signal?: string): any;
}
export interface OnApplicationShutdown {
  onApplicationShutdown(signal?: string): any;
}
export interface NestMiddleware {
  use(req: any, res: any, next: (error?: any) => void): any;
}
export interface RouteInfo {
  path: string;
  method: RequestMethod;
  version?: VersionValue;
}
export interface MiddlewareConfigProxy {
  exclude(...routes: Array<string | RouteInfo>): MiddlewareConfigProxy;
  forRoutes(...routes: Array<string | Type | RouteInfo>): MiddlewareConsumer;
}
export interface MiddlewareConsumer {
  apply(...middleware: Array<Type | Function>): MiddlewareConfigProxy;
}
export interface NestModule {
  configure(consumer: MiddlewareConsumer): any;
}
