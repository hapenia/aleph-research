use std::fmt;

use crate::domain::{
    BenchmarkRecord, BenchmarkStatus, Environment, ResearchOutcome, ResearcherDecision,
};
use crate::error::{DomainError, ResearchPolicyError};
use crate::id::{
    Attempt, BenchmarkRunId, BranchName, CommitSha, EnvironmentDigest, ExperimentId, IssueId,
    PipelineRunId, ProgramId, SessionId, TicketId, TriggerId, Version,
};
use crate::plugin::{
    BenchmarkRequest, BenchmarkRunner, Clock, CommitRequest, EnvironmentRequest, PipelineContext,
    Plugin, ReviewRequest, Sessions, Storage, TicketExecutor, TicketRequest, TriggerRequest,
    TriggerSource, WorkerRequest,
};
use crate::time::Timestamp;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[repr(u32)]
pub enum StageName {
    IssueAssigned = 0,
    ExperimentProposed = 1,
    TriggerAccepted = 2,
    TicketOpened = 3,
    WorkerStarted = 4,
    CommitSubmitted = 5,
    EnvironmentBuilt = 6,
    BenchmarkPassed = 7,
    BenchmarkFailed = 8,
    BenchmarkRetryable = 9,
    ResultRecorded = 10,
    ReviewRecorded = 11,
    ResearchCompleted = 12,
}

impl StageName {
    pub const ALL: [Self; 13] = [
        Self::IssueAssigned,
        Self::ExperimentProposed,
        Self::TriggerAccepted,
        Self::TicketOpened,
        Self::WorkerStarted,
        Self::CommitSubmitted,
        Self::EnvironmentBuilt,
        Self::BenchmarkPassed,
        Self::BenchmarkFailed,
        Self::BenchmarkRetryable,
        Self::ResultRecorded,
        Self::ReviewRecorded,
        Self::ResearchCompleted,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::IssueAssigned => "IssueAssigned",
            Self::ExperimentProposed => "ExperimentProposed",
            Self::TriggerAccepted => "TriggerAccepted",
            Self::TicketOpened => "TicketOpened",
            Self::WorkerStarted => "WorkerStarted",
            Self::CommitSubmitted => "CommitSubmitted",
            Self::EnvironmentBuilt => "EnvironmentBuilt",
            Self::BenchmarkPassed => "BenchmarkPassed",
            Self::BenchmarkFailed => "BenchmarkFailed",
            Self::BenchmarkRetryable => "BenchmarkRetryable",
            Self::ResultRecorded => "ResultRecorded",
            Self::ReviewRecorded => "ReviewRecorded",
            Self::ResearchCompleted => "ResearchCompleted",
        }
    }

    pub const fn code(self) -> u32 {
        self as u32
    }

    pub const fn from_code(code: u32) -> Option<Self> {
        match code {
            0 => Some(Self::IssueAssigned),
            1 => Some(Self::ExperimentProposed),
            2 => Some(Self::TriggerAccepted),
            3 => Some(Self::TicketOpened),
            4 => Some(Self::WorkerStarted),
            5 => Some(Self::CommitSubmitted),
            6 => Some(Self::EnvironmentBuilt),
            7 => Some(Self::BenchmarkPassed),
            8 => Some(Self::BenchmarkFailed),
            9 => Some(Self::BenchmarkRetryable),
            10 => Some(Self::ResultRecorded),
            11 => Some(Self::ReviewRecorded),
            12 => Some(Self::ResearchCompleted),
            _ => None,
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL
            .iter()
            .copied()
            .find(|stage| stage.as_str() == value)
    }

    pub const fn successors(self) -> &'static [Self] {
        match self {
            Self::IssueAssigned => &[Self::ExperimentProposed],
            Self::ExperimentProposed => &[Self::TriggerAccepted],
            Self::TriggerAccepted => &[Self::TicketOpened],
            Self::TicketOpened => &[Self::WorkerStarted],
            Self::WorkerStarted => &[Self::CommitSubmitted],
            Self::CommitSubmitted => &[Self::EnvironmentBuilt],
            Self::EnvironmentBuilt => &[
                Self::BenchmarkPassed,
                Self::BenchmarkFailed,
                Self::BenchmarkRetryable,
            ],
            Self::BenchmarkPassed => &[Self::ResultRecorded],
            Self::BenchmarkFailed => &[Self::ResearchCompleted],
            Self::BenchmarkRetryable => &[Self::EnvironmentBuilt, Self::ResearchCompleted],
            Self::ResultRecorded => &[Self::ReviewRecorded],
            Self::ReviewRecorded => &[Self::ResearchCompleted],
            Self::ResearchCompleted => &[],
        }
    }

    pub const fn successor_mask(self) -> u32 {
        let mut mask = 0u32;
        let mut index = 0usize;
        while index < self.successors().len() {
            mask |= 1u32 << self.successors()[index].code();
            index += 1;
        }
        mask
    }

    pub const fn is_terminal(self) -> bool {
        self.successors().is_empty()
    }
}

impl fmt::Display for StageName {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PipelineRun {
    id: PipelineRunId,
    experiment_id: ExperimentId,
    stage: StageName,
    attempt: Attempt,
    benchmark_run: Option<BenchmarkRunId>,
    state_version: Version,
    updated_at: Timestamp,
}

impl PipelineRun {
    pub fn new(
        id: PipelineRunId,
        experiment_id: ExperimentId,
        stage: StageName,
        attempt: Attempt,
        benchmark_run: Option<BenchmarkRunId>,
        state_version: Version,
        updated_at: Timestamp,
    ) -> Self {
        Self {
            id,
            experiment_id,
            stage,
            attempt,
            benchmark_run,
            state_version,
            updated_at,
        }
    }

    pub fn id(&self) -> &PipelineRunId {
        &self.id
    }

    pub fn experiment_id(&self) -> &ExperimentId {
        &self.experiment_id
    }

    pub const fn stage(&self) -> StageName {
        self.stage
    }

    pub const fn attempt(&self) -> Attempt {
        self.attempt
    }

    pub fn benchmark_run(&self) -> Option<&BenchmarkRunId> {
        self.benchmark_run.as_ref()
    }

    pub const fn state_version(&self) -> Version {
        self.state_version
    }

    pub const fn updated_at(&self) -> Timestamp {
        self.updated_at
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct StageIds {
    program_id: ProgramId,
    issue_id: IssueId,
    experiment_id: ExperimentId,
}

impl StageIds {
    fn new(program_id: ProgramId, issue_id: IssueId, experiment_id: ExperimentId) -> Self {
        Self {
            program_id,
            issue_id,
            experiment_id,
        }
    }
}

#[derive(Debug)]
pub struct IssueAssigned {
    program_id: ProgramId,
    issue_id: IssueId,
    assignee: SessionId,
    assigned_at: Timestamp,
}

impl IssueAssigned {
    pub fn new(
        program_id: ProgramId,
        issue_id: IssueId,
        assignee: SessionId,
        assigned_at: Timestamp,
    ) -> Self {
        Self {
            program_id,
            issue_id,
            assignee,
            assigned_at,
        }
    }

    pub fn program_id(&self) -> &ProgramId {
        &self.program_id
    }

    pub fn issue_id(&self) -> &IssueId {
        &self.issue_id
    }

    pub fn assignee(&self) -> &SessionId {
        &self.assignee
    }

    pub const fn assigned_at(&self) -> Timestamp {
        self.assigned_at
    }
}

#[derive(Debug)]
pub struct ExperimentProposed {
    ids: StageIds,
    branch: BranchName,
    base_commit: CommitSha,
    environment: Environment,
}

impl ExperimentProposed {
    pub fn new(
        program_id: ProgramId,
        issue_id: IssueId,
        experiment_id: ExperimentId,
        branch: BranchName,
        base_commit: CommitSha,
        environment: Environment,
    ) -> Self {
        Self {
            ids: StageIds::new(program_id, issue_id, experiment_id),
            branch,
            base_commit,
            environment,
        }
    }

    pub fn branch(&self) -> &BranchName {
        &self.branch
    }

    pub fn base_commit(&self) -> &CommitSha {
        &self.base_commit
    }

    pub fn environment(&self) -> &Environment {
        &self.environment
    }

    pub async fn deliver_trigger<P: Plugin>(
        self,
        context: &PipelineContext<'_, P>,
    ) -> Result<TriggerAccepted, DomainError> {
        let Self {
            ids,
            branch,
            base_commit,
            environment,
        } = self;
        let trigger_id = context
            .plugin()
            .trigger()
            .deliver(TriggerRequest {
                experiment_id: ids.experiment_id.clone(),
                branch,
                base_commit,
            })
            .await?;
        Ok(TriggerAccepted {
            ids,
            trigger_id,
            environment,
        })
    }
}

#[derive(Debug)]
pub struct TriggerAccepted {
    ids: StageIds,
    trigger_id: TriggerId,
    environment: Environment,
}

impl TriggerAccepted {
    pub fn trigger_id(&self) -> &TriggerId {
        &self.trigger_id
    }

    pub fn environment(&self) -> &Environment {
        &self.environment
    }

    pub async fn open_ticket<P: Plugin>(
        self,
        context: &PipelineContext<'_, P>,
    ) -> Result<TicketOpened, DomainError> {
        let Self {
            ids,
            trigger_id: _trigger_id,
            environment,
        } = self;
        let ticket_id = context
            .plugin()
            .executor()
            .open(TicketRequest {
                program_id: ids.program_id.clone(),
                issue_id: ids.issue_id.clone(),
                experiment_id: ids.experiment_id.clone(),
            })
            .await?;
        Ok(TicketOpened {
            ids,
            ticket_id,
            environment,
        })
    }
}

#[derive(Debug)]
pub struct TicketOpened {
    ids: StageIds,
    ticket_id: TicketId,
    environment: Environment,
}

impl TicketOpened {
    pub fn ticket_id(&self) -> &TicketId {
        &self.ticket_id
    }

    pub fn environment(&self) -> &Environment {
        &self.environment
    }

    pub async fn start_worker<P: Plugin>(
        self,
        context: &PipelineContext<'_, P>,
    ) -> Result<WorkerStarted, DomainError> {
        let Self {
            ids,
            ticket_id,
            environment,
        } = self;
        let worker_session_id = context
            .plugin()
            .sessions()
            .start_worker(WorkerRequest {
                ticket_id: ticket_id.clone(),
                experiment_id: ids.experiment_id.clone(),
            })
            .await?;
        Ok(WorkerStarted {
            ids,
            ticket_id,
            worker_session_id,
            environment,
        })
    }
}

#[derive(Debug)]
pub struct WorkerStarted {
    ids: StageIds,
    ticket_id: TicketId,
    worker_session_id: SessionId,
    environment: Environment,
}

impl WorkerStarted {
    pub fn ticket_id(&self) -> &TicketId {
        &self.ticket_id
    }

    pub fn worker_session_id(&self) -> &SessionId {
        &self.worker_session_id
    }

    pub fn environment(&self) -> &Environment {
        &self.environment
    }

    pub async fn submit_commit<P: Plugin>(
        self,
        context: &PipelineContext<'_, P>,
    ) -> Result<CommitSubmitted, DomainError> {
        let Self {
            ids,
            ticket_id,
            worker_session_id,
            environment,
        } = self;
        let commit = context
            .plugin()
            .sessions()
            .submit_commit(CommitRequest {
                ticket_id: ticket_id.clone(),
                worker_session_id,
            })
            .await?;
        Ok(CommitSubmitted {
            ids,
            ticket_id,
            commit,
            environment,
        })
    }
}

#[derive(Debug)]
pub struct CommitSubmitted {
    ids: StageIds,
    ticket_id: TicketId,
    commit: CommitSha,
    environment: Environment,
}

impl CommitSubmitted {
    pub fn ticket_id(&self) -> &TicketId {
        &self.ticket_id
    }

    pub fn commit(&self) -> &CommitSha {
        &self.commit
    }

    pub fn environment(&self) -> &Environment {
        &self.environment
    }

    pub async fn build_environment<P: Plugin>(
        self,
        context: &PipelineContext<'_, P>,
    ) -> Result<EnvironmentBuilt, DomainError> {
        let Self {
            ids,
            ticket_id,
            commit,
            environment,
        } = self;
        let environment_digest = context
            .plugin()
            .benchmark()
            .build_environment(EnvironmentRequest {
                commit: commit.clone(),
                environment: environment.clone(),
            })
            .await?;
        Ok(EnvironmentBuilt {
            ids,
            ticket_id,
            commit,
            environment,
            environment_digest,
            attempt: Attempt::first(),
        })
    }
}

#[derive(Debug)]
pub struct EnvironmentBuilt {
    ids: StageIds,
    ticket_id: TicketId,
    commit: CommitSha,
    environment: Environment,
    environment_digest: EnvironmentDigest,
    attempt: Attempt,
}

impl EnvironmentBuilt {
    pub fn ticket_id(&self) -> &TicketId {
        &self.ticket_id
    }

    pub fn commit(&self) -> &CommitSha {
        &self.commit
    }

    pub fn environment(&self) -> &Environment {
        &self.environment
    }

    pub fn environment_digest(&self) -> &EnvironmentDigest {
        &self.environment_digest
    }

    pub const fn attempt(&self) -> Attempt {
        self.attempt
    }

    pub async fn run_benchmark<P: Plugin>(
        self,
        context: &PipelineContext<'_, P>,
    ) -> Result<BenchmarkOutcome, DomainError> {
        let Self {
            ids,
            ticket_id,
            commit,
            environment,
            environment_digest,
            attempt,
        } = self;
        let program = context.program();
        let policy = program.policy();
        let max_attempts = policy.attempt_limit()?;
        let spec_hash = context
            .plugin()
            .benchmark()
            .spec_hash(program.benchmark())
            .await?;
        let record = context
            .plugin()
            .benchmark()
            .run(BenchmarkRequest {
                experiment_id: ids.experiment_id.clone(),
                ticket_id: ticket_id.clone(),
                spec: program.benchmark().clone(),
                commit: commit.clone(),
                environment_digest: environment_digest.clone(),
                attempt,
                max_attempts,
            })
            .await?;
        record.verify_source(&ids.experiment_id, &ticket_id, &commit)?;
        record.verify_contract(
            program.benchmark(),
            &spec_hash,
            &environment_digest,
            attempt,
            max_attempts,
        )?;
        context
            .plugin()
            .storage()
            .append_benchmark_record(&record)
            .await?;
        match record.status() {
            BenchmarkStatus::Passed => {
                Ok(BenchmarkOutcome::Passed(BenchmarkPassed { ids, record }))
            }
            BenchmarkStatus::Failed => {
                Ok(BenchmarkOutcome::Failed(BenchmarkFailed { ids, record }))
            }
            BenchmarkStatus::Retryable => Ok(BenchmarkOutcome::Retryable(BenchmarkRetryable {
                ids,
                ticket_id,
                commit,
                environment,
                attempt,
                record,
            })),
        }
    }
}

#[derive(Debug)]
pub enum BenchmarkOutcome {
    Passed(BenchmarkPassed),
    Failed(BenchmarkFailed),
    Retryable(BenchmarkRetryable),
}

impl BenchmarkOutcome {
    pub const fn stage_name(&self) -> StageName {
        match self {
            Self::Passed(_) => StageName::BenchmarkPassed,
            Self::Failed(_) => StageName::BenchmarkFailed,
            Self::Retryable(_) => StageName::BenchmarkRetryable,
        }
    }

    pub fn record(&self) -> &BenchmarkRecord {
        match self {
            Self::Passed(stage) => stage.record(),
            Self::Failed(stage) => stage.record(),
            Self::Retryable(stage) => stage.record(),
        }
    }
}

#[derive(Debug)]
pub struct BenchmarkPassed {
    ids: StageIds,
    record: BenchmarkRecord,
}

impl BenchmarkPassed {
    pub fn record(&self) -> &BenchmarkRecord {
        &self.record
    }

    pub fn record_result<P: Plugin>(
        self,
        _context: &PipelineContext<'_, P>,
    ) -> Result<ResultRecorded, DomainError> {
        Ok(ResultRecorded {
            ids: self.ids,
            benchmark: self.record,
        })
    }
}

#[derive(Debug)]
pub struct BenchmarkFailed {
    ids: StageIds,
    record: BenchmarkRecord,
}

impl BenchmarkFailed {
    pub fn record(&self) -> &BenchmarkRecord {
        &self.record
    }

    pub async fn close_failed<P: Plugin>(
        self,
        context: &PipelineContext<'_, P>,
    ) -> Result<ResearchCompleted, DomainError> {
        let benchmark_run = Some(self.record.id().clone());
        let completed_at = context.plugin().clock().now().await?;
        Ok(ResearchCompleted {
            ids: self.ids,
            outcome: ResearchOutcome::Failed,
            benchmark_run,
            completed_at,
        })
    }
}

#[derive(Debug)]
pub struct BenchmarkRetryable {
    ids: StageIds,
    ticket_id: TicketId,
    commit: CommitSha,
    environment: Environment,
    attempt: Attempt,
    record: BenchmarkRecord,
}

impl BenchmarkRetryable {
    pub fn ticket_id(&self) -> &TicketId {
        &self.ticket_id
    }

    pub fn commit(&self) -> &CommitSha {
        &self.commit
    }

    pub fn environment(&self) -> &Environment {
        &self.environment
    }

    pub const fn attempt(&self) -> Attempt {
        self.attempt
    }

    pub fn record(&self) -> &BenchmarkRecord {
        &self.record
    }

    pub fn can_retry<P: Plugin>(&self, context: &PipelineContext<'_, P>) -> bool {
        context
            .program()
            .policy()
            .allows_retry(self.record.attempt())
    }

    pub async fn retry_benchmark<P: Plugin>(
        self,
        context: &PipelineContext<'_, P>,
    ) -> Result<EnvironmentBuilt, DomainError> {
        let policy = context.program().policy();
        let attempt = self.record.attempt();
        if !policy.allows_retry(attempt) {
            return Err(ResearchPolicyError::RetryNotAllowed {
                attempt,
                max_attempts: policy.max_attempts_per_experiment(),
            }
            .into());
        }
        let next_attempt = attempt.next()?;
        let Self {
            ids,
            ticket_id,
            commit,
            environment,
            attempt: _attempt,
            record: _record,
        } = self;
        let environment_digest = context
            .plugin()
            .benchmark()
            .build_environment(EnvironmentRequest {
                commit: commit.clone(),
                environment: environment.clone(),
            })
            .await?;
        Ok(EnvironmentBuilt {
            ids,
            ticket_id,
            commit,
            environment,
            environment_digest,
            attempt: next_attempt,
        })
    }

    pub async fn close_failed<P: Plugin>(
        self,
        context: &PipelineContext<'_, P>,
    ) -> Result<ResearchCompleted, DomainError> {
        let benchmark_run = Some(self.record.id().clone());
        let completed_at = context.plugin().clock().now().await?;
        Ok(ResearchCompleted {
            ids: self.ids,
            outcome: ResearchOutcome::Failed,
            benchmark_run,
            completed_at,
        })
    }
}

#[derive(Debug)]
pub struct ResultRecorded {
    ids: StageIds,
    benchmark: BenchmarkRecord,
}

impl ResultRecorded {
    pub fn benchmark(&self) -> &BenchmarkRecord {
        &self.benchmark
    }

    pub async fn review_result<P: Plugin>(
        self,
        context: &PipelineContext<'_, P>,
    ) -> Result<ReviewRecorded, DomainError> {
        let decision = context
            .plugin()
            .sessions()
            .review(ReviewRequest {
                experiment_id: self.ids.experiment_id.clone(),
                benchmark: self.benchmark.clone(),
            })
            .await?;
        Ok(ReviewRecorded {
            ids: self.ids,
            benchmark: self.benchmark,
            decision,
        })
    }
}

#[derive(Debug)]
pub struct ReviewRecorded {
    ids: StageIds,
    benchmark: BenchmarkRecord,
    decision: ResearcherDecision,
}

impl ReviewRecorded {
    pub fn benchmark(&self) -> &BenchmarkRecord {
        &self.benchmark
    }

    pub const fn decision(&self) -> ResearcherDecision {
        self.decision
    }

    pub async fn close_passed<P: Plugin>(
        self,
        context: &PipelineContext<'_, P>,
    ) -> Result<ResearchCompleted, DomainError> {
        let benchmark_run = Some(self.benchmark.id().clone());
        let completed_at = context.plugin().clock().now().await?;
        Ok(ResearchCompleted {
            ids: self.ids,
            outcome: ResearchOutcome::Concluded,
            benchmark_run,
            completed_at,
        })
    }
}

#[derive(Debug)]
pub struct ResearchCompleted {
    ids: StageIds,
    outcome: ResearchOutcome,
    benchmark_run: Option<BenchmarkRunId>,
    completed_at: Timestamp,
}

impl ResearchCompleted {
    pub const fn outcome(&self) -> ResearchOutcome {
        self.outcome
    }

    pub fn benchmark_run(&self) -> Option<&BenchmarkRunId> {
        self.benchmark_run.as_ref()
    }

    pub const fn completed_at(&self) -> Timestamp {
        self.completed_at
    }
}

macro_rules! stage_accessors {
    ($($stage:ty),+ $(,)?) => {
        $(
            impl $stage {
                pub fn program_id(&self) -> &ProgramId {
                    &self.ids.program_id
                }

                pub fn issue_id(&self) -> &IssueId {
                    &self.ids.issue_id
                }

                pub fn experiment_id(&self) -> &ExperimentId {
                    &self.ids.experiment_id
                }
            }
        )+
    };
}

stage_accessors!(
    ExperimentProposed,
    TriggerAccepted,
    TicketOpened,
    WorkerStarted,
    CommitSubmitted,
    EnvironmentBuilt,
    BenchmarkPassed,
    BenchmarkFailed,
    BenchmarkRetryable,
    ResultRecorded,
    ReviewRecorded,
    ResearchCompleted,
);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stage_names_round_trip_through_codes_and_text() {
        for (index, stage) in StageName::ALL.iter().enumerate() {
            assert_eq!(stage.code(), index as u32);
            assert_eq!(StageName::from_code(stage.code()), Some(*stage));
            assert_eq!(StageName::parse(stage.as_str()), Some(*stage));
            assert_eq!(stage.to_string(), stage.as_str());
        }
        assert_eq!(StageName::from_code(13), None);
        assert_eq!(StageName::parse("Unknown"), None);
    }

    #[test]
    fn stage_order_allows_every_pipeline_edge() {
        let allowed = [
            (StageName::IssueAssigned, StageName::ExperimentProposed),
            (StageName::ExperimentProposed, StageName::TriggerAccepted),
            (StageName::TriggerAccepted, StageName::TicketOpened),
            (StageName::TicketOpened, StageName::WorkerStarted),
            (StageName::WorkerStarted, StageName::CommitSubmitted),
            (StageName::CommitSubmitted, StageName::EnvironmentBuilt),
            (StageName::EnvironmentBuilt, StageName::BenchmarkPassed),
            (StageName::EnvironmentBuilt, StageName::BenchmarkFailed),
            (StageName::EnvironmentBuilt, StageName::BenchmarkRetryable),
            (StageName::BenchmarkPassed, StageName::ResultRecorded),
            (StageName::BenchmarkFailed, StageName::ResearchCompleted),
            (StageName::BenchmarkRetryable, StageName::EnvironmentBuilt),
            (StageName::BenchmarkRetryable, StageName::ResearchCompleted),
            (StageName::ResultRecorded, StageName::ReviewRecorded),
            (StageName::ReviewRecorded, StageName::ResearchCompleted),
        ];
        for (from, to) in allowed {
            assert!(
                from.successors().contains(&to),
                "{} must not reach {to}",
                from.as_str()
            );
            assert_ne!(from.successor_mask() & (1 << to.code()), 0);
        }
    }

    #[test]
    fn stage_order_refuses_skipping() {
        assert!(
            !StageName::ExperimentProposed
                .successors()
                .contains(&StageName::TicketOpened)
        );
        assert!(
            !StageName::TicketOpened
                .successors()
                .contains(&StageName::CommitSubmitted)
        );
        assert!(
            !StageName::BenchmarkPassed
                .successors()
                .contains(&StageName::ResearchCompleted)
        );
    }

    #[test]
    fn only_research_completed_is_terminal() {
        for stage in StageName::ALL {
            assert_eq!(stage.is_terminal(), stage == StageName::ResearchCompleted);
        }
        assert_eq!(StageName::ResearchCompleted.successor_mask(), 0);
    }

    #[test]
    fn pipeline_runs_carry_their_stage() {
        let run = PipelineRun::new(
            PipelineRunId::new("run-1").unwrap(),
            ExperimentId::new("experiment-1").unwrap(),
            StageName::EnvironmentBuilt,
            Attempt::new(2).unwrap(),
            None,
            Version::first(),
            Timestamp::UNIX_EPOCH,
        );
        assert_eq!(run.stage(), StageName::EnvironmentBuilt);
        assert_eq!(run.attempt().get(), 2);
        assert_eq!(run.state_version(), Version::first());
        assert!(run.benchmark_run().is_none());
    }
}
