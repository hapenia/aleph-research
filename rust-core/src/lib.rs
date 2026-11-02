
#![deny(unsafe_code)]

pub mod plugin;

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
pub enum PluginError {
    Storage(String),
    Trigger(String),
    Ticket(String),
}

impl fmt::Display for PluginError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Storage(message) => write!(f, "storage: {message}"),
            Self::Trigger(message) => write!(f, "trigger: {message}"),
            Self::Ticket(message) => write!(f, "ticket: {message}"),
        }
    }
}

impl std::error::Error for PluginError {}



#[derive(Debug)]
pub struct ExperimentProposed {
    pub program_id: ProgramId,
    pub issue_id: IssueId,
    pub experiment_id: ExperimentId,
}

#[derive(Debug)]
pub struct TriggerAccepted {
    pub program_id: ProgramId,
    pub issue_id: IssueId,
    pub experiment_id: ExperimentId,
    pub trigger_id: TriggerId,
}

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

#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn aleph_stage_count() -> u32 {
    3
}
