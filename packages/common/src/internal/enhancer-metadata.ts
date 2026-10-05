import type {
  CanActivate,
  ExceptionFilter,
  NestInterceptor,
  PipeTransform,
  Type,
} from "../interfaces.js";

export interface EnhancerMetadata {
  guards: Array<CanActivate | Type<CanActivate>>;
  pipes: Array<PipeTransform | Type<PipeTransform>>;
  interceptors: Array<NestInterceptor | Type<NestInterceptor>>;
  filters: Array<ExceptionFilter | Type<ExceptionFilter>>;
}
export const enhancers = new WeakMap<object, EnhancerMetadata>();
export const caughtExceptions = new WeakMap<Function, Type[]>();
