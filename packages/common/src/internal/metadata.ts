export interface Type<T extends object = object> {
  new (...args: any[]): T;
}

export interface ModuleMetadata {
  imports?: Type[];
  controllers?: Type[];
  providers?: Type[];
  exports?: Type[];
}

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";
export interface RouteMetadata {
  method: HttpMethod;
  path: string;
}
export interface ParameterMetadata {
  index: number;
  source: "body" | "request" | "query" | "param";
  key?: string;
}

export const modules = new WeakMap<Type, ModuleMetadata>();
export const controllers = new WeakMap<Function, string>();
export const injectable = new WeakSet<Function>();
export const injections = new WeakMap<Function, Map<number, Type>>();
export const routes = new WeakMap<Function, RouteMetadata>();
export const statuses = new WeakMap<Function, number>();
export const parameters = new WeakMap<object, Map<string | symbol, ParameterMetadata[]>>();
