import type {
  CanActivate,
  ExceptionFilter,
  NestInterceptor,
  PipeTransform,
  Type,
} from "../interfaces.js";
import {
  caughtExceptions,
  enhancers,
  type EnhancerMetadata,
} from "../internal/enhancer-metadata.js";

function useEnhancers(
  kind: keyof EnhancerMetadata,
  entries: Array<Type | CanActivate | PipeTransform | NestInterceptor | ExceptionFilter>,
  methodName: string,
): ClassDecorator & MethodDecorator {
  for (const entry of entries) {
    if (
      typeof entry !== "function" &&
      (typeof entry !== "object" ||
        entry === null ||
        !(methodName in entry) ||
        typeof Reflect.get(entry, methodName) !== "function")
    ) {
      throw new Error(
        `Invalid ${kind} decorator entry; expected a class or ${methodName}() instance.`,
      );
    }
  }
  return (target: object, _key?: string | symbol, descriptor?: PropertyDescriptor) => {
    if (descriptor && typeof descriptor.value !== "function") {
      throw new Error("Enhancer decorators require a class or method.");
    }
    const owner: object = descriptor?.value ?? target;
    const metadata = enhancers.get(owner) ?? {
      guards: [],
      pipes: [],
      interceptors: [],
      filters: [],
    };
    // Each decorator validates its own entry type before appending.
    (metadata[kind] as typeof entries).push(...entries);
    enhancers.set(owner, metadata);
  };
}

export const UseGuards = (...guards: Array<CanActivate | Type<CanActivate>>) =>
  useEnhancers("guards", guards, "canActivate");
export const UsePipes = (...pipes: Array<PipeTransform | Type<PipeTransform>>) =>
  useEnhancers("pipes", pipes, "transform");
export const UseInterceptors = (...interceptors: Array<NestInterceptor | Type<NestInterceptor>>) =>
  useEnhancers("interceptors", interceptors, "intercept");
export const UseFilters = (...filters: Array<ExceptionFilter | Type<ExceptionFilter>>) =>
  useEnhancers("filters", filters, "catch");

export function Catch(...exceptions: Type[]): ClassDecorator {
  if (exceptions.some((exception) => typeof exception !== "function")) {
    throw new Error("@Catch expects exception classes.");
  }
  return (target) => {
    caughtExceptions.set(target, [...exceptions]);
  };
}
