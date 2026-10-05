import type { ModuleMetadata } from "../interfaces.js";
import { globalModules, modules } from "../internal/module-metadata.js";

export function Module(metadata: ModuleMetadata): ClassDecorator {
  const allowed = new Set(["imports", "controllers", "providers", "exports"]);
  for (const key of Object.keys(metadata)) {
    if (!allowed.has(key)) throw new Error(`Invalid @Module metadata property: ${key}`);
  }
  return (target) => {
    modules.set(target, {
      imports: [...(metadata.imports ?? [])],
      controllers: [...(metadata.controllers ?? [])],
      providers: [...(metadata.providers ?? [])],
      exports: [...(metadata.exports ?? [])],
    });
  };
}

export function Global(): ClassDecorator {
  return (target) => {
    globalModules.add(target);
  };
}
