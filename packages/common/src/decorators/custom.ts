import { defineMetadata } from "../internal/custom-metadata.js";

export type CustomDecorator<TKey = string> = MethodDecorator & ClassDecorator & { KEY: TKey };

export function SetMetadata<K = string, V = any>(key: K, value: V): CustomDecorator<K> {
  const decorator = (
    target: object,
    _property?: string | symbol,
    descriptor?: PropertyDescriptor,
  ): void => {
    defineMetadata(key, value, descriptor?.value ?? target);
  };
  return Object.assign(decorator, { KEY: key });
}

export function applyDecorators(
  ...decorators: Array<ClassDecorator | MethodDecorator | PropertyDecorator>
): ClassDecorator & MethodDecorator & PropertyDecorator {
  return (target: object, property?: string | symbol, descriptor?: PropertyDescriptor) => {
    for (const decorator of decorators) {
      if (property === undefined) (decorator as ClassDecorator)(target as Function);
      else if (descriptor !== undefined)
        (decorator as MethodDecorator)(target, property, descriptor);
      else (decorator as PropertyDecorator)(target, property);
    }
  };
}
