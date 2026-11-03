use std::cell::RefCell;
use std::future::Future;
use std::pin::Pin;
use std::rc::Rc;
use std::task::{Context, Poll, Waker};

use crate::command::{
    Actor, ActorRole, ClaimIssue, CloseExperiment, CloseIssue, CommandDraft, CommandError,
    CommandExecutor, CommandName, CommandOutcome, CommentIssue, CreateIssue, CreateProgram,
    HostGate, PauseProgram, ProposeExperiment, RequestBenchmark, ResumeProgram, ReviewExperiment,
    SetProgramExploration, SetProgramGoal, SetProgramMethodology, StopProgram, SubmitTicket,
};
use crate::domain::{
    Artifact, BenchmarkRecord, BenchmarkSpec, Experiment, Issue, Program, ResearcherDecision,
    Ticket, Versioned,
};
use crate::dto::{
    CoreActorRole, CoreBenchmarkBuildEnvironment, CoreBenchmarkRecord, CoreBenchmarkRun,
    CoreBenchmarkSpecHash, CoreCommandCompletedFrame, CoreCommandEffectFrame,
    CoreCommandEffectResume, CoreCommandErrorFrame, CoreCommandErrorFrameKind,
    CoreCommandErrorKind, CoreCommandFrame, CoreCommandOutcome, CoreCommandRequest,
    CoreCompletedFrame, CoreCompletedKind, CoreDomainFrame, CoreDomainKind, CoreEffectFailure,
    CoreEffectFailureKind, CoreEffectFrame, CoreEffectKind, CoreEffectResume, CoreExecutorOpen,
    CoreExperiment, CoreFrame, CoreIssue, CoreProgram, CoreProtocolFrame, CoreProtocolKind,
    CoreResearchOutcome, CoreSessionsReview, CoreSessionsStartWorker, CoreSessionsSubmitCommit,
    CoreStageName, CoreStartRequest, CoreStorageAppendAudit, CoreStorageAppendBenchmarkRecord,
    CoreStorageLoadExperiment, CoreStorageLoadIssue, CoreStorageLoadProgram, CoreStorageLoadTicket,
    CoreStorageSaveExperiment, CoreStorageSaveIssue, CoreStorageSaveProgram, CoreStorageSaveTicket,
    CoreTicket, CoreTriggerDeliver, CoreVersioned, DecimalU64,
};
use crate::error::{
    ArtifactError, BenchmarkError, ClockError, DomainError, HttpError, SessionError, StorageError,
    TicketError, ToolError, TriggerError,
};
use crate::id::{
    ArtifactId, BenchmarkRunId, CommitSha, EnvironmentDigest, ExperimentId, IssueId, PipelineRunId,
    ProgramId, RequestId, SessionId, SpecHash, TicketId, TriggerId, Version,
};
use crate::pipeline::run_pipeline;
use crate::plugin::{
    Artifacts, BenchmarkRequest, BenchmarkRunner, Clock, CommitRequest, EnvironmentRequest, Http,
    HttpRequest, HttpResponse, Plugin, ReviewRequest, Sessions, Storage, Surface, SurfaceManifest,
    TicketExecutor, TicketRequest, ToolCall, ToolOutput, Tools, TriggerRequest, TriggerSource,
    WorkerRequest,
};
use crate::stage::{ResearchCompleted, StageName};
use crate::time::Timestamp;

pub const BRIDGE_VERSION: u32 = crate::CORE_ABI_VERSION;

const STORAGE_UNEXPOSED: &str = "the storage effect is not exposed by the bridge";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EffectName {
    StorageLoadProgram,
    TriggerDeliver,
    ExecutorOpen,
    SessionsStartWorker,
    SessionsSubmitCommit,
    BenchmarkBuildEnvironment,
    BenchmarkSpecHash,
    BenchmarkRun,
    StorageAppendBenchmarkRecord,
    SessionsReview,
    ClockNow,
    StorageSaveProgram,
    StorageLoadIssue,
    StorageSaveIssue,
    StorageLoadExperiment,
    StorageSaveExperiment,
    StorageLoadTicket,
    StorageSaveTicket,
    StorageAppendAudit,
}

impl EffectName {
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
            Self::StorageSaveProgram => "storage.saveProgram",
            Self::StorageLoadIssue => "storage.loadIssue",
            Self::StorageSaveIssue => "storage.saveIssue",
            Self::StorageLoadExperiment => "storage.loadExperiment",
            Self::StorageSaveExperiment => "storage.saveExperiment",
            Self::StorageLoadTicket => "storage.loadTicket",
            Self::StorageSaveTicket => "storage.saveTicket",
            Self::StorageAppendAudit => "storage.appendAudit",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FailureKind {
    Rejected,
    Unavailable,
    NotFound,
    Conflict,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct HostFailure {
    kind: FailureKind,
    message: String,
}

impl From<CoreEffectFailure> for HostFailure {
    fn from(value: CoreEffectFailure) -> Self {
        Self {
            kind: match value.kind {
                CoreEffectFailureKind::Rejected => FailureKind::Rejected,
                CoreEffectFailureKind::Unavailable => FailureKind::Unavailable,
                CoreEffectFailureKind::NotFound => FailureKind::NotFound,
                CoreEffectFailureKind::Conflict => FailureKind::Conflict,
            },
            message: value.message,
        }
    }
}

enum PipelineEffectData {
    StorageLoadProgram(CoreStorageLoadProgram),
    TriggerDeliver(CoreTriggerDeliver),
    ExecutorOpen(CoreExecutorOpen),
    SessionsStartWorker(CoreSessionsStartWorker),
    SessionsSubmitCommit(CoreSessionsSubmitCommit),
    BenchmarkBuildEnvironment(CoreBenchmarkBuildEnvironment),
    BenchmarkSpecHash(CoreBenchmarkSpecHash),
    BenchmarkRun(CoreBenchmarkRun),
    StorageAppendBenchmarkRecord(CoreStorageAppendBenchmarkRecord),
    SessionsReview(CoreSessionsReview),
    ClockNow,
}

enum CommandEffectData {
    StorageLoadProgram(CoreStorageLoadProgram),
    StorageSaveProgram(CoreStorageSaveProgram),
    StorageLoadIssue(CoreStorageLoadIssue),
    StorageSaveIssue(CoreStorageSaveIssue),
    StorageLoadExperiment(CoreStorageLoadExperiment),
    StorageSaveExperiment(CoreStorageSaveExperiment),
    StorageLoadTicket(CoreStorageLoadTicket),
    StorageSaveTicket(CoreStorageSaveTicket),
    StorageAppendAudit(CoreStorageAppendAudit),
    ClockNow,
}

enum EffectRequest {
    Pipeline(PipelineEffectData),
    Command(CommandEffectData),
}

struct Effect {
    request: EffectRequest,
    sequence: u64,
}

impl Effect {
    fn name(&self) -> EffectName {
        match &self.request {
            EffectRequest::Pipeline(data) => match data {
                PipelineEffectData::StorageLoadProgram(_) => EffectName::StorageLoadProgram,
                PipelineEffectData::TriggerDeliver(_) => EffectName::TriggerDeliver,
                PipelineEffectData::ExecutorOpen(_) => EffectName::ExecutorOpen,
                PipelineEffectData::SessionsStartWorker(_) => EffectName::SessionsStartWorker,
                PipelineEffectData::SessionsSubmitCommit(_) => EffectName::SessionsSubmitCommit,
                PipelineEffectData::BenchmarkBuildEnvironment(_) => {
                    EffectName::BenchmarkBuildEnvironment
                }
                PipelineEffectData::BenchmarkSpecHash(_) => EffectName::BenchmarkSpecHash,
                PipelineEffectData::BenchmarkRun(_) => EffectName::BenchmarkRun,
                PipelineEffectData::StorageAppendBenchmarkRecord(_) => {
                    EffectName::StorageAppendBenchmarkRecord
                }
                PipelineEffectData::SessionsReview(_) => EffectName::SessionsReview,
                PipelineEffectData::ClockNow => EffectName::ClockNow,
            },
            EffectRequest::Command(data) => match data {
                CommandEffectData::StorageLoadProgram(_) => EffectName::StorageLoadProgram,
                CommandEffectData::StorageSaveProgram(_) => EffectName::StorageSaveProgram,
                CommandEffectData::StorageLoadIssue(_) => EffectName::StorageLoadIssue,
                CommandEffectData::StorageSaveIssue(_) => EffectName::StorageSaveIssue,
                CommandEffectData::StorageLoadExperiment(_) => EffectName::StorageLoadExperiment,
                CommandEffectData::StorageSaveExperiment(_) => EffectName::StorageSaveExperiment,
                CommandEffectData::StorageLoadTicket(_) => EffectName::StorageLoadTicket,
                CommandEffectData::StorageSaveTicket(_) => EffectName::StorageSaveTicket,
                CommandEffectData::StorageAppendAudit(_) => EffectName::StorageAppendAudit,
                CommandEffectData::ClockNow => EffectName::ClockNow,
            },
        }
    }
}

enum EffectValue {
    Program(CoreProgram),
    VersionedProgram(CoreVersioned<CoreProgram>),
    Issue(CoreVersioned<CoreIssue>),
    Experiment(CoreVersioned<CoreExperiment>),
    Ticket(CoreVersioned<CoreTicket>),
    Version(DecimalU64),
    Text(String),
    Record(CoreBenchmarkRecord),
    Decision(crate::dto::CoreResearcherDecision),
    Timestamp(String),
    Empty,
}

type EffectResult = Result<EffectValue, HostFailure>;
type PipelineFuture = Pin<Box<dyn Future<Output = Result<ResearchCompleted, DomainError>>>>;
type CommandFuture =
    Pin<Box<dyn Future<Output = (CommandName, Result<CommandOutcome, CommandError>)>>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RunMode {
    Pipeline,
    Command,
}

enum Run {
    Pipeline(PipelineFuture),
    Command(CommandFuture),
}

enum Polled {
    Pipeline(Poll<Result<ResearchCompleted, DomainError>>),
    Command(Poll<(CommandName, Result<CommandOutcome, CommandError>)>),
}

pub struct CoreState {
    run: Option<Run>,
    effect: Option<Effect>,
    response: Option<EffectResult>,
    pending: Option<(u64, EffectName)>,
    sequence: u64,
    stage: StageName,
    trace: Vec<StageName>,
    order_broken: bool,
    mode: RunMode,
    audit_role: ActorRole,
}

impl CoreState {
    pub fn new() -> Self {
        Self {
            run: None,
            effect: None,
            response: None,
            pending: None,
            sequence: 0,
            stage: StageName::ExperimentProposed,
            trace: vec![StageName::ExperimentProposed],
            order_broken: false,
            mode: RunMode::Pipeline,
            audit_role: ActorRole::Operator,
        }
    }

    fn reset(&mut self, mode: RunMode) {
        self.run = None;
        self.effect = None;
        self.response = None;
        self.pending = None;
        self.sequence = 0;
        self.stage = StageName::ExperimentProposed;
        self.trace.clear();
        self.trace.push(StageName::ExperimentProposed);
        self.order_broken = false;
        self.mode = mode;
        self.audit_role = ActorRole::Operator;
    }
}

impl Default for CoreState {
    fn default() -> Self {
        Self::new()
    }
}

pub fn start(state: &Rc<RefCell<CoreState>>, request: CoreStartRequest) -> CoreFrame {
    let initial = match request.into_domain() {
        Ok(initial) => initial,
        Err(_) => return protocol_frame("the start request is malformed"),
    };
    state.borrow_mut().reset(RunMode::Pipeline);
    let plugin = BridgePlugin::new(Rc::clone(state));
    let future = Box::pin(async move { run_pipeline(&plugin, initial).await });
    state.borrow_mut().run = Some(Run::Pipeline(future));
    poll_frame(state)
}

pub fn start_command(
    state: &Rc<RefCell<CoreState>>,
    request: CoreCommandRequest,
) -> CoreCommandFrame {
    let (request_id, actor, draft) = match request.into_domain() {
        Ok(request) => request,
        Err(_) => return command_protocol_frame("the command request is malformed"),
    };
    {
        let mut state = state.borrow_mut();
        state.reset(RunMode::Command);
        state.audit_role = actor.role();
    }
    let plugin = BridgePlugin::new(Rc::clone(state));
    let future = Box::pin(async move { execute_command(&plugin, request_id, actor, draft).await });
    state.borrow_mut().run = Some(Run::Command(future));
    poll_command_frame(state)
}

pub fn resume(state: &Rc<RefCell<CoreState>>, request: CoreEffectResume) -> CoreFrame {
    let request = match resume_parts(request) {
        Some(request) => request,
        None => return protocol_frame("the resume request is malformed"),
    };
    match accept_resume(state, request.sequence, request.effect, request.result) {
        Ok(()) => poll_frame(state),
        Err(message) => protocol_frame(&message),
    }
}

pub fn resume_command(
    state: &Rc<RefCell<CoreState>>,
    request: CoreCommandEffectResume,
) -> CoreCommandFrame {
    let request = match command_resume_parts(request) {
        Some(request) => request,
        None => return command_protocol_frame("the resume request is malformed"),
    };
    match accept_resume(state, request.sequence, request.effect, request.result) {
        Ok(()) => poll_command_frame(state),
        Err(message) => command_protocol_frame(&message),
    }
}

struct ResumeRequest {
    sequence: u64,
    effect: EffectName,
    result: EffectResult,
}

fn accept_resume(
    state: &Rc<RefCell<CoreState>>,
    sequence: u64,
    effect: EffectName,
    result: EffectResult,
) -> Result<(), String> {
    let mut state = state.borrow_mut();
    match state.pending {
        Some((pending, current)) if pending == sequence && current == effect => {}
        Some((pending, current)) => {
            return Err(format!(
                "expected {} #{pending}, received {} #{sequence}",
                current.as_str(),
                effect.as_str()
            ));
        }
        None => return Err("no effect is pending".to_string()),
    }
    state.pending = None;
    state.response = Some(result);
    Ok(())
}

fn resume_parts(request: CoreEffectResume) -> Option<ResumeRequest> {
    let (sequence, effect, result) = match request {
        CoreEffectResume::StorageLoadProgram { sequence, result } => (
            sequence.get(),
            EffectName::StorageLoadProgram,
            result.into_parts()?.map(EffectValue::Program),
        ),
        CoreEffectResume::TriggerDeliver { sequence, result } => (
            sequence.get(),
            EffectName::TriggerDeliver,
            result.into_parts()?.map(EffectValue::Text),
        ),
        CoreEffectResume::ExecutorOpen { sequence, result } => (
            sequence.get(),
            EffectName::ExecutorOpen,
            result.into_parts()?.map(EffectValue::Text),
        ),
        CoreEffectResume::SessionsStartWorker { sequence, result } => (
            sequence.get(),
            EffectName::SessionsStartWorker,
            result.into_parts()?.map(EffectValue::Text),
        ),
        CoreEffectResume::SessionsSubmitCommit { sequence, result } => (
            sequence.get(),
            EffectName::SessionsSubmitCommit,
            result.into_parts()?.map(EffectValue::Text),
        ),
        CoreEffectResume::BenchmarkBuildEnvironment { sequence, result } => (
            sequence.get(),
            EffectName::BenchmarkBuildEnvironment,
            result.into_parts()?.map(EffectValue::Text),
        ),
        CoreEffectResume::BenchmarkSpecHash { sequence, result } => (
            sequence.get(),
            EffectName::BenchmarkSpecHash,
            result.into_parts()?.map(EffectValue::Text),
        ),
        CoreEffectResume::BenchmarkRun { sequence, result } => (
            sequence.get(),
            EffectName::BenchmarkRun,
            result.into_parts()?.map(EffectValue::Record),
        ),
        CoreEffectResume::StorageAppendBenchmarkRecord { sequence, result } => (
            sequence.get(),
            EffectName::StorageAppendBenchmarkRecord,
            result.into_parts()?.map(|_| EffectValue::Empty),
        ),
        CoreEffectResume::SessionsReview { sequence, result } => (
            sequence.get(),
            EffectName::SessionsReview,
            result.into_parts()?.map(EffectValue::Decision),
        ),
        CoreEffectResume::ClockNow { sequence, result } => (
            sequence.get(),
            EffectName::ClockNow,
            result.into_parts()?.map(EffectValue::Timestamp),
        ),
    };
    Some(ResumeRequest {
        sequence,
        effect,
        result: result.map_err(HostFailure::from),
    })
}

fn command_resume_parts(request: CoreCommandEffectResume) -> Option<ResumeRequest> {
    let (sequence, effect, result) = match request {
        CoreCommandEffectResume::StorageLoadProgram { sequence, result } => (
            sequence.get(),
            EffectName::StorageLoadProgram,
            result.into_parts()?.map(EffectValue::VersionedProgram),
        ),
        CoreCommandEffectResume::StorageSaveProgram { sequence, result } => (
            sequence.get(),
            EffectName::StorageSaveProgram,
            result.into_parts()?.map(EffectValue::Version),
        ),
        CoreCommandEffectResume::StorageLoadIssue { sequence, result } => (
            sequence.get(),
            EffectName::StorageLoadIssue,
            result.into_parts()?.map(EffectValue::Issue),
        ),
        CoreCommandEffectResume::StorageSaveIssue { sequence, result } => (
            sequence.get(),
            EffectName::StorageSaveIssue,
            result.into_parts()?.map(EffectValue::Version),
        ),
        CoreCommandEffectResume::StorageLoadExperiment { sequence, result } => (
            sequence.get(),
            EffectName::StorageLoadExperiment,
            result.into_parts()?.map(EffectValue::Experiment),
        ),
        CoreCommandEffectResume::StorageSaveExperiment { sequence, result } => (
            sequence.get(),
            EffectName::StorageSaveExperiment,
            result.into_parts()?.map(EffectValue::Version),
        ),
        CoreCommandEffectResume::StorageLoadTicket { sequence, result } => (
            sequence.get(),
            EffectName::StorageLoadTicket,
            result.into_parts()?.map(EffectValue::Ticket),
        ),
        CoreCommandEffectResume::StorageSaveTicket { sequence, result } => (
            sequence.get(),
            EffectName::StorageSaveTicket,
            result.into_parts()?.map(EffectValue::Version),
        ),
        CoreCommandEffectResume::StorageAppendAudit { sequence, result } => (
            sequence.get(),
            EffectName::StorageAppendAudit,
            result.into_parts()?.map(|_| EffectValue::Empty),
        ),
        CoreCommandEffectResume::ClockNow { sequence, result } => (
            sequence.get(),
            EffectName::ClockNow,
            result.into_parts()?.map(EffectValue::Timestamp),
        ),
    };
    Some(ResumeRequest {
        sequence,
        effect,
        result: result.map_err(HostFailure::from),
    })
}

fn poll_run(state: &Rc<RefCell<CoreState>>) -> Option<Polled> {
    let run = state.borrow_mut().run.take();
    let mut run = run?;
    let mut context = Context::from_waker(Waker::noop());
    let polled = match &mut run {
        Run::Pipeline(future) => Polled::Pipeline(future.as_mut().poll(&mut context)),
        Run::Command(future) => Polled::Command(future.as_mut().poll(&mut context)),
    };
    let mut state = state.borrow_mut();
    match &polled {
        Polled::Pipeline(Poll::Pending) | Polled::Command(Poll::Pending) => {
            state.run = Some(run);
        }
        Polled::Pipeline(Poll::Ready(_)) | Polled::Command(Poll::Ready(_)) => {
            state.run = None;
        }
    }
    Some(polled)
}

fn poll_frame(state: &Rc<RefCell<CoreState>>) -> CoreFrame {
    let polled = poll_run(state);
    match polled {
        None => protocol_frame("no core run is active"),
        Some(Polled::Pipeline(Poll::Ready(result))) => {
            state.borrow_mut().run = None;
            match result {
                Ok(completed) => completed_frame(state, &completed),
                Err(error) => domain_frame(&error),
            }
        }
        Some(Polled::Pipeline(Poll::Pending)) => pending_frame(state),
        Some(Polled::Command(_)) => protocol_frame("no core run is active"),
    }
}

fn poll_command_frame(state: &Rc<RefCell<CoreState>>) -> CoreCommandFrame {
    let polled = poll_run(state);
    match polled {
        None => command_protocol_frame("no core run is active"),
        Some(Polled::Command(Poll::Ready((command, result)))) => {
            state.borrow_mut().run = None;
            match result {
                Ok(outcome) => command_completed_frame(&outcome),
                Err(error) => command_error_frame(command, &error),
            }
        }
        Some(Polled::Command(Poll::Pending)) => pending_command_frame(state),
        Some(Polled::Pipeline(_)) => command_protocol_frame("no core run is active"),
    }
}

fn pending_frame(state: &Rc<RefCell<CoreState>>) -> CoreFrame {
    let broken = {
        let mut state = state.borrow_mut();
        if state.mode == RunMode::Pipeline && state.order_broken {
            state.run = None;
            true
        } else {
            false
        }
    };
    if broken {
        return protocol_frame("the pipeline left the declared stage order");
    }
    match take_effect(state) {
        Some(effect) => effect_frame(state, effect),
        None => protocol_frame("the core suspended without an effect"),
    }
}

fn pending_command_frame(state: &Rc<RefCell<CoreState>>) -> CoreCommandFrame {
    match take_effect(state) {
        Some(effect) => command_effect_frame(effect),
        None => command_protocol_frame("the core suspended without an effect"),
    }
}

fn take_effect(state: &Rc<RefCell<CoreState>>) -> Option<Effect> {
    let mut state = state.borrow_mut();
    let effect = state.effect.take();
    if let Some(effect) = &effect {
        state.pending = Some((effect.sequence, effect.name()));
    }
    effect
}

fn effect_frame(state: &Rc<RefCell<CoreState>>, effect: Effect) -> CoreFrame {
    let stage = state.borrow().stage.into();
    let sequence = DecimalU64::new(effect.sequence);
    let kind = CoreEffectKind::Effect;
    CoreFrame::Effect(Box::new(match effect.request {
        EffectRequest::Pipeline(data) => match data {
            PipelineEffectData::StorageLoadProgram(payload) => {
                CoreEffectFrame::StorageLoadProgram {
                    kind,
                    sequence,
                    stage,
                    payload,
                }
            }
            PipelineEffectData::TriggerDeliver(payload) => CoreEffectFrame::TriggerDeliver {
                kind,
                sequence,
                stage,
                payload,
            },
            PipelineEffectData::ExecutorOpen(payload) => CoreEffectFrame::ExecutorOpen {
                kind,
                sequence,
                stage,
                payload,
            },
            PipelineEffectData::SessionsStartWorker(payload) => {
                CoreEffectFrame::SessionsStartWorker {
                    kind,
                    sequence,
                    stage,
                    payload,
                }
            }
            PipelineEffectData::SessionsSubmitCommit(payload) => {
                CoreEffectFrame::SessionsSubmitCommit {
                    kind,
                    sequence,
                    stage,
                    payload,
                }
            }
            PipelineEffectData::BenchmarkBuildEnvironment(payload) => {
                CoreEffectFrame::BenchmarkBuildEnvironment {
                    kind,
                    sequence,
                    stage,
                    payload,
                }
            }
            PipelineEffectData::BenchmarkSpecHash(payload) => CoreEffectFrame::BenchmarkSpecHash {
                kind,
                sequence,
                stage,
                payload,
            },
            PipelineEffectData::BenchmarkRun(payload) => CoreEffectFrame::BenchmarkRun {
                kind,
                sequence,
                stage,
                payload,
            },
            PipelineEffectData::StorageAppendBenchmarkRecord(payload) => {
                CoreEffectFrame::StorageAppendBenchmarkRecord {
                    kind,
                    sequence,
                    stage,
                    payload,
                }
            }
            PipelineEffectData::SessionsReview(payload) => CoreEffectFrame::SessionsReview {
                kind,
                sequence,
                stage,
                payload,
            },
            PipelineEffectData::ClockNow => CoreEffectFrame::ClockNow {
                kind,
                sequence,
                stage,
                payload: (),
            },
        },
        EffectRequest::Command(_) => return protocol_frame("no core run is active"),
    }))
}

fn command_effect_frame(effect: Effect) -> CoreCommandFrame {
    let sequence = DecimalU64::new(effect.sequence);
    let kind = CoreEffectKind::Effect;
    CoreCommandFrame::Effect(Box::new(match effect.request {
        EffectRequest::Command(data) => match data {
            CommandEffectData::StorageLoadProgram(payload) => {
                CoreCommandEffectFrame::StorageLoadProgram {
                    kind,
                    sequence,
                    payload,
                }
            }
            CommandEffectData::StorageSaveProgram(payload) => {
                CoreCommandEffectFrame::StorageSaveProgram {
                    kind,
                    sequence,
                    payload,
                }
            }
            CommandEffectData::StorageLoadIssue(payload) => {
                CoreCommandEffectFrame::StorageLoadIssue {
                    kind,
                    sequence,
                    payload,
                }
            }
            CommandEffectData::StorageSaveIssue(payload) => {
                CoreCommandEffectFrame::StorageSaveIssue {
                    kind,
                    sequence,
                    payload,
                }
            }
            CommandEffectData::StorageLoadExperiment(payload) => {
                CoreCommandEffectFrame::StorageLoadExperiment {
                    kind,
                    sequence,
                    payload,
                }
            }
            CommandEffectData::StorageSaveExperiment(payload) => {
                CoreCommandEffectFrame::StorageSaveExperiment {
                    kind,
                    sequence,
                    payload,
                }
            }
            CommandEffectData::StorageLoadTicket(payload) => {
                CoreCommandEffectFrame::StorageLoadTicket {
                    kind,
                    sequence,
                    payload,
                }
            }
            CommandEffectData::StorageSaveTicket(payload) => {
                CoreCommandEffectFrame::StorageSaveTicket {
                    kind,
                    sequence,
                    payload,
                }
            }
            CommandEffectData::StorageAppendAudit(payload) => {
                CoreCommandEffectFrame::StorageAppendAudit {
                    kind,
                    sequence,
                    payload,
                }
            }
            CommandEffectData::ClockNow => CoreCommandEffectFrame::ClockNow {
                kind,
                sequence,
                payload: (),
            },
        },
        EffectRequest::Pipeline(_) => {
            return command_protocol_frame("no core run is active");
        }
    }))
}

fn completed_frame(state: &Rc<RefCell<CoreState>>, completed: &ResearchCompleted) -> CoreFrame {
    let stages = state
        .borrow()
        .trace
        .iter()
        .copied()
        .map(CoreStageName::from)
        .collect();
    CoreFrame::Completed(CoreCompletedFrame {
        kind: CoreCompletedKind::Completed,
        outcome: CoreResearchOutcome::from(completed.outcome()),
        stages,
    })
}

fn command_completed_frame(outcome: &CommandOutcome) -> CoreCommandFrame {
    CoreCommandFrame::Completed(CoreCommandCompletedFrame {
        kind: CoreCompletedKind::Completed,
        outcome: CoreCommandOutcome::from(outcome),
    })
}

fn command_error_frame(command: CommandName, error: &CommandError) -> CoreCommandFrame {
    CoreCommandFrame::Error(CoreCommandErrorFrame {
        kind: CoreCommandErrorFrameKind::CommandError,
        error_kind: CoreCommandErrorKind::from(error.kind()),
        command: command.into(),
        message: error.to_string(),
    })
}

pub(crate) fn protocol_frame(message: &str) -> CoreFrame {
    CoreFrame::Protocol(CoreProtocolFrame {
        kind: CoreProtocolKind::Protocol,
        message: message.to_string(),
    })
}

pub(crate) fn command_protocol_frame(message: &str) -> CoreCommandFrame {
    CoreCommandFrame::Protocol(CoreProtocolFrame {
        kind: CoreProtocolKind::Protocol,
        message: message.to_string(),
    })
}

fn domain_frame(error: &DomainError) -> CoreFrame {
    CoreFrame::Domain(CoreDomainFrame {
        kind: CoreDomainKind::Domain,
        message: error.to_string(),
    })
}

fn advance(state: &Rc<RefCell<CoreState>>, stage: StageName) {
    let mut state = state.borrow_mut();
    if state.mode != RunMode::Pipeline {
        return;
    }
    if !state.stage.successors().contains(&stage) {
        state.order_broken = true;
        return;
    }
    state.stage = stage;
    state.trace.push(stage);
}

struct HostRequest {
    state: Rc<RefCell<CoreState>>,
    request: Option<EffectRequest>,
    sent: bool,
}

impl Future for HostRequest {
    type Output = EffectResult;

    fn poll(self: Pin<&mut Self>, _context: &mut Context<'_>) -> Poll<Self::Output> {
        let request = self.get_mut();
        if !request.sent {
            let sequence = {
                let mut state = request.state.borrow_mut();
                state.sequence += 1;
                state.sequence
            };
            let sent = request.request.take().expect("a host request is sent once");
            request.state.borrow_mut().effect = Some(Effect {
                request: sent,
                sequence,
            });
            request.sent = true;
            return Poll::Pending;
        }
        match request.state.borrow_mut().response.take() {
            Some(result) => Poll::Ready(result),
            None => Poll::Pending,
        }
    }
}

async fn host_request(state: &Rc<RefCell<CoreState>>, request: EffectRequest) -> EffectResult {
    HostRequest {
        state: Rc::clone(state),
        request: Some(request),
        sent: false,
    }
    .await
}

fn malformed<T>(message: &str) -> Result<T, HostFailure> {
    Err(HostFailure {
        kind: FailureKind::Unavailable,
        message: message.to_string(),
    })
}

fn expect_issue(value: EffectValue) -> Result<CoreVersioned<CoreIssue>, HostFailure> {
    match value {
        EffectValue::Issue(issue) => Ok(issue),
        _ => malformed("the issue payload is malformed"),
    }
}

fn expect_experiment(value: EffectValue) -> Result<CoreVersioned<CoreExperiment>, HostFailure> {
    match value {
        EffectValue::Experiment(experiment) => Ok(experiment),
        _ => malformed("the experiment payload is malformed"),
    }
}

fn expect_ticket(value: EffectValue) -> Result<CoreVersioned<CoreTicket>, HostFailure> {
    match value {
        EffectValue::Ticket(ticket) => Ok(ticket),
        _ => malformed("the ticket payload is malformed"),
    }
}

fn expect_version(value: EffectValue, message: &str) -> Result<Version, StorageError> {
    match value {
        EffectValue::Version(version) => {
            Version::new(version.get()).map_err(|_| StorageError::Unavailable {
                detail: message.to_string(),
            })
        }
        _ => Err(StorageError::Unavailable {
            detail: message.to_string(),
        }),
    }
}

fn expect_text(value: EffectValue) -> Result<String, HostFailure> {
    match value {
        EffectValue::Text(text) => Ok(text),
        _ => malformed("the host response is malformed"),
    }
}

fn expect_record(value: EffectValue) -> Result<CoreBenchmarkRecord, HostFailure> {
    match value {
        EffectValue::Record(record) => Ok(record),
        _ => malformed("the benchmark record payload is malformed"),
    }
}

fn expect_decision(value: EffectValue) -> Result<crate::dto::CoreResearcherDecision, HostFailure> {
    match value {
        EffectValue::Decision(decision) => Ok(decision),
        _ => malformed("the review payload is malformed"),
    }
}

fn expect_timestamp(value: EffectValue) -> Result<String, HostFailure> {
    match value {
        EffectValue::Timestamp(timestamp) => Ok(timestamp),
        _ => malformed("the clock payload is malformed"),
    }
}

fn expect_empty(value: EffectValue) -> Result<(), HostFailure> {
    match value {
        EffectValue::Empty => Ok(()),
        _ => malformed("the append payload is malformed"),
    }
}

fn storage_failure(failure: HostFailure, aggregate: crate::error::Aggregate) -> StorageError {
    match failure.kind {
        FailureKind::NotFound => StorageError::NotFound { aggregate },
        FailureKind::Conflict => StorageError::Conflict {
            expected: None,
            actual: None,
        },
        FailureKind::Rejected | FailureKind::Unavailable => StorageError::Unavailable {
            detail: failure.message,
        },
    }
}

fn trigger_failure(failure: HostFailure) -> TriggerError {
    match failure.kind {
        FailureKind::Rejected => TriggerError::Rejected {
            detail: failure.message,
        },
        FailureKind::Unavailable | FailureKind::NotFound | FailureKind::Conflict => {
            TriggerError::Unavailable {
                detail: failure.message,
            }
        }
    }
}

fn ticket_failure(failure: HostFailure) -> TicketError {
    match failure.kind {
        FailureKind::Rejected => TicketError::Rejected {
            detail: failure.message,
        },
        FailureKind::Unavailable | FailureKind::NotFound | FailureKind::Conflict => {
            TicketError::Unavailable {
                detail: failure.message,
            }
        }
    }
}

fn session_failure(failure: HostFailure) -> SessionError {
    match failure.kind {
        FailureKind::Rejected => SessionError::Rejected {
            detail: failure.message,
        },
        FailureKind::Unavailable | FailureKind::NotFound | FailureKind::Conflict => {
            SessionError::Unavailable {
                detail: failure.message,
            }
        }
    }
}

fn benchmark_failure(failure: HostFailure) -> BenchmarkError {
    match failure.kind {
        FailureKind::Rejected => BenchmarkError::Rejected {
            detail: failure.message,
        },
        FailureKind::Unavailable | FailureKind::NotFound | FailureKind::Conflict => {
            BenchmarkError::Unavailable {
                detail: failure.message,
            }
        }
    }
}

fn clock_failure(failure: HostFailure) -> ClockError {
    match failure.kind {
        FailureKind::Rejected => ClockError::Rejected {
            detail: failure.message,
        },
        FailureKind::Unavailable | FailureKind::NotFound | FailureKind::Conflict => {
            ClockError::Unavailable {
                detail: failure.message,
            }
        }
    }
}

fn invalid_identifier(error: crate::error::IdError) -> HostFailure {
    HostFailure {
        kind: FailureKind::Unavailable,
        message: format!("invalid identifier: {error}"),
    }
}

struct BridgePlugin {
    storage: BridgeStorage,
    trigger: BridgeTrigger,
    executor: BridgeExecutor,
    sessions: BridgeSessions,
    benchmark: BridgeBenchmark,
    artifacts: BridgeArtifacts,
    clock: BridgeClock,
    tools: BridgeTools,
    http: BridgeHttp,
    surface: BridgeSurface,
}

impl BridgePlugin {
    fn new(state: Rc<RefCell<CoreState>>) -> Self {
        Self {
            storage: BridgeStorage {
                state: Rc::clone(&state),
            },
            trigger: BridgeTrigger {
                state: Rc::clone(&state),
            },
            executor: BridgeExecutor {
                state: Rc::clone(&state),
            },
            sessions: BridgeSessions {
                state: Rc::clone(&state),
            },
            benchmark: BridgeBenchmark {
                state: Rc::clone(&state),
            },
            artifacts: BridgeArtifacts,
            clock: BridgeClock {
                state: Rc::clone(&state),
            },
            tools: BridgeTools,
            http: BridgeHttp,
            surface: BridgeSurface,
        }
    }
}

struct BridgeStorage {
    state: Rc<RefCell<CoreState>>,
}

struct BridgeTrigger {
    state: Rc<RefCell<CoreState>>,
}

struct BridgeExecutor {
    state: Rc<RefCell<CoreState>>,
}

struct BridgeSessions {
    state: Rc<RefCell<CoreState>>,
}

struct BridgeBenchmark {
    state: Rc<RefCell<CoreState>>,
}

struct BridgeArtifacts;
struct BridgeClock {
    state: Rc<RefCell<CoreState>>,
}
struct BridgeTools;
struct BridgeHttp;
struct BridgeSurface;

impl Storage for BridgeStorage {
    async fn load_program(&self, id: &ProgramId) -> Result<Versioned<Program>, StorageError> {
        let payload = CoreStorageLoadProgram {
            program_id: id.as_str().to_string(),
        };
        let request = if self.state.borrow().mode == RunMode::Command {
            EffectRequest::Command(CommandEffectData::StorageLoadProgram(payload))
        } else {
            EffectRequest::Pipeline(PipelineEffectData::StorageLoadProgram(payload))
        };
        let response = host_request(&self.state, request).await;
        let value = response
            .map_err(|failure| storage_failure(failure, crate::error::Aggregate::Program))?;
        let (program, version) = match value {
            EffectValue::Program(program) => (program, Version::first()),
            EffectValue::VersionedProgram(program) => {
                let version =
                    Version::new(program.version.get()).map_err(|_| StorageError::Unavailable {
                        detail: "the program version is malformed".to_string(),
                    })?;
                (program.value, version)
            }
            _ => {
                return Err(StorageError::Unavailable {
                    detail: "the program payload is malformed".to_string(),
                });
            }
        };
        let domain = program
            .into_domain()
            .map_err(|_| StorageError::Unavailable {
                detail: "the program payload is malformed".to_string(),
            })?;
        Ok(Versioned::new(domain, version))
    }

    async fn save_program(
        &self,
        program: &Program,
        expected: Option<Version>,
    ) -> Result<Version, StorageError> {
        let payload = CoreStorageSaveProgram {
            expected: expected.map(DecimalU64::from),
            program: program.into(),
        };
        let response = host_request(
            &self.state,
            EffectRequest::Command(CommandEffectData::StorageSaveProgram(payload)),
        )
        .await;
        let value = response
            .map_err(|failure| storage_failure(failure, crate::error::Aggregate::Program))?;
        expect_version(value, "the program version is malformed")
    }

    async fn load_issue(&self, id: &IssueId) -> Result<Versioned<Issue>, StorageError> {
        let payload = CoreStorageLoadIssue {
            issue_id: id.as_str().to_string(),
        };
        let response = host_request(
            &self.state,
            EffectRequest::Command(CommandEffectData::StorageLoadIssue(payload)),
        )
        .await;
        let value =
            response.map_err(|failure| storage_failure(failure, crate::error::Aggregate::Issue))?;
        let issue = expect_issue(value)
            .map_err(|failure| storage_failure(failure, crate::error::Aggregate::Issue))?;
        let domain = issue
            .value
            .into_domain()
            .map_err(|_| StorageError::Unavailable {
                detail: "the issue payload is malformed".to_string(),
            })?;
        let version = Version::new(issue.version.get()).map_err(|_| StorageError::Unavailable {
            detail: "the issue version is malformed".to_string(),
        })?;
        Ok(Versioned::new(domain, version))
    }

    async fn save_issue(
        &self,
        issue: &Issue,
        expected: Option<Version>,
    ) -> Result<Version, StorageError> {
        let payload = CoreStorageSaveIssue {
            expected: expected.map(DecimalU64::from),
            issue: issue.into(),
        };
        let response = host_request(
            &self.state,
            EffectRequest::Command(CommandEffectData::StorageSaveIssue(payload)),
        )
        .await;
        let value =
            response.map_err(|failure| storage_failure(failure, crate::error::Aggregate::Issue))?;
        expect_version(value, "the issue version is malformed")
    }

    async fn load_experiment(
        &self,
        id: &ExperimentId,
    ) -> Result<Versioned<Experiment>, StorageError> {
        let payload = CoreStorageLoadExperiment {
            experiment_id: id.as_str().to_string(),
        };
        let response = host_request(
            &self.state,
            EffectRequest::Command(CommandEffectData::StorageLoadExperiment(payload)),
        )
        .await;
        let value = response
            .map_err(|failure| storage_failure(failure, crate::error::Aggregate::Experiment))?;
        let experiment = expect_experiment(value)
            .map_err(|failure| storage_failure(failure, crate::error::Aggregate::Experiment))?;
        let domain = experiment
            .value
            .into_domain()
            .map_err(|_| StorageError::Unavailable {
                detail: "the experiment payload is malformed".to_string(),
            })?;
        let version =
            Version::new(experiment.version.get()).map_err(|_| StorageError::Unavailable {
                detail: "the experiment version is malformed".to_string(),
            })?;
        Ok(Versioned::new(domain, version))
    }

    async fn save_experiment(
        &self,
        experiment: &Experiment,
        expected: Option<Version>,
    ) -> Result<Version, StorageError> {
        let payload = CoreStorageSaveExperiment {
            expected: expected.map(DecimalU64::from),
            experiment: experiment.into(),
        };
        let response = host_request(
            &self.state,
            EffectRequest::Command(CommandEffectData::StorageSaveExperiment(payload)),
        )
        .await;
        let value = response
            .map_err(|failure| storage_failure(failure, crate::error::Aggregate::Experiment))?;
        expect_version(value, "the experiment version is malformed")
    }

    async fn load_ticket(&self, id: &TicketId) -> Result<Versioned<Ticket>, StorageError> {
        let payload = CoreStorageLoadTicket {
            ticket_id: id.as_str().to_string(),
        };
        let response = host_request(
            &self.state,
            EffectRequest::Command(CommandEffectData::StorageLoadTicket(payload)),
        )
        .await;
        let value = response
            .map_err(|failure| storage_failure(failure, crate::error::Aggregate::Ticket))?;
        let ticket = expect_ticket(value)
            .map_err(|failure| storage_failure(failure, crate::error::Aggregate::Ticket))?;
        let domain = ticket
            .value
            .into_domain()
            .map_err(|_| StorageError::Unavailable {
                detail: "the ticket payload is malformed".to_string(),
            })?;
        let version =
            Version::new(ticket.version.get()).map_err(|_| StorageError::Unavailable {
                detail: "the ticket version is malformed".to_string(),
            })?;
        Ok(Versioned::new(domain, version))
    }

    async fn save_ticket(
        &self,
        ticket: &Ticket,
        expected: Option<Version>,
    ) -> Result<Version, StorageError> {
        let payload = CoreStorageSaveTicket {
            expected: expected.map(DecimalU64::from),
            ticket: ticket.into(),
        };
        let response = host_request(
            &self.state,
            EffectRequest::Command(CommandEffectData::StorageSaveTicket(payload)),
        )
        .await;
        let value = response
            .map_err(|failure| storage_failure(failure, crate::error::Aggregate::Ticket))?;
        expect_version(value, "the ticket version is malformed")
    }

    async fn append_benchmark_record(&self, record: &BenchmarkRecord) -> Result<(), StorageError> {
        let payload = CoreStorageAppendBenchmarkRecord {
            record: record.into(),
        };
        let response = host_request(
            &self.state,
            EffectRequest::Pipeline(PipelineEffectData::StorageAppendBenchmarkRecord(payload)),
        )
        .await;
        let value = response.map_err(|failure| {
            storage_failure(failure, crate::error::Aggregate::BenchmarkRecord)
        })?;
        expect_empty(value).map_err(|failure| {
            storage_failure(failure, crate::error::Aggregate::BenchmarkRecord)
        })?;
        match record.status() {
            crate::domain::BenchmarkStatus::Passed => {
                advance(&self.state, StageName::BenchmarkPassed)
            }
            crate::domain::BenchmarkStatus::Failed => {
                advance(&self.state, StageName::BenchmarkFailed)
            }
            crate::domain::BenchmarkStatus::Retryable => {
                advance(&self.state, StageName::BenchmarkRetryable)
            }
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

    async fn append_audit(&self, entry: &crate::domain::AuditEntry) -> Result<(), StorageError> {
        let role = self.state.borrow().audit_role;
        let payload = CoreStorageAppendAudit {
            role: CoreActorRole::from(role),
            entry: entry.into(),
        };
        let response = host_request(
            &self.state,
            EffectRequest::Command(CommandEffectData::StorageAppendAudit(payload)),
        )
        .await;
        let value =
            response.map_err(|failure| storage_failure(failure, crate::error::Aggregate::Audit))?;
        expect_empty(value)
            .map_err(|failure| storage_failure(failure, crate::error::Aggregate::Audit))
    }
}

impl TriggerSource for BridgeTrigger {
    async fn deliver(&self, request: TriggerRequest) -> Result<TriggerId, TriggerError> {
        let payload = CoreTriggerDeliver {
            experiment_id: request.experiment_id.as_str().to_string(),
            branch: request.branch.as_str().to_string(),
            base_commit: request.base_commit.as_str().to_string(),
        };
        let response = host_request(
            &self.state,
            EffectRequest::Pipeline(PipelineEffectData::TriggerDeliver(payload)),
        )
        .await
        .map_err(trigger_failure)?;
        let text = expect_text(response).map_err(trigger_failure)?;
        let trigger =
            TriggerId::new(text).map_err(|error| trigger_failure(invalid_identifier(error)))?;
        advance(&self.state, StageName::TriggerAccepted);
        Ok(trigger)
    }
}

impl TicketExecutor for BridgeExecutor {
    async fn open(&self, request: TicketRequest) -> Result<TicketId, TicketError> {
        let payload = CoreExecutorOpen {
            program_id: request.program_id.as_str().to_string(),
            issue_id: request.issue_id.as_str().to_string(),
            experiment_id: request.experiment_id.as_str().to_string(),
        };
        let response = host_request(
            &self.state,
            EffectRequest::Pipeline(PipelineEffectData::ExecutorOpen(payload)),
        )
        .await
        .map_err(ticket_failure)?;
        let text = expect_text(response).map_err(ticket_failure)?;
        let ticket =
            TicketId::new(text).map_err(|error| ticket_failure(invalid_identifier(error)))?;
        advance(&self.state, StageName::TicketOpened);
        Ok(ticket)
    }
}

impl Sessions for BridgeSessions {
    async fn start_worker(&self, request: WorkerRequest) -> Result<SessionId, SessionError> {
        let payload = CoreSessionsStartWorker {
            ticket_id: request.ticket_id.as_str().to_string(),
            experiment_id: request.experiment_id.as_str().to_string(),
        };
        let response = host_request(
            &self.state,
            EffectRequest::Pipeline(PipelineEffectData::SessionsStartWorker(payload)),
        )
        .await
        .map_err(session_failure)?;
        let text = expect_text(response).map_err(session_failure)?;
        let session =
            SessionId::new(text).map_err(|error| session_failure(invalid_identifier(error)))?;
        advance(&self.state, StageName::WorkerStarted);
        Ok(session)
    }

    async fn submit_commit(&self, request: CommitRequest) -> Result<CommitSha, SessionError> {
        let payload = CoreSessionsSubmitCommit {
            ticket_id: request.ticket_id.as_str().to_string(),
            worker_session_id: request.worker_session_id.as_str().to_string(),
        };
        let response = host_request(
            &self.state,
            EffectRequest::Pipeline(PipelineEffectData::SessionsSubmitCommit(payload)),
        )
        .await
        .map_err(session_failure)?;
        let text = expect_text(response).map_err(session_failure)?;
        let commit =
            CommitSha::new(text).map_err(|error| session_failure(invalid_identifier(error)))?;
        advance(&self.state, StageName::CommitSubmitted);
        Ok(commit)
    }

    async fn review(&self, request: ReviewRequest) -> Result<ResearcherDecision, SessionError> {
        advance(&self.state, StageName::ResultRecorded);
        let payload = CoreSessionsReview {
            experiment_id: request.experiment_id.as_str().to_string(),
            benchmark: (&request.benchmark).into(),
        };
        let response = host_request(
            &self.state,
            EffectRequest::Pipeline(PipelineEffectData::SessionsReview(payload)),
        )
        .await
        .map_err(session_failure)?;
        let decision = expect_decision(response).map_err(session_failure)?;
        advance(&self.state, StageName::ReviewRecorded);
        Ok(decision.into())
    }
}

impl BenchmarkRunner for BridgeBenchmark {
    async fn spec_hash(&self, spec: &BenchmarkSpec) -> Result<SpecHash, BenchmarkError> {
        let payload = CoreBenchmarkSpecHash { spec: spec.into() };
        let response = host_request(
            &self.state,
            EffectRequest::Pipeline(PipelineEffectData::BenchmarkSpecHash(payload)),
        )
        .await
        .map_err(benchmark_failure)?;
        let text = expect_text(response).map_err(benchmark_failure)?;
        SpecHash::new(text).map_err(|_| BenchmarkError::Unavailable {
            detail: "the spec hash payload is malformed".to_string(),
        })
    }

    async fn build_environment(
        &self,
        request: EnvironmentRequest,
    ) -> Result<EnvironmentDigest, BenchmarkError> {
        let payload = CoreBenchmarkBuildEnvironment {
            commit: request.commit.as_str().to_string(),
            environment: (&request.environment).into(),
        };
        let response = host_request(
            &self.state,
            EffectRequest::Pipeline(PipelineEffectData::BenchmarkBuildEnvironment(payload)),
        )
        .await
        .map_err(benchmark_failure)?;
        let text = expect_text(response).map_err(benchmark_failure)?;
        let digest = EnvironmentDigest::new(text).map_err(|_| BenchmarkError::Unavailable {
            detail: "the environment digest payload is malformed".to_string(),
        })?;
        advance(&self.state, StageName::EnvironmentBuilt);
        Ok(digest)
    }

    async fn run(&self, request: BenchmarkRequest) -> Result<BenchmarkRecord, BenchmarkError> {
        let payload = CoreBenchmarkRun {
            experiment_id: request.experiment_id.as_str().to_string(),
            ticket_id: request.ticket_id.as_str().to_string(),
            spec: (&request.spec).into(),
            commit: request.commit.as_str().to_string(),
            environment_digest: request.environment_digest.as_str().to_string(),
            attempt: request.attempt.get(),
            max_attempts: request.max_attempts.get(),
        };
        let response = host_request(
            &self.state,
            EffectRequest::Pipeline(PipelineEffectData::BenchmarkRun(payload)),
        )
        .await
        .map_err(benchmark_failure)?;
        let record = expect_record(response).map_err(benchmark_failure)?;
        record
            .into_domain()
            .map_err(|_| BenchmarkError::Unavailable {
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
        let request = if self.state.borrow().mode == RunMode::Command {
            EffectRequest::Command(CommandEffectData::ClockNow)
        } else {
            EffectRequest::Pipeline(PipelineEffectData::ClockNow)
        };
        let response = host_request(&self.state, request)
            .await
            .map_err(clock_failure)?;
        let text = expect_timestamp(response).map_err(clock_failure)?;
        let timestamp = Timestamp::parse(&text).map_err(|_| ClockError::Unavailable {
            detail: "the clock payload is malformed".to_string(),
        })?;
        advance(&self.state, StageName::ResearchCompleted);
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

async fn execute_command(
    plugin: &BridgePlugin,
    request_id: RequestId,
    actor: Actor,
    draft: CommandDraft,
) -> (CommandName, Result<CommandOutcome, CommandError>) {
    let command = draft.name();
    let gate = HostGate::new(plugin);
    let executor = CommandExecutor::new(plugin);
    macro_rules! run {
        ($kind:ty) => {{
            let authorized = gate
                .authorize::<$kind>(&actor, request_id.clone(), draft)
                .await;
            match authorized {
                Ok(authorized) => executor.execute(authorized).await,
                Err(error) => Err(error),
            }
        }};
    }
    let result = match command {
        CommandName::CreateProgram => run!(CreateProgram),
        CommandName::PauseProgram => run!(PauseProgram),
        CommandName::ResumeProgram => run!(ResumeProgram),
        CommandName::StopProgram => run!(StopProgram),
        CommandName::SetProgramGoal => run!(SetProgramGoal),
        CommandName::SetProgramMethodology => run!(SetProgramMethodology),
        CommandName::SetProgramExploration => run!(SetProgramExploration),
        CommandName::CreateIssue => run!(CreateIssue),
        CommandName::ClaimIssue => run!(ClaimIssue),
        CommandName::CommentIssue => run!(CommentIssue),
        CommandName::CloseIssue => run!(CloseIssue),
        CommandName::ProposeExperiment => run!(ProposeExperiment),
        CommandName::ReviewExperiment => run!(ReviewExperiment),
        CommandName::CloseExperiment => run!(CloseExperiment),
        CommandName::RequestBenchmark => run!(RequestBenchmark),
        CommandName::SubmitTicket => run!(SubmitTicket),
    };
    (command, result)
}
