use std::fmt;

use crate::id::{Attempt, ExperimentId, TicketId, Version};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Aggregate {
    Program,
    Issue,
    Experiment,
    Ticket,
    BenchmarkRecord,
    PipelineRun,
    Audit,
}

impl Aggregate {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Program => "program",
            Self::Issue => "issue",
            Self::Experiment => "experiment",
            Self::Ticket => "ticket",
            Self::BenchmarkRecord => "benchmark_record",
            Self::PipelineRun => "pipeline_run",
            Self::Audit => "audit",
        }
    }
}

impl fmt::Display for Aggregate {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IdReason {
    Empty,
    TooLong { max: usize },
    InvalidCharacter { character: char },
    WrongLength { expected: usize, actual: usize },
    NotHex { character: char },
}

impl fmt::Display for IdReason {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Empty => formatter.write_str("must not be empty"),
            Self::TooLong { max } => write!(formatter, "must be at most {max} characters"),
            Self::InvalidCharacter { character } => {
                write!(formatter, "contains invalid character {character:?}")
            }
            Self::WrongLength { expected, actual } => {
                write!(formatter, "must be {expected} characters, got {actual}")
            }
            Self::NotHex { character } => {
                write!(formatter, "contains non-hex character {character:?}")
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{field} {reason}")]
pub struct IdError {
    field: &'static str,
    reason: IdReason,
}

impl IdError {
    pub fn new(field: &'static str, reason: IdReason) -> Self {
        Self { field, reason }
    }

    pub fn field(&self) -> &'static str {
        self.field
    }

    pub fn reason(&self) -> &IdReason {
        &self.reason
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum NumericError {
    #[error("{field} must be greater than zero")]
    Zero { field: &'static str },
    #[error("{field} overflowed")]
    Overflow { field: &'static str },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum TimestampError {
    #[error("timestamp must be RFC 3339 with a Z suffix")]
    InvalidFormat,
    #[error("timestamp date is out of range")]
    InvalidDate,
    #[error("timestamp is out of range")]
    OutOfRange,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum StorageError {
    #[error("{aggregate} was not found")]
    NotFound { aggregate: Aggregate },
    #[error("version conflict: expected {expected:?}, actual {actual:?}")]
    Conflict {
        expected: Option<Version>,
        actual: Option<Version>,
    },
    #[error("{aggregate} already exists")]
    AlreadyExists { aggregate: Aggregate },
    #[error("storage unavailable: {detail}")]
    Unavailable { detail: String },
}

macro_rules! host_error {
    ($name:ident) => {
        #[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
        pub enum $name {
            #[error("rejected: {detail}")]
            Rejected { detail: String },
            #[error("unavailable: {detail}")]
            Unavailable { detail: String },
        }
    };
}

host_error!(TriggerError);
host_error!(TicketError);
host_error!(SessionError);
host_error!(BenchmarkError);
host_error!(ToolError);
host_error!(HttpError);
host_error!(ClockError);

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ArtifactError {
    #[error("artifact name must not be empty")]
    EmptyName,
    #[error("artifact media type must not be empty")]
    EmptyMediaType,
    #[error("rejected: {detail}")]
    Rejected { detail: String },
    #[error("unavailable: {detail}")]
    Unavailable { detail: String },
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SurfaceError {
    #[error("{section} entry {index} is empty")]
    EmptyEntry { section: &'static str, index: usize },
    #[error("{section} entry {name:?} is duplicated")]
    DuplicateEntry { section: &'static str, name: String },
}

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum ProgramError {
    #[error("program name must not be empty")]
    EmptyName,
    #[error("program utility must not be empty")]
    EmptyUtility,
    #[error("utility metric name must not be empty")]
    EmptyUtilityMetric,
    #[error("utility metric {name:?} is duplicated")]
    DuplicateUtilityMetric { name: String },
    #[error("utility metric {name:?} has invalid weight {weight}")]
    InvalidWeight { name: String, weight: f64 },
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum IssueError {
    #[error("issue title must not be empty")]
    EmptyTitle,
}

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum LineageError {
    #[error("fresh start probability {value} must be between zero and one")]
    InvalidProbability { value: f64 },
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum AuditError {
    #[error("audit action must not be empty")]
    EmptyAction,
    #[error("audit subject must not be empty")]
    EmptySubject,
}

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum BenchmarkSpecError {
    #[error("benchmark entry must not be empty")]
    EmptyEntry,
    #[error("benchmark timeout must be greater than zero")]
    ZeroTimeout,
    #[error("benchmark spec must declare at least one metric")]
    NoMetrics,
    #[error("benchmark metric name must not be empty")]
    EmptyMetricName,
    #[error("benchmark metric {name:?} is duplicated")]
    DuplicateMetric { name: String },
    #[error("benchmark metric {name:?} has invalid tolerance")]
    InvalidTolerance { name: String },
    #[error("baseline metric {name:?} is not declared")]
    UnknownBaseline { name: String },
    #[error("baseline metric {name:?} has non-finite value {value}")]
    NonFiniteBaseline { name: String, value: f64 },
    #[error("benchmark dataset must not be empty")]
    EmptyDataset,
}

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum BenchmarkRecordError {
    #[error("benchmark metric name must not be empty")]
    EmptyMetricName,
    #[error("benchmark record metric {name:?} is duplicated")]
    DuplicateMetric { name: String },
    #[error("benchmark record metric {name:?} is not declared")]
    UnknownMetric { name: String },
    #[error("required benchmark metric {name:?} is missing")]
    MissingMetric { name: String },
    #[error("benchmark metric {name:?} has non-finite value {value}")]
    NonFiniteMetric { name: String, value: f64 },
    #[error("benchmark spec hash does not match the program contract")]
    SpecHashMismatch,
    #[error("environment digest does not match the built environment")]
    EnvironmentDigestMismatch,
    #[error("benchmark attempt {actual} does not match {expected}")]
    AttemptMismatch { expected: Attempt, actual: Attempt },
    #[error("benchmark max attempts {actual} do not match {expected}")]
    MaxAttemptsMismatch { expected: Attempt, actual: Attempt },
    #[error("benchmark attempt {attempt} exceeds {max_attempts}")]
    AttemptExceedsMaximum {
        attempt: Attempt,
        max_attempts: Attempt,
    },
    #[error("benchmark experiment {actual} does not match {expected}")]
    ExperimentMismatch {
        expected: ExperimentId,
        actual: ExperimentId,
    },
    #[error("benchmark ticket {actual} does not match {expected}")]
    TicketMismatch {
        expected: TicketId,
        actual: TicketId,
    },
    #[error("benchmark commit does not match the submitted commit")]
    CommitMismatch,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ResearchPolicyError {
    #[error("maximum experiments must be greater than zero")]
    ZeroExperiments,
    #[error("maximum compute minutes must be greater than zero")]
    ZeroComputeMinutes,
    #[error("maximum tokens must be greater than zero")]
    ZeroTokens,
    #[error("maximum attempts per experiment must be greater than zero")]
    ZeroAttempts,
    #[error("experiment budget exceeded: {used} of {max}")]
    ExperimentsExceeded { max: u32, used: u32 },
    #[error("compute budget exceeded: {used} of {max} minutes")]
    ComputeMinutesExceeded { max: u64, used: u64 },
    #[error("token budget exceeded: {used} of {max}")]
    TokensExceeded { max: u64, used: u64 },
    #[error("retry is not allowed after attempt {attempt} of {max_attempts}")]
    RetryNotAllowed { attempt: Attempt, max_attempts: u32 },
}

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum DomainError {
    #[error("invalid identifier: {0}")]
    Id(IdError),
    #[error("invalid number: {0}")]
    Number(NumericError),
    #[error("invalid timestamp: {0}")]
    Time(TimestampError),
    #[error("invalid program: {0}")]
    Program(ProgramError),
    #[error("invalid issue: {0}")]
    Issue(IssueError),
    #[error("invalid lineage: {0}")]
    Lineage(LineageError),
    #[error("invalid audit entry: {0}")]
    Audit(AuditError),
    #[error("invalid benchmark spec: {0}")]
    Spec(BenchmarkSpecError),
    #[error("invalid benchmark record: {0}")]
    Record(BenchmarkRecordError),
    #[error("research policy refused: {0}")]
    Policy(ResearchPolicyError),
    #[error("storage error: {0}")]
    Storage(StorageError),
    #[error("trigger error: {0}")]
    Trigger(TriggerError),
    #[error("ticket error: {0}")]
    Ticket(TicketError),
    #[error("session error: {0}")]
    Session(SessionError),
    #[error("benchmark error: {0}")]
    Benchmark(BenchmarkError),
    #[error("artifact error: {0}")]
    Artifact(ArtifactError),
    #[error("tool error: {0}")]
    Tool(ToolError),
    #[error("http error: {0}")]
    Http(HttpError),
    #[error("clock error: {0}")]
    Clock(ClockError),
    #[error("surface error: {0}")]
    Surface(SurfaceError),
}

macro_rules! domain_from {
    ($variant:ident, $source:ty) => {
        impl From<$source> for DomainError {
            fn from(error: $source) -> Self {
                Self::$variant(error)
            }
        }
    };
}

domain_from!(Id, IdError);
domain_from!(Number, NumericError);
domain_from!(Time, TimestampError);
domain_from!(Program, ProgramError);
domain_from!(Issue, IssueError);
domain_from!(Lineage, LineageError);
domain_from!(Audit, AuditError);
domain_from!(Spec, BenchmarkSpecError);
domain_from!(Record, BenchmarkRecordError);
domain_from!(Policy, ResearchPolicyError);
domain_from!(Storage, StorageError);
domain_from!(Trigger, TriggerError);
domain_from!(Ticket, TicketError);
domain_from!(Session, SessionError);
domain_from!(Benchmark, BenchmarkError);
domain_from!(Artifact, ArtifactError);
domain_from!(Tool, ToolError);
domain_from!(Http, HttpError);
domain_from!(Clock, ClockError);
domain_from!(Surface, SurfaceError);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn domain_errors_delegate_display() {
        let error = DomainError::from(IdError::new("program_id", IdReason::Empty));
        assert_eq!(
            error.to_string(),
            "invalid identifier: program_id must not be empty"
        );
        let error = DomainError::from(StorageError::NotFound {
            aggregate: Aggregate::Program,
        });
        assert_eq!(error.to_string(), "storage error: program was not found");
    }

    #[test]
    fn aggregate_names_are_stable() {
        assert_eq!(Aggregate::BenchmarkRecord.as_str(), "benchmark_record");
        assert_eq!(Aggregate::PipelineRun.to_string(), "pipeline_run");
    }
}
