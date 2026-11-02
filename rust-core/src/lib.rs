// TODO(@wasm-core-migration): expand this spike to the full typestate flow and expose
// the wasm ABI consumed by the thin TypeScript adapter.
//! AlephResearch typestate core (spike).
//!
//! The TypeScript shell only adapts DSH/Cordis services to this crate. The crate owns
//! the ordered research flow: each type consumes itself and returns the next stage, so
//! an earlier stage cannot be reused or skipped.

#![deny(unsafe_code)]

pub mod concepts;

use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProgramId(pub String);
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IssueId(pub String);
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExperimentId(pub String);
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TriggerId(pub String);
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TicketId(pub String);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FlowError {
    EmptyId(&'static str),
    WrongOrder,
}

impl fmt::Display for FlowError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyId(field) => write!(f, "{field} must not be empty"),
            Self::WrongOrder => write!(f, "stages must run in order"),
        }
    }
}

impl std::error::Error for FlowError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConceptError {
    Storage(String),
    Trigger(String),
    Ticket(String),
}

impl fmt::Display for ConceptError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Storage(message) => write!(f, "storage: {message}"),
            Self::Trigger(message) => write!(f, "trigger: {message}"),
            Self::Ticket(message) => write!(f, "ticket: {message}"),
        }
    }
}

impl std::error::Error for ConceptError {}

// Concept implementations live in `concepts`; they are the only host boundary. TODO(@wasm-core-migration): expose the complete concept set through wasm-bindgen.


/// Stage 1: the Researcher has proposed an Experiment plan.
#[derive(Debug)]
pub struct ExperimentProposed {
    pub program_id: ProgramId,
    pub issue_id: IssueId,
    pub experiment_id: ExperimentId,
}

/// Stage 2: the Source Eval accepted the trigger.
///
/// The stage is consumed by [`TriggerAccepted::open_ticket`], so it cannot be reused:
///
/// ```compile_fail
/// use aleph_research_core::*;
/// let proposed = ExperimentProposed::new(
///     ProgramId("p".into()), IssueId("i".into()), ExperimentId("e".into()),
/// ).unwrap();
/// let accepted = proposed.accept_trigger(TriggerId("t".into())).unwrap();
/// let _ticket = accepted.open_ticket(TicketId("ticket".into())).unwrap();
/// // `accepted` was consumed by open_ticket.
/// let _again = accepted.open_ticket(TicketId("other".into())).unwrap();
/// ```
#[derive(Debug)]
pub struct TriggerAccepted {
    pub program_id: ProgramId,
    pub issue_id: IssueId,
    pub experiment_id: ExperimentId,
    pub trigger_id: TriggerId,
}

/// Stage 3: the Executor opened a Ticket.
#[derive(Debug)]
pub struct TicketOpened {
    pub program_id: ProgramId,
    pub issue_id: IssueId,
    pub experiment_id: ExperimentId,
    pub ticket_id: TicketId,
}

impl ExperimentProposed {
    pub fn new(
        program_id: ProgramId,
        issue_id: IssueId,
        experiment_id: ExperimentId,
    ) -> Result<Self, FlowError> {
        require_id(&program_id.0, "program_id")?;
        require_id(&issue_id.0, "issue_id")?;
        require_id(&experiment_id.0, "experiment_id")?;
        Ok(Self { program_id, issue_id, experiment_id })
    }

    /// Consumes this stage; the old value cannot be used again in Rust.
    pub fn accept_trigger(self, trigger_id: TriggerId) -> Result<TriggerAccepted, FlowError> {
        require_id(&trigger_id.0, "trigger_id")?;
        Ok(TriggerAccepted {
            program_id: self.program_id,
            issue_id: self.issue_id,
            experiment_id: self.experiment_id,
            trigger_id,
        })
    }
}

impl TriggerAccepted {
    /// Consumes the accepted trigger; only this stage can open a Ticket.
    pub fn open_ticket(self, ticket_id: TicketId) -> Result<TicketOpened, FlowError> {
        require_id(&ticket_id.0, "ticket_id")?;
        Ok(TicketOpened {
            program_id: self.program_id,
            issue_id: self.issue_id,
            experiment_id: self.experiment_id,
            ticket_id,
        })
    }
}

fn require_id(value: &str, field: &'static str) -> Result<(), FlowError> {
    if value.trim().is_empty() {
        Err(FlowError::EmptyId(field))
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn proposed() -> ExperimentProposed {
        ExperimentProposed::new(
            ProgramId("p".into()),
            IssueId("i".into()),
            ExperimentId("e".into()),
        )
        .unwrap()
    }

    #[test]
    fn the_ordered_chain_produces_ticket_evidence() {
        let accepted = proposed().accept_trigger(TriggerId("t".into())).unwrap();
        let ticket = accepted.open_ticket(TicketId("ticket".into())).unwrap();
        assert_eq!(ticket.ticket_id, TicketId("ticket".into()));
        assert_eq!(ticket.experiment_id, ExperimentId("e".into()));
    }

    #[test]
    fn empty_ids_are_refused_at_the_stage_boundary() {
        let err = ExperimentProposed::new(
            ProgramId("".into()),
            IssueId("i".into()),
            ExperimentId("e".into()),
        )
        .unwrap_err();
        assert_eq!(err, FlowError::EmptyId("program_id"));
    }


}

/// Minimal WASM ABI probe; the typed wasm-bindgen facade is the next step.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn aleph_flow_stage_count() -> u32 {
    3
}
