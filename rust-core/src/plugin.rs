use std::collections::HashSet;
use std::fmt;

use crate::domain::{
    Artifact, AuditEntry, BenchmarkRecord, BenchmarkSpec, Environment, Experiment, Issue, Program,
    ResearcherDecision, Ticket, Versioned,
};
use crate::error::{
    ArtifactError, BenchmarkError, DomainError, HttpError, SessionError, StorageError,
    SurfaceError, TicketError, ToolError, TriggerError,
};
use crate::id::{
    ArtifactId, Attempt, BenchmarkRunId, BranchName, CommitSha, EnvironmentDigest, ExperimentId,
    IssueId, ProgramId, SessionId, SpecHash, TicketId, Version,
};
use crate::stage::PipelineRun;
use crate::time::Timestamp;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SurfaceManifest {
    routes: Vec<String>,
    tools: Vec<String>,
    presets: Vec<String>,
    settings: Vec<String>,
}

impl SurfaceManifest {
    pub fn new(
        routes: Vec<String>,
        tools: Vec<String>,
        presets: Vec<String>,
        settings: Vec<String>,
    ) -> Result<Self, DomainError> {
        validate_section("routes", &routes)?;
        validate_section("tools", &tools)?;
        validate_section("presets", &presets)?;
        validate_section("settings", &settings)?;
        Ok(Self {
            routes,
            tools,
            presets,
            settings,
        })
    }

    pub fn routes(&self) -> &[String] {
        &self.routes
    }

    pub fn tools(&self) -> &[String] {
        &self.tools
    }

    pub fn presets(&self) -> &[String] {
        &self.presets
    }

    pub fn settings(&self) -> &[String] {
        &self.settings
    }
}

fn validate_section(section: &'static str, entries: &[String]) -> Result<(), DomainError> {
    let mut seen = HashSet::new();
    for (index, entry) in entries.iter().enumerate() {
        if entry.trim().is_empty() {
            return Err(SurfaceError::EmptyEntry { section, index }.into());
        }
        if !seen.insert(entry.as_str()) {
            return Err(SurfaceError::DuplicateEntry {
                section,
                name: entry.clone(),
            }
            .into());
        }
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TriggerRequest {
    pub experiment_id: ExperimentId,
    pub branch: BranchName,
    pub base_commit: CommitSha,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TicketRequest {
    pub program_id: ProgramId,
    pub issue_id: IssueId,
    pub experiment_id: ExperimentId,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerRequest {
    pub ticket_id: TicketId,
    pub experiment_id: ExperimentId,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitRequest {
    pub ticket_id: TicketId,
    pub worker_session_id: SessionId,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ReviewRequest {
    pub experiment_id: ExperimentId,
    pub benchmark: BenchmarkRecord,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnvironmentRequest {
    pub commit: CommitSha,
    pub environment: Environment,
}

#[derive(Debug, Clone, PartialEq)]
pub struct BenchmarkRequest {
    pub experiment_id: ExperimentId,
    pub ticket_id: TicketId,
    pub spec: BenchmarkSpec,
    pub commit: CommitSha,
    pub environment_digest: EnvironmentDigest,
    pub attempt: Attempt,
    pub max_attempts: Attempt,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolCall {
    pub name: String,
    pub arguments: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolOutput {
    pub content: String,
    pub is_error: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum HttpMethod {
    Get,
    Post,
    Put,
    Delete,
}

impl HttpMethod {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Get => "GET",
            Self::Post => "POST",
            Self::Put => "PUT",
            Self::Delete => "DELETE",
        }
    }
}

impl fmt::Display for HttpMethod {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpRequest {
    pub method: HttpMethod,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

pub trait Storage {
    async fn load_program(&self, id: &ProgramId) -> Result<Versioned<Program>, StorageError>;

    async fn save_program(
        &self,
        program: &Program,
        expected: Option<Version>,
    ) -> Result<Version, StorageError>;

    async fn load_issue(&self, id: &IssueId) -> Result<Versioned<Issue>, StorageError>;

    async fn save_issue(
        &self,
        issue: &Issue,
        expected: Option<Version>,
    ) -> Result<Version, StorageError>;

    async fn load_experiment(
        &self,
        id: &ExperimentId,
    ) -> Result<Versioned<Experiment>, StorageError>;

    async fn save_experiment(
        &self,
        experiment: &Experiment,
        expected: Option<Version>,
    ) -> Result<Version, StorageError>;

    async fn load_ticket(&self, id: &TicketId) -> Result<Versioned<Ticket>, StorageError>;

    async fn save_ticket(
        &self,
        ticket: &Ticket,
        expected: Option<Version>,
    ) -> Result<Version, StorageError>;

    async fn append_benchmark_record(&self, record: &BenchmarkRecord) -> Result<(), StorageError>;

    async fn load_benchmark_record(
        &self,
        id: &BenchmarkRunId,
    ) -> Result<BenchmarkRecord, StorageError>;

    async fn save_pipeline_run(
        &self,
        run: &PipelineRun,
        expected: Option<Version>,
    ) -> Result<Version, StorageError>;

    async fn load_pipeline_run(
        &self,
        id: &crate::id::PipelineRunId,
    ) -> Result<Versioned<PipelineRun>, StorageError>;

    async fn append_audit(&self, entry: &AuditEntry) -> Result<(), StorageError>;
}

pub trait TriggerSource {
    async fn deliver(&self, request: TriggerRequest) -> Result<crate::id::TriggerId, TriggerError>;
}

pub trait TicketExecutor {
    async fn open(&self, request: TicketRequest) -> Result<TicketId, TicketError>;
}

pub trait Sessions {
    async fn start_worker(&self, request: WorkerRequest) -> Result<SessionId, SessionError>;

    async fn submit_commit(&self, request: CommitRequest) -> Result<CommitSha, SessionError>;

    async fn review(&self, request: ReviewRequest) -> Result<ResearcherDecision, SessionError>;
}

pub trait BenchmarkRunner {
    async fn spec_hash(&self, spec: &BenchmarkSpec) -> Result<SpecHash, BenchmarkError>;

    async fn build_environment(
        &self,
        request: EnvironmentRequest,
    ) -> Result<EnvironmentDigest, BenchmarkError>;

    async fn run(&self, request: BenchmarkRequest) -> Result<BenchmarkRecord, BenchmarkError>;
}

pub trait Artifacts {
    async fn store(&self, artifact: Artifact) -> Result<ArtifactId, ArtifactError>;

    async fn load(&self, id: &ArtifactId) -> Result<Artifact, ArtifactError>;
}

pub trait Clock {
    fn now(&self) -> Timestamp;
}

pub trait Tools {
    async fn invoke(&self, call: ToolCall) -> Result<ToolOutput, ToolError>;
}

pub trait Http {
    async fn send(&self, request: HttpRequest) -> Result<HttpResponse, HttpError>;
}

pub trait Surface {
    fn manifest(&self) -> SurfaceManifest;
}

pub trait Plugin {
    type Storage: Storage;
    type Trigger: TriggerSource;
    type Executor: TicketExecutor;
    type Sessions: Sessions;
    type Benchmark: BenchmarkRunner;
    type Artifacts: Artifacts;
    type Clock: Clock;
    type Tools: Tools;
    type Http: Http;
    type Surface: Surface;

    fn storage(&self) -> &Self::Storage;

    fn trigger(&self) -> &Self::Trigger;

    fn executor(&self) -> &Self::Executor;

    fn sessions(&self) -> &Self::Sessions;

    fn benchmark(&self) -> &Self::Benchmark;

    fn artifacts(&self) -> &Self::Artifacts;

    fn clock(&self) -> &Self::Clock;

    fn tools(&self) -> &Self::Tools;

    fn http(&self) -> &Self::Http;

    fn surface(&self) -> &Self::Surface;
}

pub struct PipelineContext<'a, P: Plugin> {
    plugin: &'a P,
    program: Program,
}

impl<'a, P: Plugin> PipelineContext<'a, P> {
    pub fn new(plugin: &'a P, program: Program) -> Self {
        Self { plugin, program }
    }

    pub fn plugin(&self) -> &'a P {
        self.plugin
    }

    pub fn program(&self) -> &Program {
        &self.program
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_manifest_accepts_unique_entries() {
        let manifest = SurfaceManifest::new(
            vec!["GET /aleph/health".to_string()],
            vec!["aleph_status".to_string()],
            vec!["aleph-researcher".to_string()],
            vec!["aleph.enabled".to_string()],
        )
        .unwrap();
        assert_eq!(manifest.routes().len(), 1);
        assert_eq!(manifest.tools(), ["aleph_status"]);
        assert_eq!(manifest.presets(), ["aleph-researcher"]);
        assert_eq!(manifest.settings(), ["aleph.enabled"]);
    }

    #[test]
    fn a_manifest_rejects_empty_and_duplicate_entries() {
        assert!(matches!(
            SurfaceManifest::new(vec![" ".to_string()], Vec::new(), Vec::new(), Vec::new()),
            Err(DomainError::Surface(SurfaceError::EmptyEntry { .. }))
        ));
        assert!(matches!(
            SurfaceManifest::new(
                vec!["GET /a".to_string(), "GET /a".to_string()],
                Vec::new(),
                Vec::new(),
                Vec::new()
            ),
            Err(DomainError::Surface(SurfaceError::DuplicateEntry { .. }))
        ));
    }

    #[test]
    fn http_methods_have_stable_names() {
        assert_eq!(HttpMethod::Get.to_string(), "GET");
        assert_eq!(HttpMethod::Delete.as_str(), "DELETE");
    }
}
