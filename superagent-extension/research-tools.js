/**
 * DSH tool-registration adapter for the AlephResearch runtime tool registry.
 *
 * `research-core/src/runtime/tools.ts` owns the four role tool sets (Operator, Researcher,
 * Implementer, Watchdog: 23 definitions) and their boundary `Schema`s. This module is the
 * DSH transport for those definitions. It does not own domain behavior: every call is
 * validated by the runtime schema and then handed to a handler injected by the caller
 * (`options.handlers`, or a host adapter exposing `executeTool`). The compiled runtime in
 * `research-core/dist/runtime/tools.js` is the source of truth; run `npm run build` in
 * `research-core` after changing the TypeScript.
 *
 * ## DSH API mapping
 *
 * `ctx.tools.register(definition, { when })` accepts a definition whose `parameters` are
 * raw JSON Schema (`JsonSchemaNode`) and whose `output` is `{ schema, render }`. This
 * adapter therefore registers a plain definition instead of calling `defineTool()`:
 * `defineTool()`'s author DSL deliberately omits JSON Schema constraints such as
 * `pattern`, `minLength`, `minItems` and `exclusiveMinimum`, and its parameter spec is a
 * property map, not the runtime schema. Registering the converted raw schema keeps the
 * model-facing contract as close to the runtime definition as DSH allows.
 *
 * DSH enforces only the subset documented in `dsh-tools/json-schema`: `type`, `oneOf`,
 * `properties`, `required`, `additionalProperties`, `items`, `enum`, `const` and the
 * annotations. The runtime schemas additionally use `pattern`, `minLength`, `maxLength`,
 * `minItems` and `exclusiveMinimum`; those keywords are dropped from the wire schema
 * because DSH rejects them, and the runtime `Schema.parse` still enforces them inside
 * `execute`. In the other direction, a runtime `{ enum: [...] }` or `{ const: ... }`
 * node has no `type`; DSH requires one on scalar nodes, so conversion infers `string`,
 * `number`, `integer`, `boolean` or `null`.
 *
 * The resulting schema is asserted with `assertSupportedJsonSchema()` at registration so
 * a runtime schema change outside the subset fails startup with a path, not at the first
 * model call. The tool output schema is the annotation-only `{}` (unconstrained JSON):
 * handlers may return a success value or a domain refusal, and this adapter does not
 * reinterpret either.
 *
 * ## Visibility and roles
 *
 * DSH supports per-step visibility: `when({ agent, modelSelection, signal })` is
 * evaluated once per model step, and a false result removes the tool from the prompt,
 * PTC bindings and execution. Every research tool is registered globally with a `when`
 * predicate for its runtime role, so an Operator tool is never visible to a Researcher
 * session (nor an Implementer's submit to anyone else). The role is read from the
 * session header's `agentPreset` by default; `options.roleOf` can override it for a
 * deployment that names presets differently. Unknown presets see no research tools
 * (fail closed). `options.roleGating: false` drops the predicate and exposes every
 * registered tool to every session; it exists for tests and is not recommended.
 *
 * ## Naming
 *
 * Every name starts with `aleph_research_` to avoid collisions with other plugins. The
 * role prefix in the runtime name is removed: `researcher_claim_issue` becomes
 * `aleph_research_claim_issue`. Two operations exist in more than one role
 * (`create_issue` for Operator/Researcher, `read_metrics` for Researcher/Watchdog), so
 * those collision names carry the role segment:
 * `aleph_research_operator_create_issue`, `aleph_research_researcher_create_issue`,
 * `aleph_research_researcher_read_metrics`, `aleph_research_watchdog_read_metrics`.
 *
 * ## Implementer submit
 *
 * `implementer_submit_implementation` deliberately has no `binding`/`ticketId`: the
 * compiled runtime schema omits them and is strict (`additionalProperties: false`), and
 * `execute` rejects either field through `Schema.parse` before a handler is called. The
 * Host mints the TicketBinding; a model must never be able to name it.
 *
 * ## Cleanup and duplicate registration
 *
 * Every registration disposer is collected and released by one `ctx.effect` callback, so
 * disposing the plugin fiber removes all 23 tools. DSH rejects a second registration of
 * the same name in one scope; this adapter does not overwrite. A failed attempt releases
 * the tools it had already registered and rethrows DSH's error, leaving the first
 * adapter's registrations intact.
 *
 * `JSON.parse` is deliberately absent; the adapter only builds and serializes JSON.
 */
import { ToolArgsError, assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools'

import { TOOL_REGISTRY } from '../research-core/dist/runtime/tools.js'

/** Bumped when the mapping or registration behavior changes. */
export const VERSION = 'research-tools/1'

/** Cordis plugin identity, matching the style of the other extension modules. */
export const name = 'aleph-research-tools'
export const inject = ['tools']

/** Every DSH-facing name starts with this prefix unless `options.prefix` overrides it. */
export const DEFAULT_PREFIX = 'aleph_research_'

/** Runtime roles, in the registry's own order. */
export const TOOL_ROLES = Object.freeze(['operator', 'researcher', 'implementer', 'watchdog'])

/** Default session-preset to runtime-role mapping. */
export const PRESET_ROLES = Object.freeze({
  'aleph-operator': 'operator',
  'aleph-researcher': 'researcher',
  'aleph-implementer': 'implementer',
  'aleph-watchdog': 'watchdog',
})

/** Schema types DSH accepts as a single scalar/container `type`. */
const SCHEMA_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])

/** Annotation keywords DSH copies through to the model-facing schema. */
const ANNOTATION_KEYS = ['description', 'title', 'default', 'examples']

/**
 * JSON Schema validation keywords the runtime uses but DSH's enforced subset does not
 * support. They are dropped from the wire schema; `Schema.parse` still enforces them.
 */
const DROPPED_VALIDATION_KEYS = new Set([
  'pattern',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'minItems',
  'maxItems',
  'uniqueItems',
  'multipleOf',
  'format',
  'minProperties',
  'maxProperties',
])

const OBJECT_KEYS = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  ...ANNOTATION_KEYS,
  ...DROPPED_VALIDATION_KEYS,
])

const ARRAY_KEYS = new Set(['type', 'items', ...ANNOTATION_KEYS, ...DROPPED_VALIDATION_KEYS])

const SCALAR_KEYS = new Set([
  'type',
  'enum',
  'const',
  ...ANNOTATION_KEYS,
  ...DROPPED_VALIDATION_KEYS,
])

const ONE_OF_KEYS = new Set(['oneOf', ...ANNOTATION_KEYS, ...DROPPED_VALIDATION_KEYS])

const isSchemaRecord = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const hasOwn = (source, key) => Object.getOwnPropertyDescriptor(source, key) !== undefined

/** Define one own enumerable property without `__proto__` assignment semantics. */
const setOwn = (target, key, value) => {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  })
}

/** The scalar JSON type of one `enum`/`const` value, or undefined when it is not JSON. */
const scalarTypeOfValue = (value) => {
  if (value === null) return 'null'
  if (typeof value === 'string') return 'string'
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Number.isInteger(value) ? 'integer' : 'number'
  }
  return undefined
}

/** Merge two inferred scalar types; `integer` widens to `number`. */
const mergeScalarTypes = (left, right) => {
  if (left === right) return left
  if ((left === 'integer' && right === 'number') || (left === 'number' && right === 'integer')) {
    return 'number'
  }
  return undefined
}

/** Infer the scalar type shared by every value of an `enum`. */
const scalarTypeOfEnum = (values, path) => {
  if (!Array.isArray(values) || values.length === 0) {
    throw new TypeError(`${path}.enum must be a non-empty array`)
  }
  let inferred
  for (const value of values) {
    const candidate = scalarTypeOfValue(value)
    if (candidate === undefined) throw new TypeError(`${path}.enum must contain only JSON scalars`)
    if (inferred === undefined) {
      inferred = candidate
      continue
    }
    const merged = mergeScalarTypes(inferred, candidate)
    if (merged === undefined) throw new TypeError(`${path}.enum values must share one scalar type`)
    inferred = merged
  }
  return inferred
}

/** Reject schema fields outside one node's DSH-supported vocabulary. */
const assertAllowedKeys = (node, allowed, path) => {
  for (const key of Object.keys(node)) {
    if (!allowed.has(key)) {
      throw new TypeError(
        `${path}.${key} is not supported by the DSH tool-parameter schema subset; `
        + 'extend toDshParameterSchema() before using it',
      )
    }
  }
}

/** Copy the annotations DSH understands, leaving the source untouched. */
const copyAnnotations = (source, target) => {
  for (const key of ANNOTATION_KEYS) {
    if (hasOwn(source, key)) target[key] = source[key]
  }
}

/** Resolve the declared or inferable type of one schema node. */
const resolveType = (node, path) => {
  if (hasOwn(node, 'type')) {
    const type = node.type
    if (typeof type !== 'string' || !SCHEMA_TYPES.has(type)) {
      throw new TypeError(
        `${path}.type must be one of ${[...SCHEMA_TYPES].join('/')}; `
        + 'type arrays (nullable unions) are not supported by DSH',
      )
    }
    return type
  }
  let inferred
  if (hasOwn(node, 'enum')) inferred = scalarTypeOfEnum(node.enum, path)
  if (hasOwn(node, 'const')) {
    const constant = scalarTypeOfValue(node.const)
    if (constant === undefined) throw new TypeError(`${path}.const must be a JSON scalar`)
    if (inferred === undefined) inferred = constant
    else {
      const merged = mergeScalarTypes(inferred, constant)
      if (merged === undefined) throw new TypeError(`${path}.enum and const must share one scalar type`)
      inferred = merged
    }
  }
  if (inferred !== undefined) return inferred
  if (hasOwn(node, 'properties') || hasOwn(node, 'required') || hasOwn(node, 'additionalProperties')) {
    return 'object'
  }
  if (hasOwn(node, 'items')) return 'array'
  throw new TypeError(`${path} must declare type or oneOf so DSH can enforce it`)
}

/** Convert one runtime schema node to the DSH-enforced raw JSON Schema subset. */
const convertNode = (node, path, seen) => {
  if (!isSchemaRecord(node)) throw new TypeError(`${path} must be a JSON Schema object`)
  if (seen.has(node)) throw new TypeError(`${path} is circular`)
  seen.add(node)
  try {
    if (hasOwn(node, 'oneOf')) return convertOneOf(node, path, seen)
    const type = resolveType(node, path)
    const converted = { type }
    copyAnnotations(node, converted)
    if (type === 'object') convertObject(node, converted, path, seen)
    else if (type === 'array') convertArray(node, converted, path, seen)
    else convertScalar(node, converted, path)
    return converted
  } finally {
    seen.delete(node)
  }
}

const convertOneOf = (node, path, seen) => {
  assertAllowedKeys(node, ONE_OF_KEYS, path)
  if (!Array.isArray(node.oneOf) || node.oneOf.length < 2) {
    throw new TypeError(`${path}.oneOf must be an array of at least two schemas`)
  }
  const branches = []
  for (let index = 0; index < node.oneOf.length; index += 1) {
    branches.push(convertNode(node.oneOf[index], `${path}.oneOf[${index}]`, seen))
  }
  const converted = { oneOf: branches }
  copyAnnotations(node, converted)
  return converted
}

const convertObject = (node, target, path, seen) => {
  assertAllowedKeys(node, OBJECT_KEYS, path)
  if (hasOwn(node, 'properties')) {
    if (!isSchemaRecord(node.properties)) throw new TypeError(`${path}.properties must be an object`)
    const properties = {}
    for (const [key, value] of Object.entries(node.properties)) {
      setOwn(properties, key, convertNode(value, `${path}.properties.${key}`, seen))
    }
    target.properties = properties
  }
  if (hasOwn(node, 'required')) {
    if (!Array.isArray(node.required) || node.required.some((entry) => typeof entry !== 'string')) {
      throw new TypeError(`${path}.required must be an array of strings`)
    }
    target.required = Array.from(node.required)
  }
  if (hasOwn(node, 'additionalProperties')) {
    if (typeof node.additionalProperties !== 'boolean') {
      throw new TypeError(
        `${path}.additionalProperties must be a boolean; DSH does not support a schema-valued form`,
      )
    }
    target.additionalProperties = node.additionalProperties
  }
}

const convertArray = (node, target, path, seen) => {
  assertAllowedKeys(node, ARRAY_KEYS, path)
  if (hasOwn(node, 'items')) {
    if (Array.isArray(node.items)) {
      throw new TypeError(`${path}.items must be one schema; tuple items are not supported by DSH`)
    }
    target.items = convertNode(node.items, `${path}.items`, seen)
  }
}

const convertScalar = (node, target, path) => {
  assertAllowedKeys(node, SCALAR_KEYS, path)
  if (hasOwn(node, 'enum')) {
    if (!Array.isArray(node.enum)) throw new TypeError(`${path}.enum must be an array`)
    target.enum = Array.from(node.enum)
  }
  if (hasOwn(node, 'const')) target.const = node.const
}

/**
 * Convert one runtime parameter schema to the raw JSON Schema shape DSH accepts.
 *
 * The result is object-rooted (tool arguments are always one JSON object), carries the
 * supported constraints, drops the validation-only keywords DSH cannot enforce, and is
 * asserted against DSH's subset before it is returned. Domain validation remains with
 * the runtime `Schema.parse` call in `execute`.
 *
 * @param {unknown} schema the runtime `Schema.toJsonSchema()` value.
 * @param {string} [label] diagnostics label for nested paths.
 * @returns {Readonly<Record<string, unknown>>} the DSH-ready parameter schema.
 */
export function toDshParameterSchema(schema, label = 'parameters') {
  const converted = convertNode(schema, label, new Set())
  if (converted.type !== 'object') {
    throw new TypeError(`${label} must be object-rooted: DSH tool arguments are a JSON object`)
  }
  assertSupportedJsonSchema(converted)
  return converted
}

/** Read the agent preset from the shapes a DSH Agent or preset scope exposes. */
const presetOf = (agent) => {
  if (typeof agent === 'string') return agent.trim()
  if (agent === null || agent === undefined) return undefined
  const candidates = [
    agent.session?.header?.agentPreset,
    agent.header?.agentPreset,
    agent.agentPreset,
    agent.ctx?.agentPreset,
    agent.preset?.id,
    agent.preset,
    agent.ctx?.session?.header?.agentPreset,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate.trim()
  }
  return undefined
}

/**
 * Default role resolver: map a session preset name to its runtime role.
 *
 * Returns undefined for an unknown preset, so the `when` predicates hide the tools
 * rather than expose them to an unclassified session.
 *
 * @param {unknown} agent a DSH Agent, a preset id, or a session header.
 * @returns {'operator'|'researcher'|'implementer'|'watchdog'|undefined} the runtime role.
 */
export function roleFromPreset(agent) {
  const preset = presetOf(agent)
  return preset === undefined ? undefined : PRESET_ROLES[preset]
}

/** Normalize and validate the tool-name prefix. */
const normalizePrefix = (prefix) => {
  if (typeof prefix !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*$/.test(prefix)) {
    throw new TypeError('options.prefix must be a tool-name fragment matching /^[A-Za-z][A-Za-z0-9_]*$/')
  }
  return prefix.endsWith('_') ? prefix : `${prefix}_`
}

/** Normalize and validate the requested runtime roles. */
const normalizeRoles = (roles) => {
  if (roles === undefined) return [...TOOL_ROLES]
  if (!Array.isArray(roles) || roles.length === 0) {
    throw new TypeError(`options.roles must be a non-empty array drawn from ${TOOL_ROLES.join(', ')}`)
  }
  const selected = []
  for (const role of roles) {
    if (!TOOL_ROLES.includes(role)) {
      throw new TypeError(`options.roles may only name ${TOOL_ROLES.join(', ')}; got ${String(role)}`)
    }
    if (!selected.includes(role)) selected.push(role)
  }
  return selected
}

/** The runtime tool name without its role prefix (`researcher_claim_issue` -> `claim_issue`). */
const operationOf = (role, runtimeName) =>
  runtimeName.startsWith(`${role}_`) ? runtimeName.slice(role.length + 1) : runtimeName

/**
 * Build the DSH-facing catalog from the compiled runtime registry.
 *
 * The returned entries carry both the runtime `Schema` (used to parse arguments) and the
 * converted DSH parameter schema (used for registration and the model prompt). Names are
 * unique across roles: base names are role-stripped, and an operation that more than one
 * runtime role defines always carries that role's segment. Collision detection covers
 * the entire registry, not only `roles`, so registering a subset never renames a tool
 * that another role would have qualified.
 *
 * @param {string} [prefix] DSH-facing name prefix.
 * @param {readonly string[]} [roles] runtime roles to include, default all four.
 * @returns {ReadonlyArray<object>} one entry per selected runtime tool.
 */
export function buildResearchToolCatalog(prefix = DEFAULT_PREFIX, roles = TOOL_ROLES) {
  const namePrefix = normalizePrefix(prefix)
  const selected = normalizeRoles(roles)

  // The runtime registry is fixed, so collision names can be computed once across every
  // role and stay stable when a deployment registers a subset.
  const collision = new Set()
  const seenBaseNames = new Set()
  for (const role of TOOL_ROLES) {
    for (const tool of Object.values(TOOL_REGISTRY[role])) {
      const baseName = `${namePrefix}${operationOf(role, tool.name)}`
      if (seenBaseNames.has(baseName)) collision.add(baseName)
      seenBaseNames.add(baseName)
    }
  }

  const entries = []
  for (const role of selected) {
    for (const [key, tool] of Object.entries(TOOL_REGISTRY[role])) {
      const runtimeName = tool.name
      const operation = operationOf(role, runtimeName)
      const baseName = `${namePrefix}${operation}`
      entries.push({
        id: `${role}.${key}`,
        role,
        key,
        operation,
        runtimeName,
        name: collision.has(baseName) ? `${namePrefix}${role}_${operation}` : baseName,
        baseName,
        command: tool.command ?? null,
        description: tool.description,
        schema: tool.parameters,
        parameters: toDshParameterSchema(tool.parameters.toJsonSchema(), `${role}.${key} parameters`),
      })
    }
  }
  return entries
}

/** A compact, frozen descriptor passed to handlers and host adapters. */
const descriptorOf = (entry) => Object.freeze({
  id: entry.id,
  name: entry.name,
  role: entry.role,
  key: entry.key,
  command: entry.command,
  runtimeName: entry.runtimeName,
  description: entry.description,
})

/** Resolve the handler for one entry, or null when the caller injected none. */
const resolveHandler = (entry, settings) => {
  const handlers = settings.handlers
  if (typeof handlers === 'function') {
    return (input, context) => handlers(input, context)
  }
  if (handlers !== null && typeof handlers === 'object') {
    for (const key of [entry.id, entry.runtimeName, entry.name, entry.key, entry.operation]) {
      if (hasOwn(handlers, key) && typeof handlers[key] === 'function') {
        return (input, context) => handlers[key].call(handlers, input, context)
      }
    }
    const group = handlers[entry.role]
    if (group !== null && typeof group === 'object' && typeof group[entry.key] === 'function') {
      return (input, context) => group[entry.key].call(group, input, context)
    }
  }
  const host = settings.host
  if (host !== null && typeof host === 'object' && typeof host.executeTool === 'function') {
    const descriptor = descriptorOf(entry)
    return (input, context) => host.executeTool(descriptor, input, context)
  }
  return null
}

/** Render one handler result as model-facing text; the value is the canonical result. */
const renderJson = (_args, value) => [{
  type: 'text',
  text: JSON.stringify(value === undefined ? null : value, null, 2),
}]

/** Build one registry-ready DSH definition for a catalog entry. */
const definitionFor = (entry, settings) => {
  const descriptor = descriptorOf(entry)
  return {
    name: entry.name,
    description: entry.description,
    parameters: entry.parameters,
    output: {
      schema: {},
      render: renderJson,
    },
    async execute(input, exec) {
      const parsed = entry.schema.parse(input)
      if (!parsed.ok) {
        // The runtime Schema is stricter than the DSH wire subset (pattern, lengths,
        // bounds, additionalProperties); keep its message instead of re-validating.
        throw new ToolArgsError([`${entry.id}: ${parsed.error.message}`])
      }
      const handler = resolveHandler(entry, settings)
      if (handler === null) {
        throw new Error(
          `${entry.name} (${entry.id}) has no injected handler; `
          + 'pass options.handlers or options.host.executeTool',
        )
      }
      return handler(parsed.value, {
        tool: descriptor,
        agent: exec?.agent,
        signal: exec?.signal,
        exec,
      })
    },
  }
}

/**
 * Register every selected runtime tool with `ctx.tools.register`.
 *
 * Each definition carries a `when` predicate for its runtime role (unless role gating is
 * disabled), so DSH's per-step visibility keeps Operator tools away from Researcher
 * sessions and Implementer submit away from every other role. A caller supplies the
 * behavior through `options.handlers` or `options.host.executeTool`; this function only
 * validates arguments and dispatches.
 *
 * @param {object} ctx a Cordis context providing `tools.register` and `effect`.
 * @param {object} [options] registration settings.
 * @param {string} [options.prefix] DSH-facing name prefix, default `aleph_research_`.
 * @param {readonly string[]} [options.roles] roles to register, default all four.
 * @param {object|Function} [options.handlers] handler map or a single handler function.
 *   Map keys may be `<role>.<key>`, the runtime tool name, the DSH tool name, the tool
 *   key or the operation name; a `handlers[role][key]` grouping is also accepted.
 * @param {object} [options.host] a Host adapter exposing `executeTool(tool, input, context)`.
 * @param {Function} [options.roleOf] custom synchronous `(agent, context) => role` resolver.
 * @param {boolean} [options.roleGating] set false to register without visibility predicates.
 * @returns {{ version: string, tools: readonly string[], catalog: ReadonlyArray<object>, dispose: Function }}
 *   the registered names, catalog and a cleanup function (also owned by `ctx.effect`).
 *
 * @throws when the context lacks the required services, the options are malformed, a
 *   converted schema is outside DSH's subset, or a tool name is already registered.
 */
export function registerResearchTools(ctx, options = {}) {
  if (ctx === null || typeof ctx !== 'object') {
    throw new TypeError('registerResearchTools requires a Cordis context')
  }
  if (ctx.tools === undefined || typeof ctx.tools.register !== 'function') {
    throw new TypeError('registerResearchTools requires ctx.tools.register()')
  }
  if (typeof ctx.effect !== 'function') {
    throw new TypeError('registerResearchTools requires ctx.effect() for cleanup')
  }
  const settings = options ?? {}
  if (settings.handlers !== undefined
    && typeof settings.handlers !== 'function'
    && (settings.handlers === null || typeof settings.handlers !== 'object')) {
    throw new TypeError('options.handlers must be a handler map or a handler function')
  }
  if (settings.host !== undefined
    && (settings.host === null || typeof settings.host !== 'object')) {
    throw new TypeError('options.host must be an object exposing executeTool(tool, input, context)')
  }
  if (settings.roleGating !== undefined && typeof settings.roleGating !== 'boolean') {
    throw new TypeError('options.roleGating must be a boolean')
  }
  if (settings.roleOf !== undefined && typeof settings.roleOf !== 'function') {
    throw new TypeError('options.roleOf must be a (agent, context) => role function')
  }
  const roleOf = typeof settings.roleOf === 'function' ? settings.roleOf : roleFromPreset
  const gating = settings.roleGating !== false
  const roles = normalizeRoles(settings.roles)
  const catalog = buildResearchToolCatalog(settings.prefix ?? DEFAULT_PREFIX, roles)

  const disposers = []
  const disposeAll = () => {
    while (disposers.length > 0) {
      const dispose = disposers.pop()
      try {
        dispose()
      } catch { /* the tool was already removed or the registry is going away */ }
    }
  }

  try {
    for (const entry of catalog) {
      const definition = definitionFor(entry, settings)
      const when = gating
        ? (context) => roleOf(context?.agent, context) === entry.role
        : undefined
      const dispose = ctx.tools.register(definition, when === undefined ? undefined : { when })
      if (typeof dispose !== 'function') {
        throw new TypeError(`ctx.tools.register() returned no disposer for ${entry.name}`)
      }
      disposers.push(dispose)
    }
  } catch (error) {
    disposeAll()
    throw error
  }

  let liftEffect
  try {
    liftEffect = ctx.effect(() => () => { disposeAll() }, 'aleph: research tools')
  } catch (error) {
    disposeAll()
    throw error
  }

  return {
    version: VERSION,
    tools: catalog.map((entry) => entry.name),
    catalog,
    dispose() {
      disposeAll()
      try {
        liftEffect?.()
      } catch { /* the fiber is already gone */ }
    },
  }
}

/**
 * Cordis plugin wrapper.
 *
 * The deployment that mounts this module passes the same options as
 * `registerResearchTools`; a YAML-only composition registers the tools but cannot inject
 * handlers, so every call fails with the no-handler error until code supplies them.
 *
 * @param {object} ctx the plugin context.
 * @param {object} [config] registration options.
 * @returns the adapter result from `registerResearchTools`.
 */
export function apply(ctx, config) {
  return registerResearchTools(ctx, config ?? {})
}
