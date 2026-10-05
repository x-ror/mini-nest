export function normalizePath(path: string): string {
  return `/${path.split("/").filter(Boolean).join("/")}`;
}
