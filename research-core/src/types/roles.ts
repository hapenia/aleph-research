/** Session roles and their capabilities; the Host authorizes commands against these. */
import type { ProgramId, ResearcherId, SessionId, TicketId } from './ids.js'

export type SessionRole = 'operator' | 'researcher' | 'implementer' | 'watchdog' | 'router'

/** Capabilities are explicit and closed; a role holds a subset of them. */
export type Capability =
  | 'program:create'
  | 'program:pause'
  | 'program:stop'
  | 'issue:create'
  | 'issue:claim'
  | 'issue:comment'
  | 'issue:close'
  | 'pr:propose'
  | 'pr:review'
  | 'ci:request'
  | 'ci:read'
  | 'pr:merge'
  | 'ticket:submit'
  | 'attention:raise'

export interface SessionIdentity {
  readonly sessionId: SessionId
  readonly role: SessionRole
  /** The DSH preset that created the Session, for diagnostics. */
  readonly preset: string
}

export interface ResearcherIdentity extends SessionIdentity {
  readonly role: 'researcher'
  readonly researcherId: ResearcherId
  /** Every command from a Researcher carries the Program it works for. */
  readonly programId: ProgramId
}

export interface ImplementerIdentity extends SessionIdentity {
  readonly role: 'implementer'
  readonly ticketId: TicketId
}

export const capabilitiesOf: Readonly<Record<SessionRole, readonly Capability[]>> = {
  operator: ['program:create', 'program:pause', 'program:stop', 'issue:create', 'pr:merge'],
  researcher: [
    'issue:create',
    'issue:claim',
    'issue:comment',
    'issue:close',
    'pr:propose',
    'pr:review',
    'ci:request',
    'ci:read',
    'attention:raise',
  ],
  implementer: ['ticket:submit', 'ci:read'],
  watchdog: ['attention:raise', 'ci:read'],
  router: [],
}
