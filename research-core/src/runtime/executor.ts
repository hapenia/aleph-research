/**
 * The single write path.
 *
 * A write route only parses the fields the model may supply. The Host mints the
 * ownership proofs (`IssueAssignment`, `TicketBinding`, a CI request token where a
 * command declares one), attaches them to the parsed command and `executeRoute` calls
 * exactly one executor slot. Nothing else may hand a command to the executor.
 *
 * Why the declared generic in `types/api.ts` is not used here: it types the route table
 * as returning `CommandOf<K>`, which includes the Host-injected `assignment`/`binding`,
 * and it takes no refusal-audit port. A parser that has only seen untrusted input could
 * satisfy that type only by asserting the proofs into existence, which is exactly the
 * forgery the runtime contract forbids. The runtime-specific signature below therefore
 * reads routes as `ModelCommandOf<K>` (the command with the Host fields omitted) and
 * takes the proofs plus the refusal-audit port as separate arguments.
 */
import type { IssueAssignment, Principal, TicketBinding } from '../types/actors.js'
import type { AuditEntryOf } from '../types/audit.js'
import type { CIRequestToken } from '../types/ci.js'
import type {
  ActorOfCommand,
  CommandContext,
  CommandOf,
  CommandOutcome,
  CommandType,
} from '../types/commands.js'
import type { DomainError, Result } from '../types/errors.js'
import type { CommandExecutor } from '../types/executor.js'
import type { IsoTimestamp, ProgramId, RequestId } from '../types/ids.js'
import type { Clock } from '../types/services.js'

/**
 * The command fields that only the Host may supply, derived from the command type. A
 * route that saw only the model's body cannot construct them, so they stay in
 * `ModelCommandOf`'s complement and arrive in `HostContext`.
 */
export type HostFieldName<K extends CommandType> = Extract<
  keyof CommandOf<K>,
  'assignment' | 'binding' | 'ciRequestToken'
>

/** A command as a write route may return it: the Host-injected fields are omitted. */
export type ModelCommandOf<K extends CommandType> = Omit<CommandOf<K>, HostFieldName<K>>

/**
 * The ownership proofs the Host attaches, by command type. The conditional resolves per
 * command literal; a command that gains a Host field also needs a case and a completer
 * entry, so the compiler forces both decisions.
 *
 * No command declares a `ciRequestToken` today: `ci.request` mints the token inside the
 * CI request transition, not as a command field. The case stays in the conditional so a
 * future command that carries one is injected here like the other proofs.
 */
export type HostInjectedFields<K extends CommandType> =
  CommandOf<K> extends { readonly assignment: IssueAssignment }
    ? { readonly assignment: IssueAssignment }
    : CommandOf<K> extends { readonly binding: TicketBinding }
      ? { readonly binding: TicketBinding }
      : CommandOf<K> extends { readonly ciRequestToken: CIRequestToken }
        ? { readonly ciRequestToken: CIRequestToken }
        : Record<never, never>

/**
 * What the Host knows for one request: the executor context, the Program it is operating
 * in (the audited subject of a refusal) and the proofs this command requires.
 */
export type HostContext<K extends CommandType> = {
  readonly context: CommandContext<K>
  /** Fallback audited program when the untrusted body names none, e.g. a submit body. */
  readonly programId: ProgramId
} & HostInjectedFields<K>

/** One write route: it parses the model-supplied fields and nothing the Host owns. */
export type WriteRoute<K extends CommandType> = (
  input: unknown,
) => Result<ModelCommandOf<K>, DomainError>

/** The write route table; mapped over every command literal, so a route cannot be missing. */
export type WriteRoutes = { readonly [K in CommandType]: WriteRoute<K> }

/**
 * The boundary parsers a write route needs before a command exists. Injected rather than
 * imported: a runtime module may not reach into the parser boundary to turn untrusted
 * input into branded values.
 */
export interface AuditSubjectParsers {
  /** The Program named by the untrusted body, when the body names one. */
  readonly programId: (input: unknown) => Result<ProgramId, DomainError>
}

/** The facts of a refused command; the audit log records exactly these. */
export interface RefusedCommandFacts {
  readonly actor: Principal
  readonly route: CommandType
  readonly programId: ProgramId
  readonly at: IsoTimestamp
  readonly requestId: RequestId
  readonly reason: string
}

/**
 * The refusal-audit port. The Host owns the audit id and the program association and
 * turns the facts into the `command.refused` fact, so a refusal cannot be silent.
 */
export interface RefusalAuditPort {
  readonly record: (facts: RefusedCommandFacts) => AuditEntryOf<'command.refused'>
}

type CommandCompleter<K extends CommandType> = (
  model: ModelCommandOf<K>,
  host: HostInjectedFields<K>,
) => CommandOf<K>

/**
 * Attach the Host proofs to the parsed command. The table is total over commands: a new
 * command literal is a compile error here, and the Host fields are added in one place, so
 * a route cannot smuggle a proof into a command and another route cannot borrow it.
 */
const COMPLETE_COMMAND: { readonly [K in CommandType]: CommandCompleter<K> } = {
  'program.create': (model) => model,
  'program.pause': (model) => model,
  'program.resume': (model) => model,
  'program.stop': (model) => model,
  'program.set-goal': (model) => model,
  'program.set-methodology': (model) => model,
  'program.set-exploration': (model) => model,
  'issue.create': (model) => model,
  'issue.claim': (model) => model,
  'issue.comment': (model) => model,
  'issue.close': (model) => model,
  'experiment.propose': (model, host) => ({ ...model, assignment: host.assignment }),
  'experiment.review': (model, host) => ({ ...model, assignment: host.assignment }),
  'experiment.close': (model, host) => ({ ...model, assignment: host.assignment }),
  'ci.request': (model) => model,
  'ticket.submit': (model, host) => ({ ...model, binding: host.binding }),
}

/**
 * Run one write route.
 *
 * The route parses the model-supplied command. A parse failure is turned into an audited
 * `command.refused` refusal before any executor slot runs. On success the Host proofs are
 * merged into the parsed command, exactly the requested executor slot is called with the
 * Host context, and its outcome is returned unchanged.
 *
 * @param routes the write route table; the route key selects the parser
 * @param parsers boundary parsers for the values a refusal needs before a command exists
 * @param executor the one write executor; only `executor[route]` is reachable
 * @param actor the principal the request arrived as; the compile-time route gate
 * @param route the command literal to run
 * @param input the untrusted body, parsed by exactly one route
 * @param host the executor context, audited program and ownership proofs
 * @param clock the Host clock used for the refusal timestamp
 * @param requestId the request id, recorded in the refusal audit
 * @param refuse the refusal-audit port
 */
export async function executeRoute<K extends CommandType>(
  routes: WriteRoutes,
  parsers: AuditSubjectParsers,
  executor: CommandExecutor,
  actor: ActorOfCommand<K>,
  route: K,
  input: unknown,
  host: HostContext<K>,
  clock: Clock,
  requestId: RequestId,
  refuse: RefusalAuditPort,
): Promise<CommandOutcome<K>> {
  const parsed = routes[route](input)
  if (!parsed.ok) {
    const namedProgram = parsers.programId(input)
    const programId = namedProgram.ok ? namedProgram.value : host.programId
    const audit = refuse.record({
      actor,
      route,
      programId,
      at: clock.now(),
      requestId,
      reason: parsed.error.message,
    })
    return { ok: false, error: parsed.error, audit: [audit] }
  }

  const command = COMPLETE_COMMAND[route](parsed.value, host)
  return await executor[route](command, host.context)
}
