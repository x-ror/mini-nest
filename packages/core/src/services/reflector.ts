import { SetMetadata, type CustomDecorator } from "@mini-nest/common";
import { getMetadata } from "@mini-nest/common/internal/metadata";

export interface CreateDecoratorOptions<TParam = any, TTransformed = TParam> {
  key?: string;
  transform?: (value: TParam) => TTransformed;
}
export type ReflectableDecorator<TParam, TTransformed = TParam> = ((
  value?: TParam,
) => CustomDecorator) & { KEY: string; readonly __valueType?: TTransformed };

let decoratorSequence = 0;

export class Reflector {
  static createDecorator<TParam>(
    options?: CreateDecoratorOptions<TParam>,
  ): ReflectableDecorator<TParam>;
  static createDecorator<TParam, TTransformed>(
    options: CreateDecoratorOptions<TParam, TTransformed> & {
      transform: (value: TParam) => TTransformed;
    },
  ): ReflectableDecorator<TParam, TTransformed>;
  static createDecorator<TParam, TTransformed = TParam>(
    options: CreateDecoratorOptions<TParam, TTransformed> = {},
  ): ReflectableDecorator<TParam, TTransformed> {
    const key = options.key ?? `mini-nest:decorator:${++decoratorSequence}`;
    return Object.assign(
      (value?: TParam) =>
        SetMetadata(key, options.transform ? options.transform(value as TParam) : value),
      { KEY: key },
    );
  }

  get<TParam, TTransformed>(
    key: ReflectableDecorator<TParam, TTransformed>,
    target: Function,
  ): TTransformed;
  get<TResult = any, TKey = any>(key: TKey, target: Function): TResult;
  get(key: unknown, target: Function): any {
    return getMetadata(this.metadataKey(key), target);
  }

  getAll<TParam, TTransformed>(
    key: ReflectableDecorator<TParam, TTransformed>,
    targets: Function[],
  ): TTransformed[];
  getAll<TResult extends any[] = any[], TKey = any>(key: TKey, targets: Function[]): TResult;
  getAll(key: unknown, targets: Function[]): any[] {
    return targets.map((target) => this.get(key, target));
  }

  getAllAndOverride<TParam, TTransformed>(
    key: ReflectableDecorator<TParam, TTransformed>,
    targets: Function[],
  ): TTransformed;
  getAllAndOverride<TResult = any, TKey = any>(key: TKey, targets: Function[]): TResult;
  getAllAndOverride(key: unknown, targets: Function[]): any {
    return this.getAll(key, targets).find((value) => value !== undefined);
  }

  getAllAndMerge<TParam, TTransformed>(
    key: ReflectableDecorator<TParam, TTransformed>,
    targets: Function[],
  ): TTransformed extends any[]
    ? TTransformed
    : TTransformed extends object
      ? TTransformed
      : TTransformed[];
  getAllAndMerge<TResult extends any[] | object = any[], TKey = any>(
    key: TKey,
    targets: Function[],
  ): TResult;
  getAllAndMerge(key: unknown, targets: Function[]): any {
    const values = this.getAll(key, targets).filter((value) => value !== undefined);
    if (!values.length) return [];
    if (values.length === 1) {
      const value = values[0];
      return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value
        : Array.isArray(value)
          ? value
          : [value];
    }
    return values.reduce((previous, current) => {
      if (Array.isArray(previous)) return previous.concat(current);
      if (
        previous !== null &&
        current !== null &&
        typeof previous === "object" &&
        typeof current === "object"
      ) {
        return { ...previous, ...current };
      }
      return [previous, current];
    });
  }

  private metadataKey(key: unknown): unknown {
    return typeof key === "function" && "KEY" in key ? key.KEY : key;
  }
}
