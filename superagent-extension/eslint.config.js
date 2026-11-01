/**
 * ESLint boundary for the superagent-extension adapter.
 *
 * `research-core` keeps the construction boundary honest with its own ESLint/ast-grep
 * configuration; the adapter lives in a separate package, so it needs the same lint
 * boundary. This file is deliberately dependency-free: it is a plain flat config that
 * only uses ESLint core rules plus the three small inline rules below, so it parses with
 * the eslint/espree installation the repository already has in `research-core/node_modules`
 * (`npm run lint` in this package points there; run it from `superagent-extension`):
 *
 *   node ../research-core/node_modules/eslint/bin/eslint.js .
 *
 * The rules enforce the four adapter-level promises of `docs/runtime-safety-contract.md`
 * (see "Only the composition root mints principals…" and "Adapter is covered"):
 *
 *   - `eval` / `new Function` are never allowed;
 *   - JSON is parsed only in the adapter's designated format-parser modules below,
 *     never in arbitrary adapter code;
 *   - the research-core boundary modules (`factories`, `hydration`, `parsers`,
 *     `type-tests`) may only be imported by the composition root, and never with a
 *     dynamic import; and
 *   - TypeScript suppression comments (`@ts-expect-error`, `@ts-ignore`,
 *     `@ts-nocheck`) are forbidden because they would hide a boundary violation.
 *
 * `test/**` is excluded: the tests exercise the adapter from the outside and may use
 * JSON to build fixtures. Adding a new format parser is a deliberate act: add its file
 * name to `PARSER_MODULES` (and justify it in the commit message), rather than adding a
 * local `JSON.parse` at the call site.
 */

/** Files that may call `JSON.parse`: one module per persisted/stream format, plus the HTTP body reader. */
const PARSER_MODULES = new Set([
  'config-store.js', // aleph-config.json / history file
  'evaluation.js', // last JSON line printed by the evaluator
  'research-channel.js', // append-only channel JSONL
  'research-extension.js', // untrusted HTTP request bodies (the adapter's body parser)
  'results.js', // append-only results JSONL
])

/** The composition root of the adapter: the only file allowed to reach into a boundary module. */
const COMPOSITION_ROOT = new Set(['index.js'])

/**
 * Path segments of the research-core boundary modules. `type-tests` is included so the
 * adapter cannot import the deliberate negative tests as a laundering route.
 */
const BOUNDARY_SEGMENT = /(?:^|[\\/])(?:factories|hydration|parsers|type-tests)(?:\.(?:[cm]?[jt]s))?(?:[\\/]|$)/

/** TypeScript suppression directives that would hide a violation from `tsc`. */
const TS_SUPPRESSION = /@ts-(?:expect-error|ignore|nocheck)\b/

/** File name without its directory, used for the allowlists above. */
function fileNameOf(filename) {
  const parts = String(filename ?? '').split(/[\\/]/)
  return parts[parts.length - 1] ?? ''
}

/** The source text of an import/require specifier, or null when it is not a static string. */
function specifierOf(sourceCode, node) {
  if (!node || typeof node !== 'object' || typeof node.type !== 'string') return null
  if (node.type === 'Literal') return typeof node.value === 'string' ? node.value : null
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    const quasi = node.quasis[0]
    return quasi && typeof quasi.value?.cooked === 'string' ? quasi.value.cooked : null
  }
  return sourceCode.getText(node)
}

const boundaryImportRule = {
  meta: {
    type: 'problem',
    docs: { description: 'research-core boundary modules are only reachable from the composition root' },
    schema: [],
    messages: {
      static:
        'Import the research-core boundary module "{{specifier}}" only from the composition root ({{roots}}), never from adapter code.',
      dynamic:
        'Dynamic import of the research-core boundary module "{{specifier}}" is forbidden; composition happens once, statically, at the root.',
    },
  },
  create(context) {
    const sourceCode = context.sourceCode
    const isRoot = COMPOSITION_ROOT.has(fileNameOf(context.filename))

    /**
     * Report a specifier when it names a boundary module. A static import (or require)
     * is allowed in the composition root only; a dynamic import is never allowed: the
     * composition root must show the dependency statically.
     */
    function check(node, specifier, kind) {
      if (specifier === null) return
      if (kind === 'static' && isRoot) return
      if (!BOUNDARY_SEGMENT.test(specifier)) return
      context.report({
        node,
        messageId: kind,
        data: { specifier, roots: [...COMPOSITION_ROOT].join(', ') },
      })
    }

    return {
      ImportDeclaration(node) {
        check(node, specifierOf(sourceCode, node.source), 'static')
      },
      ExportNamedDeclaration(node) {
        check(node, specifierOf(sourceCode, node.source), 'static')
      },
      ExportAllDeclaration(node) {
        check(node, specifierOf(sourceCode, node.source), 'static')
      },
      ImportExpression(node) {
        check(node, specifierOf(sourceCode, node.source), 'dynamic')
      },
      CallExpression(node) {
        if (node.callee.type !== 'Identifier' || node.callee.name !== 'require') return
        const [first] = node.arguments
        check(node, specifierOf(sourceCode, first), 'static')
      },
    }
  },
}

const jsonParseRule = {
  meta: {
    type: 'problem',
    docs: { description: 'JSON.parse is confined to the designated adapter parser modules' },
    schema: [],
    messages: {
      outside:
        'JSON.parse belongs to the adapter parser boundary ({{modules}}); parse through one of them instead of parsing JSON in {{file}}.',
    },
  },
  create(context) {
    const file = fileNameOf(context.filename)
    if (PARSER_MODULES.has(file)) return {}

    /** True for `JSON.parse(...)` and `globalThis.JSON.parse(...)`. */
    function isJsonParse(callee) {
      if (!callee || callee.type !== 'MemberExpression') return false
      if (callee.computed || callee.property.type !== 'Identifier' || callee.property.name !== 'parse') return false
      const object = callee.object
      if (object.type === 'Identifier') return object.name === 'JSON'
      if (object.type === 'MemberExpression' && object.object.type === 'Identifier') {
        return object.object.name === 'globalThis' && object.property.type === 'Identifier' && object.property.name === 'JSON'
      }
      return false
    }

    return {
      CallExpression(node) {
        if (!isJsonParse(node.callee)) return
        context.report({
          node,
          messageId: 'outside',
          data: { modules: [...PARSER_MODULES].join(', '), file },
        })
      },
    }
  },
}

const tsSuppressionRule = {
  meta: {
    type: 'problem',
    docs: { description: 'TypeScript suppression comments are forbidden in the adapter' },
    schema: [],
    messages: {
      suppression:
        'TypeScript suppression "{{directive}}" is forbidden: fix the type error or prove the claim at the boundary instead of silencing it.',
    },
  },
  create(context) {
    const sourceCode = context.sourceCode
    return {
      'Program:exit'() {
        for (const comment of sourceCode.getAllComments()) {
          const match = TS_SUPPRESSION.exec(comment.value)
          if (!match) continue
          context.report({
            loc: comment.loc,
            messageId: 'suppression',
            data: { directive: match[0] },
          })
        }
      },
    }
  },
}

export default [
  {
    ignores: ['node_modules/**', 'package-lock.json', 'test/**', 'eslint.config.js'],
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      // Declared so global-reference based rules (`no-implied-eval`) can recognize these
      // host/browser globals. `no-undef` is deliberately not enabled: the host injects
      // many of these, and the real import boundary is covered by the rules below.
      globals: {
        AbortController: 'readonly',
        Buffer: 'readonly',
        clearInterval: 'readonly',
        clearTimeout: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        globalThis: 'readonly',
        process: 'readonly',
        queueMicrotask: 'readonly',
        setInterval: 'readonly',
        setTimeout: 'readonly',
        structuredClone: 'readonly',
        TextDecoder: 'readonly',
        TextEncoder: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        window: 'readonly',
      },
    },
    plugins: {
      adapter: {
        rules: {
          'boundary-import': boundaryImportRule,
          'json-parse-boundary': jsonParseRule,
          'no-ts-suppressions': tsSuppressionRule,
        },
      },
    },
    rules: {
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'adapter/boundary-import': 'error',
      'adapter/json-parse-boundary': 'error',
      'adapter/no-ts-suppressions': 'error',
    },
  },
]
