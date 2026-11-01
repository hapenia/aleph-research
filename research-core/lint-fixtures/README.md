# Lint fixtures

Negative fixtures for the two boundary lint configurations. They are deliberately
invalid: the normal gates only scan `src/` (research-core) or the package root
(superagent-extension), so a config that silently stops enforcing a rule would never be
noticed. `research-core/scripts/lint-fixtures.sh` copies the real configs and these
fixtures into throwaway directories and runs ESLint/ast-grep against them.

```
core-eslint/    research-core ESLint config: assertions, any, predicates, JSON,
                dynamic imports, boundary imports, @ts-expect-error, global clock/process
core-ast-grep/  research-core ast-grep rules: the same offences as patterns
adapter/        superagent-extension ESLint config: eval/new Function, JSON.parse
                outside the designated adapter parser modules, boundary imports/require,
                dynamic boundary import, @ts-expect-error, plus the composition-root
                and parser-module allowlists
```

Each fixture directory also has accepted controls (`clean.ts` / `clean.js`), and the
adapter set has two allowlist controls (`results.js` as a designated parser module and
`index.js` as the composition root). The script fails when an invalid fixture is
accepted, when a control is rejected, when a tool is missing, or when the wrong rule
reports a fixture.

Run it directly:

```bash
bash research-core/scripts/lint-fixtures.sh   # exits 0 with "(22 invalid fixtures rejected, 6 valid controls accepted)"
```

It is not wired into `scripts/verify.sh` yet; that gate change belongs to the Lead.
