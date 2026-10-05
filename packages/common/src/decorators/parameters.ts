import type {
  CustomParamFactory,
  ParameterDecoratorOptions,
  Pipe,
  ResponseDecoratorOptions,
  Type,
} from "../interfaces.js";
import {
  parameters,
  parameterMetatypes,
  type ParameterMetadata,
} from "../internal/parameter-metadata.js";
import { isClassToken, readDesignMetadata } from "../internal/provider-metadata.js";

function registerParameter(entry: Omit<ParameterMetadata, "index">): ParameterDecorator {
  return (target, property, index) => {
    if (property === undefined || typeof target === "function") {
      throw new Error("Request parameter decorators require instance methods.");
    }
    const metadata = parameters.get(target) ?? new Map();
    const entries: ParameterMetadata[] = metadata.get(property) ?? [];
    if (entries.some((parameter) => parameter.index === index)) {
      throw new Error("A parameter may have only one request decorator.");
    }
    entries.push({ ...entry, pipes: [...entry.pipes], index });
    metadata.set(property, entries);
    parameters.set(target, metadata);
    const reflected = readDesignMetadata("design:paramtypes", target, property);
    if (Array.isArray(reflected) && reflected.every(isClassToken)) {
      const types = parameterMetatypes.get(target) ?? new Map<string | symbol, Type[]>();
      types.set(property, reflected);
      parameterMetatypes.set(target, types);
    }
  };
}

function isPipe(value: unknown): value is Pipe {
  return (
    typeof value === "function" ||
    (typeof value === "object" &&
      value !== null &&
      "transform" in value &&
      typeof value.transform === "function")
  );
}

function extract(
  source: ParameterMetadata["source"],
  dataOrPipe?: string | Pipe | ParameterDecoratorOptions,
  pipes: Pipe[] = [],
): ParameterDecorator {
  let options: ParameterDecoratorOptions = {};
  let key: string | undefined;
  if (typeof dataOrPipe === "string") key = dataOrPipe;
  else if (isPipe(dataOrPipe)) pipes = [dataOrPipe, ...pipes];
  else if (dataOrPipe !== undefined) options = dataOrPipe;
  const selected = [...(options.pipes ?? []), ...pipes];
  if (selected.some((pipe) => !isPipe(pipe)))
    throw new Error("Parameter pipes must implement transform().");
  return registerParameter({ source, key, pipes: selected, schema: options.schema });
}

export const Body = (dataOrPipe?: string | Pipe | ParameterDecoratorOptions, ...pipes: Pipe[]) =>
  extract("body", dataOrPipe, pipes);
export const Query = (dataOrPipe?: string | Pipe | ParameterDecoratorOptions, ...pipes: Pipe[]) =>
  extract("query", dataOrPipe, pipes);
export const Param = (dataOrPipe?: string | Pipe | ParameterDecoratorOptions, ...pipes: Pipe[]) =>
  extract("param", dataOrPipe, pipes);
export const Headers = (property?: string) => extract("headers", property);
export const Req = () => registerParameter({ source: "request", pipes: [] });
export const Request = Req;
export const Res = (options?: ResponseDecoratorOptions) =>
  registerParameter({ source: "response", passthrough: options?.passthrough ?? false, pipes: [] });
export const Response = Res;
export const Ip = () => registerParameter({ source: "ip", pipes: [] });
export const Next = () => registerParameter({ source: "next", pipes: [] });

export function createParamDecorator<FactoryData = any, FactoryOutput = any>(
  factory: CustomParamFactory<FactoryData, FactoryOutput>,
  enhancers: ParameterDecorator[] = [],
) {
  if (typeof factory !== "function") throw new Error("createParamDecorator requires a factory.");
  return (
    dataOrPipe?: FactoryData | Pipe | ParameterDecoratorOptions,
    ...pipes: Pipe[]
  ): ParameterDecorator => {
    const firstIsPipe = isPipe(dataOrPipe);
    const options =
      !firstIsPipe &&
      typeof dataOrPipe === "object" &&
      dataOrPipe !== null &&
      ("pipes" in dataOrPipe || "schema" in dataOrPipe)
        ? (dataOrPipe as ParameterDecoratorOptions)
        : undefined;
    const selected = [...(options?.pipes ?? []), ...(firstIsPipe ? [dataOrPipe, ...pipes] : pipes)];
    if (selected.some((pipe) => !isPipe(pipe)))
      throw new Error("Parameter pipes must implement transform().");
    const decorator = registerParameter({
      source: "custom",
      factory,
      data: firstIsPipe || options ? undefined : dataOrPipe,
      pipes: selected,
      schema: options?.schema,
    });
    return (target, property, index) => {
      decorator(target, property, index);
      for (const enhancer of enhancers) enhancer(target, property, index);
    };
  };
}
