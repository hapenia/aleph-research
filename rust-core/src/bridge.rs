use std::cell::{Cell, RefCell};
use std::future::Future;
use std::pin::Pin;
use std::task::{Context, Poll, Waker};

use crate::domain::{
    Artifact, BenchmarkRecord, BenchmarkSpec, Program, ResearcherDecision, Versioned,
};
use crate::error::{
    ArtifactError, BenchmarkError, ClockError, DomainError, HttpError, SessionError, StorageError,
    TicketError, ToolError, TriggerError,
};
use crate::id::{
    ArtifactId, BenchmarkRunId, BranchName, CommitSha, EnvironmentDigest, ExperimentId, IssueId,
    PipelineRunId, ProgramId, SessionId, SpecHash, TicketId, TriggerId, Version,
};
use crate::pipeline::run_pipeline;
use crate::plugin::{
    Artifacts, BenchmarkRequest, BenchmarkRunner, Clock, CommitRequest, EnvironmentRequest, Http,
    HttpRequest, HttpResponse, Plugin, ReviewRequest, Sessions, Storage, Surface, SurfaceManifest,
    TicketExecutor, TicketRequest, ToolCall, ToolOutput, Tools, TriggerRequest, TriggerSource,
    WorkerRequest,
};
use crate::stage::{ExperimentProposed, ResearchCompleted, StageName};
use crate::time::Timestamp;
use crate::wire::{self, Decoder, Encoder};

pub const BRIDGE_VERSION: u32 = 1;

const STORAGE_UNEXPOSED: &str = "the storage effect is not exposed by the bridge";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EffectName {
    StorageLoadProgram = 0,
    TriggerDeliver = 1,
    ExecutorOpen = 2,
    SessionsStartWorker = 3,
    SessionsSubmitCommit = 4,
    BenchmarkBuildEnvironment = 5,
    BenchmarkSpecHash = 6,
    BenchmarkRun = 7,
    StorageAppendBenchmarkRecord = 8,
    SessionsReview = 9,
    ClockNow = 10,
}

impl EffectName {
    const fn code(self) -> u8 {
        self as u8
    }

    const fn from_code(code: u8) -> Option<Self> {
        match code {
            0 => Some(Self::StorageLoadProgram),
            1 => Some(Self::TriggerDeliver),
            2 => Some(Self::ExecutorOpen),
            3 => Some(Self::SessionsStartWorker),
            4 => Some(Self::SessionsSubmitCommit),
            5 => Some(Self::BenchmarkBuildEnvironment),
            6 => Some(Self::BenchmarkSpecHash),
            7 => Some(Self::BenchmarkRun),
            8 => Some(Self::StorageAppendBenchmarkRecord),
            9 => Some(Self::SessionsReview),
            10 => Some(Self::ClockNow),
            _ => None,
        }
    }

    const fn as_str(self) -> &'static str {
        match self {
            Self::StorageLoadProgram => "storage.loadProgram",
            Self::TriggerDeliver => "trigger.deliver",
            Self::ExecutorOpen => "executor.open",
            Self::SessionsStartWorker => "sessions.startWorker",
            Self::SessionsSubmitCommit => "sessions.submitCommit",
            Self::BenchmarkBuildEnvironment => "benchmark.buildEnvironment",
            Self::BenchmarkSpecHash => "benchmark.specHash",
            Self::BenchmarkRun => "benchmark.run",
            Self::StorageAppendBenchmarkRecord => "storage.appendBenchmarkRecord",
            Self::SessionsReview => "sessions.review",
            Self::ClockNow => "clock.now",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FailureKind {
    Rejected = 0,
    Unavailable = 1,
}

impl FailureKind {
    const fn from_code(code: u8) -> Option<Self> {
        match code {
            0 => Some(Self::Rejected),
            1 => Some(Self::Unavailable),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct HostFailure {
    kind: FailureKind,
    message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Effect {
    name: EffectName,
    sequence: u64,
    payload: Vec<u8>,
}

type EffectResult = Result<Vec<u8>, HostFailure>;
type PipelineFuture = Pin<Box<dyn Future<Output = Result<ResearchCompleted, DomainError>>>>;

struct Run {
    future: PipelineFuture,
}

struct Resume {
    sequence: u64,
    effect: EffectName,
    result: EffectResult,
}

thread_local! {
    static RUN: RefCell<Option<Run>> = const { RefCell::new(None) };
    static EFFECT: RefCell<Option<Effect>> = const { RefCell::new(None) };
    static RESPONSE: RefCell<Option<EffectResult>> = const { RefCell::new(None) };
    static PENDING: Cell<Option<(u64, EffectName)>> = const { Cell::new(None) };
    static SEQUENCE: Cell<u64> = const { Cell::new(0) };
    static STAGE: Cell<StageName> = const { Cell::new(StageName::ExperimentProposed) };
    static TRACE: RefCell<Vec<StageName>> = const { RefCell::new(Vec::new()) };
    static ORDER_BROKEN: Cell<bool> = const { Cell::new(false) };
}

pub const fn version() -> u32 {
    BRIDGE_VERSION
}

pub fn start(request: &[u8]) -> Vec<u8> {
    let initial = match decode_start(request) {
        Ok(initial) => initial,
        Err(_) => return frame_protocol("the start request is malformed"),
    };
    reset();
    RUN.with(|slot| {
        *slot.borrow_mut() = Some(Run {
            future: Box::pin(run_pipeline(&PLUGIN, initial)),
        });
    });
    poll_frame()
}

pub fn resume(request: &[u8]) -> Vec<u8> {
    let request = match decode_resume(request) {
        Ok(request) => request,
        Err(_) => return frame_protocol("the resume request is malformed"),
    };
    match PENDING.with(Cell::get) {
        Some((sequence, effect)) if sequence == request.sequence && effect == request.effect => {}
        Some((sequence, effect)) => {
            return frame_protocol(&format!(
                "expected {} #{sequence}, received {} #{}",
                effect.as_str(),
                request.effect.as_str(),
                request.sequence
            ));
        }
        None => return frame_protocol("no effect is pending"),
    }
    PENDING.with(|cell| cell.set(None));
    RESPONSE.with(|slot| *slot.borrow_mut() = Some(request.result));
    poll_frame()
}

fn reset() {
    RUN.with(|slot| *slot.borrow_mut() = None);
    EFFECT.with(|slot| *slot.borrow_mut() = None);
    RESPONSE.with(|slot| *slot.borrow_mut() = None);
    PENDING.with(|cell| cell.set(None));
    SEQUENCE.with(|cell| cell.set(0));
    STAGE.with(|cell| cell.set(StageName::ExperimentProposed));
    TRACE.with(|trace| {
        let mut trace = trace.borrow_mut();
        trace.clear();
        trace.push(StageName::ExperimentProposed);
    });
    ORDER_BROKEN.with(|cell| cell.set(false));
}

fn poll_frame() -> Vec<u8> {
    let polled = RUN.with(|slot| {
        let mut guard = slot.borrow_mut();
        let run = guard.as_mut()?;
        let mut context = Context::from_waker(Waker::noop());
        Some(run.future.as_mut().poll(&mut context))
    });
    match polled {
        None => frame_protocol("no pipeline is running"),
        Some(Poll::Ready(result)) => {
            RUN.with(|slot| *slot.borrow_mut() = None);
            match result {
                Ok(completed) => frame_completed(&completed),
                Err(error) => frame_domain(&error),
            }
        }
        Some(Poll::Pending) => {
            if ORDER_BROKEN.with(Cell::get) {
                RUN.with(|slot| *slot.borrow_mut() = None);
                return frame_protocol("the pipeline left the declared stage order");
            }
            match take_effect() {
                Some(effect) => frame_effect(&effect),
                None => frame_protocol("the pipeline suspended without an effect"),
            }
        }
    }
}

fn take_effect() -> Option<Effect> {
    let effect = EFFECT.with(|slot| slot.borrow_mut().take());
    if let Some(effect) = &effect {
        PENDING.with(|cell| cell.set(Some((effect.sequence, effect.name))));
    }
    effect
}

fn advance(stage: StageName) {
    let current = STAGE.with(Cell::get);
    if !current.successors().contains(&stage) {
        ORDER_BROKEN.with(|cell| cell.set(true));
        return;
    }
    STAGE.with(|cell| cell.set(stage));
    TRACE.with(|trace| trace.borrow_mut().push(stage));
}

fn frame_effect(effect: &Effect) -> Vec<u8> {
    let mut encoder = Encoder::new();
    encoder.u8(0);
    encoder.u8(effect.name.code());
    encoder.u64(effect.sequence);
    encoder.u8(STAGE.with(Cell::get).code() as u8);
    encoder.bytes(&effect.payload);
    encoder.finish()
}

fn frame_completed(completed: &ResearchCompleted) -> Vec<u8> {
    let mut encoder = Encoder::new();
    encoder.u8(1);
    encoder.u8(match completed.outcome() {
        crate::domain::ResearchOutcome::Concluded => 0,
        crate::domain::ResearchOutcome::Failed => 1,
        crate::domain::ResearchOutcome::Cancelled => 2,
    });
    let trace = TRACE.with(|trace| trace.borrow().clone());
    encoder.u32(trace.len() as u32);
    for stage in trace {
        encoder.u8(stage.code() as u8);
    }
    encoder.finish()
}

fn frame_protocol(message: &str) -> Vec<u8> {
    let mut encoder = Encoder::new();
    encoder.u8(2);
    encoder.string(message);
    encoder.finish()
}

fn frame_domain(error: &DomainError) -> Vec<u8> {
    let mut encoder = Encoder::new();
    encoder.u8(3);
    encoder.string(&error.to_string());
    encoder.finish()
}

fn decode_start(bytes: &[u8]) -> Result<ExperimentProposed, wire::DecodeError> {
    let mut decoder = Decoder::new(bytes);
    let program_id = ProgramId::new(decoder.string()?).map_err(|_| wire::DecodeError)?;
    let issue_id = IssueId::new(decoder.string()?).map_err(|_| wire::DecodeError)?;
    let experiment_id = ExperimentId::new(decoder.string()?).map_err(|_| wire::DecodeError)?;
    let branch = BranchName::new(decoder.string()?).map_err(|_| wire::DecodeError)?;
    let base_commit = CommitSha::new(decoder.string()?).map_err(|_| wire::DecodeError)?;
    let environment = wire::decode_environment(&mut decoder)?;
    decoder.finish()?;
    Ok(ExperimentProposed::new(
        program_id,
        issue_id,
        experiment_id,
        branch,
        base_commit,
        environment,
    ))
}

fn decode_resume(bytes: &[u8]) -> Result<Resume, wire::DecodeError> {
    let mut decoder = Decoder::new(bytes);
    let sequence = decoder.u64()?;
    let effect = EffectName::from_code(decoder.u8()?).ok_or(wire::DecodeError)?;
    let result = match decoder.u8()? {
        0 => Ok(decoder.bytes()?.to_vec()),
        1 => {
            let kind = FailureKind::from_code(decoder.u8()?).ok_or(wire::DecodeError)?;
            let message = decoder.string()?.to_string();
            Err(HostFailure { kind, message })
        }
        _ => return Err(wire::DecodeError),
    };
    decoder.finish()?;
    Ok(Resume {
        sequence,
        effect,
        result,
    })
}

struct HostRequest {
    name: EffectName,
    payload: Option<Vec<u8>>,
    sent: bool,
}

impl Future for HostRequest {
    type Output = EffectResult;

    fn poll(self: Pin<&mut Self>, _context: &mut Context<'_>) -> Poll<Self::Output> {
        let request = self.get_mut();
        if !request.sent {
            let sequence = SEQUENCE.with(|cell| {
                let next = cell.get() + 1;
                cell.set(next);
                next
            });
            let payload = request.payload.take().unwrap_or_default();
            EFFECT.with(|slot| {
                *slot.borrow_mut() = Some(Effect {
                    name: request.name,
                    sequence,
                    payload,
                });
            });
            request.sent = true;
            return Poll::Pending;
        }
        match RESPONSE.with(|slot| slot.borrow_mut().take()) {
            Some(result) => Poll::Ready(result),
            None => Poll::Pending,
        }
    }
}

async fn host_request(name: EffectName, payload: Vec<u8>) -> EffectResult {
    HostRequest {
        name,
        payload: Some(payload),
        sent: false,
    }
    .await
}

fn storage_failure(failure: HostFailure) -> StorageError {
    StorageError::Unavailable {
        detail: failure.message,
    }
}

fn trigger_failure(failure: HostFailure) -> TriggerError {
    match failure.kind {
        FailureKind::Rejected => TriggerError::Rejected {
            detail: failure.message,
        },
        FailureKind::Unavailable => TriggerError::Unavailable {
            detail: failure.message,
        },
    }
}

fn ticket_failure(failure: HostFailure) -> TicketError {
    match failure.kind {
        FailureKind::Rejected => TicketError::Rejected {
            detail: failure.message,
        },
        FailureKind::Unavailable => TicketError::Unavailable {
            detail: failure.message,
        },
    }
}

fn session_failure(failure: HostFailure) -> SessionError {
    match failure.kind {
        FailureKind::Rejected => SessionError::Rejected {
            detail: failure.message,
        },
        FailureKind::Unavailable => SessionError::Unavailable {
            detail: failure.message,
        },
    }
}

fn benchmark_failure(failure: HostFailure) -> BenchmarkError {
    match failure.kind {
        FailureKind::Rejected => BenchmarkError::Rejected {
            detail: failure.message,
        },
        FailureKind::Unavailable => BenchmarkError::Unavailable {
            detail: failure.message,
        },
    }
}

fn clock_failure(failure: HostFailure) -> ClockError {
    match failure.kind {
        FailureKind::Rejected => ClockError::Rejected {
            detail: failure.message,
        },
        FailureKind::Unavailable => ClockError::Unavailable {
            detail: failure.message,
        },
    }
}

fn decode_id<T>(
    bytes: &[u8],
    parse: impl FnOnce(&str) -> Result<T, crate::error::IdError>,
) -> Result<T, HostFailure> {
    let malformed = |message: String| HostFailure {
        kind: FailureKind::Unavailable,
        message,
    };
    let mut decoder = Decoder::new(bytes);
    let value = decoder
        .string()
        .map_err(|_| malformed("the host response is malformed".to_string()))?;
    let parsed = parse(value).map_err(|error| malformed(format!("invalid identifier: {error}")))?;
    decoder
        .finish()
        .map_err(|_| malformed("the host response has trailing bytes".to_string()))?;
    Ok(parsed)
}

fn decode_program(bytes: &[u8]) -> Result<Versioned<Program>, wire::DecodeError> {
    let mut decoder = Decoder::new(bytes);
    let program = wire::decode_program(&mut decoder)?;
    decoder.finish()?;
    Ok(program)
}

fn decode_record(bytes: &[u8]) -> Result<BenchmarkRecord, wire::DecodeError> {
    let mut decoder = Decoder::new(bytes);
    let record = wire::decode_record(&mut decoder)?;
    decoder.finish()?;
    Ok(record)
}

fn decode_decision(bytes: &[u8]) -> Result<ResearcherDecision, wire::DecodeError> {
    let mut decoder = Decoder::new(bytes);
    let decision = wire::decode_decision(&mut decoder)?;
    decoder.finish()?;
    Ok(decision)
}

fn decode_timestamp(bytes: &[u8]) -> Result<Timestamp, wire::DecodeError> {
    let mut decoder = Decoder::new(bytes);
    let timestamp = wire::decode_timestamp(&mut decoder)?;
    decoder.finish()?;
    Ok(timestamp)
}

fn decode_spec_hash(bytes: &[u8]) -> Result<SpecHash, wire::DecodeError> {
    decode_id(bytes, |value| SpecHash::new(value)).map_err(|_| wire::DecodeError)
}

fn decode_environment_digest(bytes: &[u8]) -> Result<EnvironmentDigest, wire::DecodeError> {
    decode_id(bytes, |value| EnvironmentDigest::new(value)).map_err(|_| wire::DecodeError)
}

fn expect_empty(bytes: &[u8]) -> Result<(), wire::DecodeError> {
    Decoder::new(bytes).finish()
}

struct BridgePlugin;

struct BridgeStorage;
struct BridgeTrigger;
struct BridgeExecutor;
struct BridgeSessions;
struct BridgeBenchmark;
struct BridgeArtifacts;
struct BridgeClock;
struct BridgeTools;
struct BridgeHttp;
struct BridgeSurface;

static PLUGIN: BridgePlugin = BridgePlugin;
static STORAGE: BridgeStorage = BridgeStorage;
static TRIGGER: BridgeTrigger = BridgeTrigger;
static EXECUTOR: BridgeExecutor = BridgeExecutor;
static SESSIONS: BridgeSessions = BridgeSessions;
static BENCHMARK: BridgeBenchmark = BridgeBenchmark;
static ARTIFACTS: BridgeArtifacts = BridgeArtifacts;
static CLOCK: BridgeClock = BridgeClock;
static TOOLS: BridgeTools = BridgeTools;
static HTTP: BridgeHttp = BridgeHttp;
static SURFACE: BridgeSurface = BridgeSurface;

impl Storage for BridgeStorage {
    async fn load_program(&self, id: &ProgramId) -> Result<Versioned<Program>, StorageError> {
        let mut encoder = Encoder::new();
        encoder.string(id.as_str());
        let response = host_request(EffectName::StorageLoadProgram, encoder.finish()).await;
        let bytes = response.map_err(storage_failure)?;
        decode_program(&bytes).map_err(|_| StorageError::Unavailable {
            detail: "the program payload is malformed".to_string(),
        })
    }

    async fn save_program(
        &self,
        _program: &Program,
        _expected: Option<Version>,
    ) -> Result<Version, StorageError> {
        Err(StorageError::Unavailable {
            detail: STORAGE_UNEXPOSED.to_string(),
        })
    }

    async fn load_issue(
        &self,
        _id: &IssueId,
    ) -> Result<Versioned<crate::domain::Issue>, StorageError> {
        Err(StorageError::Unavailable {
            detail: STORAGE_UNEXPOSED.to_string(),
        })
    }

    async fn save_issue(
        &self,
        _issue: &crate::domain::Issue,
        _expected: Option<Version>,
    ) -> Result<Version, StorageError> {
        Err(StorageError::Unavailable {
            detail: STORAGE_UNEXPOSED.to_string(),
        })
    }

    async fn load_experiment(
        &self,
        _id: &ExperimentId,
    ) -> Result<Versioned<crate::domain::Experiment>, StorageError> {
        Err(StorageError::Unavailable {
            detail: STORAGE_UNEXPOSED.to_string(),
        })
    }

    async fn save_experiment(
        &self,
        _experiment: &crate::domain::Experiment,
        _expected: Option<Version>,
    ) -> Result<Version, StorageError> {
        Err(StorageError::Unavailable {
            detail: STORAGE_UNEXPOSED.to_string(),
        })
    }

    async fn load_ticket(
        &self,
        _id: &TicketId,
    ) -> Result<Versioned<crate::domain::Ticket>, StorageError> {
        Err(StorageError::Unavailable {
            detail: STORAGE_UNEXPOSED.to_string(),
        })
    }

    async fn save_ticket(
        &self,
        _ticket: &crate::domain::Ticket,
        _expected: Option<Version>,
    ) -> Result<Version, StorageError> {
        Err(StorageError::Unavailable {
            detail: STORAGE_UNEXPOSED.to_string(),
        })
    }

    async fn append_benchmark_record(&self, record: &BenchmarkRecord) -> Result<(), StorageError> {
        let mut encoder = Encoder::new();
        wire::encode_record(&mut encoder, record);
        let response =
            host_request(EffectName::StorageAppendBenchmarkRecord, encoder.finish()).await;
        let bytes = response.map_err(storage_failure)?;
        expect_empty(&bytes).map_err(|_| StorageError::Unavailable {
            detail: "the append payload is malformed".to_string(),
        })?;
        match record.status() {
            crate::domain::BenchmarkStatus::Passed => advance(StageName::BenchmarkPassed),
            crate::domain::BenchmarkStatus::Failed => advance(StageName::BenchmarkFailed),
            crate::domain::BenchmarkStatus::Retryable => advance(StageName::BenchmarkRetryable),
        }
        Ok(())
    }

    async fn load_benchmark_record(
        &self,
        _id: &BenchmarkRunId,
    ) -> Result<BenchmarkRecord, StorageError> {
        Err(StorageError::Unavailable {
            detail: STORAGE_UNEXPOSED.to_string(),
        })
    }

    async fn save_pipeline_run(
        &self,
        _run: &crate::stage::PipelineRun,
        _expected: Option<Version>,
    ) -> Result<Version, StorageError> {
        Err(StorageError::Unavailable {
            detail: STORAGE_UNEXPOSED.to_string(),
        })
    }

    async fn load_pipeline_run(
        &self,
        _id: &PipelineRunId,
    ) -> Result<Versioned<crate::stage::PipelineRun>, StorageError> {
        Err(StorageError::Unavailable {
            detail: STORAGE_UNEXPOSED.to_string(),
        })
    }

    async fn append_audit(&self, _entry: &crate::domain::AuditEntry) -> Result<(), StorageError> {
        Err(StorageError::Unavailable {
            detail: STORAGE_UNEXPOSED.to_string(),
        })
    }
}

impl TriggerSource for BridgeTrigger {
    async fn deliver(&self, request: TriggerRequest) -> Result<TriggerId, TriggerError> {
        let mut encoder = Encoder::new();
        encoder.string(request.experiment_id.as_str());
        encoder.string(request.branch.as_str());
        encoder.string(request.base_commit.as_str());
        let response = host_request(EffectName::TriggerDeliver, encoder.finish()).await;
        let bytes = response.map_err(trigger_failure)?;
        let trigger = decode_id(&bytes, |value| TriggerId::new(value)).map_err(trigger_failure)?;
        advance(StageName::TriggerAccepted);
        Ok(trigger)
    }
}

impl TicketExecutor for BridgeExecutor {
    async fn open(&self, request: TicketRequest) -> Result<TicketId, TicketError> {
        let mut encoder = Encoder::new();
        encoder.string(request.program_id.as_str());
        encoder.string(request.issue_id.as_str());
        encoder.string(request.experiment_id.as_str());
        let response = host_request(EffectName::ExecutorOpen, encoder.finish()).await;
        let bytes = response.map_err(ticket_failure)?;
        let ticket = decode_id(&bytes, |value| TicketId::new(value)).map_err(ticket_failure)?;
        advance(StageName::TicketOpened);
        Ok(ticket)
    }
}

impl Sessions for BridgeSessions {
    async fn start_worker(&self, request: WorkerRequest) -> Result<SessionId, SessionError> {
        let mut encoder = Encoder::new();
        encoder.string(request.ticket_id.as_str());
        encoder.string(request.experiment_id.as_str());
        let response = host_request(EffectName::SessionsStartWorker, encoder.finish()).await;
        let bytes = response.map_err(session_failure)?;
        let session = decode_id(&bytes, |value| SessionId::new(value)).map_err(session_failure)?;
        advance(StageName::WorkerStarted);
        Ok(session)
    }

    async fn submit_commit(&self, request: CommitRequest) -> Result<CommitSha, SessionError> {
        let mut encoder = Encoder::new();
        encoder.string(request.ticket_id.as_str());
        encoder.string(request.worker_session_id.as_str());
        let response = host_request(EffectName::SessionsSubmitCommit, encoder.finish()).await;
        let bytes = response.map_err(session_failure)?;
        let commit = decode_id(&bytes, |value| CommitSha::new(value)).map_err(session_failure)?;
        advance(StageName::CommitSubmitted);
        Ok(commit)
    }

    async fn review(&self, request: ReviewRequest) -> Result<ResearcherDecision, SessionError> {
        advance(StageName::ResultRecorded);
        let mut encoder = Encoder::new();
        encoder.string(request.experiment_id.as_str());
        wire::encode_record(&mut encoder, &request.benchmark);
        let response = host_request(EffectName::SessionsReview, encoder.finish()).await;
        let bytes = response.map_err(session_failure)?;
        let decision = decode_decision(&bytes).map_err(|_| SessionError::Unavailable {
            detail: "the review payload is malformed".to_string(),
        })?;
        advance(StageName::ReviewRecorded);
        Ok(decision)
    }
}

impl BenchmarkRunner for BridgeBenchmark {
    async fn spec_hash(&self, spec: &BenchmarkSpec) -> Result<SpecHash, BenchmarkError> {
        let mut encoder = Encoder::new();
        wire::encode_spec(&mut encoder, spec);
        let response = host_request(EffectName::BenchmarkSpecHash, encoder.finish()).await;
        let bytes = response.map_err(benchmark_failure)?;
        decode_spec_hash(&bytes).map_err(|_| BenchmarkError::Unavailable {
            detail: "the spec hash payload is malformed".to_string(),
        })
    }

    async fn build_environment(
        &self,
        request: EnvironmentRequest,
    ) -> Result<EnvironmentDigest, BenchmarkError> {
        let mut encoder = Encoder::new();
        encoder.string(request.commit.as_str());
        wire::encode_environment(&mut encoder, &request.environment);
        let response = host_request(EffectName::BenchmarkBuildEnvironment, encoder.finish()).await;
        let bytes = response.map_err(benchmark_failure)?;
        let digest =
            decode_environment_digest(&bytes).map_err(|_| BenchmarkError::Unavailable {
                detail: "the environment digest payload is malformed".to_string(),
            })?;
        advance(StageName::EnvironmentBuilt);
        Ok(digest)
    }

    async fn run(&self, request: BenchmarkRequest) -> Result<BenchmarkRecord, BenchmarkError> {
        let mut encoder = Encoder::new();
        encoder.string(request.experiment_id.as_str());
        encoder.string(request.ticket_id.as_str());
        wire::encode_spec(&mut encoder, &request.spec);
        encoder.string(request.commit.as_str());
        encoder.string(request.environment_digest.as_str());
        encoder.u32(request.attempt.get());
        encoder.u32(request.max_attempts.get());
        let response = host_request(EffectName::BenchmarkRun, encoder.finish()).await;
        let bytes = response.map_err(benchmark_failure)?;
        decode_record(&bytes).map_err(|_| BenchmarkError::Unavailable {
            detail: "the benchmark record payload is malformed".to_string(),
        })
    }
}

impl Artifacts for BridgeArtifacts {
    async fn store(&self, _artifact: Artifact) -> Result<ArtifactId, ArtifactError> {
        Err(ArtifactError::Unavailable {
            detail: "artifacts are not exposed by the bridge".to_string(),
        })
    }

    async fn load(&self, _id: &ArtifactId) -> Result<Artifact, ArtifactError> {
        Err(ArtifactError::Unavailable {
            detail: "artifacts are not exposed by the bridge".to_string(),
        })
    }
}

impl Clock for BridgeClock {
    async fn now(&self) -> Result<Timestamp, ClockError> {
        let response = host_request(EffectName::ClockNow, Vec::new()).await;
        let bytes = response.map_err(clock_failure)?;
        let timestamp = decode_timestamp(&bytes).map_err(|_| ClockError::Unavailable {
            detail: "the clock payload is malformed".to_string(),
        })?;
        advance(StageName::ResearchCompleted);
        Ok(timestamp)
    }
}

impl Tools for BridgeTools {
    async fn invoke(&self, _call: ToolCall) -> Result<ToolOutput, ToolError> {
        Err(ToolError::Unavailable {
            detail: "tools are not exposed by the bridge".to_string(),
        })
    }
}

impl Http for BridgeHttp {
    async fn send(&self, _request: HttpRequest) -> Result<HttpResponse, HttpError> {
        Err(HttpError::Unavailable {
            detail: "http is not exposed by the bridge".to_string(),
        })
    }
}

impl Surface for BridgeSurface {
    fn manifest(&self) -> SurfaceManifest {
        SurfaceManifest::new(Vec::new(), Vec::new(), Vec::new(), Vec::new())
            .expect("an empty surface manifest is valid")
    }
}

impl Plugin for BridgePlugin {
    type Storage = BridgeStorage;
    type Trigger = BridgeTrigger;
    type Executor = BridgeExecutor;
    type Sessions = BridgeSessions;
    type Benchmark = BridgeBenchmark;
    type Artifacts = BridgeArtifacts;
    type Clock = BridgeClock;
    type Tools = BridgeTools;
    type Http = BridgeHttp;
    type Surface = BridgeSurface;

    fn storage(&self) -> &Self::Storage {
        &STORAGE
    }

    fn trigger(&self) -> &Self::Trigger {
        &TRIGGER
    }

    fn executor(&self) -> &Self::Executor {
        &EXECUTOR
    }

    fn sessions(&self) -> &Self::Sessions {
        &SESSIONS
    }

    fn benchmark(&self) -> &Self::Benchmark {
        &BENCHMARK
    }

    fn artifacts(&self) -> &Self::Artifacts {
        &ARTIFACTS
    }

    fn clock(&self) -> &Self::Clock {
        &CLOCK
    }

    fn tools(&self) -> &Self::Tools {
        &TOOLS
    }

    fn http(&self) -> &Self::Http {
        &HTTP
    }

    fn surface(&self) -> &Self::Surface {
        &SURFACE
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;
    use crate::domain::{
        BenchmarkMetric, Exploration, MetricDirection as DomainDirection, MetricWeight,
        ProgramInput, ProgramStatus, ResearchPolicy, Usage,
    };
    use crate::id::BenchmarkSpecId;

    fn start_request() -> Vec<u8> {
        let mut encoder = Encoder::new();
        encoder.string("program-1");
        encoder.string("issue-1");
        encoder.string("experiment-1");
        encoder.string("experiment/one");
        encoder.string(&"0".repeat(40));
        encoder.u8(0);
        encoder.string("requirements.txt");
        encoder.finish()
    }

    fn program() -> Versioned<Program> {
        let spec = BenchmarkSpec::new(
            BenchmarkSpecId::new("benchmark-1").unwrap(),
            "bench.py",
            30_000,
            vec![BenchmarkMetric::new("score", DomainDirection::Maximize, true, None).unwrap()],
            1,
            BTreeMap::new(),
            None,
        )
        .unwrap();
        let program = Program::new(ProgramInput {
            id: ProgramId::new("program-1").unwrap(),
            owner: crate::id::ActorId::new("operator-1").unwrap(),
            name: "Program".to_string(),
            goal: "Improve the benchmark".to_string(),
            methodology: "Propose, run, review".to_string(),
            benchmark: spec,
            utility: vec![MetricWeight::new("score", DomainDirection::Maximize, 1.0).unwrap()],
            exploration: Exploration::Normal,
            policy: ResearchPolicy::default(),
            usage: Usage::ZERO,
            status: ProgramStatus::Running,
            created_at: Timestamp::UNIX_EPOCH,
        })
        .unwrap();
        Versioned::new(program, Version::first())
    }

    fn program_bytes() -> Vec<u8> {
        let mut encoder = Encoder::new();
        wire::encode_program(&mut encoder, &program());
        encoder.finish()
    }

    fn resume_request(sequence: u64, effect: EffectName, payload: Vec<u8>) -> Vec<u8> {
        let mut encoder = Encoder::new();
        encoder.u64(sequence);
        encoder.u8(effect.code());
        encoder.u8(0);
        encoder.bytes(&payload);
        encoder.finish()
    }

    fn resume_failure(sequence: u64, effect: EffectName) -> Vec<u8> {
        let mut encoder = Encoder::new();
        encoder.u64(sequence);
        encoder.u8(effect.code());
        encoder.u8(1);
        encoder.u8(FailureKind::Rejected as u8);
        encoder.string("the host rejected the effect");
        encoder.finish()
    }

    fn effect_frame(frame: &[u8]) -> (EffectName, u64, u8, Vec<u8>) {
        let mut decoder = Decoder::new(frame);
        assert_eq!(decoder.u8().unwrap(), 0);
        let effect = EffectName::from_code(decoder.u8().unwrap()).unwrap();
        let sequence = decoder.u64().unwrap();
        let stage = decoder.u8().unwrap();
        let payload = decoder.bytes().unwrap().to_vec();
        decoder.finish().unwrap();
        (effect, sequence, stage, payload)
    }

    #[test]
    fn a_start_request_emits_the_program_load_effect() {
        let frame = start(&start_request());
        let (effect, sequence, stage, payload) = effect_frame(&frame);
        assert_eq!(effect, EffectName::StorageLoadProgram);
        assert_eq!(sequence, 1);
        assert_eq!(stage, StageName::ExperimentProposed.code() as u8);
        let mut decoder = Decoder::new(&payload);
        assert_eq!(decoder.string().unwrap(), "program-1");
        decoder.finish().unwrap();
    }

    #[test]
    fn a_resume_must_match_the_pending_effect() {
        let frame = start(&start_request());
        let (effect, sequence, _, _) = effect_frame(&frame);
        assert_eq!(effect, EffectName::StorageLoadProgram);
        let frame = resume(&resume_request(
            sequence,
            EffectName::BenchmarkRun,
            Encoder::new().finish(),
        ));
        let mut decoder = Decoder::new(&frame);
        assert_eq!(decoder.u8().unwrap(), 2);
        assert!(decoder.string().unwrap().contains("benchmark.run"));
        decoder.finish().unwrap();

        let frame = resume(&resume_request(
            sequence,
            EffectName::StorageLoadProgram,
            program_bytes(),
        ));
        let (effect, sequence, stage, _) = effect_frame(&frame);
        assert_eq!(effect, EffectName::TriggerDeliver);
        assert_eq!(sequence, 2);
        assert_eq!(stage, StageName::ExperimentProposed.code() as u8);
    }

    #[test]
    fn a_replayed_resume_is_refused() {
        let frame = start(&start_request());
        let (_, sequence, _, _) = effect_frame(&frame);
        let request = resume_request(sequence, EffectName::StorageLoadProgram, program_bytes());
        let _ = effect_frame(&resume(&request));
        let frame = resume(&request);
        let mut decoder = Decoder::new(&frame);
        assert_eq!(decoder.u8().unwrap(), 2);
        assert!(decoder.string().unwrap().contains("expected"));
        decoder.finish().unwrap();
    }

    #[test]
    fn a_rejected_effect_stops_the_pipeline_without_advancing() {
        let frame = start(&start_request());
        let (_, sequence, _, _) = effect_frame(&frame);
        let frame = resume(&resume_request(
            sequence,
            EffectName::StorageLoadProgram,
            program_bytes(),
        ));
        let (effect, sequence, stage, _) = effect_frame(&frame);
        assert_eq!(effect, EffectName::TriggerDeliver);
        assert_eq!(stage, StageName::ExperimentProposed.code() as u8);
        let frame = resume(&resume_failure(sequence, EffectName::TriggerDeliver));
        let mut decoder = Decoder::new(&frame);
        assert_eq!(decoder.u8().unwrap(), 3);
        assert!(decoder.string().unwrap().contains("rejected"));
        decoder.finish().unwrap();
    }
}
