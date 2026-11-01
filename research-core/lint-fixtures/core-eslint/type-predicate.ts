// Fixture: a user-defined type predicate can forge any nominal type.
export function isNonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}
