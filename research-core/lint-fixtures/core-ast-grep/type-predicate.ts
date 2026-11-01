// Fixture: a type predicate can forge a nominal type.
export function isString(value: unknown): value is string {
  return typeof value === 'string'
}
