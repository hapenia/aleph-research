// Fixture: a string callback is implied eval.
export function later() {
  return setTimeout('work()', 10)
}
