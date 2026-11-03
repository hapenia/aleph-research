use std::collections::{BTreeMap, HashSet};
use std::fmt;

use getset::{CopyGetters, Getters};

use crate::error::{
    ArtifactError, AuditError, BenchmarkRecordError, BenchmarkSpecError, DomainError, IssueError,
    LineageError, ProgramError, ResearchPolicyError,
};
use crate::id::{
    ActorId, ArtifactId, Attempt, AuditId, BenchmarkRunId, BenchmarkSpecId, BranchName, CommentId,
    CommitSha, EnvironmentDigest, EnvironmentFile, ExperimentId, IssueId, ProgramId, RequestId,
    SessionId, SpecHash, TicketId,
};
use crate::time::Timestamp;

macro_rules! simple_enum {
    ($name:ident { $($variant:ident => $text:literal),+ $(,)? }) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
        pub enum $name {
            $($variant),+
        }

        impl $name {
            pub const fn as_str(self) -> &'static str {
                match self {
                    $(Self::$variant => $text),+
                }
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str(self.as_str())
            }
        }
    };
}

simple_enum!(MetricDirection {
    Maximize => "maximize",
    Minimize => "minimize",
});

simple_enum!(Exploration {
    Low => "low",
    Normal => "normal",
    High => "high",
});

simple_enum!(ProgramStatus {
    Running => "running",
    Paused => "paused",
    Stopped => "stopped",
});

simple_enum!(IssueStatus {
    Open => "open",
    Assigned => "assigned",
    Closed => "closed",
});

simple_enum!(ExperimentStatus {
    Open => "open",
    Concluded => "concluded",
    Failed => "failed",
    Cancelled => "cancelled",
});

simple_enum!(TicketStatus {
    Open => "open",
    Running => "running",
    Succeeded => "succeeded",
    Failed => "failed",
    Abandoned => "abandoned",
});

simple_enum!(BenchmarkStatus {
    Passed => "passed",
    Failed => "failed",
    Retryable => "retryable",
});

simple_enum!(EnvironmentKind {
    Requirements => "requirements",
    UvLock => "uv-lock",
});

simple_enum!(LineageStrategy {
    Continue => "continue",
    Branch => "branch",
    Fresh => "fresh",
});

simple_enum!(ResearchOutcome {
    Concluded => "concluded",
    Failed => "failed",
    Cancelled => "cancelled",
});

simple_enum!(StopReason {
    GoalMet => "goal-met",
    PolicyExhausted => "policy-exhausted",
    NoHypothesis => "no-hypothesis",
    Cancelled => "cancelled",
});

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ResearcherDecision {
    Propose,
    Revise,
    Stop(StopReason),
}

impl ResearcherDecision {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Propose => "propose",
            Self::Revise => "revise",
            Self::Stop(_) => "stop",
        }
    }

    pub const fn stop_reason(self) -> Option<StopReason> {
        match self {
            Self::Stop(reason) => Some(reason),
            Self::Propose | Self::Revise => None,
        }
    }
}

impl fmt::Display for ResearcherDecision {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Environment {
    Requirements(EnvironmentFile),
    UvLock(EnvironmentFile),
}

impl Environment {
    pub fn requirements(file: EnvironmentFile) -> Self {
        Self::Requirements(file)
    }

    pub fn uv_lock(file: EnvironmentFile) -> Self {
        Self::UvLock(file)
    }

    pub const fn kind(&self) -> EnvironmentKind {
        match self {
            Self::Requirements(_) => EnvironmentKind::Requirements,
            Self::UvLock(_) => EnvironmentKind::UvLock,
        }
    }

    pub fn file(&self) -> &EnvironmentFile {
        match self {
            Self::Requirements(file) | Self::UvLock(file) => file,
        }
    }
}

#[derive(Debug, Clone, PartialEq, CopyGetters)]
pub struct Metric {
    name: String,
    #[getset(get_copy = "pub")]
    value: f64,
}

impl Metric {
    pub fn new(name: impl Into<String>, value: f64) -> Result<Self, DomainError> {
        let name = name.into();
        if name.trim().is_empty() {
            return Err(BenchmarkRecordError::EmptyMetricName.into());
        }
        if !value.is_finite() {
            return Err(BenchmarkRecordError::NonFiniteMetric { name, value }.into());
        }
        Ok(Self { name, value })
    }

    pub fn name(&self) -> &str {
        &self.name
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct BenchmarkMetric {
    name: String,
    direction: MetricDirection,
    required: bool,
    tolerance: Option<f64>,
}

impl BenchmarkMetric {
    pub fn new(
        name: impl Into<String>,
        direction: MetricDirection,
        required: bool,
        tolerance: Option<f64>,
    ) -> Result<Self, DomainError> {
        let name = name.into();
        if name.trim().is_empty() {
            return Err(BenchmarkSpecError::EmptyMetricName.into());
        }
        if let Some(value) = tolerance
            && (!value.is_finite() || value < 0.0)
        {
            return Err(BenchmarkSpecError::InvalidTolerance { name }.into());
        }
        Ok(Self {
            name,
            direction,
            required,
            tolerance,
        })
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub const fn direction(&self) -> MetricDirection {
        self.direction
    }

    pub const fn required(&self) -> bool {
        self.required
    }

    pub const fn tolerance(&self) -> Option<f64> {
        self.tolerance
    }
}

#[derive(Debug, Clone, PartialEq, Getters)]
pub struct BenchmarkSpec {
    #[getset(get = "pub")]
    id: BenchmarkSpecId,
    entry: String,
    timeout_ms: u64,
    metrics: Vec<BenchmarkMetric>,
    max_retries: u32,
    #[getset(get = "pub")]
    baseline: BTreeMap<String, f64>,
    dataset: Option<String>,
}

impl BenchmarkSpec {
    pub fn new(
        id: BenchmarkSpecId,
        entry: impl Into<String>,
        timeout_ms: u64,
        metrics: Vec<BenchmarkMetric>,
        max_retries: u32,
        baseline: BTreeMap<String, f64>,
        dataset: Option<String>,
    ) -> Result<Self, DomainError> {
        let entry = entry.into();
        if entry.trim().is_empty() {
            return Err(BenchmarkSpecError::EmptyEntry.into());
        }
        if timeout_ms == 0 {
            return Err(BenchmarkSpecError::ZeroTimeout.into());
        }
        if metrics.is_empty() {
            return Err(BenchmarkSpecError::NoMetrics.into());
        }
        let mut names = HashSet::new();
        for metric in &metrics {
            if !names.insert(metric.name()) {
                return Err(BenchmarkSpecError::DuplicateMetric {
                    name: metric.name().to_string(),
                }
                .into());
            }
        }
        for (name, value) in &baseline {
            if !names.contains(name.as_str()) {
                return Err(BenchmarkSpecError::UnknownBaseline { name: name.clone() }.into());
            }
            if !value.is_finite() {
                return Err(BenchmarkSpecError::NonFiniteBaseline {
                    name: name.clone(),
                    value: *value,
                }
                .into());
            }
        }
        if let Some(dataset) = &dataset
            && dataset.trim().is_empty()
        {
            return Err(BenchmarkSpecError::EmptyDataset.into());
        }
        Ok(Self {
            id,
            entry,
            timeout_ms,
            metrics,
            max_retries,
            baseline,
            dataset,
        })
    }

    pub fn entry(&self) -> &str {
        &self.entry
    }

    pub const fn timeout_ms(&self) -> u64 {
        self.timeout_ms
    }

    pub fn metrics(&self) -> &[BenchmarkMetric] {
        &self.metrics
    }

    pub const fn max_retries(&self) -> u32 {
        self.max_retries
    }

    pub fn dataset(&self) -> Option<&str> {
        self.dataset.as_deref()
    }

    pub fn metric(&self, name: &str) -> Option<&BenchmarkMetric> {
        self.metrics.iter().find(|metric| metric.name() == name)
    }
}

#[derive(Debug, Clone, PartialEq, Getters)]
pub struct BenchmarkRecord {
    #[getset(get = "pub")]
    id: BenchmarkRunId,
    #[getset(get = "pub")]
    experiment_id: ExperimentId,
    #[getset(get = "pub")]
    ticket_id: TicketId,
    #[getset(get = "pub")]
    commit: CommitSha,
    #[getset(get = "pub")]
    spec_hash: SpecHash,
    #[getset(get = "pub")]
    environment_digest: EnvironmentDigest,
    metrics: Vec<Metric>,
    status: BenchmarkStatus,
    attempt: Attempt,
    max_attempts: Attempt,
    stdout: String,
    stderr: String,
    artifacts: Vec<ArtifactId>,
    created_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq)]
pub struct BenchmarkRecordInput {
    pub id: BenchmarkRunId,
    pub experiment_id: ExperimentId,
    pub ticket_id: TicketId,
    pub commit: CommitSha,
    pub spec_hash: SpecHash,
    pub environment_digest: EnvironmentDigest,
    pub metrics: Vec<Metric>,
    pub status: BenchmarkStatus,
    pub attempt: Attempt,
    pub max_attempts: Attempt,
    pub stdout: String,
    pub stderr: String,
    pub artifacts: Vec<ArtifactId>,
    pub created_at: Timestamp,
}

impl BenchmarkRecord {
    pub fn new(input: BenchmarkRecordInput) -> Result<Self, DomainError> {
        if input.attempt > input.max_attempts {
            return Err(BenchmarkRecordError::AttemptExceedsMaximum {
                attempt: input.attempt,
                max_attempts: input.max_attempts,
            }
            .into());
        }
        let mut names = HashSet::new();
        for metric in &input.metrics {
            if !names.insert(metric.name()) {
                return Err(BenchmarkRecordError::DuplicateMetric {
                    name: metric.name().to_string(),
                }
                .into());
            }
        }
        Ok(Self {
            id: input.id,
            experiment_id: input.experiment_id,
            ticket_id: input.ticket_id,
            commit: input.commit,
            spec_hash: input.spec_hash,
            environment_digest: input.environment_digest,
            metrics: input.metrics,
            status: input.status,
            attempt: input.attempt,
            max_attempts: input.max_attempts,
            stdout: input.stdout,
            stderr: input.stderr,
            artifacts: input.artifacts,
            created_at: input.created_at,
        })
    }

    pub fn metrics(&self) -> &[Metric] {
        &self.metrics
    }

    pub const fn status(&self) -> BenchmarkStatus {
        self.status
    }

    pub const fn attempt(&self) -> Attempt {
        self.attempt
    }

    pub const fn max_attempts(&self) -> Attempt {
        self.max_attempts
    }

    pub fn stdout(&self) -> &str {
        &self.stdout
    }

    pub fn stderr(&self) -> &str {
        &self.stderr
    }

    pub fn artifacts(&self) -> &[ArtifactId] {
        &self.artifacts
    }

    pub const fn created_at(&self) -> Timestamp {
        self.created_at
    }

    pub fn verify_source(
        &self,
        experiment_id: &ExperimentId,
        ticket_id: &TicketId,
        commit: &CommitSha,
    ) -> Result<(), DomainError> {
        if &self.experiment_id != experiment_id {
            return Err(BenchmarkRecordError::ExperimentMismatch {
                expected: experiment_id.clone(),
                actual: self.experiment_id.clone(),
            }
            .into());
        }
        if &self.ticket_id != ticket_id {
            return Err(BenchmarkRecordError::TicketMismatch {
                expected: ticket_id.clone(),
                actual: self.ticket_id.clone(),
            }
            .into());
        }
        if &self.commit != commit {
            return Err(BenchmarkRecordError::CommitMismatch.into());
        }
        Ok(())
    }

    pub fn verify_contract(
        &self,
        spec: &BenchmarkSpec,
        spec_hash: &SpecHash,
        environment_digest: &EnvironmentDigest,
        attempt: Attempt,
        max_attempts: Attempt,
    ) -> Result<(), DomainError> {
        if &self.spec_hash != spec_hash {
            return Err(BenchmarkRecordError::SpecHashMismatch.into());
        }
        if &self.environment_digest != environment_digest {
            return Err(BenchmarkRecordError::EnvironmentDigestMismatch.into());
        }
        if self.attempt != attempt {
            return Err(BenchmarkRecordError::AttemptMismatch {
                expected: attempt,
                actual: self.attempt,
            }
            .into());
        }
        if self.max_attempts != max_attempts {
            return Err(BenchmarkRecordError::MaxAttemptsMismatch {
                expected: max_attempts,
                actual: self.max_attempts,
            }
            .into());
        }
        for metric in &self.metrics {
            if spec.metric(metric.name()).is_none() {
                return Err(BenchmarkRecordError::UnknownMetric {
                    name: metric.name().to_string(),
                }
                .into());
            }
        }
        for metric in spec.metrics() {
            if metric.required()
                && !self
                    .metrics
                    .iter()
                    .any(|value| value.name() == metric.name())
            {
                return Err(BenchmarkRecordError::MissingMetric {
                    name: metric.name().to_string(),
                }
                .into());
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Usage {
    experiments: u32,
    compute_minutes: u64,
    tokens: u64,
}

impl Usage {
    pub const ZERO: Self = Self {
        experiments: 0,
        compute_minutes: 0,
        tokens: 0,
    };

    pub const fn new(experiments: u32, compute_minutes: u64, tokens: u64) -> Self {
        Self {
            experiments,
            compute_minutes,
            tokens,
        }
    }

    pub const fn experiments(&self) -> u32 {
        self.experiments
    }

    pub const fn compute_minutes(&self) -> u64 {
        self.compute_minutes
    }

    pub const fn tokens(&self) -> u64 {
        self.tokens
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResearchPolicy {
    max_experiments: u32,
    max_compute_minutes: u64,
    max_tokens: u64,
    max_attempts_per_experiment: u32,
}

impl ResearchPolicy {
    pub fn new(
        max_experiments: u32,
        max_compute_minutes: u64,
        max_tokens: u64,
        max_attempts_per_experiment: u32,
    ) -> Result<Self, DomainError> {
        if max_experiments == 0 {
            return Err(ResearchPolicyError::ZeroExperiments.into());
        }
        if max_compute_minutes == 0 {
            return Err(ResearchPolicyError::ZeroComputeMinutes.into());
        }
        if max_tokens == 0 {
            return Err(ResearchPolicyError::ZeroTokens.into());
        }
        if max_attempts_per_experiment == 0 {
            return Err(ResearchPolicyError::ZeroAttempts.into());
        }
        Ok(Self {
            max_experiments,
            max_compute_minutes,
            max_tokens,
            max_attempts_per_experiment,
        })
    }

    pub const fn max_experiments(&self) -> u32 {
        self.max_experiments
    }

    pub const fn max_compute_minutes(&self) -> u64 {
        self.max_compute_minutes
    }

    pub const fn max_tokens(&self) -> u64 {
        self.max_tokens
    }

    pub const fn max_attempts_per_experiment(&self) -> u32 {
        self.max_attempts_per_experiment
    }

    pub fn attempt_limit(&self) -> Result<Attempt, DomainError> {
        Ok(Attempt::new(self.max_attempts_per_experiment)?)
    }

    pub fn allows_retry(&self, attempt: Attempt) -> bool {
        attempt.get() < self.max_attempts_per_experiment
    }

    pub fn check_usage(&self, usage: &Usage) -> Result<(), DomainError> {
        if usage.experiments > self.max_experiments {
            return Err(ResearchPolicyError::ExperimentsExceeded {
                max: self.max_experiments,
                used: usage.experiments,
            }
            .into());
        }
        if usage.compute_minutes > self.max_compute_minutes {
            return Err(ResearchPolicyError::ComputeMinutesExceeded {
                max: self.max_compute_minutes,
                used: usage.compute_minutes,
            }
            .into());
        }
        if usage.tokens > self.max_tokens {
            return Err(ResearchPolicyError::TokensExceeded {
                max: self.max_tokens,
                used: usage.tokens,
            }
            .into());
        }
        Ok(())
    }
}

impl Default for ResearchPolicy {
    fn default() -> Self {
        Self {
            max_experiments: 16,
            max_compute_minutes: 480,
            max_tokens: 1_000_000,
            max_attempts_per_experiment: 3,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct MetricWeight {
    name: String,
    direction: MetricDirection,
    weight: f64,
}

impl MetricWeight {
    pub fn new(
        name: impl Into<String>,
        direction: MetricDirection,
        weight: f64,
    ) -> Result<Self, DomainError> {
        let name = name.into();
        if name.trim().is_empty() {
            return Err(ProgramError::EmptyUtilityMetric.into());
        }
        if !weight.is_finite() || weight < 0.0 {
            return Err(ProgramError::InvalidWeight { name, weight }.into());
        }
        Ok(Self {
            name,
            direction,
            weight,
        })
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub const fn direction(&self) -> MetricDirection {
        self.direction
    }

    pub const fn weight(&self) -> f64 {
        self.weight
    }
}

#[derive(Debug, Clone, PartialEq, Getters)]
pub struct Program {
    #[getset(get = "pub")]
    id: ProgramId,
    #[getset(get = "pub")]
    owner: ActorId,
    name: String,
    goal: String,
    methodology: String,
    #[getset(get = "pub")]
    benchmark: BenchmarkSpec,
    utility: Vec<MetricWeight>,
    exploration: Exploration,
    policy: ResearchPolicy,
    usage: Usage,
    status: ProgramStatus,
    created_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ProgramInput {
    pub id: ProgramId,
    pub owner: ActorId,
    pub name: String,
    pub goal: String,
    pub methodology: String,
    pub benchmark: BenchmarkSpec,
    pub utility: Vec<MetricWeight>,
    pub exploration: Exploration,
    pub policy: ResearchPolicy,
    pub usage: Usage,
    pub status: ProgramStatus,
    pub created_at: Timestamp,
}

impl Program {
    pub fn new(input: ProgramInput) -> Result<Self, DomainError> {
        let name = input.name.trim().to_string();
        if name.is_empty() {
            return Err(ProgramError::EmptyName.into());
        }
        if input.utility.is_empty() {
            return Err(ProgramError::EmptyUtility.into());
        }
        let mut names = HashSet::new();
        for weight in &input.utility {
            if !names.insert(weight.name()) {
                return Err(ProgramError::DuplicateUtilityMetric {
                    name: weight.name().to_string(),
                }
                .into());
            }
        }
        Ok(Self {
            id: input.id,
            owner: input.owner,
            name,
            goal: input.goal,
            methodology: input.methodology,
            benchmark: input.benchmark,
            utility: input.utility,
            exploration: input.exploration,
            policy: input.policy,
            usage: input.usage,
            status: input.status,
            created_at: input.created_at,
        })
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn goal(&self) -> &str {
        &self.goal
    }

    pub fn methodology(&self) -> &str {
        &self.methodology
    }

    pub fn utility(&self) -> &[MetricWeight] {
        &self.utility
    }

    pub const fn exploration(&self) -> Exploration {
        self.exploration
    }

    pub const fn policy(&self) -> ResearchPolicy {
        self.policy
    }

    pub const fn usage(&self) -> Usage {
        self.usage
    }

    pub const fn status(&self) -> ProgramStatus {
        self.status
    }

    pub const fn created_at(&self) -> Timestamp {
        self.created_at
    }

    pub fn set_status(&mut self, status: ProgramStatus) {
        self.status = status;
    }

    pub fn set_goal(&mut self, goal: String) {
        self.goal = goal;
    }

    pub fn set_methodology(&mut self, methodology: String) {
        self.methodology = methodology;
    }

    pub fn set_exploration(&mut self, exploration: Exploration) {
        self.exploration = exploration;
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Getters)]
pub struct Issue {
    #[getset(get = "pub")]
    id: IssueId,
    #[getset(get = "pub")]
    program_id: ProgramId,
    title: String,
    body: String,
    labels: Vec<String>,
    #[getset(get = "pub")]
    author: ActorId,
    created_at: Timestamp,
    status: IssueStatus,
    assignee: Option<SessionId>,
    experiments: Vec<ExperimentId>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IssueInput {
    pub id: IssueId,
    pub program_id: ProgramId,
    pub title: String,
    pub body: String,
    pub labels: Vec<String>,
    pub author: ActorId,
    pub created_at: Timestamp,
}

impl Issue {
    pub fn new(input: IssueInput) -> Result<Self, DomainError> {
        if input.title.trim().is_empty() {
            return Err(IssueError::EmptyTitle.into());
        }
        Ok(Self {
            id: input.id,
            program_id: input.program_id,
            title: input.title,
            body: input.body,
            labels: input.labels,
            author: input.author,
            created_at: input.created_at,
            status: IssueStatus::Open,
            assignee: None,
            experiments: Vec::new(),
        })
    }

    pub fn title(&self) -> &str {
        &self.title
    }

    pub fn body(&self) -> &str {
        &self.body
    }

    pub fn labels(&self) -> &[String] {
        &self.labels
    }

    pub const fn created_at(&self) -> Timestamp {
        self.created_at
    }

    pub const fn status(&self) -> IssueStatus {
        self.status
    }

    pub fn assignee(&self) -> Option<&SessionId> {
        self.assignee.as_ref()
    }

    pub fn experiments(&self) -> &[ExperimentId] {
        &self.experiments
    }

    pub fn restore(
        input: IssueInput,
        status: IssueStatus,
        assignee: Option<SessionId>,
        experiments: Vec<ExperimentId>,
    ) -> Result<Self, DomainError> {
        let mut issue = Self::new(input)?;
        issue.status = status;
        issue.assignee = assignee;
        issue.experiments = experiments;
        Ok(issue)
    }

    pub fn assign(mut self, session: SessionId) -> Self {
        self.status = IssueStatus::Assigned;
        self.assignee = Some(session);
        self
    }

    pub fn close(mut self) -> Self {
        self.status = IssueStatus::Closed;
        self
    }

    pub fn add_experiment(&mut self, experiment: ExperimentId) {
        if !self.experiments.contains(&experiment) {
            self.experiments.push(experiment);
        }
    }
}

#[derive(Debug, Clone, PartialEq, Getters)]
pub struct Lineage {
    strategy: LineageStrategy,
    #[getset(get = "pub")]
    base_commit: CommitSha,
    fresh_start_probability: f64,
}

impl Lineage {
    pub fn new(
        strategy: LineageStrategy,
        base_commit: CommitSha,
        fresh_start_probability: f64,
    ) -> Result<Self, DomainError> {
        if !fresh_start_probability.is_finite() || !(0.0..=1.0).contains(&fresh_start_probability) {
            return Err(LineageError::InvalidProbability {
                value: fresh_start_probability,
            }
            .into());
        }
        Ok(Self {
            strategy,
            base_commit,
            fresh_start_probability,
        })
    }

    pub const fn strategy(&self) -> LineageStrategy {
        self.strategy
    }

    pub const fn fresh_start_probability(&self) -> f64 {
        self.fresh_start_probability
    }
}

#[derive(Debug, Clone, PartialEq, Getters)]
pub struct Experiment {
    #[getset(get = "pub")]
    id: ExperimentId,
    #[getset(get = "pub")]
    program_id: ProgramId,
    #[getset(get = "pub")]
    issue_id: IssueId,
    #[getset(get = "pub")]
    branch: BranchName,
    #[getset(get = "pub")]
    head: CommitSha,
    #[getset(get = "pub")]
    environment: Environment,
    #[getset(get = "pub")]
    lineage: Lineage,
    plan_comment_id: Option<CommentId>,
    #[getset(get = "pub")]
    created_by: ActorId,
    created_at: Timestamp,
    status: ExperimentStatus,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ExperimentInput {
    pub id: ExperimentId,
    pub program_id: ProgramId,
    pub issue_id: IssueId,
    pub branch: BranchName,
    pub head: CommitSha,
    pub environment: Environment,
    pub lineage: Lineage,
    pub plan_comment_id: Option<CommentId>,
    pub created_by: ActorId,
    pub created_at: Timestamp,
    pub status: ExperimentStatus,
}

impl Experiment {
    pub fn new(input: ExperimentInput) -> Self {
        Self {
            id: input.id,
            program_id: input.program_id,
            issue_id: input.issue_id,
            branch: input.branch,
            head: input.head,
            environment: input.environment,
            lineage: input.lineage,
            plan_comment_id: input.plan_comment_id,
            created_by: input.created_by,
            created_at: input.created_at,
            status: input.status,
        }
    }

    pub fn plan_comment_id(&self) -> Option<&CommentId> {
        self.plan_comment_id.as_ref()
    }

    pub const fn created_at(&self) -> Timestamp {
        self.created_at
    }

    pub const fn status(&self) -> ExperimentStatus {
        self.status
    }

    pub fn set_status(&mut self, status: ExperimentStatus) {
        self.status = status;
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Getters)]
pub struct TicketAssignment {
    #[getset(get = "pub")]
    branch: BranchName,
    #[getset(get = "pub")]
    base_commit: CommitSha,
}

impl TicketAssignment {
    pub fn new(branch: BranchName, base_commit: CommitSha) -> Self {
        Self {
            branch,
            base_commit,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Getters)]
pub struct Ticket {
    #[getset(get = "pub")]
    id: TicketId,
    #[getset(get = "pub")]
    experiment_id: ExperimentId,
    #[getset(get = "pub")]
    assignment: TicketAssignment,
    status: TicketStatus,
    commit: Option<CommitSha>,
    worker_session_id: Option<SessionId>,
}

impl Ticket {
    pub fn new(id: TicketId, experiment_id: ExperimentId, assignment: TicketAssignment) -> Self {
        Self {
            id,
            experiment_id,
            assignment,
            status: TicketStatus::Open,
            commit: None,
            worker_session_id: None,
        }
    }

    pub fn restore(
        id: TicketId,
        experiment_id: ExperimentId,
        assignment: TicketAssignment,
        status: TicketStatus,
        commit: Option<CommitSha>,
        worker_session_id: Option<SessionId>,
    ) -> Self {
        Self {
            id,
            experiment_id,
            assignment,
            status,
            commit,
            worker_session_id,
        }
    }

    pub const fn status(&self) -> TicketStatus {
        self.status
    }

    pub fn commit(&self) -> Option<&CommitSha> {
        self.commit.as_ref()
    }

    pub fn worker_session_id(&self) -> Option<&SessionId> {
        self.worker_session_id.as_ref()
    }

    pub fn submit(mut self, commit: CommitSha) -> Self {
        self.status = TicketStatus::Succeeded;
        self.commit = Some(commit);
        self
    }
}

#[derive(Debug, Clone, PartialEq, Getters)]
pub struct AuditEntry {
    #[getset(get = "pub")]
    id: AuditId,
    #[getset(get = "pub")]
    actor: ActorId,
    action: String,
    subject: String,
    detail: String,
    #[getset(get = "pub")]
    request_id: RequestId,
    created_at: Timestamp,
}

impl AuditEntry {
    pub fn new(
        id: AuditId,
        actor: ActorId,
        action: impl Into<String>,
        subject: impl Into<String>,
        detail: impl Into<String>,
        request_id: RequestId,
        created_at: Timestamp,
    ) -> Result<Self, DomainError> {
        let action = action.into();
        let subject = subject.into();
        if action.trim().is_empty() {
            return Err(AuditError::EmptyAction.into());
        }
        if subject.trim().is_empty() {
            return Err(AuditError::EmptySubject.into());
        }
        Ok(Self {
            id,
            actor,
            action,
            subject,
            detail: detail.into(),
            request_id,
            created_at,
        })
    }

    pub fn action(&self) -> &str {
        &self.action
    }

    pub fn subject(&self) -> &str {
        &self.subject
    }

    pub fn detail(&self) -> &str {
        &self.detail
    }

    pub const fn created_at(&self) -> Timestamp {
        self.created_at
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Getters)]
pub struct Artifact {
    #[getset(get = "pub")]
    experiment_id: ExperimentId,
    name: String,
    media_type: String,
    bytes: Vec<u8>,
}

impl Artifact {
    pub fn new(
        experiment_id: ExperimentId,
        name: impl Into<String>,
        media_type: impl Into<String>,
        bytes: Vec<u8>,
    ) -> Result<Self, DomainError> {
        let name = name.into();
        let media_type = media_type.into();
        if name.trim().is_empty() {
            return Err(ArtifactError::EmptyName.into());
        }
        if media_type.trim().is_empty() {
            return Err(ArtifactError::EmptyMediaType.into());
        }
        Ok(Self {
            experiment_id,
            name,
            media_type,
            bytes,
        })
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn media_type(&self) -> &str {
        &self.media_type
    }

    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Versioned<T> {
    value: T,
    version: crate::id::Version,
}

impl<T> Versioned<T> {
    pub fn new(value: T, version: crate::id::Version) -> Self {
        Self { value, version }
    }

    pub fn value(&self) -> &T {
        &self.value
    }

    pub fn version(&self) -> crate::id::Version {
        self.version
    }

    pub fn into_value(self) -> T {
        self.value
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn metric(name: &str) -> BenchmarkMetric {
        BenchmarkMetric::new(name, MetricDirection::Maximize, true, None).unwrap()
    }

    fn spec() -> BenchmarkSpec {
        BenchmarkSpec::new(
            BenchmarkSpecId::new("benchmark-1").unwrap(),
            "bench.py",
            60_000,
            vec![metric("score")],
            1,
            BTreeMap::new(),
            None,
        )
        .unwrap()
    }

    fn policy() -> ResearchPolicy {
        ResearchPolicy::new(10, 600, 1_000_000, 3).unwrap()
    }

    fn weight(name: &str) -> MetricWeight {
        MetricWeight::new(name, MetricDirection::Maximize, 1.0).unwrap()
    }

    fn program_input() -> ProgramInput {
        ProgramInput {
            id: ProgramId::new("program-1").unwrap(),
            owner: ActorId::new("operator-1").unwrap(),
            name: "Program".to_string(),
            goal: "goal".to_string(),
            methodology: "method".to_string(),
            benchmark: spec(),
            utility: vec![weight("score")],
            exploration: Exploration::Normal,
            policy: policy(),
            usage: Usage::ZERO,
            status: ProgramStatus::Running,
            created_at: Timestamp::UNIX_EPOCH,
        }
    }

    fn record_input() -> BenchmarkRecordInput {
        BenchmarkRecordInput {
            id: BenchmarkRunId::new("benchmark-1").unwrap(),
            experiment_id: ExperimentId::new("experiment-1").unwrap(),
            ticket_id: TicketId::new("ticket-1").unwrap(),
            commit: CommitSha::new("a".repeat(40)).unwrap(),
            spec_hash: SpecHash::default(),
            environment_digest: EnvironmentDigest::default(),
            metrics: vec![Metric::new("score", 0.75).unwrap()],
            status: BenchmarkStatus::Passed,
            attempt: Attempt::first(),
            max_attempts: Attempt::new(3).unwrap(),
            stdout: String::new(),
            stderr: String::new(),
            artifacts: Vec::new(),
            created_at: Timestamp::UNIX_EPOCH,
        }
    }

    #[test]
    fn a_valid_spec_is_accepted() {
        let spec = spec();
        assert_eq!(spec.entry(), "bench.py");
        assert_eq!(spec.metrics().len(), 1);
        assert_eq!(
            spec.metric("score").unwrap().direction(),
            MetricDirection::Maximize
        );
        assert!(spec.metric("missing").is_none());
    }

    #[test]
    fn spec_validation_rejects_incomplete_contracts() {
        let id = BenchmarkSpecId::new("benchmark-1").unwrap();
        assert!(matches!(
            BenchmarkSpec::new(
                id.clone(),
                "",
                1,
                vec![metric("s")],
                0,
                BTreeMap::new(),
                None
            ),
            Err(DomainError::Spec(BenchmarkSpecError::EmptyEntry))
        ));
        assert!(matches!(
            BenchmarkSpec::new(
                id.clone(),
                "bench.py",
                0,
                vec![metric("s")],
                0,
                BTreeMap::new(),
                None
            ),
            Err(DomainError::Spec(BenchmarkSpecError::ZeroTimeout))
        ));
        assert!(matches!(
            BenchmarkSpec::new(
                id.clone(),
                "bench.py",
                1,
                Vec::new(),
                0,
                BTreeMap::new(),
                None
            ),
            Err(DomainError::Spec(BenchmarkSpecError::NoMetrics))
        ));
        assert!(matches!(
            BenchmarkSpec::new(
                id.clone(),
                "bench.py",
                1,
                vec![metric("s"), metric("s")],
                0,
                BTreeMap::new(),
                None
            ),
            Err(DomainError::Spec(
                BenchmarkSpecError::DuplicateMetric { .. }
            ))
        ));
        assert!(matches!(
            BenchmarkSpec::new(
                id.clone(),
                "bench.py",
                1,
                vec![metric("s")],
                0,
                BTreeMap::from([("other".to_string(), 1.0)]),
                None
            ),
            Err(DomainError::Spec(
                BenchmarkSpecError::UnknownBaseline { .. }
            ))
        ));
        assert!(matches!(
            BenchmarkSpec::new(
                id.clone(),
                "bench.py",
                1,
                vec![metric("s")],
                0,
                BTreeMap::from([("s".to_string(), f64::NAN)]),
                None
            ),
            Err(DomainError::Spec(
                BenchmarkSpecError::NonFiniteBaseline { .. }
            ))
        ));
        assert!(matches!(
            BenchmarkSpec::new(
                id,
                "bench.py",
                1,
                vec![metric("s")],
                0,
                BTreeMap::new(),
                Some(" ".into())
            ),
            Err(DomainError::Spec(BenchmarkSpecError::EmptyDataset))
        ));
    }

    #[test]
    fn metrics_reject_non_finite_values_and_empty_names() {
        assert!(matches!(
            Metric::new(" ", 1.0),
            Err(DomainError::Record(BenchmarkRecordError::EmptyMetricName))
        ));
        assert!(matches!(
            Metric::new("score", f64::INFINITY),
            Err(DomainError::Record(
                BenchmarkRecordError::NonFiniteMetric { .. }
            ))
        ));
    }

    #[test]
    fn benchmark_metrics_reject_invalid_tolerances() {
        assert!(matches!(
            BenchmarkMetric::new("score", MetricDirection::Maximize, true, Some(-1.0)),
            Err(DomainError::Spec(
                BenchmarkSpecError::InvalidTolerance { .. }
            ))
        ));
        assert!(matches!(
            BenchmarkMetric::new(" ", MetricDirection::Maximize, true, None),
            Err(DomainError::Spec(BenchmarkSpecError::EmptyMetricName))
        ));
    }

    #[test]
    fn policies_reject_zero_limits() {
        assert!(matches!(
            ResearchPolicy::new(0, 1, 1, 1),
            Err(DomainError::Policy(ResearchPolicyError::ZeroExperiments))
        ));
        assert!(matches!(
            ResearchPolicy::new(1, 0, 1, 1),
            Err(DomainError::Policy(ResearchPolicyError::ZeroComputeMinutes))
        ));
        assert!(matches!(
            ResearchPolicy::new(1, 1, 0, 1),
            Err(DomainError::Policy(ResearchPolicyError::ZeroTokens))
        ));
        assert!(matches!(
            ResearchPolicy::new(1, 1, 1, 0),
            Err(DomainError::Policy(ResearchPolicyError::ZeroAttempts))
        ));
    }

    #[test]
    fn policies_bound_retries_and_usage() {
        let policy = policy();
        assert!(policy.allows_retry(Attempt::new(2).unwrap()));
        assert!(!policy.allows_retry(Attempt::new(3).unwrap()));
        assert!(policy.check_usage(&Usage::new(10, 600, 1_000_000)).is_ok());
        assert!(matches!(
            policy.check_usage(&Usage::new(11, 0, 0)),
            Err(DomainError::Policy(
                ResearchPolicyError::ExperimentsExceeded { .. }
            ))
        ));
        assert!(matches!(
            policy.check_usage(&Usage::new(0, 601, 0)),
            Err(DomainError::Policy(
                ResearchPolicyError::ComputeMinutesExceeded { .. }
            ))
        ));
        assert!(matches!(
            policy.check_usage(&Usage::new(0, 0, 1_000_001)),
            Err(DomainError::Policy(
                ResearchPolicyError::TokensExceeded { .. }
            ))
        ));
        assert_eq!(policy.attempt_limit().unwrap().get(), 3);
    }

    #[test]
    fn the_default_policy_is_bounded() {
        let policy = ResearchPolicy::default();
        assert_eq!(policy.max_experiments(), 16);
        assert_eq!(policy.max_attempts_per_experiment(), 3);
        assert!(policy.allows_retry(Attempt::first()));
    }

    #[test]
    fn programs_validate_their_identity_and_utility() {
        let program = Program::new(program_input()).unwrap();
        assert_eq!(program.name(), "Program");
        assert_eq!(program.utility().len(), 1);
        assert_eq!(program.policy(), policy());

        let mut input = program_input();
        input.name = "  ".to_string();
        assert!(matches!(
            Program::new(input),
            Err(DomainError::Program(ProgramError::EmptyName))
        ));

        let mut input = program_input();
        input.utility = Vec::new();
        assert!(matches!(
            Program::new(input),
            Err(DomainError::Program(ProgramError::EmptyUtility))
        ));

        let mut input = program_input();
        input.utility = vec![weight("score"), weight("score")];
        assert!(matches!(
            Program::new(input),
            Err(DomainError::Program(
                ProgramError::DuplicateUtilityMetric { .. }
            ))
        ));
    }

    #[test]
    fn utility_weights_are_validated() {
        assert!(matches!(
            MetricWeight::new(" ", MetricDirection::Maximize, 1.0),
            Err(DomainError::Program(ProgramError::EmptyUtilityMetric))
        ));
        assert!(matches!(
            MetricWeight::new("score", MetricDirection::Maximize, -1.0),
            Err(DomainError::Program(ProgramError::InvalidWeight { .. }))
        ));
        assert!(matches!(
            MetricWeight::new("score", MetricDirection::Maximize, f64::NAN),
            Err(DomainError::Program(ProgramError::InvalidWeight { .. }))
        ));
    }

    #[test]
    fn issues_require_a_title() {
        let input = IssueInput {
            id: IssueId::new("issue-1").unwrap(),
            program_id: ProgramId::new("program-1").unwrap(),
            title: " ".to_string(),
            body: String::new(),
            labels: Vec::new(),
            author: ActorId::new("actor-1").unwrap(),
            created_at: Timestamp::UNIX_EPOCH,
        };
        assert!(matches!(
            Issue::new(input),
            Err(DomainError::Issue(IssueError::EmptyTitle))
        ));
    }

    #[test]
    fn lineage_probability_is_bounded() {
        let base = CommitSha::zero();
        assert!(Lineage::new(LineageStrategy::Continue, base.clone(), 0.5).is_ok());
        assert!(matches!(
            Lineage::new(LineageStrategy::Continue, base.clone(), 1.5),
            Err(DomainError::Lineage(
                LineageError::InvalidProbability { .. }
            ))
        ));
        assert!(matches!(
            Lineage::new(LineageStrategy::Continue, base, f64::NAN),
            Err(DomainError::Lineage(
                LineageError::InvalidProbability { .. }
            ))
        ));
    }

    #[test]
    fn a_valid_record_is_accepted() {
        let record = BenchmarkRecord::new(record_input()).unwrap();
        assert_eq!(record.status(), BenchmarkStatus::Passed);
        assert_eq!(record.attempt(), Attempt::first());
        assert_eq!(record.metrics()[0].value(), 0.75);
        assert_eq!(record.created_at(), Timestamp::UNIX_EPOCH);
    }

    #[test]
    fn record_attempts_cannot_exceed_their_maximum() {
        let mut input = record_input();
        input.attempt = Attempt::new(4).unwrap();
        assert!(matches!(
            BenchmarkRecord::new(input),
            Err(DomainError::Record(
                BenchmarkRecordError::AttemptExceedsMaximum { .. }
            ))
        ));
    }

    #[test]
    fn records_reject_duplicate_metrics() {
        let mut input = record_input();
        input.metrics = vec![
            Metric::new("score", 1.0).unwrap(),
            Metric::new("score", 2.0).unwrap(),
        ];
        assert!(matches!(
            BenchmarkRecord::new(input),
            Err(DomainError::Record(
                BenchmarkRecordError::DuplicateMetric { .. }
            ))
        ));
    }

    #[test]
    fn records_verify_their_source() {
        let record = BenchmarkRecord::new(record_input()).unwrap();
        assert!(
            record
                .verify_source(
                    &ExperimentId::new("experiment-1").unwrap(),
                    &TicketId::new("ticket-1").unwrap(),
                    &CommitSha::new("a".repeat(40)).unwrap()
                )
                .is_ok()
        );
        assert!(matches!(
            record.verify_source(
                &ExperimentId::new("experiment-2").unwrap(),
                &TicketId::new("ticket-1").unwrap(),
                &CommitSha::new("a".repeat(40)).unwrap()
            ),
            Err(DomainError::Record(
                BenchmarkRecordError::ExperimentMismatch { .. }
            ))
        ));
        assert!(matches!(
            record.verify_source(
                &ExperimentId::new("experiment-1").unwrap(),
                &TicketId::new("ticket-2").unwrap(),
                &CommitSha::new("a".repeat(40)).unwrap()
            ),
            Err(DomainError::Record(
                BenchmarkRecordError::TicketMismatch { .. }
            ))
        ));
        assert!(matches!(
            record.verify_source(
                &ExperimentId::new("experiment-1").unwrap(),
                &TicketId::new("ticket-1").unwrap(),
                &CommitSha::new("b".repeat(40)).unwrap()
            ),
            Err(DomainError::Record(BenchmarkRecordError::CommitMismatch))
        ));
    }

    #[test]
    fn records_verify_the_program_contract() {
        let record = BenchmarkRecord::new(record_input()).unwrap();
        let spec = spec();
        assert!(
            record
                .verify_contract(
                    &spec,
                    &SpecHash::default(),
                    &EnvironmentDigest::default(),
                    Attempt::first(),
                    Attempt::new(3).unwrap()
                )
                .is_ok()
        );
        assert!(matches!(
            record.verify_contract(
                &spec,
                &SpecHash::new("f".repeat(64)).unwrap(),
                &EnvironmentDigest::default(),
                Attempt::first(),
                Attempt::new(3).unwrap()
            ),
            Err(DomainError::Record(BenchmarkRecordError::SpecHashMismatch))
        ));
        assert!(matches!(
            record.verify_contract(
                &spec,
                &SpecHash::default(),
                &EnvironmentDigest::new("e".repeat(64)).unwrap(),
                Attempt::first(),
                Attempt::new(3).unwrap()
            ),
            Err(DomainError::Record(
                BenchmarkRecordError::EnvironmentDigestMismatch
            ))
        ));
        assert!(matches!(
            record.verify_contract(
                &spec,
                &SpecHash::default(),
                &EnvironmentDigest::default(),
                Attempt::new(2).unwrap(),
                Attempt::new(3).unwrap()
            ),
            Err(DomainError::Record(
                BenchmarkRecordError::AttemptMismatch { .. }
            ))
        ));
        assert!(matches!(
            record.verify_contract(
                &spec,
                &SpecHash::default(),
                &EnvironmentDigest::default(),
                Attempt::first(),
                Attempt::new(2).unwrap()
            ),
            Err(DomainError::Record(
                BenchmarkRecordError::MaxAttemptsMismatch { .. }
            ))
        ));
    }

    #[test]
    fn records_verify_required_and_declared_metrics() {
        let mut input = record_input();
        input.metrics = vec![Metric::new("other", 1.0).unwrap()];
        let record = BenchmarkRecord::new(input).unwrap();
        assert!(matches!(
            record.verify_contract(
                &spec(),
                &SpecHash::default(),
                &EnvironmentDigest::default(),
                Attempt::first(),
                Attempt::new(3).unwrap()
            ),
            Err(DomainError::Record(
                BenchmarkRecordError::UnknownMetric { .. }
            ))
        ));

        let mut input = record_input();
        input.metrics = Vec::new();
        let record = BenchmarkRecord::new(input).unwrap();
        assert!(matches!(
            record.verify_contract(
                &spec(),
                &SpecHash::default(),
                &EnvironmentDigest::default(),
                Attempt::first(),
                Attempt::new(3).unwrap()
            ),
            Err(DomainError::Record(
                BenchmarkRecordError::MissingMetric { .. }
            ))
        ));
    }

    #[test]
    fn audit_entries_require_action_and_subject() {
        let id = AuditId::new("audit-1").unwrap();
        let actor = ActorId::new("actor-1").unwrap();
        let request = RequestId::new("request-1").unwrap();
        assert!(matches!(
            AuditEntry::new(
                id.clone(),
                actor.clone(),
                " ",
                "subject",
                "",
                request.clone(),
                Timestamp::UNIX_EPOCH
            ),
            Err(DomainError::Audit(AuditError::EmptyAction))
        ));
        assert!(matches!(
            AuditEntry::new(
                id.clone(),
                actor.clone(),
                "action",
                " ",
                "",
                request.clone(),
                Timestamp::UNIX_EPOCH
            ),
            Err(DomainError::Audit(AuditError::EmptySubject))
        ));
        assert!(
            AuditEntry::new(
                id,
                actor,
                "action",
                "subject",
                "",
                request,
                Timestamp::UNIX_EPOCH
            )
            .is_ok()
        );
    }

    #[test]
    fn artifacts_require_a_name_and_media_type() {
        let experiment = ExperimentId::new("experiment-1").unwrap();
        assert!(matches!(
            Artifact::new(experiment.clone(), " ", "text/plain", Vec::new()),
            Err(DomainError::Artifact(ArtifactError::EmptyName))
        ));
        assert!(matches!(
            Artifact::new(experiment.clone(), "stdout", " ", Vec::new()),
            Err(DomainError::Artifact(ArtifactError::EmptyMediaType))
        ));
        let artifact = Artifact::new(experiment, "stdout", "text/plain", b"ok".to_vec()).unwrap();
        assert_eq!(artifact.bytes(), b"ok");
    }

    #[test]
    fn environment_kinds_are_reported() {
        let file = EnvironmentFile::new("requirements.txt").unwrap();
        let environment = Environment::requirements(file);
        assert_eq!(environment.kind(), EnvironmentKind::Requirements);
        assert_eq!(environment.file().as_str(), "requirements.txt");
        let file = EnvironmentFile::new("uv.lock").unwrap();
        assert_eq!(Environment::uv_lock(file).kind(), EnvironmentKind::UvLock);
    }

    #[test]
    fn decisions_and_outcomes_render_stable_names() {
        assert_eq!(ResearcherDecision::Propose.as_str(), "propose");
        assert_eq!(
            ResearcherDecision::Stop(StopReason::GoalMet).stop_reason(),
            Some(StopReason::GoalMet)
        );
        assert_eq!(ResearcherDecision::Revise.stop_reason(), None);
        assert_eq!(ResearchOutcome::Cancelled.to_string(), "cancelled");
        assert_eq!(StopReason::PolicyExhausted.as_str(), "policy-exhausted");
    }
}
