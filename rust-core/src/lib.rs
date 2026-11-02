#![deny(unsafe_code)]
#![allow(async_fn_in_trait)]

pub mod domain;
pub mod error;
pub mod id;
pub mod memory;
pub mod pipeline;
pub mod plugin;
pub mod stage;
pub mod time;

#[cfg(target_arch = "wasm32")]
#[allow(unsafe_code)]
mod wasm;

pub const CORE_ABI_VERSION: u32 = 1;

pub use domain::{
    Artifact, AuditEntry, BenchmarkMetric, BenchmarkRecord, BenchmarkRecordInput, BenchmarkSpec,
    BenchmarkStatus, Environment, Experiment, ExperimentInput, ExperimentStatus, Exploration,
    Issue, IssueInput, IssueStatus, Lineage, LineageStrategy, Metric, MetricDirection,
    MetricWeight, Program, ProgramInput, ProgramStatus, ResearchOutcome, ResearchPolicy,
    ResearcherDecision, StopReason, Ticket, TicketAssignment, TicketStatus, Usage, Versioned,
};
pub use error::{
    Aggregate, ArtifactError, AuditError, BenchmarkError, BenchmarkRecordError, BenchmarkSpecError,
    DomainError, HttpError, IdError, IdReason, IssueError, LineageError, NumericError,
    ProgramError, ResearchPolicyError, SessionError, StorageError, SurfaceError, TicketError,
    TimestampError, ToolError, TriggerError,
};
pub use id::{
    ActorId, ArtifactId, Attempt, AuditId, BenchmarkRunId, BenchmarkSpecId, BranchName, CommentId,
    CommitSha, EnvironmentDigest, EnvironmentFile, ExperimentId, IssueId, PipelineRunId, ProgramId,
    RequestId, SessionId, SpecHash, TicketId, TriggerId, Version,
};
pub use pipeline::run_pipeline;
pub use plugin::{
    Artifacts, BenchmarkRequest, BenchmarkRunner, Clock, CommitRequest, EnvironmentRequest, Http,
    HttpMethod, HttpRequest, HttpResponse, PipelineContext, Plugin, ReviewRequest, Sessions,
    Storage, Surface, SurfaceManifest, TicketExecutor, TicketRequest, ToolCall, ToolOutput, Tools,
    TriggerRequest, TriggerSource, WorkerRequest,
};
pub use stage::{
    BenchmarkFailed, BenchmarkOutcome, BenchmarkPassed, BenchmarkRetryable, CommitSubmitted,
    EnvironmentBuilt, ExperimentProposed, IssueAssigned, PipelineRun, ResearchCompleted,
    ResultRecorded, ReviewRecorded, StageName, TicketOpened, TriggerAccepted, WorkerStarted,
};
pub use time::Timestamp;
