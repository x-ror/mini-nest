const metadata = new WeakMap<object, Map<unknown, unknown>>();

export function defineMetadata(key: unknown, value: unknown, target: object): void {
  const entries = metadata.get(target) ?? new Map<unknown, unknown>();
  entries.set(key, value);
  metadata.set(target, entries);
}

export function getMetadata<T = unknown>(key: unknown, target: object): T | undefined {
  let current: object | null = target;
  while (current) {
    const entries = metadata.get(current);
    if (entries?.has(key)) return entries.get(key) as T;
    current = Object.getPrototypeOf(current);
  }
  return undefined;
}
