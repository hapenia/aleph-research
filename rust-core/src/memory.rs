use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::collections::hash_map::Entry;
use std::hash::Hash;

use crate::domain::{
    Artifact, AuditEntry, BenchmarkRecord, BenchmarkRecordInput, BenchmarkSpec, BenchmarkStatus,
    Experiment, Issue, Metric, Program, ResearcherDecision, Ticket, Versioned,
};
use crate::error::{
    Aggregate, ArtifactError, BenchmarkError, HttpError, SessionError, StorageError, TicketError,
    ToolError, TriggerError,
};
use crate::id::{
    ArtifactId, BenchmarkRunId, CommitSha, EnvironmentDigest, ExperimentId, IssueId, PipelineRunId,
    ProgramId, SessionId, SpecHash, TicketId, TriggerId, Version,
};
use crate::plugin::{
    Artifacts, BenchmarkRequest, BenchmarkRunner, Clock, CommitRequest, EnvironmentRequest, Http,
    HttpRequest, HttpResponse, Plugin, ReviewRequest, Sessions, Storage, Surface, SurfaceManifest,
    TicketExecutor, TicketRequest, ToolCall, ToolOutput, Tools, TriggerRequest, TriggerSource,
    WorkerRequest,
};
use crate::stage::PipelineRun;
use crate::time::Timestamp;

#[derive(Debug, Default)]
pub struct InMemoryStorage {
    programs: RefCell<HashMap<ProgramId, Versioned<Program>>>,
    issues: RefCell<HashMap<IssueId, Versioned<Issue>>>,
    experiments: RefCell<HashMap<ExperimentId, Versioned<Experiment>>>,
    tickets: RefCell<HashMap<TicketId, Versioned<Ticket>>>,
    records: RefCell<HashMap<BenchmarkRunId, BenchmarkRecord>>,
    pipeline_runs: RefCell<HashMap<PipelineRunId, Versioned<PipelineRun>>>,
    audits: RefCell<Vec<AuditEntry>>,
}

fn load_entry<K, T>(
    entries: &RefCell<HashMap<K, Versioned<T>>>,
    key: &K,
    aggregate: Aggregate,
) -> Result<Versioned<T>, StorageError>
where
    K: Eq + Hash,
    T: Clone,
{
    entries
        .borrow()
        .get(key)
        .cloned()
        .ok_or(StorageError::NotFound { aggregate })
}

fn save_entry<K, T>(
    entries: &RefCell<HashMap<K, Versioned<T>>>,
    key: K,
    value: T,
    expected: Option<Version>,
) -> Result<Version, StorageError>
where
    K: Eq + Hash,
{
    let mut entries = entries.borrow_mut();
    let current = entries.get(&key).map(Versioned::version);
    let next = match (current, expected) {
        (None, None) => Version::first(),
        (None, Some(_)) => {
            return Err(StorageError::Conflict {
                expected,
                actual: None,
            });
        }
        (Some(actual), None) => {
            return Err(StorageError::Conflict {
                expected: None,
                actual: Some(actual),
            });
        }
        (Some(actual), Some(previous)) if actual == previous => {
            actual.next().map_err(|error| StorageError::Unavailable {
                detail: error.to_string(),
            })?
        }
        (Some(actual), Some(_)) => {
            return Err(StorageError::Conflict {
                expected,
                actual: Some(actual),
            });
        }
    };
    entries.insert(key, Versioned::new(value, next));
    Ok(next)
}

impl InMemoryStorage {
    pub fn put_program(&self, program: Program) -> Result<Version, StorageError> {
        save_entry(&self.programs, program.id().clone(), program, None)
    }

    pub fn audits(&self) -> Vec<AuditEntry> {
        self.audits.borrow().clone()
    }
}

impl Storage for InMemoryStorage {
    async fn load_program(&self, id: &ProgramId) -> Result<Versioned<Program>, StorageError> {
        load_entry(&self.programs, id, Aggregate::Program)
    }

    async fn save_program(
        &self,
        program: &Program,
        expected: Option<Version>,
    ) -> Result<Version, StorageError> {
        save_entry(
            &self.programs,
            program.id().clone(),
            program.clone(),
            expected,
        )
    }

    async fn load_issue(&self, id: &IssueId) -> Result<Versioned<Issue>, StorageError> {
        load_entry(&self.issues, id, Aggregate::Issue)
    }

    async fn save_issue(
        &self,
        issue: &Issue,
        expected: Option<Version>,
    ) -> Result<Version, StorageError> {
        save_entry(&self.issues, issue.id().clone(), issue.clone(), expected)
    }

    async fn load_experiment(
        &self,
        id: &ExperimentId,
    ) -> Result<Versioned<Experiment>, StorageError> {
        load_entry(&self.experiments, id, Aggregate::Experiment)
    }

    async fn save_experiment(
        &self,
        experiment: &Experiment,
        expected: Option<Version>,
    ) -> Result<Version, StorageError> {
        save_entry(
            &self.experiments,
            experiment.id().clone(),
            experiment.clone(),
            expected,
        )
    }

    async fn load_ticket(&self, id: &TicketId) -> Result<Versioned<Ticket>, StorageError> {
        load_entry(&self.tickets, id, Aggregate::Ticket)
    }

    async fn save_ticket(
        &self,
        ticket: &Ticket,
        expected: Option<Version>,
    ) -> Result<Version, StorageError> {
        save_entry(&self.tickets, ticket.id().clone(), ticket.clone(), expected)
    }

    async fn append_benchmark_record(&self, record: &BenchmarkRecord) -> Result<(), StorageError> {
        match self.records.borrow_mut().entry(record.id().clone()) {
            Entry::Occupied(_) => Err(StorageError::AlreadyExists {
                aggregate: Aggregate::BenchmarkRecord,
            }),
            Entry::Vacant(slot) => {
                slot.insert(record.clone());
                Ok(())
            }
        }
    }

    async fn load_benchmark_record(
        &self,
        id: &BenchmarkRunId,
    ) -> Result<BenchmarkRecord, StorageError> {
        self.records
            .borrow()
            .get(id)
            .cloned()
            .ok_or(StorageError::NotFound {
                aggregate: Aggregate::BenchmarkRecord,
            })
    }

    async fn save_pipeline_run(
        &self,
        run: &PipelineRun,
        expected: Option<Version>,
    ) -> Result<Version, StorageError> {
        save_entry(&self.pipeline_runs, run.id().clone(), run.clone(), expected)
    }

    async fn load_pipeline_run(
        &self,
        id: &PipelineRunId,
    ) -> Result<Versioned<PipelineRun>, StorageError> {
        load_entry(&self.pipeline_runs, id, Aggregate::PipelineRun)
    }

    async fn append_audit(&self, entry: &AuditEntry) -> Result<(), StorageError> {
        self.audits.borrow_mut().push(entry.clone());
        Ok(())
    }
}

#[derive(Debug, Default)]
pub struct InMemoryTriggerSource {
    counter: Cell<u64>,
    failure: Option<TriggerError>,
}

impl InMemoryTriggerSource {
    pub fn failing(mut self, failure: TriggerError) -> Self {
        self.failure = Some(failure);
        self
    }
}

impl TriggerSource for InMemoryTriggerSource {
    async fn deliver(&self, _request: TriggerRequest) -> Result<TriggerId, TriggerError> {
        if let Some(failure) = &self.failure {
            return Err(failure.clone());
        }
        let next = self.counter.get() + 1;
        self.counter.set(next);
        TriggerId::new(format!("trigger-{next}")).map_err(|error| TriggerError::Rejected {
            detail: error.to_string(),
        })
    }
}

#[derive(Debug, Default)]
pub struct InMemoryTicketExecutor {
    counter: Cell<u64>,
    failure: Option<TicketError>,
}

impl InMemoryTicketExecutor {
    pub fn failing(mut self, failure: TicketError) -> Self {
        self.failure = Some(failure);
        self
    }
}

impl TicketExecutor for InMemoryTicketExecutor {
    async fn open(&self, _request: TicketRequest) -> Result<TicketId, TicketError> {
        if let Some(failure) = &self.failure {
            return Err(failure.clone());
        }
        let next = self.counter.get() + 1;
        self.counter.set(next);
        TicketId::new(format!("ticket-{next}")).map_err(|error| TicketError::Rejected {
            detail: error.to_string(),
        })
    }
}

#[derive(Debug)]
pub struct InMemorySessions {
    commit: CommitSha,
    decision: ResearcherDecision,
    counter: Cell<u64>,
    start_failure: Option<SessionError>,
    commit_failure: Option<SessionError>,
    review_failure: Option<SessionError>,
}

impl InMemorySessions {
    pub fn with_commit(mut self, commit: CommitSha) -> Self {
        self.commit = commit;
        self
    }

    pub fn with_decision(mut self, decision: ResearcherDecision) -> Self {
        self.decision = decision;
        self
    }

    pub fn with_start_failure(mut self, failure: SessionError) -> Self {
        self.start_failure = Some(failure);
        self
    }

    pub fn with_commit_failure(mut self, failure: SessionError) -> Self {
        self.commit_failure = Some(failure);
        self
    }

    pub fn with_review_failure(mut self, failure: SessionError) -> Self {
        self.review_failure = Some(failure);
        self
    }
}

impl Default for InMemorySessions {
    fn default() -> Self {
        Self {
            commit: CommitSha::zero(),
            decision: ResearcherDecision::Propose,
            counter: Cell::new(0),
            start_failure: None,
            commit_failure: None,
            review_failure: None,
        }
    }
}

impl Sessions for InMemorySessions {
    async fn start_worker(&self, _request: WorkerRequest) -> Result<SessionId, SessionError> {
        if let Some(failure) = &self.start_failure {
            return Err(failure.clone());
        }
        let next = self.counter.get() + 1;
        self.counter.set(next);
        SessionId::new(format!("session-{next}")).map_err(|error| SessionError::Rejected {
            detail: error.to_string(),
        })
    }

    async fn submit_commit(&self, _request: CommitRequest) -> Result<CommitSha, SessionError> {
        if let Some(failure) = &self.commit_failure {
            return Err(failure.clone());
        }
        Ok(self.commit.clone())
    }

    async fn review(&self, _request: ReviewRequest) -> Result<ResearcherDecision, SessionError> {
        if let Some(failure) = &self.review_failure {
            return Err(failure.clone());
        }
        Ok(self.decision)
    }
}

#[derive(Debug)]
pub struct InMemoryBenchmark {
    spec_hash: SpecHash,
    environment_digest: EnvironmentDigest,
    status: BenchmarkStatus,
    metrics: Vec<Metric>,
    stdout: String,
    stderr: String,
    artifacts: Vec<ArtifactId>,
    created_at: Timestamp,
    counter: Cell<u64>,
    status_sequence: Vec<BenchmarkStatus>,
    hash_failure: Option<BenchmarkError>,
    environment_failure: Option<BenchmarkError>,
    run_failure: Option<BenchmarkError>,
    record_spec_hash: Option<SpecHash>,
    record_environment_digest: Option<EnvironmentDigest>,
}

impl Default for InMemoryBenchmark {
    fn default() -> Self {
        Self {
            spec_hash: SpecHash::default(),
            environment_digest: EnvironmentDigest::default(),
            status: BenchmarkStatus::Passed,
            metrics: Vec::new(),
            stdout: String::new(),
            stderr: String::new(),
            artifacts: Vec::new(),
            created_at: Timestamp::UNIX_EPOCH,
            counter: Cell::new(0),
            status_sequence: Vec::new(),
            hash_failure: None,
            environment_failure: None,
            run_failure: None,
            record_spec_hash: None,
            record_environment_digest: None,
        }
    }
}

impl InMemoryBenchmark {
    pub fn with_spec_hash(mut self, spec_hash: SpecHash) -> Self {
        self.spec_hash = spec_hash;
        self
    }

    pub fn with_environment_digest(mut self, environment_digest: EnvironmentDigest) -> Self {
        self.environment_digest = environment_digest;
        self
    }

    pub fn with_status(mut self, status: BenchmarkStatus) -> Self {
        self.status = status;
        self
    }

    pub fn with_metrics(mut self, metrics: Vec<Metric>) -> Self {
        self.metrics = metrics;
        self
    }

    pub fn with_artifacts(mut self, artifacts: Vec<ArtifactId>) -> Self {
        self.artifacts = artifacts;
        self
    }

    pub fn with_created_at(mut self, created_at: Timestamp) -> Self {
        self.created_at = created_at;
        self
    }

    pub fn with_status_sequence(mut self, status_sequence: Vec<BenchmarkStatus>) -> Self {
        self.status_sequence = status_sequence;
        self
    }

    pub fn with_hash_failure(mut self, failure: BenchmarkError) -> Self {
        self.hash_failure = Some(failure);
        self
    }

    pub fn with_environment_failure(mut self, failure: BenchmarkError) -> Self {
        self.environment_failure = Some(failure);
        self
    }

    pub fn with_run_failure(mut self, failure: BenchmarkError) -> Self {
        self.run_failure = Some(failure);
        self
    }

    pub fn with_record_spec_hash(mut self, spec_hash: SpecHash) -> Self {
        self.record_spec_hash = Some(spec_hash);
        self
    }

    pub fn with_record_environment_digest(mut self, environment_digest: EnvironmentDigest) -> Self {
        self.record_environment_digest = Some(environment_digest);
        self
    }
}

impl BenchmarkRunner for InMemoryBenchmark {
    async fn spec_hash(&self, _spec: &BenchmarkSpec) -> Result<SpecHash, BenchmarkError> {
        if let Some(failure) = &self.hash_failure {
            return Err(failure.clone());
        }
        Ok(self.spec_hash.clone())
    }

    async fn build_environment(
        &self,
        _request: EnvironmentRequest,
    ) -> Result<EnvironmentDigest, BenchmarkError> {
        if let Some(failure) = &self.environment_failure {
            return Err(failure.clone());
        }
        Ok(self.environment_digest.clone())
    }

    async fn run(&self, request: BenchmarkRequest) -> Result<BenchmarkRecord, BenchmarkError> {
        if let Some(failure) = &self.run_failure {
            return Err(failure.clone());
        }
        let next = self.counter.get() + 1;
        self.counter.set(next);
        let status = self
            .status_sequence
            .get(next as usize - 1)
            .copied()
            .unwrap_or(self.status);
        let record_spec_hash = self
            .record_spec_hash
            .clone()
            .unwrap_or_else(|| self.spec_hash.clone());
        let record_environment_digest = self
            .record_environment_digest
            .clone()
            .unwrap_or_else(|| request.environment_digest.clone());
        let metrics = if self.metrics.is_empty() {
            let mut metrics = Vec::with_capacity(request.spec.metrics().len());
            for metric in request.spec.metrics() {
                metrics.push(Metric::new(metric.name(), 0.0).map_err(|error| {
                    BenchmarkError::Rejected {
                        detail: error.to_string(),
                    }
                })?);
            }
            metrics
        } else {
            self.metrics.clone()
        };
        let id = BenchmarkRunId::new(format!("benchmark-{next}")).map_err(|error| {
            BenchmarkError::Rejected {
                detail: error.to_string(),
            }
        })?;
        BenchmarkRecord::new(BenchmarkRecordInput {
            id,
            experiment_id: request.experiment_id,
            ticket_id: request.ticket_id,
            commit: request.commit,
            spec_hash: record_spec_hash,
            environment_digest: record_environment_digest,
            metrics,
            status,
            attempt: request.attempt,
            max_attempts: request.max_attempts,
            stdout: self.stdout.clone(),
            stderr: self.stderr.clone(),
            artifacts: self.artifacts.clone(),
            created_at: self.created_at,
        })
        .map_err(|error| BenchmarkError::Rejected {
            detail: error.to_string(),
        })
    }
}

#[derive(Debug, Default)]
pub struct InMemoryArtifacts {
    entries: RefCell<HashMap<ArtifactId, Artifact>>,
    counter: Cell<u64>,
}

impl Artifacts for InMemoryArtifacts {
    async fn store(&self, artifact: Artifact) -> Result<ArtifactId, ArtifactError> {
        let next = self.counter.get() + 1;
        self.counter.set(next);
        let id = ArtifactId::new(format!("artifact-{next}")).map_err(|error| {
            ArtifactError::Rejected {
                detail: error.to_string(),
            }
        })?;
        self.entries.borrow_mut().insert(id.clone(), artifact);
        Ok(id)
    }

    async fn load(&self, id: &ArtifactId) -> Result<Artifact, ArtifactError> {
        self.entries
            .borrow()
            .get(id)
            .cloned()
            .ok_or(ArtifactError::Rejected {
                detail: format!("artifact {id} is not stored"),
            })
    }
}

#[derive(Debug, Default)]
pub struct InMemoryClock {
    now: Timestamp,
}

impl InMemoryClock {
    pub fn with_now(mut self, now: Timestamp) -> Self {
        self.now = now;
        self
    }
}

impl Clock for InMemoryClock {
    async fn now(&self) -> Result<Timestamp, crate::error::ClockError> {
        Ok(self.now)
    }
}

#[derive(Debug, Default)]
pub struct InMemoryTools;

impl Tools for InMemoryTools {
    async fn invoke(&self, _call: ToolCall) -> Result<ToolOutput, ToolError> {
        Ok(ToolOutput {
            content: String::new(),
            is_error: false,
        })
    }
}

#[derive(Debug, Default)]
pub struct InMemoryHttp;

impl Http for InMemoryHttp {
    async fn send(&self, _request: HttpRequest) -> Result<HttpResponse, HttpError> {
        Ok(HttpResponse {
            status: 200,
            headers: Vec::new(),
            body: Vec::new(),
        })
    }
}

#[derive(Debug)]
pub struct InMemorySurface {
    manifest: SurfaceManifest,
}

impl Default for InMemorySurface {
    fn default() -> Self {
        Self {
            manifest: SurfaceManifest::new(
                vec!["GET /aleph/health".to_string()],
                vec!["aleph_status".to_string()],
                vec!["aleph-researcher".to_string()],
                vec!["aleph.enabled".to_string()],
            )
            .expect("default surface manifest is valid"),
        }
    }
}

impl InMemorySurface {
    pub fn with_manifest(manifest: SurfaceManifest) -> Self {
        Self { manifest }
    }
}

impl Surface for InMemorySurface {
    fn manifest(&self) -> SurfaceManifest {
        self.manifest.clone()
    }
}

#[derive(Debug, Default)]
pub struct InMemoryPlugin {
    pub storage: InMemoryStorage,
    pub trigger: InMemoryTriggerSource,
    pub executor: InMemoryTicketExecutor,
    pub sessions: InMemorySessions,
    pub benchmark: InMemoryBenchmark,
    pub artifacts: InMemoryArtifacts,
    pub clock: InMemoryClock,
    pub tools: InMemoryTools,
    pub http: InMemoryHttp,
    pub surface: InMemorySurface,
}

impl Plugin for InMemoryPlugin {
    type Storage = InMemoryStorage;
    type Trigger = InMemoryTriggerSource;
    type Executor = InMemoryTicketExecutor;
    type Sessions = InMemorySessions;
    type Benchmark = InMemoryBenchmark;
    type Artifacts = InMemoryArtifacts;
    type Clock = InMemoryClock;
    type Tools = InMemoryTools;
    type Http = InMemoryHttp;
    type Surface = InMemorySurface;

    fn storage(&self) -> &Self::Storage {
        &self.storage
    }

    fn trigger(&self) -> &Self::Trigger {
        &self.trigger
    }

    fn executor(&self) -> &Self::Executor {
        &self.executor
    }

    fn sessions(&self) -> &Self::Sessions {
        &self.sessions
    }

    fn benchmark(&self) -> &Self::Benchmark {
        &self.benchmark
    }

    fn artifacts(&self) -> &Self::Artifacts {
        &self.artifacts
    }

    fn clock(&self) -> &Self::Clock {
        &self.clock
    }

    fn tools(&self) -> &Self::Tools {
        &self.tools
    }

    fn http(&self) -> &Self::Http {
        &self.http
    }

    fn surface(&self) -> &Self::Surface {
        &self.surface
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn block_on<F: std::future::Future>(future: F) -> F::Output {
        let mut future = std::pin::pin!(future);
        let mut context = std::task::Context::from_waker(std::task::Waker::noop());
        match future.as_mut().poll(&mut context) {
            std::task::Poll::Ready(output) => output,
            std::task::Poll::Pending => panic!("in-memory future suspended"),
        }
    }

    #[test]
    fn in_memory_storage_requires_unique_programs() {
        let storage = InMemoryStorage::default();
        let program = crate::domain::Program::new(crate::domain::ProgramInput {
            id: ProgramId::new("program-1").unwrap(),
            owner: crate::id::ActorId::new("operator-1").unwrap(),
            name: "Program".to_string(),
            goal: String::new(),
            methodology: String::new(),
            benchmark: BenchmarkSpec::new(
                crate::id::BenchmarkSpecId::new("benchmark-1").unwrap(),
                "bench.py",
                1_000,
                vec![
                    crate::domain::BenchmarkMetric::new(
                        "score",
                        crate::domain::MetricDirection::Maximize,
                        true,
                        None,
                    )
                    .unwrap(),
                ],
                0,
                std::collections::BTreeMap::new(),
                None,
            )
            .unwrap(),
            utility: vec![
                crate::domain::MetricWeight::new(
                    "score",
                    crate::domain::MetricDirection::Maximize,
                    1.0,
                )
                .unwrap(),
            ],
            exploration: crate::domain::Exploration::Normal,
            policy: crate::domain::ResearchPolicy::default(),
            usage: crate::domain::Usage::ZERO,
            status: crate::domain::ProgramStatus::Running,
            created_at: Timestamp::UNIX_EPOCH,
        })
        .unwrap();
        let version = storage.put_program(program).unwrap();
        assert_eq!(version, Version::first());
        assert!(storage.audits().is_empty());
    }

    #[test]
    fn in_memory_benchmark_defaults_to_a_passing_runner() {
        let benchmark = InMemoryBenchmark::default();
        assert_eq!(benchmark.status, BenchmarkStatus::Passed);
        assert_eq!(benchmark.spec_hash, SpecHash::default());
        assert_eq!(benchmark.environment_digest, EnvironmentDigest::default());
    }

    #[test]
    fn in_memory_sessions_default_to_a_proposal() {
        let sessions = InMemorySessions::default();
        assert!(sessions.commit.is_zero());
        assert_eq!(sessions.decision, ResearcherDecision::Propose);
    }

    #[test]
    fn the_default_plugin_surface_is_complete() {
        let plugin = InMemoryPlugin::default();
        let manifest = plugin.surface().manifest();
        assert_eq!(manifest.routes().len(), 1);
        assert_eq!(manifest.tools().len(), 1);
        assert_eq!(manifest.presets().len(), 1);
        assert_eq!(manifest.settings().len(), 1);
        assert_eq!(
            block_on(plugin.clock().now()).unwrap(),
            Timestamp::UNIX_EPOCH
        );
    }
}
