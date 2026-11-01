import js from '@eslint/js'
import tseslint from 'typescript-eslint'

/**
 * Static analysis beyond TypeScript.
 *
 * The compiler cannot stop `as`, `any`, JSON.parse or calls to factory methods. These
 * rules make the single trust boundary in the blueprint real: type assertions,
 * factory/fromRow calls, JSON parsing and non-null assertions are only allowed in the
 * factory/hydration modules and in the type tests that deliberately exercise them.
 */
export default tseslint.config(
  { ignores: ['node_modules/**', 'dist/**', 'eslint.config.js'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'never' }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector: 'TSTypePredicate',
          message: 'User-defined type predicates can forge any nominal type; parse inside the boundary instead.',
        },
        {
          selector: "MemberExpression[object.name='JSON']",
          message: 'Hydration goes through the boundary parser, not JSON.',
        },
        {
          selector: "CallExpression[callee.object.name='JSON'][callee.property.name='parse']",
          message: 'Hydration goes through fromRow, not JSON.parse.',
        },
        {
          selector: 'CallExpression[callee.object.name=/^(Date|Math)$/][callee.property.name="now"]',
          message: 'Use the Clock port, not a global clock.',
        },
        {
          selector: 'ImportExpression',
          message: 'Dynamic imports are not part of the domain package.',
        },
      ],
      'no-restricted-globals': ['error', 'process', 'fetch', 'setTimeout', 'setInterval', 'globalThis', 'JSON', 'eval'],
      'no-eval': 'error',
      'no-new-func': 'error',
      '@typescript-eslint/ban-ts-comment': [
        'error',
        { 'ts-expect-error': true, 'ts-ignore': true, 'ts-nocheck': true, 'ts-check': false },
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/factories.js', '**/hydration.js', '**/parsers.js', '**/type-tests.js'],
              message: 'Boundary modules are imported only by the adapter/composition root.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/type-tests.ts', 'src/factories.ts', 'src/hydration.ts', 'src/parsers.ts'],
    rules: {
      '@typescript-eslint/consistent-type-assertions': 'off',
      'no-restricted-syntax': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-restricted-imports': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
    },
  },
  {
    // The command parser reuses parsers.ts; it gets only the import exemption, not the
    // assertion/predicate/JSON allowlist.
    files: ['src/parsers-commands.ts'],
    rules: {
      'no-restricted-imports': 'off',
    },
  },
  {
    files: ['src/types/**/*.ts'],
    rules: {
      // Type-only declarations do not execute; unused imports are checked by tsc.
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },
)
