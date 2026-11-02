
use crate::{PluginError, ExperimentProposed, TicketOpened, TriggerId, TicketId};

pub trait Storage {
    fn save_program(&self, program_id: &str) -> Result<(), PluginError>;
    fn save_ticket(&self, ticket_id: &str) -> Result<(), PluginError>;
}

pub trait TriggerSource {
    fn deliver_experiment(&self, experiment_id: &str) -> Result<TriggerId, PluginError>;
}

pub trait TicketExecutor {
    fn open_ticket(&self, experiment_id: &str) -> Result<TicketId, PluginError>;
}

pub trait Plugin {
    type Storage: Storage;
    type Trigger: TriggerSource;
    type Ticket: TicketExecutor;

    fn storage(&self) -> &Self::Storage;
    fn trigger(&self) -> &Self::Trigger;
    fn ticket(&self) -> &Self::Ticket;
}

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

    struct MemoryStorage;
    impl Storage for MemoryStorage {
        fn save_program(&self, _: &str) -> Result<(), PluginError> { Ok(()) }
        fn save_ticket(&self, _: &str) -> Result<(), PluginError> { Ok(()) }
    }
    struct TestTriggerSource;
    impl TriggerSource for TestTriggerSource {
        fn deliver_experiment(&self, _: &str) -> Result<TriggerId, PluginError> {
            Ok(TriggerId("trigger".into()))
        }
    }
    struct TestTicketExecutor;
    impl TicketExecutor for TestTicketExecutor {
        fn open_ticket(&self, _: &str) -> Result<TicketId, PluginError> {
            Ok(TicketId("ticket".into()))
        }
    }

    struct FakePlugin {
        storage: MemoryStorage,
        trigger: TestTriggerSource,
        ticket: TestTicketExecutor,
    }
    impl Plugin for FakePlugin {
        type Storage = MemoryStorage;
        type Trigger = TestTriggerSource;
        type Ticket = TestTicketExecutor;
        fn storage(&self) -> &Self::Storage { &self.storage }
        fn trigger(&self) -> &Self::Trigger { &self.trigger }
        fn ticket(&self) -> &Self::Ticket { &self.ticket }
    }

    #[test]
    fn a_complete_plugin_drives_the_chain() {
        let plugin = FakePlugin { storage: MemoryStorage, trigger: TestTriggerSource, ticket: TestTicketExecutor };
        let proposed = ExperimentProposed::new(
            ProgramId("p".into()), IssueId("i".into()), ExperimentId("e".into()),
        ).unwrap();
        let ticket = run(&plugin, proposed).unwrap();
        assert_eq!(ticket.ticket_id, TicketId("ticket".into()));
    }
}
