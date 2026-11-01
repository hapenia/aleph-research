// Fixture: a dynamic import of a research-core boundary module.
export async function load() {
  return import('../research-core/src/parsers.js')
}
