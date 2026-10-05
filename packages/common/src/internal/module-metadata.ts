import type { ModuleMetadata } from "../interfaces.js";

export const modules = new WeakMap<Function, ModuleMetadata>();
export const globalModules = new WeakSet<Function>();
