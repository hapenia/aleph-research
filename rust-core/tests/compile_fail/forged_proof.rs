#![allow(dead_code)]

use aleph_research_core::command::{AuthorizationProof, CommandName, PauseProgram};

fn main() {
    let _ = AuthorizationProof::<PauseProgram>::mint(CommandName::PauseProgram);
}
