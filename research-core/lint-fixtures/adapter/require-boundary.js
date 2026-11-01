// Fixture: require of a research-core boundary module outside the composition root.
export function load() {
  return require('../research-core/src/hydration.js')
}
