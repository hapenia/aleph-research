#![allow(dead_code)]

use aleph_research_core::{ExperimentProposed, PipelineContext, Plugin};

async fn skip<P: Plugin>(state: ExperimentProposed, context: &PipelineContext<'_, P>) {
    let _ = state.open_ticket(context).await;
}

fn main() {}
