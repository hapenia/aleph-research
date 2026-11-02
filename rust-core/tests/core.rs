mod support;

use aleph_research_core::memory::{
    InMemoryArtifacts, InMemoryBenchmark, InMemoryClock, InMemorySessions, InMemoryTicketExecutor,
    InMemoryTriggerSource,
};
use aleph_research_core::{
    ActorId, Artifact, ArtifactId, Artifacts, Attempt, AuditEntry, AuditId, BenchmarkError,
    BenchmarkOutcome, BenchmarkRecordError, BenchmarkRunId, BenchmarkStatus, CommitSha,
    DomainError, EnvironmentDigest, ExperimentId, PipelineContext, PipelineRun, PipelineRunId,
    RequestId, ResearchOutcome, ResearchPolicy, ResearchPolicyError, SessionError, SpecHash,
    StageName, Storage, StorageError, TicketError, Timestamp, TriggerError, Usage, Version,
};
use support::*;

#[test]
fn a_complete_plugin_concludes_a_passing_experiment() {
    let program = program(ResearchPolicy::default());
    let plugin = plugin_for(&program);
    let completed = run(&plugin, proposed()).unwrap();
    assert_eq!(completed.outcome(), ResearchOutcome::Concluded);
    assert_eq!(completed.experiment_id().as_str(), "experiment-1");
    assert_eq!(completed.benchmark_run().unwrap().as_str(), "benchmark-1");
}

#[test]
fn the_benchmark_record_is_persisted() {
    let program = program(ResearchPolicy::default());
    let plugin = plugin_for(&program);
    let completed = run(&plugin, proposed()).unwrap();
    let record = block_on(
        plugin
            .storage
            .load_benchmark_record(completed.benchmark_run().unwrap()),
    )
    .unwrap();
    assert_eq!(record.status(), BenchmarkStatus::Passed);
    assert_eq!(record.experiment_id().as_str(), "experiment-1");
    assert_eq!(record.metrics()[0].name(), "score");
    assert_eq!(record.metrics()[0].value(), 0.0);
    assert_eq!(record.spec_hash(), &SpecHash::default());
    assert_eq!(record.environment_digest(), &EnvironmentDigest::default());
    assert_eq!(record.attempt().get(), 1);
    assert_eq!(record.max_attempts().get(), 3);
    assert!(matches!(
        block_on(plugin.storage.append_benchmark_record(&record)),
        Err(StorageError::AlreadyExists { .. })
    ));
}

#[test]
fn the_submitted_commit_is_recorded() {
    let program = program(ResearchPolicy::default());
    let mut plugin = plugin_for(&program);
    let commit = CommitSha::new("b".repeat(40)).unwrap();
    plugin.sessions = InMemorySessions::default().with_commit(commit.clone());
    let completed = run(&plugin, proposed()).unwrap();
    let record = block_on(
        plugin
            .storage
            .load_benchmark_record(completed.benchmark_run().unwrap()),
    )
    .unwrap();
    assert_eq!(record.commit(), &commit);
}

#[test]
fn a_failed_benchmark_completes_with_failure() {
    let program = program(ResearchPolicy::default());
    let mut plugin = plugin_for(&program);
    plugin.benchmark = InMemoryBenchmark::default().with_status(BenchmarkStatus::Failed);
    let completed = run(&plugin, proposed()).unwrap();
    assert_eq!(completed.outcome(), ResearchOutcome::Failed);
    let record = block_on(
        plugin
            .storage
            .load_benchmark_record(completed.benchmark_run().unwrap()),
    )
    .unwrap();
    assert_eq!(record.status(), BenchmarkStatus::Failed);
}

#[test]
fn a_retryable_benchmark_retries_until_it_passes() {
    let program = program(ResearchPolicy::new(4, 60, 10_000, 2).unwrap());
    let mut plugin = plugin_for(&program);
    plugin.benchmark = InMemoryBenchmark::default()
        .with_status_sequence(vec![BenchmarkStatus::Retryable, BenchmarkStatus::Passed]);
    let completed = run(&plugin, proposed()).unwrap();
    assert_eq!(completed.outcome(), ResearchOutcome::Concluded);
    assert_eq!(completed.benchmark_run().unwrap().as_str(), "benchmark-2");
    let first = block_on(
        plugin
            .storage
            .load_benchmark_record(&BenchmarkRunId::new("benchmark-1").unwrap()),
    )
    .unwrap();
    assert_eq!(first.status(), BenchmarkStatus::Retryable);
    assert_eq!(first.attempt().get(), 1);
    let second = block_on(
        plugin
            .storage
            .load_benchmark_record(&BenchmarkRunId::new("benchmark-2").unwrap()),
    )
    .unwrap();
    assert_eq!(second.status(), BenchmarkStatus::Passed);
    assert_eq!(second.attempt().get(), 2);
}

#[test]
fn a_retryable_benchmark_is_terminal_when_the_policy_is_exhausted() {
    let program = program(ResearchPolicy::new(4, 60, 10_000, 2).unwrap());
    let mut plugin = plugin_for(&program);
    plugin.benchmark = InMemoryBenchmark::default().with_status(BenchmarkStatus::Retryable);
    let completed = run(&plugin, proposed()).unwrap();
    assert_eq!(completed.outcome(), ResearchOutcome::Failed);
    assert_eq!(completed.benchmark_run().unwrap().as_str(), "benchmark-2");
    assert!(matches!(
        block_on(
            plugin
                .storage
                .load_benchmark_record(&BenchmarkRunId::new("benchmark-3").unwrap())
        ),
        Err(aleph_research_core::StorageError::NotFound { .. })
    ));
}

#[test]
fn a_single_attempt_policy_refuses_retry() {
    let program = program(ResearchPolicy::new(4, 60, 10_000, 1).unwrap());
    let mut plugin = plugin_for(&program);
    plugin.benchmark = InMemoryBenchmark::default().with_status(BenchmarkStatus::Retryable);
    let context = PipelineContext::new(&plugin, program.clone());
    let accepted = block_on(proposed().deliver_trigger(&context)).unwrap();
    let ticket = block_on(accepted.open_ticket(&context)).unwrap();
    let worker = block_on(ticket.start_worker(&context)).unwrap();
    let commit = block_on(worker.submit_commit(&context)).unwrap();
    let environment = block_on(commit.build_environment(&context)).unwrap();
    let outcome = block_on(environment.run_benchmark(&context)).unwrap();
    let BenchmarkOutcome::Retryable(retryable) = outcome else {
        panic!("expected a retryable benchmark");
    };
    assert!(!retryable.can_retry(&context));
    let error = block_on(retryable.retry_benchmark(&context)).unwrap_err();
    assert!(matches!(
        error,
        DomainError::Policy(ResearchPolicyError::RetryNotAllowed { .. })
    ));
}

#[test]
fn stage_transitions_carry_identity_and_facts() {
    let program = program(ResearchPolicy::default());
    let plugin = plugin_for(&program);
    let context = PipelineContext::new(&plugin, program.clone());
    let initial = proposed();
    assert_eq!(initial.program_id(), program.id());
    assert_eq!(initial.issue_id().as_str(), "issue-1");
    assert_eq!(initial.branch().as_str(), "experiment/one");
    assert!(initial.base_commit().is_zero());
    assert_eq!(initial.environment().file().as_str(), "requirements.txt");
    let accepted = block_on(initial.deliver_trigger(&context)).unwrap();
    assert_eq!(accepted.trigger_id().as_str(), "trigger-1");
    let ticket = block_on(accepted.open_ticket(&context)).unwrap();
    assert_eq!(ticket.ticket_id().as_str(), "ticket-1");
    let worker = block_on(ticket.start_worker(&context)).unwrap();
    assert_eq!(worker.worker_session_id().as_str(), "session-1");
    let commit = block_on(worker.submit_commit(&context)).unwrap();
    assert!(commit.commit().is_zero());
    let environment = block_on(commit.build_environment(&context)).unwrap();
    assert_eq!(environment.attempt().get(), 1);
    assert_eq!(
        environment.environment_digest(),
        &EnvironmentDigest::default()
    );
    let outcome = block_on(environment.run_benchmark(&context)).unwrap();
    assert_eq!(
        outcome.stage_name(),
        aleph_research_core::StageName::BenchmarkPassed
    );
    let BenchmarkOutcome::Passed(passed) = outcome else {
        panic!("expected a passing benchmark");
    };
    assert_eq!(passed.record().status(), BenchmarkStatus::Passed);
    let recorded = passed.record_result(&context).unwrap();
    assert_eq!(recorded.benchmark().id().as_str(), "benchmark-1");
    let reviewed = block_on(recorded.review_result(&context)).unwrap();
    assert_eq!(
        reviewed.decision(),
        aleph_research_core::ResearcherDecision::Propose
    );
    let completed = block_on(reviewed.close_passed(&context)).unwrap();
    assert_eq!(completed.outcome(), ResearchOutcome::Concluded);
}

#[test]
fn in_memory_storage_round_trips_aggregates_with_cas() {
    let program = program(ResearchPolicy::default());
    let plugin = plugin_for(&program);
    let stored = block_on(plugin.storage.load_program(program.id())).unwrap();
    assert_eq!(stored.version(), Version::first());
    let next = block_on(
        plugin
            .storage
            .save_program(&program, Some(Version::first())),
    )
    .unwrap();
    assert_eq!(next, Version::new(2).unwrap());
    assert!(matches!(
        block_on(
            plugin
                .storage
                .save_program(&program, Some(Version::first()))
        ),
        Err(StorageError::Conflict { .. })
    ));
    assert!(matches!(
        block_on(plugin.storage.save_program(&program, None)),
        Err(StorageError::Conflict { .. })
    ));
}

#[test]
fn pipeline_runs_and_audit_entries_are_persisted() {
    let program = program(ResearchPolicy::default());
    let plugin = plugin_for(&program);
    let run = PipelineRun::new(
        PipelineRunId::new("run-1").unwrap(),
        ExperimentId::new("experiment-1").unwrap(),
        StageName::EnvironmentBuilt,
        Attempt::new(2).unwrap(),
        None,
        Version::first(),
        Timestamp::UNIX_EPOCH,
    );
    assert_eq!(
        block_on(plugin.storage.save_pipeline_run(&run, None)).unwrap(),
        Version::first()
    );
    assert_eq!(
        block_on(plugin.storage.load_pipeline_run(run.id()))
            .unwrap()
            .value(),
        &run
    );
    let entry = AuditEntry::new(
        AuditId::new("audit-1").unwrap(),
        ActorId::new("actor-1").unwrap(),
        "experiment.propose",
        "experiment:experiment-1",
        "proposed",
        RequestId::new("request-1").unwrap(),
        Timestamp::UNIX_EPOCH,
    )
    .unwrap();
    block_on(plugin.storage.append_audit(&entry)).unwrap();
    assert_eq!(plugin.storage.audits(), vec![entry]);
}

#[test]
fn in_memory_artifacts_round_trip() {
    let artifacts = InMemoryArtifacts::default();
    let artifact = Artifact::new(
        ExperimentId::new("experiment-1").unwrap(),
        "stdout",
        "text/plain",
        b"ok".to_vec(),
    )
    .unwrap();
    let id = block_on(artifacts.store(artifact.clone())).unwrap();
    assert_eq!(block_on(artifacts.load(&id)).unwrap(), artifact);
    assert!(block_on(artifacts.load(&ArtifactId::new("missing").unwrap())).is_err());
}

#[test]
fn an_exhausted_program_policy_refuses_to_start() {
    let program = program_with_usage(
        ResearchPolicy::new(1, 60, 10_000, 1).unwrap(),
        Usage::new(2, 0, 0),
    );
    let plugin = plugin_for(&program);
    let error = run(&plugin, proposed()).unwrap_err();
    assert!(matches!(
        error,
        DomainError::Policy(ResearchPolicyError::ExperimentsExceeded { .. })
    ));
}

#[test]
fn a_missing_program_is_refused() {
    let plugin = aleph_research_core::memory::InMemoryPlugin::default();
    let error = run(&plugin, proposed()).unwrap_err();
    assert!(matches!(
        error,
        DomainError::Storage(aleph_research_core::StorageError::NotFound {
            aggregate: aleph_research_core::Aggregate::Program
        })
    ));
}

#[test]
fn trigger_errors_are_typed() {
    let program = program(ResearchPolicy::default());
    let mut plugin = plugin_for(&program);
    plugin.trigger = InMemoryTriggerSource::default().failing(TriggerError::Rejected {
        detail: "source refused".to_string(),
    });
    let error = run(&plugin, proposed()).unwrap_err();
    assert!(matches!(
        error,
        DomainError::Trigger(TriggerError::Rejected { .. })
    ));
}

#[test]
fn ticket_errors_are_typed() {
    let program = program(ResearchPolicy::default());
    let mut plugin = plugin_for(&program);
    plugin.executor = InMemoryTicketExecutor::default().failing(TicketError::Unavailable {
        detail: "executor down".to_string(),
    });
    let error = run(&plugin, proposed()).unwrap_err();
    assert!(matches!(
        error,
        DomainError::Ticket(TicketError::Unavailable { .. })
    ));
}

#[test]
fn worker_start_errors_are_typed() {
    let program = program(ResearchPolicy::default());
    let mut plugin = plugin_for(&program);
    plugin.sessions = InMemorySessions::default().with_start_failure(SessionError::Rejected {
        detail: "no worker".to_string(),
    });
    let error = run(&plugin, proposed()).unwrap_err();
    assert!(matches!(
        error,
        DomainError::Session(SessionError::Rejected { .. })
    ));
}

#[test]
fn commit_errors_are_typed() {
    let program = program(ResearchPolicy::default());
    let mut plugin = plugin_for(&program);
    plugin.sessions = InMemorySessions::default().with_commit_failure(SessionError::Rejected {
        detail: "no commit".to_string(),
    });
    let error = run(&plugin, proposed()).unwrap_err();
    assert!(matches!(
        error,
        DomainError::Session(SessionError::Rejected { .. })
    ));
}

#[test]
fn review_errors_are_typed() {
    let program = program(ResearchPolicy::default());
    let mut plugin = plugin_for(&program);
    plugin.sessions = InMemorySessions::default().with_review_failure(SessionError::Rejected {
        detail: "no review".to_string(),
    });
    let error = run(&plugin, proposed()).unwrap_err();
    assert!(matches!(
        error,
        DomainError::Session(SessionError::Rejected { .. })
    ));
}

#[test]
fn benchmark_errors_are_typed() {
    let program = program(ResearchPolicy::default());
    let mut plugin = plugin_for(&program);
    plugin.benchmark = InMemoryBenchmark::default().with_hash_failure(BenchmarkError::Rejected {
        detail: "no hash".to_string(),
    });
    assert!(matches!(
        run(&plugin, proposed()).unwrap_err(),
        DomainError::Benchmark(BenchmarkError::Rejected { .. })
    ));

    let mut plugin = plugin_for(&program);
    plugin.benchmark =
        InMemoryBenchmark::default().with_environment_failure(BenchmarkError::Unavailable {
            detail: "no environment".to_string(),
        });
    assert!(matches!(
        run(&plugin, proposed()).unwrap_err(),
        DomainError::Benchmark(BenchmarkError::Unavailable { .. })
    ));

    let mut plugin = plugin_for(&program);
    plugin.benchmark = InMemoryBenchmark::default().with_run_failure(BenchmarkError::Rejected {
        detail: "no run".to_string(),
    });
    assert!(matches!(
        run(&plugin, proposed()).unwrap_err(),
        DomainError::Benchmark(BenchmarkError::Rejected { .. })
    ));
}

#[test]
fn spec_hash_mismatches_are_refused() {
    let program = program(ResearchPolicy::default());
    let mut plugin = plugin_for(&program);
    plugin.benchmark =
        InMemoryBenchmark::default().with_record_spec_hash(SpecHash::new("f".repeat(64)).unwrap());
    let error = run(&plugin, proposed()).unwrap_err();
    assert!(matches!(
        error,
        DomainError::Record(BenchmarkRecordError::SpecHashMismatch)
    ));
}

#[test]
fn environment_digest_mismatches_are_refused() {
    let program = program(ResearchPolicy::default());
    let mut plugin = plugin_for(&program);
    plugin.benchmark = InMemoryBenchmark::default()
        .with_record_environment_digest(EnvironmentDigest::new("e".repeat(64)).unwrap());
    let error = run(&plugin, proposed()).unwrap_err();
    assert!(matches!(
        error,
        DomainError::Record(BenchmarkRecordError::EnvironmentDigestMismatch)
    ));
}

#[test]
fn undeclared_metrics_are_refused() {
    let program = program(ResearchPolicy::default());
    let mut plugin = plugin_for(&program);
    plugin.benchmark = InMemoryBenchmark::default().with_metrics(vec![metric("other", 1.0)]);
    let error = run(&plugin, proposed()).unwrap_err();
    assert!(matches!(
        error,
        DomainError::Record(BenchmarkRecordError::UnknownMetric { .. })
    ));
}

#[test]
fn the_clock_stamps_completion() {
    let now = Timestamp::parse("2026-11-02T11:26:39.000Z").unwrap();
    let program = program(ResearchPolicy::default());
    let mut plugin = plugin_for(&program);
    plugin.clock = InMemoryClock::default().with_now(now);
    let completed = run(&plugin, proposed()).unwrap();
    assert_eq!(completed.completed_at(), now);
}
