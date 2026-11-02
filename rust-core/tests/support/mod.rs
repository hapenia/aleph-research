use std::collections::BTreeMap;
use std::future::Future;
use std::task::{Context, Poll, Waker};

use aleph_research_core::memory::InMemoryPlugin;
use aleph_research_core::{
    BenchmarkMetric, BenchmarkSpec, BenchmarkSpecId, BranchName, CommitSha, DomainError,
    Environment, EnvironmentFile, ExperimentId, ExperimentProposed, IssueId, Metric,
    MetricDirection, MetricWeight, Program, ProgramId, ProgramInput, ProgramStatus,
    ResearchCompleted, ResearchPolicy, Timestamp, Usage, run_pipeline,
};

pub fn block_on<F: Future>(future: F) -> F::Output {
    let mut future = std::pin::pin!(future);
    let mut context = Context::from_waker(Waker::noop());
    match future.as_mut().poll(&mut context) {
        Poll::Ready(output) => output,
        Poll::Pending => panic!("in-memory future suspended"),
    }
}

pub fn metric(name: &str, value: f64) -> Metric {
    Metric::new(name, value).unwrap()
}

pub fn spec() -> BenchmarkSpec {
    BenchmarkSpec::new(
        BenchmarkSpecId::new("benchmark-1").unwrap(),
        "bench.py",
        30_000,
        vec![BenchmarkMetric::new("score", MetricDirection::Maximize, true, None).unwrap()],
        1,
        BTreeMap::new(),
        None,
    )
    .unwrap()
}

pub fn program(policy: ResearchPolicy) -> Program {
    program_with_usage(policy, Usage::ZERO)
}

pub fn program_with_usage(policy: ResearchPolicy, usage: Usage) -> Program {
    Program::new(ProgramInput {
        id: ProgramId::new("program-1").unwrap(),
        name: "Program".to_string(),
        goal: "Improve the benchmark".to_string(),
        methodology: "Propose, run, review".to_string(),
        benchmark: spec(),
        utility: vec![MetricWeight::new("score", MetricDirection::Maximize, 1.0).unwrap()],
        exploration: aleph_research_core::Exploration::Normal,
        policy,
        usage,
        status: ProgramStatus::Running,
        created_at: Timestamp::UNIX_EPOCH,
    })
    .unwrap()
}

pub fn plugin_for(program: &Program) -> InMemoryPlugin {
    let plugin = InMemoryPlugin::default();
    plugin.storage.put_program(program.clone()).unwrap();
    plugin
}

pub fn proposed() -> ExperimentProposed {
    ExperimentProposed::new(
        ProgramId::new("program-1").unwrap(),
        IssueId::new("issue-1").unwrap(),
        ExperimentId::new("experiment-1").unwrap(),
        BranchName::new("experiment/one").unwrap(),
        CommitSha::zero(),
        Environment::requirements(EnvironmentFile::new("requirements.txt").unwrap()),
    )
}

pub fn run(
    plugin: &InMemoryPlugin,
    initial: ExperimentProposed,
) -> Result<ResearchCompleted, DomainError> {
    block_on(run_pipeline(plugin, initial))
}
