import type { CustomParamFactory, Pipe, StandardSchema, Type } from "../interfaces.js";

export interface ParameterMetadata {
  index: number;
  source:
    | "body"
    | "request"
    | "query"
    | "param"
    | "headers"
    | "ip"
    | "response"
    | "next"
    | "custom";
  key?: string;
  pipes: Pipe[];
  schema?: StandardSchema;
  passthrough?: boolean;
  factory?: CustomParamFactory;
  data?: unknown;
}
export const parameters = new WeakMap<object, Map<string | symbol, ParameterMetadata[]>>();
export const parameterMetatypes = new WeakMap<object, Map<string | symbol, Type[]>>();
