// Fixture: a type assertion outside the factory/hydration boundary.
export function forge(value: unknown): string {
  return value as string
}
