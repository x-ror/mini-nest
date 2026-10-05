import {
  controllers,
  injectable,
  injections,
  modules,
  type Type,
} from "@mini-nest/common/internal/metadata";

interface ModuleRef {
  type: Type;
  imports: ModuleRef[];
  providers: Set<Type>;
  controllers: Type[];
  exports: Set<Type>;
  instances: Map<Type, object>;
}

export class Container {
  private readonly refs = new Map<Type, ModuleRef>();
  private readonly building = new Set<Type>();
  private readonly resolving = new Map<ModuleRef, Set<Type>>();

  createControllers(root: Type): object[] {
    this.addModule(root);
    const result: object[] = [];
    for (const ref of this.refs.values()) {
      for (const provider of ref.providers) this.resolve(provider, ref);
      for (const controller of ref.controllers) result.push(this.resolve(controller, ref));
    }
    return result;
  }

  private addModule(type: Type): ModuleRef {
    if (this.building.has(type)) {
      throw new Error(`Circular module import: ${type.name}`);
    }
    const existing = this.refs.get(type);
    if (existing) return existing;
    const metadata = modules.get(type);
    if (!metadata) throw new Error(`${type.name} must have a @Module decorator.`);

    const ref: ModuleRef = {
      type,
      imports: [],
      providers: new Set(metadata.providers),
      controllers: metadata.controllers ?? [],
      exports: new Set(metadata.exports),
      instances: new Map(),
    };
    for (const provider of ref.providers) {
      if (!injectable.has(provider)) {
        throw new Error(`${provider.name} must have an @Injectable decorator.`);
      }
    }
    for (const controller of ref.controllers) {
      if (!controllers.has(controller)) {
        throw new Error(`${controller.name} must have a @Controller decorator.`);
      }
    }
    for (const exported of ref.exports) {
      if (!ref.providers.has(exported)) {
        throw new Error(`${type.name} can only export its own providers: ${exported.name}`);
      }
    }
    this.building.add(type);
    for (const imported of metadata.imports ?? []) ref.imports.push(this.addModule(imported));
    this.building.delete(type);
    this.refs.set(type, ref);
    return ref;
  }

  private resolve(type: Type, ref: ModuleRef): object {
    if (!ref.providers.has(type) && !ref.controllers.includes(type)) {
      return this.resolve(type, this.findProviderModule(type, ref));
    }
    const existing = ref.instances.get(type);
    if (existing) return existing;
    const resolving = this.resolving.get(ref) ?? new Set<Type>();
    this.resolving.set(ref, resolving);
    if (resolving.has(type)) {
      throw new Error(`Circular dependency while resolving ${type.name} in ${ref.type.name}.`);
    }
    resolving.add(type);
    try {
      const instance = new type(...this.resolveConstructorArguments(type, ref));
      ref.instances.set(type, instance);
      return instance;
    } finally {
      resolving.delete(type);
    }
  }

  private findProviderModule(type: Type, ref: ModuleRef): ModuleRef {
    const candidates = ref.imports.filter((imported) => imported.exports.has(type));
    if (candidates.length > 1) {
      throw new Error(`Ambiguous provider ${type.name} in ${ref.type.name}.`);
    }
    const imported = candidates[0];
    if (!imported) {
      throw new Error(`Provider ${type.name} is not available in ${ref.type.name}.`);
    }
    return imported;
  }

  private resolveConstructorArguments(type: Type, ref: ModuleRef): unknown[] {
    const dependencies = injections.get(type) ?? new Map<number, Type>();
    const decoratedParameterCount = Math.max(
      0,
      ...[...dependencies.keys()].map((index) => index + 1),
    );
    const parameterCount = Math.max(type.length, decoratedParameterCount);
    return Array.from({ length: parameterCount }, (_, index) => {
      const dependency = dependencies.get(index);
      if (!dependency) {
        if (index < type.length) {
          throw new Error(`Missing @Inject for constructor parameter ${index} of ${type.name}.`);
        }
        return undefined;
      }
      if (!injectable.has(dependency)) {
        throw new Error(
          `Cannot resolve constructor parameter ${index} of ${type.name}; use an @Injectable class.`,
        );
      }
      return this.resolve(dependency, ref);
    });
  }
}
