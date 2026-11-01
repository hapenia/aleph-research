// Fixture: hydration through JSON instead of the boundary parser.
export function decode(text: string): unknown {
  return JSON.parse(text)
}
