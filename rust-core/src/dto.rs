use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
#[cfg(not(target_arch = "wasm32"))]
use ts_rs::TS;

use crate::command::{
    Actor, ActorRole, ClaimIssueCommand, CloseExperimentCommand, CloseIssueCommand, CommandDraft,
    CommandErrorKind, CommandName, CommandOutcome, CommentIssueCommand, CreateIssueCommand,
    CreateProgramCommand, PauseProgramCommand, ProposeExperimentCommand, RequestBenchmarkCommand,
    ResumeProgramCommand, ReviewExperimentCommand, SetProgramExplorationCommand,
    SetProgramGoalCommand, SetProgramMethodologyCommand, StopProgramCommand, SubmitTicketCommand,
};
use crate::domain::{
    AuditEntry, BenchmarkMetric, BenchmarkRecord, BenchmarkRecordInput, BenchmarkSpec,
    BenchmarkStatus, Environment, EnvironmentKind, Experiment, ExperimentInput, ExperimentStatus,
    Exploration, Issue, IssueInput, IssueStatus, Lineage, LineageStrategy, Metric, MetricDirection,
    MetricWeight, Program, ProgramInput, ProgramStatus, ResearchOutcome, ResearchPolicy,
    ResearcherDecision, StopReason, Ticket, TicketAssignment, TicketStatus, Usage, Versioned,
};
use crate::id::{
    ActorId, ArtifactId, Attempt, AuditId, BenchmarkRunId, BenchmarkSpecId, BranchName, CommentId,
    CommitSha, EnvironmentDigest, EnvironmentFile, ExperimentId, IssueId, ProgramId, RequestId,
    SessionId, SpecHash, TicketId, Version,
};
use crate::stage::StageName;
use crate::time::Timestamp;

type Conversion<T> = Result<T, String>;

fn parse_environment(value: String) -> Conversion<EnvironmentFile> {
    EnvironmentFile::new(value).map_err(|error| error.to_string())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(TS))]
#[serde(try_from = "String", into = "String")]
#[cfg_attr(not(target_arch = "wasm32"), ts(as = "String"))]
pub struct DecimalU64(u64);

impl DecimalU64 {
    pub const fn new(value: u64) -> Self {
        Self(value)
    }

    pub const fn get(self) -> u64 {
        self.0
    }
}

impl TryFrom<String> for DecimalU64 {
    type Error = String;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        value
            .parse::<u64>()
            .map(Self)
            .map_err(|_| format!("invalid decimal u64: {value}"))
    }
}

impl From<DecimalU64> for String {
    fn from(value: DecimalU64) -> Self {
        value.0.to_string()
    }
}

impl From<Version> for DecimalU64 {
    fn from(value: Version) -> Self {
        Self(value.get())
    }
}

impl From<u64> for DecimalU64 {
    fn from(value: u64) -> Self {
        Self(value)
    }
}

impl std::fmt::Display for DecimalU64 {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(formatter)
    }
}

#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(TS))]
pub struct CoreVersioned<T> {
    pub value: T,
    pub version: DecimalU64,
}

impl<T> CoreVersioned<T> {
    pub fn into_domain(self) -> Conversion<Versioned<T>> {
        let version = Version::new(self.version.get()).map_err(|error| error.to_string())?;
        Ok(Versioned::new(self.value, version))
    }
}

impl<T> From<&Versioned<T>> for CoreVersioned<T>
where
    T: Clone,
{
    fn from(value: &Versioned<T>) -> Self {
        Self {
            value: value.value().clone(),
            version: DecimalU64::new(value.version().get()),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(TS))]
#[serde(rename_all = "kebab-case")]
pub enum CoreEnvironmentKind {
    Requirements,
    UvLock,
}

impl From<EnvironmentKind> for CoreEnvironmentKind {
    fn from(value: EnvironmentKind) -> Self {
        match value {
            EnvironmentKind::Requirements => Self::Requirements,
            EnvironmentKind::UvLock => Self::UvLock,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct CoreEnvironmentDeclaration {
    pub kind: CoreEnvironmentKind,
    pub file: String,
}

impl From<&Environment> for CoreEnvironmentDeclaration {
    fn from(value: &Environment) -> Self {
        Self {
            kind: value.kind().into(),
            file: value.file().as_str().to_string(),
        }
    }
}

impl CoreEnvironmentDeclaration {
    pub fn into_domain(self) -> Conversion<Environment> {
        let file = parse_environment(self.file)?;
        Ok(match self.kind {
            CoreEnvironmentKind::Requirements => Environment::requirements(file),
            CoreEnvironmentKind::UvLock => Environment::uv_lock(file),
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(TS))]
#[serde(rename_all = "kebab-case")]
pub enum CoreMetricDirection {
    Maximize,
    Minimize,
}

impl From<MetricDirection> for CoreMetricDirection {
    fn from(value: MetricDirection) -> Self {
        match value {
            MetricDirection::Maximize => Self::Maximize,
            MetricDirection::Minimize => Self::Minimize,
        }
    }
}

impl From<CoreMetricDirection> for MetricDirection {
    fn from(value: CoreMetricDirection) -> Self {
        match value {
            CoreMetricDirection::Maximize => Self::Maximize,
            CoreMetricDirection::Minimize => Self::Minimize,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(TS))]
#[serde(rename_all = "kebab-case")]
pub enum CoreExploration {
    Low,
    Normal,
    High,
}

impl From<Exploration> for CoreExploration {
    fn from(value: Exploration) -> Self {
        match value {
            Exploration::Low => Self::Low,
            Exploration::Normal => Self::Normal,
            Exploration::High => Self::High,
        }
    }
}

impl From<CoreExploration> for Exploration {
    fn from(value: CoreExploration) -> Self {
        match value {
            CoreExploration::Low => Self::Low,
            CoreExploration::Normal => Self::Normal,
            CoreExploration::High => Self::High,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(TS))]
#[serde(rename_all = "kebab-case")]
pub enum CoreProgramStatus {
    Running,
    Paused,
    Stopped,
}

impl From<ProgramStatus> for CoreProgramStatus {
    fn from(value: ProgramStatus) -> Self {
        match value {
            ProgramStatus::Running => Self::Running,
            ProgramStatus::Paused => Self::Paused,
            ProgramStatus::Stopped => Self::Stopped,
        }
    }
}

impl From<CoreProgramStatus> for ProgramStatus {
    fn from(value: CoreProgramStatus) -> Self {
        match value {
            CoreProgramStatus::Running => Self::Running,
            CoreProgramStatus::Paused => Self::Paused,
            CoreProgramStatus::Stopped => Self::Stopped,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(TS))]
#[serde(rename_all = "kebab-case")]
pub enum CoreIssueStatus {
    Open,
    Assigned,
    Closed,
}

impl From<IssueStatus> for CoreIssueStatus {
    fn from(value: IssueStatus) -> Self {
        match value {
            IssueStatus::Open => Self::Open,
            IssueStatus::Assigned => Self::Assigned,
            IssueStatus::Closed => Self::Closed,
        }
    }
}

impl From<CoreIssueStatus> for IssueStatus {
    fn from(value: CoreIssueStatus) -> Self {
        match value {
            CoreIssueStatus::Open => Self::Open,
            CoreIssueStatus::Assigned => Self::Assigned,
            CoreIssueStatus::Closed => Self::Closed,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(TS))]
#[serde(rename_all = "kebab-case")]
pub enum CoreExperimentStatus {
    Open,
    Concluded,
    Failed,
    Cancelled,
}

impl From<ExperimentStatus> for CoreExperimentStatus {
    fn from(value: ExperimentStatus) -> Self {
        match value {
            ExperimentStatus::Open => Self::Open,
            ExperimentStatus::Concluded => Self::Concluded,
            ExperimentStatus::Failed => Self::Failed,
            ExperimentStatus::Cancelled => Self::Cancelled,
        }
    }
}

impl From<CoreExperimentStatus> for ExperimentStatus {
    fn from(value: CoreExperimentStatus) -> Self {
        match value {
            CoreExperimentStatus::Open => Self::Open,
            CoreExperimentStatus::Concluded => Self::Concluded,
            CoreExperimentStatus::Failed => Self::Failed,
            CoreExperimentStatus::Cancelled => Self::Cancelled,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(TS))]
#[serde(rename_all = "kebab-case")]
pub enum CoreTicketStatus {
    Open,
    Running,
    Succeeded,
    Failed,
    Abandoned,
}

impl From<TicketStatus> for CoreTicketStatus {
    fn from(value: TicketStatus) -> Self {
        match value {
            TicketStatus::Open => Self::Open,
            TicketStatus::Running => Self::Running,
            TicketStatus::Succeeded => Self::Succeeded,
            TicketStatus::Failed => Self::Failed,
            TicketStatus::Abandoned => Self::Abandoned,
        }
    }
}

impl From<CoreTicketStatus> for TicketStatus {
    fn from(value: CoreTicketStatus) -> Self {
        match value {
            CoreTicketStatus::Open => Self::Open,
            CoreTicketStatus::Running => Self::Running,
            CoreTicketStatus::Succeeded => Self::Succeeded,
            CoreTicketStatus::Failed => Self::Failed,
            CoreTicketStatus::Abandoned => Self::Abandoned,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(TS))]
#[serde(rename_all = "kebab-case")]
pub enum CoreBenchmarkStatus {
    Passed,
    Failed,
    Retryable,
}

impl From<BenchmarkStatus> for CoreBenchmarkStatus {
    fn from(value: BenchmarkStatus) -> Self {
        match value {
            BenchmarkStatus::Passed => Self::Passed,
            BenchmarkStatus::Failed => Self::Failed,
            BenchmarkStatus::Retryable => Self::Retryable,
        }
    }
}

impl From<CoreBenchmarkStatus> for BenchmarkStatus {
    fn from(value: CoreBenchmarkStatus) -> Self {
        match value {
            CoreBenchmarkStatus::Passed => Self::Passed,
            CoreBenchmarkStatus::Failed => Self::Failed,
            CoreBenchmarkStatus::Retryable => Self::Retryable,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(TS))]
#[serde(rename_all = "kebab-case")]
pub enum CoreLineageStrategy {
    Continue,
    Branch,
    Fresh,
}

impl From<LineageStrategy> for CoreLineageStrategy {
    fn from(value: LineageStrategy) -> Self {
        match value {
            LineageStrategy::Continue => Self::Continue,
            LineageStrategy::Branch => Self::Branch,
            LineageStrategy::Fresh => Self::Fresh,
        }
    }
}

impl From<CoreLineageStrategy> for LineageStrategy {
    fn from(value: CoreLineageStrategy) -> Self {
        match value {
            CoreLineageStrategy::Continue => Self::Continue,
            CoreLineageStrategy::Branch => Self::Branch,
            CoreLineageStrategy::Fresh => Self::Fresh,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(TS))]
#[serde(rename_all = "kebab-case")]
pub enum CoreStopReason {
    GoalMet,
    PolicyExhausted,
    NoHypothesis,
    Cancelled,
}

impl From<StopReason> for CoreStopReason {
    fn from(value: StopReason) -> Self {
        match value {
            StopReason::GoalMet => Self::GoalMet,
            StopReason::PolicyExhausted => Self::PolicyExhausted,
            StopReason::NoHypothesis => Self::NoHypothesis,
            StopReason::Cancelled => Self::Cancelled,
        }
    }
}

impl From<CoreStopReason> for StopReason {
    fn from(value: CoreStopReason) -> Self {
        match value {
            CoreStopReason::GoalMet => Self::GoalMet,
            CoreStopReason::PolicyExhausted => Self::PolicyExhausted,
            CoreStopReason::NoHypothesis => Self::NoHypothesis,
            CoreStopReason::Cancelled => Self::Cancelled,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(TS))]
#[serde(rename_all = "kebab-case")]
pub enum CoreResearchOutcome {
    Concluded,
    Failed,
    Cancelled,
}

impl From<ResearchOutcome> for CoreResearchOutcome {
    fn from(value: ResearchOutcome) -> Self {
        match value {
            ResearchOutcome::Concluded => Self::Concluded,
            ResearchOutcome::Failed => Self::Failed,
            ResearchOutcome::Cancelled => Self::Cancelled,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(TS))]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum CoreResearcherDecision {
    Propose,
    Revise,
    Stop { reason: CoreStopReason },
}

impl From<ResearcherDecision> for CoreResearcherDecision {
    fn from(value: ResearcherDecision) -> Self {
        match value {
            ResearcherDecision::Propose => Self::Propose,
            ResearcherDecision::Revise => Self::Revise,
            ResearcherDecision::Stop(reason) => Self::Stop {
                reason: reason.into(),
            },
        }
    }
}

impl From<CoreResearcherDecision> for ResearcherDecision {
    fn from(value: CoreResearcherDecision) -> Self {
        match value {
            CoreResearcherDecision::Propose => Self::Propose,
            CoreResearcherDecision::Revise => Self::Revise,
            CoreResearcherDecision::Stop { reason } => Self::Stop(reason.into()),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(TS))]
pub enum CoreStageName {
    IssueAssigned,
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
}

impl From<StageName> for CoreStageName {
    fn from(value: StageName) -> Self {
        match value {
            StageName::IssueAssigned => Self::IssueAssigned,
            StageName::ExperimentProposed => Self::ExperimentProposed,
            StageName::TriggerAccepted => Self::TriggerAccepted,
            StageName::TicketOpened => Self::TicketOpened,
            StageName::WorkerStarted => Self::WorkerStarted,
            StageName::CommitSubmitted => Self::CommitSubmitted,
            StageName::EnvironmentBuilt => Self::EnvironmentBuilt,
            StageName::BenchmarkPassed => Self::BenchmarkPassed,
            StageName::BenchmarkFailed => Self::BenchmarkFailed,
            StageName::BenchmarkRetryable => Self::BenchmarkRetryable,
            StageName::ResultRecorded => Self::ResultRecorded,
            StageName::ReviewRecorded => Self::ReviewRecorded,
            StageName::ResearchCompleted => Self::ResearchCompleted,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(TS))]
#[serde(rename_all = "kebab-case")]
pub enum CoreActorRole {
    Operator,
    Researcher,
    Implementer,
}

impl From<ActorRole> for CoreActorRole {
    fn from(value: ActorRole) -> Self {
        match value {
            ActorRole::Operator => Self::Operator,
            ActorRole::Researcher => Self::Researcher,
            ActorRole::Implementer => Self::Implementer,
        }
    }
}

impl From<CoreActorRole> for ActorRole {
    fn from(value: CoreActorRole) -> Self {
        match value {
            CoreActorRole::Operator => Self::Operator,
            CoreActorRole::Researcher => Self::Researcher,
            CoreActorRole::Implementer => Self::Implementer,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct CoreActor {
    pub id: String,
    pub role: CoreActorRole,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(not(target_arch = "wasm32"), ts(optional))]
    pub session_id: Option<String>,
}

impl From<&Actor> for CoreActor {
    fn from(value: &Actor) -> Self {
        Self {
            id: value.id().as_str().to_string(),
            role: value.role().into(),
            session_id: value.session().map(|session| session.as_str().to_string()),
        }
    }
}

impl CoreActor {
    pub fn into_domain(self) -> Conversion<Actor> {
        let id = ActorId::new(self.id).map_err(|error| error.to_string())?;
        let session = self
            .session_id
            .map(|value| SessionId::new(value).map_err(|error| error.to_string()))
            .transpose()?;
        Ok(Actor::new(id, self.role.into(), session))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct CoreBenchmarkMetric {
    pub name: String,
    pub direction: CoreMetricDirection,
    pub required: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(not(target_arch = "wasm32"), ts(optional))]
    pub tolerance: Option<f64>,
}

impl From<&BenchmarkMetric> for CoreBenchmarkMetric {
    fn from(value: &BenchmarkMetric) -> Self {
        Self {
            name: value.name().to_string(),
            direction: value.direction().into(),
            required: value.required(),
            tolerance: value.tolerance(),
        }
    }
}

impl CoreBenchmarkMetric {
    fn into_domain(self) -> Conversion<BenchmarkMetric> {
        BenchmarkMetric::new(
            self.name,
            self.direction.into(),
            self.required,
            self.tolerance,
        )
        .map_err(|error| error.to_string())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct CoreBenchmarkSpec {
    pub id: String,
    pub entry: String,
    pub timeout_ms: DecimalU64,
    pub metrics: Vec<CoreBenchmarkMetric>,
    pub max_retries: u32,
    pub baseline: BTreeMap<String, f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(not(target_arch = "wasm32"), ts(optional))]
    pub dataset: Option<String>,
}

impl From<&BenchmarkSpec> for CoreBenchmarkSpec {
    fn from(value: &BenchmarkSpec) -> Self {
        Self {
            id: value.id().as_str().to_string(),
            entry: value.entry().to_string(),
            timeout_ms: DecimalU64::new(value.timeout_ms()),
            metrics: value.metrics().iter().map(Into::into).collect(),
            max_retries: value.max_retries(),
            baseline: value.baseline().clone(),
            dataset: value.dataset().map(ToString::to_string),
        }
    }
}

impl CoreBenchmarkSpec {
    pub fn into_domain(self) -> Conversion<BenchmarkSpec> {
        let id = BenchmarkSpecId::new(self.id).map_err(|error| error.to_string())?;
        let metrics = self
            .metrics
            .into_iter()
            .map(CoreBenchmarkMetric::into_domain)
            .collect::<Conversion<Vec<_>>>()?;
        BenchmarkSpec::new(
            id,
            self.entry,
            self.timeout_ms.get(),
            metrics,
            self.max_retries,
            self.baseline,
            self.dataset,
        )
        .map_err(|error| error.to_string())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct CoreMetric {
    pub name: String,
    pub value: f64,
}

impl From<&Metric> for CoreMetric {
    fn from(value: &Metric) -> Self {
        Self {
            name: value.name().to_string(),
            value: value.value(),
        }
    }
}

impl CoreMetric {
    fn into_domain(self) -> Conversion<Metric> {
        Metric::new(self.name, self.value).map_err(|error| error.to_string())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct CoreMetricWeight {
    pub name: String,
    pub direction: CoreMetricDirection,
    pub weight: f64,
}

impl From<&MetricWeight> for CoreMetricWeight {
    fn from(value: &MetricWeight) -> Self {
        Self {
            name: value.name().to_string(),
            direction: value.direction().into(),
            weight: value.weight(),
        }
    }
}

impl CoreMetricWeight {
    fn into_domain(self) -> Conversion<MetricWeight> {
        MetricWeight::new(self.name, self.direction.into(), self.weight)
            .map_err(|error| error.to_string())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct CoreUsage {
    pub experiments: u32,
    pub compute_minutes: DecimalU64,
    pub tokens: DecimalU64,
}

impl From<Usage> for CoreUsage {
    fn from(value: Usage) -> Self {
        Self {
            experiments: value.experiments(),
            compute_minutes: DecimalU64::new(value.compute_minutes()),
            tokens: DecimalU64::new(value.tokens()),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct CoreResearchPolicy {
    pub max_experiments: u32,
    pub max_compute_minutes: DecimalU64,
    pub max_tokens: DecimalU64,
    pub max_attempts_per_experiment: u32,
}

impl From<ResearchPolicy> for CoreResearchPolicy {
    fn from(value: ResearchPolicy) -> Self {
        Self {
            max_experiments: value.max_experiments(),
            max_compute_minutes: DecimalU64::new(value.max_compute_minutes()),
            max_tokens: DecimalU64::new(value.max_tokens()),
            max_attempts_per_experiment: value.max_attempts_per_experiment(),
        }
    }
}

impl CoreResearchPolicy {
    fn into_domain(self) -> Conversion<ResearchPolicy> {
        ResearchPolicy::new(
            self.max_experiments,
            self.max_compute_minutes.get(),
            self.max_tokens.get(),
            self.max_attempts_per_experiment,
        )
        .map_err(|error| error.to_string())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct CoreProgram {
    pub id: String,
    pub owner: String,
    pub name: String,
    pub goal: String,
    pub methodology: String,
    pub benchmark: CoreBenchmarkSpec,
    pub utility: Vec<CoreMetricWeight>,
    pub exploration: CoreExploration,
    pub policy: CoreResearchPolicy,
    pub usage: CoreUsage,
    pub status: CoreProgramStatus,
    pub created_at: String,
}

impl From<&Program> for CoreProgram {
    fn from(value: &Program) -> Self {
        Self {
            id: value.id().as_str().to_string(),
            owner: value.owner().as_str().to_string(),
            name: value.name().to_string(),
            goal: value.goal().to_string(),
            methodology: value.methodology().to_string(),
            benchmark: value.benchmark().into(),
            utility: value.utility().iter().map(Into::into).collect(),
            exploration: value.exploration().into(),
            policy: value.policy().into(),
            usage: value.usage().into(),
            status: value.status().into(),
            created_at: value.created_at().to_string(),
        }
    }
}

impl CoreProgram {
    pub fn into_domain(self) -> Conversion<Program> {
        let id = ProgramId::new(self.id).map_err(|error| error.to_string())?;
        let owner = ActorId::new(self.owner).map_err(|error| error.to_string())?;
        let benchmark = self.benchmark.into_domain()?;
        let utility = self
            .utility
            .into_iter()
            .map(CoreMetricWeight::into_domain)
            .collect::<Conversion<Vec<_>>>()?;
        let policy = self.policy.into_domain()?;
        let created_at = Timestamp::parse(&self.created_at).map_err(|error| error.to_string())?;
        Program::new(ProgramInput {
            id,
            owner,
            name: self.name,
            goal: self.goal,
            methodology: self.methodology,
            benchmark,
            utility,
            exploration: self.exploration.into(),
            policy,
            usage: Usage::new(
                self.usage.experiments,
                self.usage.compute_minutes.get(),
                self.usage.tokens.get(),
            ),
            status: self.status.into(),
            created_at,
        })
        .map_err(|error| error.to_string())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct CoreLineage {
    pub strategy: CoreLineageStrategy,
    pub base_commit: String,
    pub fresh_start_probability: f64,
}

impl From<&Lineage> for CoreLineage {
    fn from(value: &Lineage) -> Self {
        Self {
            strategy: value.strategy().into(),
            base_commit: value.base_commit().as_str().to_string(),
            fresh_start_probability: value.fresh_start_probability(),
        }
    }
}

impl CoreLineage {
    fn into_domain(self) -> Conversion<Lineage> {
        let base_commit = CommitSha::new(self.base_commit).map_err(|error| error.to_string())?;
        Lineage::new(
            self.strategy.into(),
            base_commit,
            self.fresh_start_probability,
        )
        .map_err(|error| error.to_string())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct CoreExperiment {
    pub id: String,
    pub program_id: String,
    pub issue_id: String,
    pub branch: String,
    pub head: String,
    pub environment: CoreEnvironmentDeclaration,
    pub lineage: CoreLineage,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(not(target_arch = "wasm32"), ts(optional))]
    pub plan_comment_id: Option<String>,
    pub created_by: String,
    pub created_at: String,
    pub status: CoreExperimentStatus,
}

impl From<&Experiment> for CoreExperiment {
    fn from(value: &Experiment) -> Self {
        Self {
            id: value.id().as_str().to_string(),
            program_id: value.program_id().as_str().to_string(),
            issue_id: value.issue_id().as_str().to_string(),
            branch: value.branch().as_str().to_string(),
            head: value.head().as_str().to_string(),
            environment: value.environment().into(),
            lineage: value.lineage().into(),
            plan_comment_id: value
                .plan_comment_id()
                .map(|comment| comment.as_str().to_string()),
            created_by: value.created_by().as_str().to_string(),
            created_at: value.created_at().to_string(),
            status: value.status().into(),
        }
    }
}

impl CoreExperiment {
    pub fn into_domain(self) -> Conversion<Experiment> {
        let id = ExperimentId::new(self.id).map_err(|error| error.to_string())?;
        let program_id = ProgramId::new(self.program_id).map_err(|error| error.to_string())?;
        let issue_id = IssueId::new(self.issue_id).map_err(|error| error.to_string())?;
        let branch = BranchName::new(self.branch).map_err(|error| error.to_string())?;
        let head = CommitSha::new(self.head).map_err(|error| error.to_string())?;
        let environment = self.environment.into_domain()?;
        let lineage = self.lineage.into_domain()?;
        let plan_comment_id = self
            .plan_comment_id
            .map(|value| CommentId::new(value).map_err(|error| error.to_string()))
            .transpose()?;
        let created_by = ActorId::new(self.created_by).map_err(|error| error.to_string())?;
        let created_at = Timestamp::parse(&self.created_at).map_err(|error| error.to_string())?;
        Ok(Experiment::new(ExperimentInput {
            id,
            program_id,
            issue_id,
            branch,
            head,
            environment,
            lineage,
            plan_comment_id,
            created_by,
            created_at,
            status: self.status.into(),
        }))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct CoreIssue {
    pub id: String,
    pub program_id: String,
    pub title: String,
    pub body: String,
    pub labels: Vec<String>,
    pub author: String,
    pub created_at: String,
    pub status: CoreIssueStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(not(target_arch = "wasm32"), ts(optional))]
    pub assignee: Option<String>,
    pub experiments: Vec<String>,
}

impl From<&Issue> for CoreIssue {
    fn from(value: &Issue) -> Self {
        Self {
            id: value.id().as_str().to_string(),
            program_id: value.program_id().as_str().to_string(),
            title: value.title().to_string(),
            body: value.body().to_string(),
            labels: value.labels().to_vec(),
            author: value.author().as_str().to_string(),
            created_at: value.created_at().to_string(),
            status: value.status().into(),
            assignee: value.assignee().map(|session| session.as_str().to_string()),
            experiments: value
                .experiments()
                .iter()
                .map(|experiment| experiment.as_str().to_string())
                .collect(),
        }
    }
}

impl CoreIssue {
    pub fn into_domain(self) -> Conversion<Issue> {
        let id = IssueId::new(self.id).map_err(|error| error.to_string())?;
        let program_id = ProgramId::new(self.program_id).map_err(|error| error.to_string())?;
        let author = ActorId::new(self.author).map_err(|error| error.to_string())?;
        let created_at = Timestamp::parse(&self.created_at).map_err(|error| error.to_string())?;
        let assignee = self
            .assignee
            .map(|value| SessionId::new(value).map_err(|error| error.to_string()))
            .transpose()?;
        let experiments = self
            .experiments
            .into_iter()
            .map(|value| ExperimentId::new(value).map_err(|error| error.to_string()))
            .collect::<Conversion<Vec<_>>>()?;
        Issue::restore(
            IssueInput {
                id,
                program_id,
                title: self.title,
                body: self.body,
                labels: self.labels,
                author,
                created_at,
            },
            self.status.into(),
            assignee,
            experiments,
        )
        .map_err(|error| error.to_string())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct CoreTicket {
    pub id: String,
    pub experiment_id: String,
    pub branch: String,
    pub base_commit: String,
    pub status: CoreTicketStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(not(target_arch = "wasm32"), ts(optional))]
    pub commit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(not(target_arch = "wasm32"), ts(optional))]
    pub worker_session_id: Option<String>,
}

impl From<&Ticket> for CoreTicket {
    fn from(value: &Ticket) -> Self {
        Self {
            id: value.id().as_str().to_string(),
            experiment_id: value.experiment_id().as_str().to_string(),
            branch: value.assignment().branch().as_str().to_string(),
            base_commit: value.assignment().base_commit().as_str().to_string(),
            status: value.status().into(),
            commit: value.commit().map(|commit| commit.as_str().to_string()),
            worker_session_id: value
                .worker_session_id()
                .map(|session| session.as_str().to_string()),
        }
    }
}

impl CoreTicket {
    pub fn into_domain(self) -> Conversion<Ticket> {
        let id = TicketId::new(self.id).map_err(|error| error.to_string())?;
        let experiment_id =
            ExperimentId::new(self.experiment_id).map_err(|error| error.to_string())?;
        let branch = BranchName::new(self.branch).map_err(|error| error.to_string())?;
        let base_commit = CommitSha::new(self.base_commit).map_err(|error| error.to_string())?;
        let commit = self
            .commit
            .map(|value| CommitSha::new(value).map_err(|error| error.to_string()))
            .transpose()?;
        let worker_session_id = self
            .worker_session_id
            .map(|value| SessionId::new(value).map_err(|error| error.to_string()))
            .transpose()?;
        Ok(Ticket::restore(
            id,
            experiment_id,
            TicketAssignment::new(branch, base_commit),
            self.status.into(),
            commit,
            worker_session_id,
        ))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct CoreAuditEntry {
    pub id: String,
    pub actor: String,
    pub action: String,
    pub subject: String,
    pub detail: String,
    pub request_id: String,
    pub created_at: String,
}

impl From<&AuditEntry> for CoreAuditEntry {
    fn from(value: &AuditEntry) -> Self {
        Self {
            id: value.id().as_str().to_string(),
            actor: value.actor().as_str().to_string(),
            action: value.action().to_string(),
            subject: value.subject().to_string(),
            detail: value.detail().to_string(),
            request_id: value.request_id().as_str().to_string(),
            created_at: value.created_at().to_string(),
        }
    }
}

impl CoreAuditEntry {
    pub fn into_domain(self) -> Conversion<AuditEntry> {
        let id = AuditId::new(self.id).map_err(|error| error.to_string())?;
        let actor = ActorId::new(self.actor).map_err(|error| error.to_string())?;
        let request_id = RequestId::new(self.request_id).map_err(|error| error.to_string())?;
        let created_at = Timestamp::parse(&self.created_at).map_err(|error| error.to_string())?;
        AuditEntry::new(
            id,
            actor,
            self.action,
            self.subject,
            self.detail,
            request_id,
            created_at,
        )
        .map_err(|error| error.to_string())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct CoreBenchmarkRecord {
    pub id: String,
    pub experiment_id: String,
    pub ticket_id: String,
    pub commit: String,
    pub spec_hash: String,
    pub environment_digest: String,
    pub metrics: Vec<CoreMetric>,
    pub status: CoreBenchmarkStatus,
    pub attempt: u32,
    pub max_attempts: u32,
    pub stdout: String,
    pub stderr: String,
    pub artifacts: Vec<String>,
    pub created_at: String,
}

impl From<&BenchmarkRecord> for CoreBenchmarkRecord {
    fn from(value: &BenchmarkRecord) -> Self {
        Self {
            id: value.id().as_str().to_string(),
            experiment_id: value.experiment_id().as_str().to_string(),
            ticket_id: value.ticket_id().as_str().to_string(),
            commit: value.commit().as_str().to_string(),
            spec_hash: value.spec_hash().as_str().to_string(),
            environment_digest: value.environment_digest().as_str().to_string(),
            metrics: value.metrics().iter().map(Into::into).collect(),
            status: value.status().into(),
            attempt: value.attempt().get(),
            max_attempts: value.max_attempts().get(),
            stdout: value.stdout().to_string(),
            stderr: value.stderr().to_string(),
            artifacts: value
                .artifacts()
                .iter()
                .map(|artifact| artifact.as_str().to_string())
                .collect(),
            created_at: value.created_at().to_string(),
        }
    }
}

impl CoreBenchmarkRecord {
    pub fn into_domain(self) -> Conversion<BenchmarkRecord> {
        let id = BenchmarkRunId::new(self.id).map_err(|error| error.to_string())?;
        let experiment_id =
            ExperimentId::new(self.experiment_id).map_err(|error| error.to_string())?;
        let ticket_id = TicketId::new(self.ticket_id).map_err(|error| error.to_string())?;
        let commit = CommitSha::new(self.commit).map_err(|error| error.to_string())?;
        let spec_hash = SpecHash::new(self.spec_hash).map_err(|error| error.to_string())?;
        let environment_digest =
            EnvironmentDigest::new(self.environment_digest).map_err(|error| error.to_string())?;
        let metrics = self
            .metrics
            .into_iter()
            .map(CoreMetric::into_domain)
            .collect::<Conversion<Vec<_>>>()?;
        let attempt = Attempt::new(self.attempt).map_err(|error| error.to_string())?;
        let max_attempts = Attempt::new(self.max_attempts).map_err(|error| error.to_string())?;
        let artifacts = self
            .artifacts
            .into_iter()
            .map(|value| ArtifactId::new(value).map_err(|error| error.to_string()))
            .collect::<Conversion<Vec<_>>>()?;
        let created_at = Timestamp::parse(&self.created_at).map_err(|error| error.to_string())?;
        BenchmarkRecord::new(BenchmarkRecordInput {
            id,
            experiment_id,
            ticket_id,
            commit,
            spec_hash,
            environment_digest,
            metrics,
            status: self.status.into(),
            attempt,
            max_attempts,
            stdout: self.stdout,
            stderr: self.stderr,
            artifacts,
            created_at,
        })
        .map_err(|error| error.to_string())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(TS))]
#[serde(rename_all = "kebab-case")]
pub enum CoreCommandName {
    #[serde(rename = "program.create")]
    ProgramCreate,
    #[serde(rename = "program.pause")]
    ProgramPause,
    #[serde(rename = "program.resume")]
    ProgramResume,
    #[serde(rename = "program.stop")]
    ProgramStop,
    #[serde(rename = "program.goal")]
    ProgramGoal,
    #[serde(rename = "program.methodology")]
    ProgramMethodology,
    #[serde(rename = "program.exploration")]
    ProgramExploration,
    #[serde(rename = "issue.create")]
    IssueCreate,
    #[serde(rename = "issue.claim")]
    IssueClaim,
    #[serde(rename = "issue.comment")]
    IssueComment,
    #[serde(rename = "issue.close")]
    IssueClose,
    #[serde(rename = "experiment.propose")]
    ExperimentPropose,
    #[serde(rename = "experiment.review")]
    ExperimentReview,
    #[serde(rename = "experiment.close")]
    ExperimentClose,
    #[serde(rename = "benchmark.request")]
    BenchmarkRequest,
    #[serde(rename = "ticket.submit")]
    TicketSubmit,
}

impl From<CommandName> for CoreCommandName {
    fn from(value: CommandName) -> Self {
        match value {
            CommandName::CreateProgram => Self::ProgramCreate,
            CommandName::PauseProgram => Self::ProgramPause,
            CommandName::ResumeProgram => Self::ProgramResume,
            CommandName::StopProgram => Self::ProgramStop,
            CommandName::SetProgramGoal => Self::ProgramGoal,
            CommandName::SetProgramMethodology => Self::ProgramMethodology,
            CommandName::SetProgramExploration => Self::ProgramExploration,
            CommandName::CreateIssue => Self::IssueCreate,
            CommandName::ClaimIssue => Self::IssueClaim,
            CommandName::CommentIssue => Self::IssueComment,
            CommandName::CloseIssue => Self::IssueClose,
            CommandName::ProposeExperiment => Self::ExperimentPropose,
            CommandName::ReviewExperiment => Self::ExperimentReview,
            CommandName::CloseExperiment => Self::ExperimentClose,
            CommandName::RequestBenchmark => Self::BenchmarkRequest,
            CommandName::SubmitTicket => Self::TicketSubmit,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(TS))]
#[serde(rename_all = "kebab-case")]
pub enum CoreCommandErrorKind {
    InvalidDraft,
    Unauthorized,
    Forbidden,
    Ownership,
    StateConflict,
    Storage,
    Clock,
}

impl From<CommandErrorKind> for CoreCommandErrorKind {
    fn from(value: CommandErrorKind) -> Self {
        match value {
            CommandErrorKind::InvalidDraft => Self::InvalidDraft,
            CommandErrorKind::Unauthorized => Self::Unauthorized,
            CommandErrorKind::Forbidden => Self::Forbidden,
            CommandErrorKind::Ownership => Self::Ownership,
            CommandErrorKind::StateConflict => Self::StateConflict,
            CommandErrorKind::Storage => Self::Storage,
            CommandErrorKind::Clock => Self::Clock,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(TS))]
#[serde(tag = "name", rename_all_fields = "camelCase")]
pub enum CoreCommandDraft {
    #[serde(rename = "program.create")]
    ProgramCreate {
        id: String,
        program_name: String,
        goal: String,
        methodology: String,
        benchmark: CoreBenchmarkSpec,
        utility: Vec<CoreMetricWeight>,
        exploration: CoreExploration,
        policy: CoreResearchPolicy,
    },
    #[serde(rename = "program.pause")]
    ProgramPause { program_id: String },
    #[serde(rename = "program.resume")]
    ProgramResume { program_id: String },
    #[serde(rename = "program.stop")]
    ProgramStop { program_id: String },
    #[serde(rename = "program.goal")]
    ProgramGoal { program_id: String, goal: String },
    #[serde(rename = "program.methodology")]
    ProgramMethodology {
        program_id: String,
        methodology: String,
    },
    #[serde(rename = "program.exploration")]
    ProgramExploration {
        program_id: String,
        exploration: CoreExploration,
    },
    #[serde(rename = "issue.create")]
    IssueCreate {
        id: String,
        program_id: String,
        title: String,
        body: String,
        labels: Vec<String>,
    },
    #[serde(rename = "issue.claim")]
    IssueClaim { issue_id: String },
    #[serde(rename = "issue.comment")]
    IssueComment { issue_id: String, body: String },
    #[serde(rename = "issue.close")]
    IssueClose { issue_id: String },
    #[serde(rename = "experiment.propose")]
    ExperimentPropose {
        id: String,
        program_id: String,
        issue_id: String,
        branch: String,
        head: String,
        environment: CoreEnvironmentDeclaration,
        lineage: CoreLineage,
        #[serde(skip_serializing_if = "Option::is_none")]
        #[cfg_attr(not(target_arch = "wasm32"), ts(optional))]
        plan_comment_id: Option<String>,
    },
    #[serde(rename = "experiment.review")]
    ExperimentReview {
        experiment_id: String,
        decision: CoreResearcherDecision,
    },
    #[serde(rename = "experiment.close")]
    ExperimentClose { experiment_id: String },
    #[serde(rename = "benchmark.request")]
    BenchmarkRequest { experiment_id: String },
    #[serde(rename = "ticket.submit")]
    TicketSubmit { ticket_id: String, commit: String },
}

impl CoreCommandDraft {
    pub fn into_domain(self) -> Conversion<CommandDraft> {
        let id = |value: String| ProgramId::new(value).map_err(|error| error.to_string());
        let issue = |value: String| IssueId::new(value).map_err(|error| error.to_string());
        let experiment =
            |value: String| ExperimentId::new(value).map_err(|error| error.to_string());
        Ok(match self {
            Self::ProgramCreate {
                id,
                program_name,
                goal,
                methodology,
                benchmark,
                utility,
                exploration,
                policy,
            } => CommandDraft::CreateProgram(Box::new(CreateProgramCommand {
                id: ProgramId::new(id).map_err(|error| error.to_string())?,
                name: program_name,
                goal,
                methodology,
                benchmark: benchmark.into_domain()?,
                utility: utility
                    .into_iter()
                    .map(CoreMetricWeight::into_domain)
                    .collect::<Conversion<Vec<_>>>()?,
                exploration: exploration.into(),
                policy: policy.into_domain()?,
            })),
            Self::ProgramPause { program_id } => {
                CommandDraft::PauseProgram(Box::new(PauseProgramCommand {
                    program_id: id(program_id)?,
                }))
            }
            Self::ProgramResume { program_id } => {
                CommandDraft::ResumeProgram(Box::new(ResumeProgramCommand {
                    program_id: id(program_id)?,
                }))
            }
            Self::ProgramStop { program_id } => {
                CommandDraft::StopProgram(Box::new(StopProgramCommand {
                    program_id: id(program_id)?,
                }))
            }
            Self::ProgramGoal { program_id, goal } => {
                CommandDraft::SetProgramGoal(Box::new(SetProgramGoalCommand {
                    program_id: id(program_id)?,
                    goal,
                }))
            }
            Self::ProgramMethodology {
                program_id,
                methodology,
            } => CommandDraft::SetProgramMethodology(Box::new(SetProgramMethodologyCommand {
                program_id: id(program_id)?,
                methodology,
            })),
            Self::ProgramExploration {
                program_id,
                exploration,
            } => CommandDraft::SetProgramExploration(Box::new(SetProgramExplorationCommand {
                program_id: id(program_id)?,
                exploration: exploration.into(),
            })),
            Self::IssueCreate {
                id: issue_id,
                program_id,
                title,
                body,
                labels,
            } => CommandDraft::CreateIssue(Box::new(CreateIssueCommand {
                id: issue(issue_id)?,
                program_id: id(program_id)?,
                title,
                body,
                labels,
            })),
            Self::IssueClaim { issue_id } => {
                CommandDraft::ClaimIssue(Box::new(ClaimIssueCommand {
                    issue_id: issue(issue_id)?,
                }))
            }
            Self::IssueComment { issue_id, body } => {
                CommandDraft::CommentIssue(Box::new(CommentIssueCommand {
                    issue_id: issue(issue_id)?,
                    body,
                }))
            }
            Self::IssueClose { issue_id } => {
                CommandDraft::CloseIssue(Box::new(CloseIssueCommand {
                    issue_id: issue(issue_id)?,
                }))
            }
            Self::ExperimentPropose {
                id: experiment_id,
                program_id,
                issue_id,
                branch,
                head,
                environment,
                lineage,
                plan_comment_id,
            } => CommandDraft::ProposeExperiment(Box::new(ProposeExperimentCommand {
                id: experiment(experiment_id)?,
                program_id: id(program_id)?,
                issue_id: issue(issue_id)?,
                branch: BranchName::new(branch).map_err(|error| error.to_string())?,
                head: CommitSha::new(head).map_err(|error| error.to_string())?,
                environment: environment.into_domain()?,
                lineage: lineage.into_domain()?,
                plan_comment_id: plan_comment_id
                    .map(|value| CommentId::new(value).map_err(|error| error.to_string()))
                    .transpose()?,
            })),
            Self::ExperimentReview {
                experiment_id,
                decision,
            } => CommandDraft::ReviewExperiment(Box::new(ReviewExperimentCommand {
                experiment_id: experiment(experiment_id)?,
                decision: decision.into(),
            })),
            Self::ExperimentClose { experiment_id } => {
                CommandDraft::CloseExperiment(Box::new(CloseExperimentCommand {
                    experiment_id: experiment(experiment_id)?,
                }))
            }
            Self::BenchmarkRequest { experiment_id } => {
                CommandDraft::RequestBenchmark(Box::new(RequestBenchmarkCommand {
                    experiment_id: experiment(experiment_id)?,
                }))
            }
            Self::TicketSubmit { ticket_id, commit } => {
                CommandDraft::SubmitTicket(Box::new(SubmitTicketCommand {
                    ticket_id: TicketId::new(ticket_id).map_err(|error| error.to_string())?,
                    commit: CommitSha::new(commit).map_err(|error| error.to_string())?,
                }))
            }
        })
    }
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(TS))]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum CoreCommandOutcome {
    ProgramCreated {
        program: String,
        version: DecimalU64,
    },
    ProgramUpdated {
        program: String,
        version: DecimalU64,
    },
    IssueCreated {
        issue: String,
        version: DecimalU64,
    },
    IssueUpdated {
        issue: String,
        version: DecimalU64,
    },
    IssueCommented {
        issue: String,
    },
    ExperimentCreated {
        experiment: String,
        version: DecimalU64,
    },
    ExperimentUpdated {
        experiment: String,
        version: DecimalU64,
    },
    ExperimentReviewed {
        experiment: String,
        decision: CoreResearcherDecision,
    },
    BenchmarkRequested {
        experiment: String,
    },
    TicketSubmitted {
        ticket: String,
        commit: String,
        version: DecimalU64,
    },
}

impl From<&CommandOutcome> for CoreCommandOutcome {
    fn from(value: &CommandOutcome) -> Self {
        match value {
            CommandOutcome::ProgramCreated { program, version } => Self::ProgramCreated {
                program: program.as_str().to_string(),
                version: (*version).into(),
            },
            CommandOutcome::ProgramUpdated { program, version } => Self::ProgramUpdated {
                program: program.as_str().to_string(),
                version: (*version).into(),
            },
            CommandOutcome::IssueCreated { issue, version } => Self::IssueCreated {
                issue: issue.as_str().to_string(),
                version: (*version).into(),
            },
            CommandOutcome::IssueUpdated { issue, version } => Self::IssueUpdated {
                issue: issue.as_str().to_string(),
                version: (*version).into(),
            },
            CommandOutcome::IssueCommented { issue } => Self::IssueCommented {
                issue: issue.as_str().to_string(),
            },
            CommandOutcome::ExperimentCreated {
                experiment,
                version,
            } => Self::ExperimentCreated {
                experiment: experiment.as_str().to_string(),
                version: (*version).into(),
            },
            CommandOutcome::ExperimentUpdated {
                experiment,
                version,
            } => Self::ExperimentUpdated {
                experiment: experiment.as_str().to_string(),
                version: (*version).into(),
            },
            CommandOutcome::ExperimentReviewed {
                experiment,
                decision,
            } => Self::ExperimentReviewed {
                experiment: experiment.as_str().to_string(),
                decision: (*decision).into(),
            },
            CommandOutcome::BenchmarkRequested { experiment } => Self::BenchmarkRequested {
                experiment: experiment.as_str().to_string(),
            },
            CommandOutcome::TicketSubmitted {
                ticket,
                commit,
                version,
            } => Self::TicketSubmitted {
                ticket: ticket.as_str().to_string(),
                commit: commit.as_str().to_string(),
                version: (*version).into(),
            },
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct CoreStartRequest {
    pub program_id: String,
    pub issue_id: String,
    pub experiment_id: String,
    pub branch: String,
    pub base_commit: String,
    pub environment: CoreEnvironmentDeclaration,
}

impl CoreStartRequest {
    pub fn into_domain(self) -> Conversion<crate::stage::ExperimentProposed> {
        let program_id = ProgramId::new(self.program_id).map_err(|error| error.to_string())?;
        let issue_id = IssueId::new(self.issue_id).map_err(|error| error.to_string())?;
        let experiment_id =
            ExperimentId::new(self.experiment_id).map_err(|error| error.to_string())?;
        let branch = BranchName::new(self.branch).map_err(|error| error.to_string())?;
        let base_commit = CommitSha::new(self.base_commit).map_err(|error| error.to_string())?;
        let environment = self.environment.into_domain()?;
        Ok(crate::stage::ExperimentProposed::new(
            program_id,
            issue_id,
            experiment_id,
            branch,
            base_commit,
            environment,
        ))
    }
}

#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct CoreCommandRequest {
    pub request_id: String,
    pub actor: CoreActor,
    pub draft: CoreCommandDraft,
}

impl CoreCommandRequest {
    pub fn into_domain(self) -> Conversion<(RequestId, Actor, CommandDraft)> {
        let request_id = RequestId::new(self.request_id).map_err(|error| error.to_string())?;
        let actor = self.actor.into_domain()?;
        let draft = self.draft.into_domain()?;
        Ok((request_id, actor, draft))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(TS))]
#[serde(rename_all = "kebab-case")]
pub enum CoreEffectFailureKind {
    Rejected,
    Unavailable,
    NotFound,
    Conflict,
}

#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct CoreEffectFailure {
    pub kind: CoreEffectFailureKind,
    pub message: String,
}

#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct CoreAck {
    pub acknowledged: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct CoreEffectResult<T> {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(not(target_arch = "wasm32"), ts(optional))]
    pub value: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(not(target_arch = "wasm32"), ts(optional))]
    pub failure: Option<CoreEffectFailure>,
}

impl<T> CoreEffectResult<T> {
    pub fn into_parts(self) -> Option<Result<T, CoreEffectFailure>> {
        match (self.ok, self.value, self.failure) {
            (true, Some(value), None) => Some(Ok(value)),
            (false, None, Some(failure)) => Some(Err(failure)),
            _ => None,
        }
    }
}

macro_rules! effect_payload {
    ($($name:ident { $($(#[$meta:meta])* $field:ident : $ty:ty),* $(,)? })*) => {
        $(
            #[derive(Debug, Clone, Serialize, Deserialize)]
            #[cfg_attr(not(target_arch = "wasm32"), derive(TS))]
            #[serde(rename_all = "camelCase")]
            pub struct $name {
                $($(#[$meta])* pub $field: $ty,)*
            }
        )*
    };
}

effect_payload! {
    CoreStorageLoadProgram { program_id: String }
    CoreStorageLoadIssue { issue_id: String }
    CoreStorageLoadExperiment { experiment_id: String }
    CoreStorageLoadTicket { ticket_id: String }
    CoreTriggerDeliver { experiment_id: String, branch: String, base_commit: String }
    CoreExecutorOpen { program_id: String, issue_id: String, experiment_id: String }
    CoreSessionsStartWorker { ticket_id: String, experiment_id: String }
    CoreSessionsSubmitCommit { ticket_id: String, worker_session_id: String }
    CoreBenchmarkBuildEnvironment { commit: String, environment: CoreEnvironmentDeclaration }
    CoreBenchmarkSpecHash { spec: CoreBenchmarkSpec }
    CoreBenchmarkRun {
        experiment_id: String,
        ticket_id: String,
        spec: CoreBenchmarkSpec,
        commit: String,
        environment_digest: String,
        attempt: u32,
        max_attempts: u32,
    }
    CoreStorageAppendBenchmarkRecord { record: CoreBenchmarkRecord }
    CoreSessionsReview { experiment_id: String, benchmark: CoreBenchmarkRecord }
    CoreStorageSaveProgram {
        #[serde(skip_serializing_if = "Option::is_none")]
        #[cfg_attr(not(target_arch = "wasm32"), ts(optional))]
        expected: Option<DecimalU64>,
        program: CoreProgram,
    }
    CoreStorageSaveIssue {
        #[serde(skip_serializing_if = "Option::is_none")]
        #[cfg_attr(not(target_arch = "wasm32"), ts(optional))]
        expected: Option<DecimalU64>,
        issue: CoreIssue,
    }
    CoreStorageSaveExperiment {
        #[serde(skip_serializing_if = "Option::is_none")]
        #[cfg_attr(not(target_arch = "wasm32"), ts(optional))]
        expected: Option<DecimalU64>,
        experiment: CoreExperiment,
    }
    CoreStorageSaveTicket {
        #[serde(skip_serializing_if = "Option::is_none")]
        #[cfg_attr(not(target_arch = "wasm32"), ts(optional))]
        expected: Option<DecimalU64>,
        ticket: CoreTicket,
    }
    CoreStorageAppendAudit { role: CoreActorRole, entry: CoreAuditEntry }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(TS))]
#[serde(rename_all = "kebab-case")]
pub enum CoreEffectKind {
    Effect,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(TS))]
#[serde(rename_all = "kebab-case")]
pub enum CoreCompletedKind {
    Completed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(TS))]
#[serde(rename_all = "kebab-case")]
pub enum CoreProtocolKind {
    Protocol,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(TS))]
#[serde(rename_all = "kebab-case")]
pub enum CoreDomainKind {
    Domain,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(TS))]
#[serde(rename_all = "kebab-case")]
pub enum CoreCommandErrorFrameKind {
    CommandError,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(TS))]
#[serde(tag = "effect")]
pub enum CoreEffectFrame {
    #[serde(rename = "storage.loadProgram")]
    StorageLoadProgram {
        kind: CoreEffectKind,
        sequence: DecimalU64,
        stage: CoreStageName,
        payload: CoreStorageLoadProgram,
    },
    #[serde(rename = "trigger.deliver")]
    TriggerDeliver {
        kind: CoreEffectKind,
        sequence: DecimalU64,
        stage: CoreStageName,
        payload: CoreTriggerDeliver,
    },
    #[serde(rename = "executor.open")]
    ExecutorOpen {
        kind: CoreEffectKind,
        sequence: DecimalU64,
        stage: CoreStageName,
        payload: CoreExecutorOpen,
    },
    #[serde(rename = "sessions.startWorker")]
    SessionsStartWorker {
        kind: CoreEffectKind,
        sequence: DecimalU64,
        stage: CoreStageName,
        payload: CoreSessionsStartWorker,
    },
    #[serde(rename = "sessions.submitCommit")]
    SessionsSubmitCommit {
        kind: CoreEffectKind,
        sequence: DecimalU64,
        stage: CoreStageName,
        payload: CoreSessionsSubmitCommit,
    },
    #[serde(rename = "benchmark.buildEnvironment")]
    BenchmarkBuildEnvironment {
        kind: CoreEffectKind,
        sequence: DecimalU64,
        stage: CoreStageName,
        payload: CoreBenchmarkBuildEnvironment,
    },
    #[serde(rename = "benchmark.specHash")]
    BenchmarkSpecHash {
        kind: CoreEffectKind,
        sequence: DecimalU64,
        stage: CoreStageName,
        payload: CoreBenchmarkSpecHash,
    },
    #[serde(rename = "benchmark.run")]
    BenchmarkRun {
        kind: CoreEffectKind,
        sequence: DecimalU64,
        stage: CoreStageName,
        payload: CoreBenchmarkRun,
    },
    #[serde(rename = "storage.appendBenchmarkRecord")]
    StorageAppendBenchmarkRecord {
        kind: CoreEffectKind,
        sequence: DecimalU64,
        stage: CoreStageName,
        payload: CoreStorageAppendBenchmarkRecord,
    },
    #[serde(rename = "sessions.review")]
    SessionsReview {
        kind: CoreEffectKind,
        sequence: DecimalU64,
        stage: CoreStageName,
        payload: CoreSessionsReview,
    },
    #[serde(rename = "clock.now")]
    ClockNow {
        kind: CoreEffectKind,
        sequence: DecimalU64,
        stage: CoreStageName,
        payload: (),
    },
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct CoreCompletedFrame {
    pub kind: CoreCompletedKind,
    pub outcome: CoreResearchOutcome,
    pub stages: Vec<CoreStageName>,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct CoreProtocolFrame {
    pub kind: CoreProtocolKind,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct CoreDomainFrame {
    pub kind: CoreDomainKind,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(TS))]
#[serde(untagged)]
pub enum CoreFrame {
    Effect(Box<CoreEffectFrame>),
    Completed(CoreCompletedFrame),
    Protocol(CoreProtocolFrame),
    Domain(CoreDomainFrame),
}

#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(TS))]
#[serde(tag = "effect")]
pub enum CoreEffectResume {
    #[serde(rename = "storage.loadProgram")]
    StorageLoadProgram {
        sequence: DecimalU64,
        result: CoreEffectResult<CoreProgram>,
    },
    #[serde(rename = "trigger.deliver")]
    TriggerDeliver {
        sequence: DecimalU64,
        result: CoreEffectResult<String>,
    },
    #[serde(rename = "executor.open")]
    ExecutorOpen {
        sequence: DecimalU64,
        result: CoreEffectResult<String>,
    },
    #[serde(rename = "sessions.startWorker")]
    SessionsStartWorker {
        sequence: DecimalU64,
        result: CoreEffectResult<String>,
    },
    #[serde(rename = "sessions.submitCommit")]
    SessionsSubmitCommit {
        sequence: DecimalU64,
        result: CoreEffectResult<String>,
    },
    #[serde(rename = "benchmark.buildEnvironment")]
    BenchmarkBuildEnvironment {
        sequence: DecimalU64,
        result: CoreEffectResult<String>,
    },
    #[serde(rename = "benchmark.specHash")]
    BenchmarkSpecHash {
        sequence: DecimalU64,
        result: CoreEffectResult<String>,
    },
    #[serde(rename = "benchmark.run")]
    BenchmarkRun {
        sequence: DecimalU64,
        result: CoreEffectResult<CoreBenchmarkRecord>,
    },
    #[serde(rename = "storage.appendBenchmarkRecord")]
    StorageAppendBenchmarkRecord {
        sequence: DecimalU64,
        result: CoreEffectResult<CoreAck>,
    },
    #[serde(rename = "sessions.review")]
    SessionsReview {
        sequence: DecimalU64,
        result: CoreEffectResult<CoreResearcherDecision>,
    },
    #[serde(rename = "clock.now")]
    ClockNow {
        sequence: DecimalU64,
        result: CoreEffectResult<String>,
    },
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(TS))]
#[serde(tag = "effect")]
pub enum CoreCommandEffectFrame {
    #[serde(rename = "storage.loadProgram")]
    StorageLoadProgram {
        kind: CoreEffectKind,
        sequence: DecimalU64,
        payload: CoreStorageLoadProgram,
    },
    #[serde(rename = "storage.saveProgram")]
    StorageSaveProgram {
        kind: CoreEffectKind,
        sequence: DecimalU64,
        payload: CoreStorageSaveProgram,
    },
    #[serde(rename = "storage.loadIssue")]
    StorageLoadIssue {
        kind: CoreEffectKind,
        sequence: DecimalU64,
        payload: CoreStorageLoadIssue,
    },
    #[serde(rename = "storage.saveIssue")]
    StorageSaveIssue {
        kind: CoreEffectKind,
        sequence: DecimalU64,
        payload: CoreStorageSaveIssue,
    },
    #[serde(rename = "storage.loadExperiment")]
    StorageLoadExperiment {
        kind: CoreEffectKind,
        sequence: DecimalU64,
        payload: CoreStorageLoadExperiment,
    },
    #[serde(rename = "storage.saveExperiment")]
    StorageSaveExperiment {
        kind: CoreEffectKind,
        sequence: DecimalU64,
        payload: CoreStorageSaveExperiment,
    },
    #[serde(rename = "storage.loadTicket")]
    StorageLoadTicket {
        kind: CoreEffectKind,
        sequence: DecimalU64,
        payload: CoreStorageLoadTicket,
    },
    #[serde(rename = "storage.saveTicket")]
    StorageSaveTicket {
        kind: CoreEffectKind,
        sequence: DecimalU64,
        payload: CoreStorageSaveTicket,
    },
    #[serde(rename = "storage.appendAudit")]
    StorageAppendAudit {
        kind: CoreEffectKind,
        sequence: DecimalU64,
        payload: CoreStorageAppendAudit,
    },
    #[serde(rename = "clock.now")]
    ClockNow {
        kind: CoreEffectKind,
        sequence: DecimalU64,
        payload: (),
    },
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct CoreCommandCompletedFrame {
    pub kind: CoreCompletedKind,
    pub outcome: CoreCommandOutcome,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct CoreCommandErrorFrame {
    pub kind: CoreCommandErrorFrameKind,
    pub error_kind: CoreCommandErrorKind,
    pub command: CoreCommandName,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(TS))]
#[serde(untagged)]
pub enum CoreCommandFrame {
    Effect(Box<CoreCommandEffectFrame>),
    Completed(CoreCommandCompletedFrame),
    Error(CoreCommandErrorFrame),
    Protocol(CoreProtocolFrame),
}

#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(TS))]
#[serde(tag = "effect")]
pub enum CoreCommandEffectResume {
    #[serde(rename = "storage.loadProgram")]
    StorageLoadProgram {
        sequence: DecimalU64,
        result: CoreEffectResult<CoreVersioned<CoreProgram>>,
    },
    #[serde(rename = "storage.saveProgram")]
    StorageSaveProgram {
        sequence: DecimalU64,
        result: CoreEffectResult<DecimalU64>,
    },
    #[serde(rename = "storage.loadIssue")]
    StorageLoadIssue {
        sequence: DecimalU64,
        result: CoreEffectResult<CoreVersioned<CoreIssue>>,
    },
    #[serde(rename = "storage.saveIssue")]
    StorageSaveIssue {
        sequence: DecimalU64,
        result: CoreEffectResult<DecimalU64>,
    },
    #[serde(rename = "storage.loadExperiment")]
    StorageLoadExperiment {
        sequence: DecimalU64,
        result: CoreEffectResult<CoreVersioned<CoreExperiment>>,
    },
    #[serde(rename = "storage.saveExperiment")]
    StorageSaveExperiment {
        sequence: DecimalU64,
        result: CoreEffectResult<DecimalU64>,
    },
    #[serde(rename = "storage.loadTicket")]
    StorageLoadTicket {
        sequence: DecimalU64,
        result: CoreEffectResult<CoreVersioned<CoreTicket>>,
    },
    #[serde(rename = "storage.saveTicket")]
    StorageSaveTicket {
        sequence: DecimalU64,
        result: CoreEffectResult<DecimalU64>,
    },
    #[serde(rename = "storage.appendAudit")]
    StorageAppendAudit {
        sequence: DecimalU64,
        result: CoreEffectResult<CoreAck>,
    },
    #[serde(rename = "clock.now")]
    ClockNow {
        sequence: DecimalU64,
        result: CoreEffectResult<String>,
    },
}

#[cfg(not(target_arch = "wasm32"))]
pub fn export_bindings(directory: &std::path::Path) -> Result<(), ts_rs::ExportError> {
    let config = ts_rs::Config::new()
        .with_out_dir(directory)
        .with_import_extension(Some("js"));
    CoreStartRequest::export_all(&config)?;
    CoreCommandRequest::export_all(&config)?;
    CoreFrame::export_all(&config)?;
    CoreEffectResume::export_all(&config)?;
    CoreCommandFrame::export_all(&config)?;
    CoreCommandEffectResume::export_all(&config)?;
    CoreProgram::export_all(&config)?;
    CoreIssue::export_all(&config)?;
    CoreExperiment::export_all(&config)?;
    CoreTicket::export_all(&config)?;
    CoreAuditEntry::export_all(&config)?;
    CoreBenchmarkRecord::export_all(&config)?;
    CoreBenchmarkSpec::export_all(&config)?;
    CoreCommandDraft::export_all(&config)?;
    CoreCommandOutcome::export_all(&config)?;
    Ok(())
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;

    #[test]
    fn decimal_u64_round_trips_through_decimal_text() {
        let value = DecimalU64::new(u64::MAX);
        assert_eq!(value.to_string(), u64::MAX.to_string());
        assert_eq!(
            DecimalU64::try_from(u64::MAX.to_string()).unwrap(),
            DecimalU64::new(u64::MAX)
        );
        assert!(DecimalU64::try_from("not-a-number".to_string()).is_err());
    }

    #[test]
    fn export_bindings_writes_the_tracked_directory() {
        let default = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("research-core")
            .join("src")
            .join("adapter")
            .join("bindings");
        let directory = std::env::var_os("TS_RS_EXPORT_DIR")
            .map(std::path::PathBuf::from)
            .unwrap_or(default);
        export_bindings(&directory).unwrap();
    }
}
