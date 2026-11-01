/**
 * Principals: whoever acts on the domain. Each role is a nominal class with a private
 * constructor, so roles cannot be forged or interchanged by structural typing.
 */
import type {
  ImplementerSessionId,
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
