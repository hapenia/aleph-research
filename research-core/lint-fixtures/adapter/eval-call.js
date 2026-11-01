// Fixture: eval must never appear in the adapter.
export function run(code) {
  return eval(code)
}
