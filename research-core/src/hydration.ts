/**
 * Hydration boundary (implementation phase): the only place allowed to parse storage
 * rows / JSON into nominal states. Every function returns a Result and validates at
 * runtime; nothing outside this module may parse a row into a state.
 */
export {}
