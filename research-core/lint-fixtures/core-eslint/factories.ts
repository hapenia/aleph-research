// Valid control: src/factories.ts is the trusted construction boundary, where an
// assertion is deliberately allowed by the config override.
export function trust(row: unknown): string {
  return row as string
}
