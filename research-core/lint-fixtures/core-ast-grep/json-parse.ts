// Fixture: JSON.parse outside the boundary parser module.
export function decode(text: string): unknown {
  return JSON.parse(text)
}
