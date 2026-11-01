// Fixture: a dynamic import outside the composition root.
export async function load(): Promise<unknown> {
  return await import('./types/ids.js')
}
