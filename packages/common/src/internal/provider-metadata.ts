import type { ForwardReference, InjectionToken, ScopeOptions, Type } from "../interfaces.js";

export const injectable = new WeakSet<Function>();
export const providerOptions = new WeakMap<Function, ScopeOptions>();
export const injections = new WeakMap<Function, Map<number, InjectionToken | ForwardReference>>();
export const optionalInjections = new WeakMap<Function, Set<number>>();
export const propertyInjections = new WeakMap<
  object,
  Map<string | symbol, InjectionToken | ForwardReference>
>();
export const optionalProperties = new WeakMap<object, Set<string | symbol>>();

export function readDesignMetadata(
  key: string,
  target: object,
  property?: string | symbol,
): unknown {
  const getter: unknown = Reflect.get(Reflect, "getMetadata");
  return typeof getter === "function" ? getter.call(Reflect, key, target, property) : undefined;
}

export function isClassToken(token: unknown): token is Type {
  return typeof token === "function" && token.prototype !== undefined;
}

export function constructorDependencies(
  target: Function,
): Map<number, InjectionToken | ForwardReference> {
  const reflected = readDesignMetadata("design:paramtypes", target);
  const dependencies = new Map<number, InjectionToken | ForwardReference>();
  if (Array.isArray(reflected)) {
    reflected.forEach((token: unknown, index) => {
      if (typeof token === "function") dependencies.set(index, token);
    });
  }
  for (const [index, token] of injections.get(target) ?? []) dependencies.set(index, token);
  return dependencies;
}
