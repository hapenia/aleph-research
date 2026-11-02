use crate::error::DomainError;
use crate::plugin::{PipelineContext, Plugin, Storage};
use crate::stage::{BenchmarkOutcome, ExperimentProposed, ResearchCompleted};

pub async fn run_pipeline<P: Plugin>(
    plugin: &P,
    initial: ExperimentProposed,
) -> Result<ResearchCompleted, DomainError> {
    let program = plugin
        .storage()
        .load_program(initial.program_id())
        .await?
        .into_value();
    program.policy().check_usage(&program.usage())?;
    let context = PipelineContext::new(plugin, program);
    let accepted = initial.deliver_trigger(&context).await?;
    let ticket = accepted.open_ticket(&context).await?;
    let worker = ticket.start_worker(&context).await?;
    let commit = worker.submit_commit(&context).await?;
    let mut environment = commit.build_environment(&context).await?;
    loop {
        match environment.run_benchmark(&context).await? {
            BenchmarkOutcome::Passed(passed) => {
                let recorded = passed.record_result(&context)?;
                let reviewed = recorded.review_result(&context).await?;
                return reviewed.close_passed(&context);
            }
            BenchmarkOutcome::Failed(failed) => return failed.close_failed(&context),
            BenchmarkOutcome::Retryable(retryable) => {
                if retryable.can_retry(&context) {
                    environment = retryable.retry_benchmark(&context).await?;
                } else {
                    return retryable.close_failed(&context);
                }
            }
        }
    }
}
