/**
 * Principals and binding tokens. Principal roles are nominal classes; ownership is proved
 * by IsssueAssignment / TicketBinding tokens that only the Host mints after a runtime
 * check, not by a role class alone.
 */
import type { Result, StoreError } from './errors.js'
import type {
  ExperimentId,
  ImplementerSessionId,
  IssueId,
  OperatorSessionId,
  ResearcherSessionId,
  RouterSessionId,
  TicketId,
  WatchdogSessionId,
} from './ids.js'

export declare class OperatorPrincipal {
  private constructor()
  private readonly __operator: true
  readonly kind: 'operator'
  readonly sessionId: OperatorSessionId
}
export declare class ResearcherPrincipal {
  private constructor()
  private readonly __researcher: true
  readonly kind: 'researcher'
  readonly sessionId: ResearcherSessionId
}
export declare class ImplementerPrincipal {
  private constructor()
  private readonly __implementer: true
  readonly kind: 'implementer'
  readonly sessionId: ImplementerSessionId
  /** Bound by the Host when the Ticket starts; the model cannot choose it. */
  readonly ticketId: TicketId
}
export declare class WatchdogPrincipal {
  private constructor()
  private readonly __watchdog: true
  readonly kind: 'watchdog'
  readonly sessionId: WatchdogSessionId
}
export declare class HostPrincipal {
  private constructor()
  private readonly __host: true
  readonly kind: 'host'
  /** The one root authority the adapter creates at startup; see the trust-boundary note. */
}
export declare class RouterPrincipal {
  private constructor()
  private readonly __router: true
  readonly kind: 'router'
  readonly sessionId: RouterSessionId
}

export type Principal =
  | OperatorPrincipal
  | ResearcherPrincipal
  | ImplementerPrincipal
  | WatchdogPrincipal
  | HostPrincipal
  | RouterPrincipal

export type SessionRole = 'operator' | 'researcher' | 'implementer' | 'watchdog' | 'router'

/**
 * Proof that a Researcher is the current assignee of an Issue. Minted by
 * `AssignedIssue.authorize(actor)` after comparing the Session, never by a model.
 */
export declare class IssueAssignment {
  private constructor()
  private readonly __assignment: true
  readonly issueId: IssueId
  readonly assignee: ResearcherPrincipal
}

/**
 * Proof that an Implementer Session owns a Ticket for a specific Experiment. Minted by
 * the Host from the Ticket record; the tool input never carries it.
 */
export declare class TicketBinding {
  private constructor()
  private readonly __binding: true
  readonly ticketId: TicketId
  readonly experimentId: ExperimentId
  readonly sessionId: ImplementerSessionId
}

export type Capability =
  | 'program:create'
  | 'program:pause'
  | 'program:stop'
  | 'program:exploration'
  | 'program:goal'
  | 'issue:create'
  | 'issue:claim'
  | 'issue:comment'
  | 'issue:close'
  | 'experiment:propose'
  | 'experiment:review'
  | 'ci:request'
  | 'ticket:submit'
  | 'attention:raise'

/** The two principals that may author an Issue. */
export type IssueAuthor = OperatorPrincipal | ResearcherPrincipal
