#![allow(dead_code)]

use aleph_research_core::ProgramId;
use aleph_research_core::command::{CommandDraft, CommandExecutor, PauseProgramCommand};
use aleph_research_core::memory::InMemoryPlugin;

fn main() {
    let plugin = InMemoryPlugin::default();
    let executor = CommandExecutor::new(&plugin);
    let draft = CommandDraft::PauseProgram(Box::new(PauseProgramCommand {
        program_id: ProgramId::new("program-1").unwrap(),
    }));
    let _ = executor.execute(draft);
}
