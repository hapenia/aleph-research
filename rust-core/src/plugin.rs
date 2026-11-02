//! Plugin concepts that the TypeScript shell must implement.
//!
//! The Rust type system owns the plugin composition. A `Plugin` has associated
//! Storage/Trigger/Ticket concepts; the flow entry point accepts only that trait, so a
//! plugin missing a concept cannot be started. TypeScript supplies concrete adapters and
//! generated wasm-bindgen declarations make a missing method a TypeScript error too.

use crate::{PluginError, ExperimentProposed, TicketOpened, TriggerId, TicketId};

/// Durable state/audit writes.
pub trait Storage {
    fn save_program(&self, program_id: &str) -> Result<(), PluginError>;
    fn save_ticket(&self, ticket_id: &str) -> Result<(), PluginError>;
}

/// Delivery to the prototype Source Eval.
pub trait TriggerSource {
    fn deliver_experiment(&self, experiment_id: &str) -> Result<TriggerId, PluginError>;
}

/// Implementer Ticket creation.
pub trait TicketExecutor {
    fn open_ticket(&self, experiment_id: &str) -> Result<TicketId, PluginError>;
}

/// The complete plugin surface. All concepts are required; a partial implementation
/// cannot satisfy the trait and therefore cannot call `run`.
pub trait Plugin {
    type Storage: Storage;
    type Trigger: TriggerSource;
    type Ticket: TicketExecutor;

    fn storage(&self) -> &Self::Storage;
    fn trigger(&self) -> &Self::Trigger;
    fn ticket(&self) -> &Self::Ticket;
}

/// Wires the first three concepts. The only input is a complete plugin, so the Rust
/// compiler rejects a plugin that is missing Storage, Trigger or Ticket.
pub fn run<C: Plugin>(
    plugin: &C,
    proposed: ExperimentProposed,
) -> Result<TicketOpened, PluginError> {
    plugin.storage().save_program(&proposed.program_id.0)?;
    let trigger_id = plugin.trigger().deliver_experiment(&proposed.experiment_id.0)?;
    let accepted = proposed
        .accept_trigger(trigger_id)
        .map_err(|_| PluginError::Trigger("trigger stage failed".into()))?;
    let ticket_id = plugin.ticket().open_ticket(&accepted.experiment_id.0)?;
    let ticket = accepted
        .open_ticket(ticket_id)
        .map_err(|_| PluginError::Ticket("ticket stage failed".into()))?;
    plugin.storage().save_ticket(&ticket.ticket_id.0)?;
    Ok(ticket)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ExperimentId, IssueId, ProgramId};

    struct Storage;
    impl Storage for Storage {
        fn save_program(&self, _: &str) -> Result<(), PluginError> { Ok(()) }
        fn save_ticket(&self, _: &str) -> Result<(), PluginError> { Ok(()) }
    }
    struct Trigger;
    impl TriggerSource for Trigger {
        fn deliver_experiment(&self, _: &str) -> Result<TriggerId, PluginError> {
            Ok(TriggerId("trigger".into()))
        }
    }
    struct Ticket;
    impl TicketExecutor for Ticket {
        fn open_ticket(&self, _: &str) -> Result<TicketId, PluginError> {
            Ok(TicketId("ticket".into()))
        }
    }

    struct FakePlugin {
        storage: Storage,
        trigger: Trigger,
        ticket: Ticket,
    }
    impl Plugin for FakePlugin {
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
        let ticket = run(&plugin, proposed).unwrap();
        assert_eq!(ticket.ticket_id, TicketId("ticket".into()));
    }
}
