//! Plugin concepts that the TypeScript shell must implement.
//!
//! The Rust type system owns the plugin composition. A `CompletePlugin` has associated
//! Storage/Trigger/Ticket concepts; the flow entry point accepts only that trait, so a
//! plugin missing a concept cannot be started. TypeScript supplies concrete adapters and
//! generated wasm-bindgen declarations make a missing method a TypeScript error too.

use crate::{ConceptError, ExperimentProposed, TicketOpened, TriggerId, TicketId};

/// Durable state/audit writes.
pub trait StorageConcept {
    fn save_program(&self, program_id: &str) -> Result<(), ConceptError>;
    fn save_ticket(&self, ticket_id: &str) -> Result<(), ConceptError>;
}

/// Delivery to the prototype Source Eval.
pub trait TriggerConcept {
    fn deliver_experiment(&self, experiment_id: &str) -> Result<TriggerId, ConceptError>;
}

/// Implementer Ticket creation.
pub trait TicketConcept {
    fn open_ticket(&self, experiment_id: &str) -> Result<TicketId, ConceptError>;
}

/// The complete plugin surface. All concepts are required; a partial implementation
/// cannot satisfy the trait and therefore cannot call `run_research_chain`.
pub trait CompletePlugin {
    type Storage: StorageConcept;
    type Trigger: TriggerConcept;
    type Ticket: TicketConcept;

    fn storage(&self) -> &Self::Storage;
    fn trigger(&self) -> &Self::Trigger;
    fn ticket(&self) -> &Self::Ticket;
}

/// Wires the first three concepts. The only input is a complete plugin, so the Rust
/// compiler rejects a plugin that is missing Storage, Trigger or Ticket.
pub fn run_research_chain<C: CompletePlugin>(
    plugin: &C,
    proposed: ExperimentProposed,
) -> Result<TicketOpened, ConceptError> {
    plugin.storage().save_program(&proposed.program_id.0)?;
    let trigger_id = plugin.trigger().deliver_experiment(&proposed.experiment_id.0)?;
    let accepted = proposed
        .accept_trigger(trigger_id)
        .map_err(|_| ConceptError::Trigger("trigger stage failed".into()))?;
    let ticket_id = plugin.ticket().open_ticket(&accepted.experiment_id.0)?;
    let ticket = accepted
        .open_ticket(ticket_id)
        .map_err(|_| ConceptError::Ticket("ticket stage failed".into()))?;
    plugin.storage().save_ticket(&ticket.ticket_id.0)?;
    Ok(ticket)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ExperimentId, IssueId, ProgramId};

    struct Storage;
    impl StorageConcept for Storage {
        fn save_program(&self, _: &str) -> Result<(), ConceptError> { Ok(()) }
        fn save_ticket(&self, _: &str) -> Result<(), ConceptError> { Ok(()) }
    }
    struct Trigger;
    impl TriggerConcept for Trigger {
        fn deliver_experiment(&self, _: &str) -> Result<TriggerId, ConceptError> {
            Ok(TriggerId("trigger".into()))
        }
    }
    struct Ticket;
    impl TicketConcept for Ticket {
        fn open_ticket(&self, _: &str) -> Result<TicketId, ConceptError> {
            Ok(TicketId("ticket".into()))
        }
    }

    struct FakePlugin {
        storage: Storage,
        trigger: Trigger,
        ticket: Ticket,
    }
    impl CompletePlugin for FakePlugin {
        type Storage = Storage;
        type Trigger = Trigger;
        type Ticket = Ticket;
        fn storage(&self) -> &Self::Storage { &self.storage }
        fn trigger(&self) -> &Self::Trigger { &self.trigger }
        fn ticket(&self) -> &Self::Ticket { &self.ticket }
    }

    #[test]
    fn a_complete_plugin_drives_the_chain() {
        let plugin = FakePlugin { storage: Storage, trigger: Trigger, ticket: Ticket };
        let proposed = ExperimentProposed::new(
            ProgramId("p".into()), IssueId("i".into()), ExperimentId("e".into()),
        ).unwrap();
        let ticket = run_research_chain(&plugin, proposed).unwrap();
        assert_eq!(ticket.ticket_id, TicketId("ticket".into()));
    }
}
