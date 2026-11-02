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

#[derive(Debug, Clone, PartialEq, Eq)]
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

impl fmt::Display for IdError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{} {}", self.field, self.reason)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NumericError {
    Zero { field: &'static str },
    Overflow { field: &'static str },
}

impl fmt::Display for NumericError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Zero { field } => write!(formatter, "{field} must be greater than zero"),
            Self::Overflow { field } => write!(formatter, "{field} overflowed"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TimestampError {
    InvalidFormat,
    InvalidDate,
    OutOfRange,
}

impl fmt::Display for TimestampError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidFormat => {
                formatter.write_str("timestamp must be RFC 3339 with a Z suffix")
            }
            Self::InvalidDate => formatter.write_str("timestamp date is out of range"),
            Self::OutOfRange => formatter.write_str("timestamp is out of range"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StorageError {
    NotFound {
        aggregate: Aggregate,
    },
    Conflict {
        expected: Option<Version>,
        actual: Option<Version>,
    },
    AlreadyExists {
        aggregate: Aggregate,
    },
    Unavailable {
        detail: String,
    },
}

impl fmt::Display for StorageError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotFound { aggregate } => write!(formatter, "{aggregate} was not found"),
            Self::Conflict { expected, actual } => {
                write!(
                    formatter,
                    "version conflict: expected {expected:?}, actual {actual:?}"
                )
            }
            Self::AlreadyExists { aggregate } => write!(formatter, "{aggregate} already exists"),
            Self::Unavailable { detail } => write!(formatter, "storage unavailable: {detail}"),
        }
    }
}

macro_rules! host_error {
    ($name:ident) => {
        #[derive(Debug, Clone, PartialEq, Eq)]
        pub enum $name {
            Rejected { detail: String },
            Unavailable { detail: String },
        }

        impl fmt::Display for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                match self {
                    Self::Rejected { detail } => write!(formatter, "rejected: {detail}"),
                    Self::Unavailable { detail } => write!(formatter, "unavailable: {detail}"),
                }
            }
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ArtifactError {
    EmptyName,
    EmptyMediaType,
    Rejected { detail: String },
    Unavailable { detail: String },
}

impl fmt::Display for ArtifactError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyName => formatter.write_str("artifact name must not be empty"),
            Self::EmptyMediaType => formatter.write_str("artifact media type must not be empty"),
            Self::Rejected { detail } => write!(formatter, "rejected: {detail}"),
            Self::Unavailable { detail } => write!(formatter, "unavailable: {detail}"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SurfaceError {
    EmptyEntry { section: &'static str, index: usize },
    DuplicateEntry { section: &'static str, name: String },
}

impl fmt::Display for SurfaceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyEntry { section, index } => {
                write!(formatter, "{section} entry {index} is empty")
            }
            Self::DuplicateEntry { section, name } => {
                write!(formatter, "{section} entry {name:?} is duplicated")
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum ProgramError {
    EmptyName,
    EmptyUtility,
    EmptyUtilityMetric,
    DuplicateUtilityMetric { name: String },
    InvalidWeight { name: String, weight: f64 },
}

impl fmt::Display for ProgramError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyName => formatter.write_str("program name must not be empty"),
            Self::EmptyUtility => formatter.write_str("program utility must not be empty"),
            Self::EmptyUtilityMetric => {
                formatter.write_str("utility metric name must not be empty")
            }
            Self::DuplicateUtilityMetric { name } => {
                write!(formatter, "utility metric {name:?} is duplicated")
            }
            Self::InvalidWeight { name, weight } => {
                write!(
                    formatter,
                    "utility metric {name:?} has invalid weight {weight}"
                )
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IssueError {
    EmptyTitle,
}

impl fmt::Display for IssueError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyTitle => formatter.write_str("issue title must not be empty"),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum LineageError {
    InvalidProbability { value: f64 },
}

impl fmt::Display for LineageError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidProbability { value } => {
                write!(
                    formatter,
                    "fresh start probability {value} must be between zero and one"
                )
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuditError {
    EmptyAction,
    EmptySubject,
}

impl fmt::Display for AuditError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyAction => formatter.write_str("audit action must not be empty"),
            Self::EmptySubject => formatter.write_str("audit subject must not be empty"),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum BenchmarkSpecError {
    EmptyEntry,
    ZeroTimeout,
    NoMetrics,
    EmptyMetricName,
    DuplicateMetric { name: String },
    InvalidTolerance { name: String },
    UnknownBaseline { name: String },
    NonFiniteBaseline { name: String, value: f64 },
    EmptyDataset,
}

impl fmt::Display for BenchmarkSpecError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyEntry => formatter.write_str("benchmark entry must not be empty"),
            Self::ZeroTimeout => formatter.write_str("benchmark timeout must be greater than zero"),
            Self::NoMetrics => {
                formatter.write_str("benchmark spec must declare at least one metric")
            }
            Self::EmptyMetricName => formatter.write_str("benchmark metric name must not be empty"),
            Self::DuplicateMetric { name } => {
                write!(formatter, "benchmark metric {name:?} is duplicated")
            }
            Self::InvalidTolerance { name } => {
                write!(formatter, "benchmark metric {name:?} has invalid tolerance")
            }
            Self::UnknownBaseline { name } => {
                write!(formatter, "baseline metric {name:?} is not declared")
            }
            Self::NonFiniteBaseline { name, value } => {
                write!(
                    formatter,
                    "baseline metric {name:?} has non-finite value {value}"
                )
            }
            Self::EmptyDataset => formatter.write_str("benchmark dataset must not be empty"),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum BenchmarkRecordError {
    EmptyMetricName,
    DuplicateMetric {
        name: String,
    },
    UnknownMetric {
        name: String,
    },
    MissingMetric {
        name: String,
    },
    NonFiniteMetric {
        name: String,
        value: f64,
    },
    SpecHashMismatch,
    EnvironmentDigestMismatch,
    AttemptMismatch {
        expected: Attempt,
        actual: Attempt,
    },
    MaxAttemptsMismatch {
        expected: Attempt,
        actual: Attempt,
    },
    AttemptExceedsMaximum {
        attempt: Attempt,
        max_attempts: Attempt,
    },
    ExperimentMismatch {
        expected: ExperimentId,
        actual: ExperimentId,
    },
    TicketMismatch {
        expected: TicketId,
        actual: TicketId,
    },
    CommitMismatch,
}

impl fmt::Display for BenchmarkRecordError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyMetricName => formatter.write_str("benchmark metric name must not be empty"),
            Self::DuplicateMetric { name } => {
                write!(formatter, "benchmark record metric {name:?} is duplicated")
            }
            Self::UnknownMetric { name } => {
                write!(
                    formatter,
                    "benchmark record metric {name:?} is not declared"
                )
            }
            Self::MissingMetric { name } => {
                write!(formatter, "required benchmark metric {name:?} is missing")
            }
            Self::NonFiniteMetric { name, value } => {
                write!(
                    formatter,
                    "benchmark metric {name:?} has non-finite value {value}"
                )
            }
            Self::SpecHashMismatch => {
                formatter.write_str("benchmark spec hash does not match the program contract")
            }
            Self::EnvironmentDigestMismatch => {
                formatter.write_str("environment digest does not match the built environment")
            }
            Self::AttemptMismatch { expected, actual } => {
                write!(
                    formatter,
                    "benchmark attempt {actual} does not match {expected}"
                )
            }
            Self::MaxAttemptsMismatch { expected, actual } => {
                write!(
                    formatter,
                    "benchmark max attempts {actual} do not match {expected}"
                )
            }
            Self::AttemptExceedsMaximum {
                attempt,
                max_attempts,
            } => write!(
                formatter,
                "benchmark attempt {attempt} exceeds {max_attempts}"
            ),
            Self::ExperimentMismatch { expected, actual } => {
                write!(
                    formatter,
                    "benchmark experiment {actual} does not match {expected}"
                )
            }
            Self::TicketMismatch { expected, actual } => {
                write!(
                    formatter,
                    "benchmark ticket {actual} does not match {expected}"
                )
            }
            Self::CommitMismatch => {
                formatter.write_str("benchmark commit does not match the submitted commit")
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResearchPolicyError {
    ZeroExperiments,
    ZeroComputeMinutes,
    ZeroTokens,
    ZeroAttempts,
    ExperimentsExceeded { max: u32, used: u32 },
    ComputeMinutesExceeded { max: u64, used: u64 },
    TokensExceeded { max: u64, used: u64 },
    RetryNotAllowed { attempt: Attempt, max_attempts: u32 },
}

impl fmt::Display for ResearchPolicyError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ZeroExperiments => {
                formatter.write_str("maximum experiments must be greater than zero")
            }
            Self::ZeroComputeMinutes => {
                formatter.write_str("maximum compute minutes must be greater than zero")
            }
            Self::ZeroTokens => formatter.write_str("maximum tokens must be greater than zero"),
            Self::ZeroAttempts => {
                formatter.write_str("maximum attempts per experiment must be greater than zero")
            }
            Self::ExperimentsExceeded { max, used } => {
                write!(formatter, "experiment budget exceeded: {used} of {max}")
            }
            Self::ComputeMinutesExceeded { max, used } => {
                write!(
                    formatter,
                    "compute budget exceeded: {used} of {max} minutes"
                )
            }
            Self::TokensExceeded { max, used } => {
                write!(formatter, "token budget exceeded: {used} of {max}")
            }
            Self::RetryNotAllowed {
                attempt,
                max_attempts,
            } => write!(
                formatter,
                "retry is not allowed after attempt {attempt} of {max_attempts}"
            ),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum DomainError {
    Id(IdError),
    Number(NumericError),
    Time(TimestampError),
    Program(ProgramError),
    Issue(IssueError),
    Lineage(LineageError),
    Audit(AuditError),
    Spec(BenchmarkSpecError),
    Record(BenchmarkRecordError),
    Policy(ResearchPolicyError),
    Storage(StorageError),
    Trigger(TriggerError),
    Ticket(TicketError),
    Session(SessionError),
    Benchmark(BenchmarkError),
    Artifact(ArtifactError),
    Tool(ToolError),
    Http(HttpError),
    Clock(ClockError),
    Surface(SurfaceError),
}

impl fmt::Display for DomainError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Id(error) => write!(formatter, "invalid identifier: {error}"),
            Self::Number(error) => write!(formatter, "invalid number: {error}"),
            Self::Time(error) => write!(formatter, "invalid timestamp: {error}"),
            Self::Program(error) => write!(formatter, "invalid program: {error}"),
            Self::Issue(error) => write!(formatter, "invalid issue: {error}"),
            Self::Lineage(error) => write!(formatter, "invalid lineage: {error}"),
            Self::Audit(error) => write!(formatter, "invalid audit entry: {error}"),
            Self::Spec(error) => write!(formatter, "invalid benchmark spec: {error}"),
            Self::Record(error) => write!(formatter, "invalid benchmark record: {error}"),
            Self::Policy(error) => write!(formatter, "research policy refused: {error}"),
            Self::Storage(error) => write!(formatter, "storage error: {error}"),
            Self::Trigger(error) => write!(formatter, "trigger error: {error}"),
            Self::Ticket(error) => write!(formatter, "ticket error: {error}"),
            Self::Session(error) => write!(formatter, "session error: {error}"),
            Self::Benchmark(error) => write!(formatter, "benchmark error: {error}"),
            Self::Artifact(error) => write!(formatter, "artifact error: {error}"),
            Self::Tool(error) => write!(formatter, "tool error: {error}"),
            Self::Http(error) => write!(formatter, "http error: {error}"),
            Self::Clock(error) => write!(formatter, "clock error: {error}"),
            Self::Surface(error) => write!(formatter, "surface error: {error}"),
        }
    }
}

impl std::error::Error for DomainError {}

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

impl std::error::Error for IdError {}
impl std::error::Error for NumericError {}
impl std::error::Error for TimestampError {}
impl std::error::Error for StorageError {}
impl std::error::Error for TriggerError {}
impl std::error::Error for TicketError {}
impl std::error::Error for SessionError {}
impl std::error::Error for BenchmarkError {}
impl std::error::Error for ArtifactError {}
impl std::error::Error for ToolError {}
impl std::error::Error for HttpError {}
impl std::error::Error for ClockError {}
impl std::error::Error for SurfaceError {}
impl std::error::Error for ProgramError {}
impl std::error::Error for IssueError {}
impl std::error::Error for LineageError {}
impl std::error::Error for AuditError {}
impl std::error::Error for BenchmarkSpecError {}
impl std::error::Error for BenchmarkRecordError {}
impl std::error::Error for ResearchPolicyError {}

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
