import type { ControllerOptions, VersionValue } from "../interfaces.js";

export type HttpMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "OPTIONS"
  | "HEAD"
  | "SEARCH"
  | "ALL";
export interface RouteMetadata {
  method: HttpMethod;
  paths: string[];
}
export interface RedirectMetadata {
  url: string;
  statusCode: number;
}
export const controllers = new WeakMap<Function, ControllerOptions>();
export const routes = new WeakMap<Function, RouteMetadata>();
export const statuses = new WeakMap<Function, number>();
export const responseHeaders = new WeakMap<Function, Map<string, string | (() => string)>>();
export const redirects = new WeakMap<Function, RedirectMetadata>();
export const versions = new WeakMap<Function, VersionValue>();
