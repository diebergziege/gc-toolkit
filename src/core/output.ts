export function toJson(value: unknown): string {
  const compact = JSON.stringify(value);
  return compact.length < 4000 ? JSON.stringify(value, null, 2) : compact;
}
