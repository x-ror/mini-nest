import type { ForwardReference, InjectableOptions, InjectionToken } from "../interfaces.js";
import {
  injectable,
  injections,
  optionalInjections,
  optionalProperties,
  propertyInjections,
  providerOptions,
  readDesignMetadata,
} from "../internal/provider-metadata.js";

export const forwardRef = <T = any>(fn: () => T): ForwardReference<T> => ({ forwardRef: fn });

export function Injectable(options: InjectableOptions = {}): ClassDecorator {
  return (target) => {
    injectable.add(target);
    providerOptions.set(target, { ...options });
  };
}

function isToken(token: unknown): token is InjectionToken | ForwardReference {
  return (
    typeof token === "string" ||
    typeof token === "symbol" ||
    typeof token === "function" ||
    (typeof token === "object" &&
      token !== null &&
      "forwardRef" in token &&
      typeof token.forwardRef === "function")
  );
}

export function Inject(
  token?: InjectionToken | ForwardReference,
): PropertyDecorator & ParameterDecorator {
  return (target: object, property: string | symbol | undefined, index?: number) => {
    let dependency: unknown = token;
    if (dependency === undefined) {
      const reflected = readDesignMetadata(
        index === undefined ? "design:type" : "design:paramtypes",
        target,
        property,
      );
      dependency = Array.isArray(reflected) && index !== undefined ? reflected[index] : reflected;
    }
    if (!isToken(dependency)) {
      throw new Error("@Inject requires a token or available design-type metadata.");
    }
    if (index === undefined && property !== undefined) {
      if (typeof target === "function") throw new Error("@Inject requires an instance property.");
      const entries = propertyInjections.get(target) ?? new Map();
      if (entries.has(property)) throw new Error("A property may have only one @Inject decorator.");
      entries.set(property, dependency);
      propertyInjections.set(target, entries);
      return;
    }
    if (index === undefined || property !== undefined || typeof target !== "function") {
      throw new Error("@Inject requires a constructor parameter or property.");
    }
    const entries = injections.get(target) ?? new Map();
    if (entries.has(index)) {
      throw new Error("A constructor parameter may have only one @Inject decorator.");
    }
    entries.set(index, dependency);
    injections.set(target, entries);
  };
}

export function Optional(): PropertyDecorator & ParameterDecorator {
  return (target: object, property: string | symbol | undefined, index?: number) => {
    if (index === undefined && property !== undefined) {
      if (typeof target === "function") throw new Error("@Optional requires an instance property.");
      const entries = optionalProperties.get(target) ?? new Set();
      entries.add(property);
      optionalProperties.set(target, entries);
    } else if (index !== undefined && property === undefined && typeof target === "function") {
      const entries = optionalInjections.get(target) ?? new Set();
      entries.add(index);
      optionalInjections.set(target, entries);
    } else {
      throw new Error("@Optional requires a constructor parameter or property.");
    }
  };
}
