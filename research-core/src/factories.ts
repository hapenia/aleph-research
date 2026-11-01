/**
 * Factory boundary (implementation phase): the only place allowed to construct a nominal
 * domain state, call a private constructor, or trust Host input. ESLint and ast-grep
 * reject `.create(` calls, assertions and `any` outside this module (and hydration.ts).
 */
export {}
