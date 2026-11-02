#![allow(dead_code)]

use aleph_research_core::{ExperimentProposed, PipelineContext, Plugin};

async fn reuse<P: Plugin>(state: ExperimentProposed, context: &PipelineContext<'_, P>) {
    let _ = state.deliver_trigger(context).await;
    let _ = state.deliver_trigger(context).await;
}

fn main() {}
