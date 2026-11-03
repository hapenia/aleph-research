use std::collections::HashSet;
use std::fmt;
use std::marker::PhantomData;

use getset::Getters;

use crate::domain::{
    AuditEntry, BenchmarkSpec, Environment, Experiment, ExperimentInput, ExperimentStatus,
    Exploration, Issue, IssueInput, IssueStatus, Lineage, MetricWeight, Program, ProgramInput,
    ProgramStatus, ResearchPolicy, ResearcherDecision, Ticket, TicketStatus, Usage, Versioned,
};
use crate::error::{ClockError, StorageError};
use crate::id::{
    ActorId, AuditId, BranchName, CommentId, CommitSha, ExperimentId, IssueId, ProgramId,
    RequestId, SessionId, TicketId, Version,
};
use crate::plugin::{Clock, Plugin, Storage};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CommandName {
    CreateProgram,
    PauseProgram,
    ResumeProgram,
    StopProgram,
    SetProgramGoal,
    SetProgramMethodology,
    SetProgramExploration,
    CreateIssue,
    ClaimIssue,
    CommentIssue,
    CloseIssue,
    ProposeExperiment,
    ReviewExperiment,
    CloseExperiment,
    RequestBenchmark,
    SubmitTicket,
}

impl CommandName {
    pub const fn code(self) -> u8 {
        match self {
            Self::CreateProgram => 0,
            Self::PauseProgram => 1,
            Self::ResumeProgram => 2,
            Self::StopProgram => 3,
            Self::SetProgramGoal => 4,
            Self::SetProgramMethodology => 5,
            Self::SetProgramExploration => 6,
            Self::CreateIssue => 7,
            Self::ClaimIssue => 8,
            Self::CommentIssue => 9,
            Self::CloseIssue => 10,
            Self::ProposeExperiment => 11,
            Self::ReviewExperiment => 12,
            Self::CloseExperiment => 13,
            Self::RequestBenchmark => 14,
            Self::SubmitTicket => 15,
        }
    }

    pub const fn from_code(code: u8) -> Option<Self> {
        match code {
            0 => Some(Self::CreateProgram),
            1 => Some(Self::PauseProgram),
            2 => Some(Self::ResumeProgram),
            3 => Some(Self::StopProgram),
            4 => Some(Self::SetProgramGoal),
            5 => Some(Self::SetProgramMethodology),
            6 => Some(Self::SetProgramExploration),
            7 => Some(Self::CreateIssue),
            8 => Some(Self::ClaimIssue),
            9 => Some(Self::CommentIssue),
            10 => Some(Self::CloseIssue),
            11 => Some(Self::ProposeExperiment),
            12 => Some(Self::ReviewExperiment),
            13 => Some(Self::CloseExperiment),
            14 => Some(Self::RequestBenchmark),
            15 => Some(Self::SubmitTicket),
            _ => None,
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::CreateProgram => "program.create",
            Self::PauseProgram => "program.pause",
            Self::ResumeProgram => "program.resume",
            Self::StopProgram => "program.stop",
            Self::SetProgramGoal => "program.goal",
            Self::SetProgramMethodology => "program.methodology",
            Self::SetProgramExploration => "program.exploration",
            Self::CreateIssue => "issue.create",
            Self::ClaimIssue => "issue.claim",
            Self::CommentIssue => "issue.comment",
            Self::CloseIssue => "issue.close",
            Self::ProposeExperiment => "experiment.propose",
            Self::ReviewExperiment => "experiment.review",
            Self::CloseExperiment => "experiment.close",
            Self::RequestBenchmark => "benchmark.request",
            Self::SubmitTicket => "ticket.submit",
        }
    }
}

impl fmt::Display for CommandName {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Capability {
    ManageProgram,
    WriteIssue,
    ClaimIssue,
    WriteExperiment,
    RequestBenchmark,
    SubmitTicket,
}

impl Capability {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ManageProgram => "program.manage",
            Self::WriteIssue => "issue.write",
            Self::ClaimIssue => "issue.claim",
            Self::WriteExperiment => "experiment.write",
            Self::RequestBenchmark => "benchmark.request",
            Self::SubmitTicket => "ticket.submit",
        }
    }
}

impl fmt::Display for Capability {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ActorRole {
    Operator,
    Researcher,
    Implementer,
}

impl ActorRole {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Operator => "operator",
            Self::Researcher => "researcher",
            Self::Implementer => "implementer",
        }
    }

    pub const fn grants(self, capability: Capability) -> bool {
        matches!(
            (self, capability),
            (
                Self::Operator,
                Capability::ManageProgram | Capability::WriteIssue | Capability::RequestBenchmark
            ) | (
                Self::Researcher,
                Capability::WriteIssue
                    | Capability::ClaimIssue
                    | Capability::WriteExperiment
                    | Capability::RequestBenchmark
            ) | (
                Self::Implementer,
                Capability::WriteIssue | Capability::SubmitTicket
            )
        )
    }
}

impl fmt::Display for ActorRole {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Getters)]
pub struct Actor {
    #[getset(get = "pub")]
    id: ActorId,
    role: ActorRole,
    session: Option<SessionId>,
}

impl Actor {
    pub fn new(id: ActorId, role: ActorRole, session: Option<SessionId>) -> Self {
        Self { id, role, session }
    }

    pub fn operator(id: ActorId) -> Self {
        Self {
            id,
            role: ActorRole::Operator,
            session: None,
        }
    }

    pub fn researcher(id: ActorId, session: SessionId) -> Self {
        Self {
            id,
            role: ActorRole::Researcher,
            session: Some(session),
        }
    }

    pub fn implementer(id: ActorId, session: SessionId) -> Self {
        Self {
            id,
            role: ActorRole::Implementer,
            session: Some(session),
        }
    }

    pub const fn role(&self) -> ActorRole {
        self.role
    }

    pub fn session(&self) -> Option<&SessionId> {
        self.session.as_ref()
    }

    pub const fn has_capability(&self, capability: Capability) -> bool {
        self.role.grants(capability)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CommandSubject {
    Program(ProgramId),
    Issue(IssueId),
    Experiment(ExperimentId),
    Ticket(TicketId),
}

impl fmt::Display for CommandSubject {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Program(id) => write!(formatter, "program:{id}"),
            Self::Issue(id) => write!(formatter, "issue:{id}"),
            Self::Experiment(id) => write!(formatter, "experiment:{id}"),
            Self::Ticket(id) => write!(formatter, "ticket:{id}"),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct CreateProgramCommand {
    pub id: ProgramId,
    pub name: String,
    pub goal: String,
    pub methodology: String,
    pub benchmark: BenchmarkSpec,
    pub utility: Vec<MetricWeight>,
    pub exploration: Exploration,
    pub policy: ResearchPolicy,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PauseProgramCommand {
    pub program_id: ProgramId,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResumeProgramCommand {
    pub program_id: ProgramId,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StopProgramCommand {
    pub program_id: ProgramId,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SetProgramGoalCommand {
    pub program_id: ProgramId,
    pub goal: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SetProgramMethodologyCommand {
    pub program_id: ProgramId,
    pub methodology: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SetProgramExplorationCommand {
    pub program_id: ProgramId,
    pub exploration: Exploration,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreateIssueCommand {
    pub id: IssueId,
    pub program_id: ProgramId,
    pub title: String,
    pub body: String,
    pub labels: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaimIssueCommand {
    pub issue_id: IssueId,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommentIssueCommand {
    pub issue_id: IssueId,
    pub body: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloseIssueCommand {
    pub issue_id: IssueId,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ProposeExperimentCommand {
    pub id: ExperimentId,
    pub program_id: ProgramId,
    pub issue_id: IssueId,
    pub branch: BranchName,
    pub head: CommitSha,
    pub environment: Environment,
    pub lineage: Lineage,
    pub plan_comment_id: Option<CommentId>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReviewExperimentCommand {
    pub experiment_id: ExperimentId,
    pub decision: ResearcherDecision,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloseExperimentCommand {
    pub experiment_id: ExperimentId,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequestBenchmarkCommand {
    pub experiment_id: ExperimentId,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubmitTicketCommand {
    pub ticket_id: TicketId,
    pub commit: CommitSha,
}

#[derive(Debug, Clone, PartialEq)]
pub enum CommandDraft {
    CreateProgram(Box<CreateProgramCommand>),
    PauseProgram(Box<PauseProgramCommand>),
    ResumeProgram(Box<ResumeProgramCommand>),
    StopProgram(Box<StopProgramCommand>),
    SetProgramGoal(Box<SetProgramGoalCommand>),
    SetProgramMethodology(Box<SetProgramMethodologyCommand>),
    SetProgramExploration(Box<SetProgramExplorationCommand>),
    CreateIssue(Box<CreateIssueCommand>),
    ClaimIssue(Box<ClaimIssueCommand>),
    CommentIssue(Box<CommentIssueCommand>),
    CloseIssue(Box<CloseIssueCommand>),
    ProposeExperiment(Box<ProposeExperimentCommand>),
    ReviewExperiment(Box<ReviewExperimentCommand>),
    CloseExperiment(Box<CloseExperimentCommand>),
    RequestBenchmark(Box<RequestBenchmarkCommand>),
    SubmitTicket(Box<SubmitTicketCommand>),
}

impl CommandDraft {
    pub const fn name(&self) -> CommandName {
        match self {
            Self::CreateProgram(_) => CommandName::CreateProgram,
            Self::PauseProgram(_) => CommandName::PauseProgram,
            Self::ResumeProgram(_) => CommandName::ResumeProgram,
            Self::StopProgram(_) => CommandName::StopProgram,
            Self::SetProgramGoal(_) => CommandName::SetProgramGoal,
            Self::SetProgramMethodology(_) => CommandName::SetProgramMethodology,
            Self::SetProgramExploration(_) => CommandName::SetProgramExploration,
            Self::CreateIssue(_) => CommandName::CreateIssue,
            Self::ClaimIssue(_) => CommandName::ClaimIssue,
            Self::CommentIssue(_) => CommandName::CommentIssue,
            Self::CloseIssue(_) => CommandName::CloseIssue,
            Self::ProposeExperiment(_) => CommandName::ProposeExperiment,
            Self::ReviewExperiment(_) => CommandName::ReviewExperiment,
            Self::CloseExperiment(_) => CommandName::CloseExperiment,
            Self::RequestBenchmark(_) => CommandName::RequestBenchmark,
            Self::SubmitTicket(_) => CommandName::SubmitTicket,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Command {
    CreateProgram(Box<CreateProgramCommand>),
    PauseProgram(Box<PauseProgramCommand>),
    ResumeProgram(Box<ResumeProgramCommand>),
    StopProgram(Box<StopProgramCommand>),
    SetProgramGoal(Box<SetProgramGoalCommand>),
    SetProgramMethodology(Box<SetProgramMethodologyCommand>),
    SetProgramExploration(Box<SetProgramExplorationCommand>),
    CreateIssue(Box<CreateIssueCommand>),
    ClaimIssue(Box<ClaimIssueCommand>),
    CommentIssue(Box<CommentIssueCommand>),
    CloseIssue(Box<CloseIssueCommand>),
    ProposeExperiment(Box<ProposeExperimentCommand>),
    ReviewExperiment(Box<ReviewExperimentCommand>),
    CloseExperiment(Box<CloseExperimentCommand>),
    RequestBenchmark(Box<RequestBenchmarkCommand>),
    SubmitTicket(Box<SubmitTicketCommand>),
}

impl Command {
    pub const fn name(&self) -> CommandName {
        match self {
            Self::CreateProgram(_) => CommandName::CreateProgram,
            Self::PauseProgram(_) => CommandName::PauseProgram,
            Self::ResumeProgram(_) => CommandName::ResumeProgram,
            Self::StopProgram(_) => CommandName::StopProgram,
            Self::SetProgramGoal(_) => CommandName::SetProgramGoal,
            Self::SetProgramMethodology(_) => CommandName::SetProgramMethodology,
            Self::SetProgramExploration(_) => CommandName::SetProgramExploration,
            Self::CreateIssue(_) => CommandName::CreateIssue,
            Self::ClaimIssue(_) => CommandName::ClaimIssue,
            Self::CommentIssue(_) => CommandName::CommentIssue,
            Self::CloseIssue(_) => CommandName::CloseIssue,
            Self::ProposeExperiment(_) => CommandName::ProposeExperiment,
            Self::ReviewExperiment(_) => CommandName::ReviewExperiment,
            Self::CloseExperiment(_) => CommandName::CloseExperiment,
            Self::RequestBenchmark(_) => CommandName::RequestBenchmark,
            Self::SubmitTicket(_) => CommandName::SubmitTicket,
        }
    }

    pub const fn capability(&self) -> Capability {
        match self {
            Self::CreateProgram(_)
            | Self::PauseProgram(_)
            | Self::ResumeProgram(_)
            | Self::StopProgram(_)
            | Self::SetProgramGoal(_)
            | Self::SetProgramMethodology(_)
            | Self::SetProgramExploration(_) => Capability::ManageProgram,
            Self::CreateIssue(_) | Self::CommentIssue(_) | Self::CloseIssue(_) => {
                Capability::WriteIssue
            }
            Self::ClaimIssue(_) => Capability::ClaimIssue,
            Self::ProposeExperiment(_) | Self::ReviewExperiment(_) | Self::CloseExperiment(_) => {
                Capability::WriteExperiment
            }
            Self::RequestBenchmark(_) => Capability::RequestBenchmark,
            Self::SubmitTicket(_) => Capability::SubmitTicket,
        }
    }

    pub fn subject(&self) -> CommandSubject {
        match self {
            Self::CreateProgram(command) => CommandSubject::Program(command.id.clone()),
            Self::PauseProgram(command) => CommandSubject::Program(command.program_id.clone()),
            Self::ResumeProgram(command) => CommandSubject::Program(command.program_id.clone()),
            Self::StopProgram(command) => CommandSubject::Program(command.program_id.clone()),
            Self::SetProgramGoal(command) => CommandSubject::Program(command.program_id.clone()),
            Self::SetProgramMethodology(command) => {
                CommandSubject::Program(command.program_id.clone())
            }
            Self::SetProgramExploration(command) => {
                CommandSubject::Program(command.program_id.clone())
            }
            Self::CreateIssue(command) => CommandSubject::Issue(command.id.clone()),
            Self::ClaimIssue(command) => CommandSubject::Issue(command.issue_id.clone()),
            Self::CommentIssue(command) => CommandSubject::Issue(command.issue_id.clone()),
            Self::CloseIssue(command) => CommandSubject::Issue(command.issue_id.clone()),
            Self::ProposeExperiment(command) => CommandSubject::Experiment(command.id.clone()),
            Self::ReviewExperiment(command) => {
                CommandSubject::Experiment(command.experiment_id.clone())
            }
            Self::CloseExperiment(command) => {
                CommandSubject::Experiment(command.experiment_id.clone())
            }
            Self::RequestBenchmark(command) => {
                CommandSubject::Experiment(command.experiment_id.clone())
            }
            Self::SubmitTicket(command) => CommandSubject::Ticket(command.ticket_id.clone()),
        }
    }

    pub fn audit_detail(&self) -> String {
        match self {
            Self::CommentIssue(command) => command.body.clone(),
            Self::ReviewExperiment(command) => command.decision.to_string(),
            Self::SetProgramGoal(command) => command.goal.clone(),
            Self::SetProgramMethodology(command) => command.methodology.clone(),
            _ => String::new(),
        }
    }
}

mod sealed {
    pub trait Sealed {}
}

pub trait CommandKind: sealed::Sealed + Sized {
    type Command: Clone;

    const NAME: CommandName;

    fn parse(draft: CommandDraft) -> Result<Self::Command, CommandError>;

    fn into_command(command: Self::Command) -> Command;
}

macro_rules! command_kind {
    ($name:ident, $payload:ident) => {
        #[derive(Debug, Clone, Copy)]
        pub struct $name;

        impl sealed::Sealed for $name {}

        impl CommandKind for $name {
            type Command = $payload;

            const NAME: CommandName = CommandName::$name;

            fn parse(draft: CommandDraft) -> Result<Self::Command, CommandError> {
                match draft {
                    CommandDraft::$name(command) => Ok(*command),
                    _ => Err(CommandError::InvalidDraft {
                        command: CommandName::$name,
                        detail: "draft kind does not match the requested command".to_string(),
                    }),
                }
            }

            fn into_command(command: Self::Command) -> Command {
                Command::$name(Box::new(command))
            }
        }
    };
}

command_kind!(CreateProgram, CreateProgramCommand);
command_kind!(PauseProgram, PauseProgramCommand);
command_kind!(ResumeProgram, ResumeProgramCommand);
command_kind!(StopProgram, StopProgramCommand);
command_kind!(SetProgramGoal, SetProgramGoalCommand);
command_kind!(SetProgramMethodology, SetProgramMethodologyCommand);
command_kind!(SetProgramExploration, SetProgramExplorationCommand);
command_kind!(CreateIssue, CreateIssueCommand);
command_kind!(ClaimIssue, ClaimIssueCommand);
command_kind!(CommentIssue, CommentIssueCommand);
command_kind!(CloseIssue, CloseIssueCommand);
command_kind!(ProposeExperiment, ProposeExperimentCommand);
command_kind!(ReviewExperiment, ReviewExperimentCommand);
command_kind!(CloseExperiment, CloseExperimentCommand);
command_kind!(RequestBenchmark, RequestBenchmarkCommand);
command_kind!(SubmitTicket, SubmitTicketCommand);

pub struct AuthorizationProof<K> {
    name: CommandName,
    marker: PhantomData<fn() -> K>,
}

impl<K> AuthorizationProof<K> {
    fn mint(name: CommandName) -> Self {
        Self {
            name,
            marker: PhantomData,
        }
    }

    pub const fn name(&self) -> CommandName {
        self.name
    }
}

impl<K> fmt::Debug for AuthorizationProof<K> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "AuthorizationProof({})", self.name)
    }
}

#[derive(Debug)]
pub struct AuthorizedCommand<K: CommandKind> {
    command: K::Command,
    actor: Actor,
    request_id: RequestId,
    authorization: AuthorizationProof<K>,
}

impl<K: CommandKind> AuthorizedCommand<K> {
    pub fn command(&self) -> &K::Command {
        &self.command
    }

    pub fn actor(&self) -> &Actor {
        &self.actor
    }

    pub fn request_id(&self) -> &RequestId {
        &self.request_id
    }

    pub const fn name(&self) -> CommandName {
        K::NAME
    }

    pub const fn authorization(&self) -> &AuthorizationProof<K> {
        &self.authorization
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CommandErrorKind {
    InvalidDraft,
    Unauthorized,
    Forbidden,
    Ownership,
    StateConflict,
    Storage,
    Clock,
}

impl CommandErrorKind {
    pub const fn code(self) -> u8 {
        match self {
            Self::InvalidDraft => 0,
            Self::Unauthorized => 1,
            Self::Forbidden => 2,
            Self::Ownership => 3,
            Self::StateConflict => 4,
            Self::Storage => 5,
            Self::Clock => 6,
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::InvalidDraft => "invalid-draft",
            Self::Unauthorized => "unauthorized",
            Self::Forbidden => "forbidden",
            Self::Ownership => "ownership",
            Self::StateConflict => "state-conflict",
            Self::Storage => "storage",
            Self::Clock => "clock",
        }
    }
}

impl fmt::Display for CommandErrorKind {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum CommandError {
    #[error("invalid {command} command: {detail}")]
    InvalidDraft {
        command: CommandName,
        detail: String,
    },
    #[error("{actor} is not authorized for {command}: {detail}")]
    Unauthorized {
        actor: ActorId,
        command: CommandName,
        detail: String,
    },
    #[error("{actor} lacks capability {capability} for {command}")]
    Forbidden {
        actor: ActorId,
        command: CommandName,
        capability: Capability,
    },
    #[error("{actor} does not own {subject} for {command}")]
    Ownership {
        actor: ActorId,
        command: CommandName,
        subject: String,
    },
    #[error("{command} cannot change {subject} while it is {state}")]
    StateConflict {
        command: CommandName,
        subject: String,
        state: String,
    },
    #[error("command storage error: {0}")]
    Storage(StorageError),
    #[error("command clock error: {0}")]
    Clock(ClockError),
}

impl CommandError {
    pub const fn kind(&self) -> CommandErrorKind {
        match self {
            Self::InvalidDraft { .. } => CommandErrorKind::InvalidDraft,
            Self::Unauthorized { .. } => CommandErrorKind::Unauthorized,
            Self::Forbidden { .. } => CommandErrorKind::Forbidden,
            Self::Ownership { .. } => CommandErrorKind::Ownership,
            Self::StateConflict { .. } => CommandErrorKind::StateConflict,
            Self::Storage(_) => CommandErrorKind::Storage,
            Self::Clock(_) => CommandErrorKind::Clock,
        }
    }

    pub const fn command(&self) -> Option<CommandName> {
        match self {
            Self::InvalidDraft { command, .. }
            | Self::Unauthorized { command, .. }
            | Self::Forbidden { command, .. }
            | Self::Ownership { command, .. }
            | Self::StateConflict { command, .. } => Some(*command),
            Self::Storage(_) | Self::Clock(_) => None,
        }
    }
}

impl From<ClockError> for CommandError {
    fn from(error: ClockError) -> Self {
        Self::Clock(error)
    }
}

impl From<StorageError> for CommandError {
    fn from(error: StorageError) -> Self {
        Self::Storage(error)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CommandOutcome {
    ProgramCreated {
        program: ProgramId,
        version: Version,
    },
    ProgramUpdated {
        program: ProgramId,
        version: Version,
    },
    IssueCreated {
        issue: IssueId,
        version: Version,
    },
    IssueUpdated {
        issue: IssueId,
        version: Version,
    },
    IssueCommented {
        issue: IssueId,
    },
    ExperimentCreated {
        experiment: ExperimentId,
        version: Version,
    },
    ExperimentUpdated {
        experiment: ExperimentId,
        version: Version,
    },
    ExperimentReviewed {
        experiment: ExperimentId,
        decision: ResearcherDecision,
    },
    BenchmarkRequested {
        experiment: ExperimentId,
    },
    TicketSubmitted {
        ticket: TicketId,
        commit: CommitSha,
        version: Version,
    },
}

pub struct HostGate<'a, P: Plugin> {
    plugin: &'a P,
}

impl<'a, P: Plugin> HostGate<'a, P> {
    pub fn new(plugin: &'a P) -> Self {
        Self { plugin }
    }

    pub async fn authorize<K: CommandKind>(
        &self,
        actor: &Actor,
        request_id: RequestId,
        draft: CommandDraft,
    ) -> Result<AuthorizedCommand<K>, CommandError> {
        let command = K::parse(draft)?;
        let unified = K::into_command(command.clone());
        validate_command(&unified)?;
        authorize_command(self.plugin, actor, &unified).await?;
        Ok(AuthorizedCommand {
            command,
            actor: actor.clone(),
            request_id,
            authorization: AuthorizationProof::mint(K::NAME),
        })
    }
}

pub struct CommandExecutor<'a, P: Plugin> {
    plugin: &'a P,
}

impl<'a, P: Plugin> CommandExecutor<'a, P> {
    pub fn new(plugin: &'a P) -> Self {
        Self { plugin }
    }

    pub async fn execute<K: CommandKind>(
        &self,
        authorized: AuthorizedCommand<K>,
    ) -> Result<CommandOutcome, CommandError> {
        let AuthorizedCommand {
            command,
            actor,
            request_id,
            authorization,
        } = authorized;
        if authorization.name() != K::NAME {
            return Err(CommandError::Unauthorized {
                actor: actor.id().clone(),
                command: K::NAME,
                detail: "authorization proof does not match the command".to_string(),
            });
        }
        let command = K::into_command(command);
        if command.name() != K::NAME {
            return Err(CommandError::Unauthorized {
                actor: actor.id().clone(),
                command: K::NAME,
                detail: "authorized payload does not match the command kind".to_string(),
            });
        }
        let name = command.name();
        let subject = command.subject();
        let detail = command.audit_detail();
        let outcome = self.execute_command(&actor, &command).await?;
        self.append_audit(&actor, request_id, name, subject, detail)
            .await?;
        Ok(outcome)
    }

    async fn execute_command(
        &self,
        actor: &Actor,
        command: &Command,
    ) -> Result<CommandOutcome, CommandError> {
        let name = command.name();
        match command {
            Command::CreateProgram(command) => {
                let program = Program::new(ProgramInput {
                    id: command.id.clone(),
                    owner: actor.id().clone(),
                    name: command.name.clone(),
                    goal: command.goal.clone(),
                    methodology: command.methodology.clone(),
                    benchmark: command.benchmark.clone(),
                    utility: command.utility.clone(),
                    exploration: command.exploration,
                    policy: command.policy,
                    usage: Usage::ZERO,
                    status: ProgramStatus::Running,
                    created_at: self.plugin.clock().now().await?,
                })
                .map_err(|error| invalid_error(name, error))?;
                let version = self.plugin.storage().save_program(&program, None).await?;
                Ok(CommandOutcome::ProgramCreated {
                    program: command.id.clone(),
                    version,
                })
            }
            Command::PauseProgram(command) => {
                self.update_program(&command.program_id, |program| {
                    program.set_status(ProgramStatus::Paused);
                })
                .await
            }
            Command::ResumeProgram(command) => {
                self.update_program(&command.program_id, |program| {
                    program.set_status(ProgramStatus::Running);
                })
                .await
            }
            Command::StopProgram(command) => {
                self.update_program(&command.program_id, |program| {
                    program.set_status(ProgramStatus::Stopped);
                })
                .await
            }
            Command::SetProgramGoal(command) => {
                self.update_program(&command.program_id, |program| {
                    program.set_goal(command.goal.clone());
                })
                .await
            }
            Command::SetProgramMethodology(command) => {
                self.update_program(&command.program_id, |program| {
                    program.set_methodology(command.methodology.clone());
                })
                .await
            }
            Command::SetProgramExploration(command) => {
                self.update_program(&command.program_id, |program| {
                    program.set_exploration(command.exploration);
                })
                .await
            }
            Command::CreateIssue(command) => {
                let issue = Issue::new(IssueInput {
                    id: command.id.clone(),
                    program_id: command.program_id.clone(),
                    title: command.title.clone(),
                    body: command.body.clone(),
                    labels: command.labels.clone(),
                    author: actor.id().clone(),
                    created_at: self.plugin.clock().now().await?,
                })
                .map_err(|error| invalid_error(name, error))?;
                let version = self.plugin.storage().save_issue(&issue, None).await?;
                Ok(CommandOutcome::IssueCreated {
                    issue: command.id.clone(),
                    version,
                })
            }
            Command::ClaimIssue(command) => {
                let session = require_session(actor, name)?;
                let stored = self.plugin.storage().load_issue(&command.issue_id).await?;
                let issue = stored.value().clone().assign(session.clone());
                let version = self
                    .plugin
                    .storage()
                    .save_issue(&issue, Some(stored.version()))
                    .await?;
                Ok(CommandOutcome::IssueUpdated {
                    issue: command.issue_id.clone(),
                    version,
                })
            }
            Command::CommentIssue(command) => Ok(CommandOutcome::IssueCommented {
                issue: command.issue_id.clone(),
            }),
            Command::CloseIssue(command) => {
                let stored = self.plugin.storage().load_issue(&command.issue_id).await?;
                let issue = stored.value().clone().close();
                let version = self
                    .plugin
                    .storage()
                    .save_issue(&issue, Some(stored.version()))
                    .await?;
                Ok(CommandOutcome::IssueUpdated {
                    issue: command.issue_id.clone(),
                    version,
                })
            }
            Command::ProposeExperiment(command) => {
                let experiment = Experiment::new(ExperimentInput {
                    id: command.id.clone(),
                    program_id: command.program_id.clone(),
                    issue_id: command.issue_id.clone(),
                    branch: command.branch.clone(),
                    head: command.head.clone(),
                    environment: command.environment.clone(),
                    lineage: command.lineage.clone(),
                    plan_comment_id: command.plan_comment_id.clone(),
                    created_by: actor.id().clone(),
                    created_at: self.plugin.clock().now().await?,
                    status: ExperimentStatus::Open,
                });
                let version = self
                    .plugin
                    .storage()
                    .save_experiment(&experiment, None)
                    .await?;
                let stored = self.plugin.storage().load_issue(&command.issue_id).await?;
                let mut issue = stored.value().clone();
                issue.add_experiment(command.id.clone());
                self.plugin
                    .storage()
                    .save_issue(&issue, Some(stored.version()))
                    .await?;
                Ok(CommandOutcome::ExperimentCreated {
                    experiment: command.id.clone(),
                    version,
                })
            }
            Command::ReviewExperiment(command) => Ok(CommandOutcome::ExperimentReviewed {
                experiment: command.experiment_id.clone(),
                decision: command.decision,
            }),
            Command::CloseExperiment(command) => {
                let stored = self
                    .plugin
                    .storage()
                    .load_experiment(&command.experiment_id)
                    .await?;
                let mut experiment = stored.value().clone();
                experiment.set_status(ExperimentStatus::Cancelled);
                let version = self
                    .plugin
                    .storage()
                    .save_experiment(&experiment, Some(stored.version()))
                    .await?;
                Ok(CommandOutcome::ExperimentUpdated {
                    experiment: command.experiment_id.clone(),
                    version,
                })
            }
            Command::RequestBenchmark(command) => Ok(CommandOutcome::BenchmarkRequested {
                experiment: command.experiment_id.clone(),
            }),
            Command::SubmitTicket(command) => {
                let stored = self
                    .plugin
                    .storage()
                    .load_ticket(&command.ticket_id)
                    .await?;
                let ticket = stored.value().clone().submit(command.commit.clone());
                let version = self
                    .plugin
                    .storage()
                    .save_ticket(&ticket, Some(stored.version()))
                    .await?;
                Ok(CommandOutcome::TicketSubmitted {
                    ticket: command.ticket_id.clone(),
                    commit: command.commit.clone(),
                    version,
                })
            }
        }
    }

    async fn update_program<F>(
        &self,
        program_id: &ProgramId,
        update: F,
    ) -> Result<CommandOutcome, CommandError>
    where
        F: FnOnce(&mut Program),
    {
        let stored = self.plugin.storage().load_program(program_id).await?;
        let mut program = stored.value().clone();
        update(&mut program);
        let version = self
            .plugin
            .storage()
            .save_program(&program, Some(stored.version()))
            .await?;
        Ok(CommandOutcome::ProgramUpdated {
            program: program_id.clone(),
            version,
        })
    }

    async fn append_audit(
        &self,
        actor: &Actor,
        request_id: RequestId,
        name: CommandName,
        subject: CommandSubject,
        detail: String,
    ) -> Result<(), CommandError> {
        let created_at = self.plugin.clock().now().await?;
        let audit_id = AuditId::new(format!(
            "audit-{}-{}",
            created_at.as_millis(),
            request_id.as_str()
        ))
        .map_err(|error| invalid_error(name, error))?;
        let entry = AuditEntry::new(
            audit_id,
            actor.id().clone(),
            name.as_str(),
            subject.to_string(),
            detail,
            request_id,
            created_at,
        )
        .map_err(|error| invalid_error(name, error))?;
        self.plugin.storage().append_audit(&entry).await?;
        Ok(())
    }
}

fn validate_command(command: &Command) -> Result<(), CommandError> {
    let name = command.name();
    match command {
        Command::CreateProgram(command) => {
            if command.name.trim().is_empty() {
                return Err(invalid_error(name, "program name must not be empty"));
            }
            if command.utility.is_empty() {
                return Err(invalid_error(name, "program utility must not be empty"));
            }
            let mut names = HashSet::new();
            for weight in &command.utility {
                if !names.insert(weight.name()) {
                    return Err(invalid_error(
                        name,
                        format!("utility metric {} is duplicated", weight.name()),
                    ));
                }
            }
        }
        Command::SetProgramGoal(command) if command.goal.trim().is_empty() => {
            return Err(invalid_error(name, "program goal must not be empty"));
        }
        Command::SetProgramMethodology(command) if command.methodology.trim().is_empty() => {
            return Err(invalid_error(name, "program methodology must not be empty"));
        }
        Command::CreateIssue(command) if command.title.trim().is_empty() => {
            return Err(invalid_error(name, "issue title must not be empty"));
        }
        Command::CommentIssue(command) if command.body.trim().is_empty() => {
            return Err(invalid_error(name, "issue comment body must not be empty"));
        }
        _ => {}
    }
    Ok(())
}

async fn authorize_command<P: Plugin>(
    plugin: &P,
    actor: &Actor,
    command: &Command,
) -> Result<(), CommandError> {
    let name = command.name();
    let capability = command.capability();
    if !actor.has_capability(capability) {
        return Err(CommandError::Forbidden {
            actor: actor.id().clone(),
            command: name,
            capability,
        });
    }
    match command {
        Command::CreateProgram(command) => {
            ensure_program_missing(plugin.storage(), name, &command.id).await
        }
        Command::PauseProgram(command) => {
            let stored = load_program(plugin.storage(), &command.program_id).await?;
            ensure_program_owner(actor, name, stored.value())?;
            if stored.value().status() != ProgramStatus::Running {
                return Err(state_conflict(
                    name,
                    CommandSubject::Program(command.program_id.clone()),
                    stored.value().status().as_str(),
                ));
            }
            Ok(())
        }
        Command::ResumeProgram(command) => {
            let stored = load_program(plugin.storage(), &command.program_id).await?;
            ensure_program_owner(actor, name, stored.value())?;
            if stored.value().status() != ProgramStatus::Paused {
                return Err(state_conflict(
                    name,
                    CommandSubject::Program(command.program_id.clone()),
                    stored.value().status().as_str(),
                ));
            }
            Ok(())
        }
        Command::StopProgram(command) => {
            let stored = load_program(plugin.storage(), &command.program_id).await?;
            ensure_program_owner(actor, name, stored.value())?;
            if stored.value().status() == ProgramStatus::Stopped {
                return Err(state_conflict(
                    name,
                    CommandSubject::Program(command.program_id.clone()),
                    stored.value().status().as_str(),
                ));
            }
            Ok(())
        }
        Command::SetProgramGoal(command) => {
            ensure_program_active(plugin.storage(), actor, name, &command.program_id).await
        }
        Command::SetProgramMethodology(command) => {
            ensure_program_active(plugin.storage(), actor, name, &command.program_id).await
        }
        Command::SetProgramExploration(command) => {
            ensure_program_active(plugin.storage(), actor, name, &command.program_id).await
        }
        Command::CreateIssue(command) => {
            let program = load_program(plugin.storage(), &command.program_id).await?;
            if program.value().status() != ProgramStatus::Running {
                return Err(state_conflict(
                    name,
                    CommandSubject::Program(command.program_id.clone()),
                    program.value().status().as_str(),
                ));
            }
            ensure_issue_missing(plugin.storage(), name, &command.id).await
        }
        Command::ClaimIssue(command) => {
            let stored = load_issue(plugin.storage(), &command.issue_id).await?;
            if stored.value().status() != IssueStatus::Open || stored.value().assignee().is_some() {
                return Err(state_conflict(
                    name,
                    CommandSubject::Issue(command.issue_id.clone()),
                    stored.value().status().as_str(),
                ));
            }
            require_session(actor, name)?;
            Ok(())
        }
        Command::CommentIssue(command) => {
            let stored = load_issue(plugin.storage(), &command.issue_id).await?;
            if stored.value().status() == IssueStatus::Closed {
                return Err(state_conflict(
                    name,
                    CommandSubject::Issue(command.issue_id.clone()),
                    stored.value().status().as_str(),
                ));
            }
            let program = load_program(plugin.storage(), stored.value().program_id()).await?;
            ensure_issue_owner(actor, name, stored.value(), program.value())
        }
        Command::CloseIssue(command) => {
            let stored = load_issue(plugin.storage(), &command.issue_id).await?;
            if stored.value().status() == IssueStatus::Closed {
                return Err(state_conflict(
                    name,
                    CommandSubject::Issue(command.issue_id.clone()),
                    stored.value().status().as_str(),
                ));
            }
            let program = load_program(plugin.storage(), stored.value().program_id()).await?;
            ensure_issue_owner(actor, name, stored.value(), program.value())
        }
        Command::ProposeExperiment(command) => {
            let issue = load_issue(plugin.storage(), &command.issue_id).await?;
            if issue.value().status() != IssueStatus::Assigned {
                return Err(state_conflict(
                    name,
                    CommandSubject::Issue(command.issue_id.clone()),
                    issue.value().status().as_str(),
                ));
            }
            let session = require_session(actor, name)?;
            if issue.value().assignee() != Some(session) {
                return Err(ownership(
                    actor,
                    name,
                    CommandSubject::Issue(command.issue_id.clone()),
                ));
            }
            if issue.value().program_id() != &command.program_id {
                return Err(invalid_error(
                    name,
                    "experiment program does not match the issue program",
                ));
            }
            let program = load_program(plugin.storage(), &command.program_id).await?;
            if program.value().status() != ProgramStatus::Running {
                return Err(state_conflict(
                    name,
                    CommandSubject::Program(command.program_id.clone()),
                    program.value().status().as_str(),
                ));
            }
            ensure_experiment_missing(plugin.storage(), name, &command.id).await
        }
        Command::ReviewExperiment(command) => {
            let experiment = load_experiment(plugin.storage(), &command.experiment_id).await?;
            let program = load_program(plugin.storage(), experiment.value().program_id()).await?;
            ensure_experiment_owner(actor, name, experiment.value(), program.value())?;
            if experiment.value().status() != ExperimentStatus::Open {
                return Err(state_conflict(
                    name,
                    CommandSubject::Experiment(command.experiment_id.clone()),
                    experiment.value().status().as_str(),
                ));
            }
            Ok(())
        }
        Command::CloseExperiment(command) => {
            let experiment = load_experiment(plugin.storage(), &command.experiment_id).await?;
            let program = load_program(plugin.storage(), experiment.value().program_id()).await?;
            ensure_experiment_owner(actor, name, experiment.value(), program.value())?;
            if experiment.value().status() != ExperimentStatus::Open {
                return Err(state_conflict(
                    name,
                    CommandSubject::Experiment(command.experiment_id.clone()),
                    experiment.value().status().as_str(),
                ));
            }
            Ok(())
        }
        Command::RequestBenchmark(command) => {
            let experiment = load_experiment(plugin.storage(), &command.experiment_id).await?;
            let program = load_program(plugin.storage(), experiment.value().program_id()).await?;
            ensure_experiment_owner(actor, name, experiment.value(), program.value())?;
            if experiment.value().status() != ExperimentStatus::Open {
                return Err(state_conflict(
                    name,
                    CommandSubject::Experiment(command.experiment_id.clone()),
                    experiment.value().status().as_str(),
                ));
            }
            if program.value().status() != ProgramStatus::Running {
                return Err(state_conflict(
                    name,
                    CommandSubject::Program(program.value().id().clone()),
                    program.value().status().as_str(),
                ));
            }
            Ok(())
        }
        Command::SubmitTicket(command) => {
            let ticket = load_ticket(plugin.storage(), &command.ticket_id).await?;
            let session = require_session(actor, name)?;
            if ticket.value().worker_session_id() != Some(session) {
                return Err(ownership(
                    actor,
                    name,
                    CommandSubject::Ticket(command.ticket_id.clone()),
                ));
            }
            if ticket.value().status() != TicketStatus::Running {
                return Err(state_conflict(
                    name,
                    CommandSubject::Ticket(command.ticket_id.clone()),
                    ticket.value().status().as_str(),
                ));
            }
            Ok(())
        }
    }
}

async fn ensure_program_active<S: Storage>(
    storage: &S,
    actor: &Actor,
    command: CommandName,
    program_id: &ProgramId,
) -> Result<(), CommandError> {
    let stored = load_program(storage, program_id).await?;
    ensure_program_owner(actor, command, stored.value())?;
    if stored.value().status() == ProgramStatus::Stopped {
        return Err(state_conflict(
            command,
            CommandSubject::Program(program_id.clone()),
            stored.value().status().as_str(),
        ));
    }
    Ok(())
}

async fn ensure_program_missing<S: Storage>(
    storage: &S,
    command: CommandName,
    id: &ProgramId,
) -> Result<(), CommandError> {
    match storage.load_program(id).await {
        Ok(_) => Err(state_conflict(
            command,
            CommandSubject::Program(id.clone()),
            "exists",
        )),
        Err(StorageError::NotFound { .. }) => Ok(()),
        Err(error) => Err(CommandError::Storage(error)),
    }
}

async fn ensure_issue_missing<S: Storage>(
    storage: &S,
    command: CommandName,
    id: &IssueId,
) -> Result<(), CommandError> {
    match storage.load_issue(id).await {
        Ok(_) => Err(state_conflict(
            command,
            CommandSubject::Issue(id.clone()),
            "exists",
        )),
        Err(StorageError::NotFound { .. }) => Ok(()),
        Err(error) => Err(CommandError::Storage(error)),
    }
}

async fn ensure_experiment_missing<S: Storage>(
    storage: &S,
    command: CommandName,
    id: &ExperimentId,
) -> Result<(), CommandError> {
    match storage.load_experiment(id).await {
        Ok(_) => Err(state_conflict(
            command,
            CommandSubject::Experiment(id.clone()),
            "exists",
        )),
        Err(StorageError::NotFound { .. }) => Ok(()),
        Err(error) => Err(CommandError::Storage(error)),
    }
}

async fn load_program<S: Storage>(
    storage: &S,
    id: &ProgramId,
) -> Result<Versioned<Program>, CommandError> {
    storage
        .load_program(id)
        .await
        .map_err(CommandError::Storage)
}

async fn load_issue<S: Storage>(
    storage: &S,
    id: &IssueId,
) -> Result<Versioned<Issue>, CommandError> {
    storage.load_issue(id).await.map_err(CommandError::Storage)
}

async fn load_experiment<S: Storage>(
    storage: &S,
    id: &ExperimentId,
) -> Result<Versioned<Experiment>, CommandError> {
    storage
        .load_experiment(id)
        .await
        .map_err(CommandError::Storage)
}

async fn load_ticket<S: Storage>(
    storage: &S,
    id: &TicketId,
) -> Result<Versioned<Ticket>, CommandError> {
    storage.load_ticket(id).await.map_err(CommandError::Storage)
}

fn ensure_program_owner(
    actor: &Actor,
    command: CommandName,
    program: &Program,
) -> Result<(), CommandError> {
    if program.owner() == actor.id() {
        Ok(())
    } else {
        Err(ownership(
            actor,
            command,
            CommandSubject::Program(program.id().clone()),
        ))
    }
}

fn ensure_issue_owner(
    actor: &Actor,
    command: CommandName,
    issue: &Issue,
    program: &Program,
) -> Result<(), CommandError> {
    let assigned = actor
        .session()
        .is_some_and(|session| issue.assignee() == Some(session));
    if issue.author() == actor.id() || assigned || program.owner() == actor.id() {
        Ok(())
    } else {
        Err(ownership(
            actor,
            command,
            CommandSubject::Issue(issue.id().clone()),
        ))
    }
}

fn ensure_experiment_owner(
    actor: &Actor,
    command: CommandName,
    experiment: &Experiment,
    program: &Program,
) -> Result<(), CommandError> {
    if experiment.created_by() == actor.id() || program.owner() == actor.id() {
        Ok(())
    } else {
        Err(ownership(
            actor,
            command,
            CommandSubject::Experiment(experiment.id().clone()),
        ))
    }
}

fn require_session(actor: &Actor, command: CommandName) -> Result<&SessionId, CommandError> {
    actor.session().ok_or_else(|| CommandError::Unauthorized {
        actor: actor.id().clone(),
        command,
        detail: "a session is required".to_string(),
    })
}

fn ownership(actor: &Actor, command: CommandName, subject: CommandSubject) -> CommandError {
    CommandError::Ownership {
        actor: actor.id().clone(),
        command,
        subject: subject.to_string(),
    }
}

fn state_conflict(command: CommandName, subject: CommandSubject, state: &str) -> CommandError {
    CommandError::StateConflict {
        command,
        subject: subject.to_string(),
        state: state.to_string(),
    }
}

fn invalid_error(command: CommandName, detail: impl fmt::Display) -> CommandError {
    CommandError::InvalidDraft {
        command,
        detail: detail.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session() -> SessionId {
        SessionId::new("session-1").unwrap()
    }

    #[test]
    fn roles_grant_only_their_capabilities() {
        assert!(ActorRole::Operator.grants(Capability::ManageProgram));
        assert!(ActorRole::Operator.grants(Capability::WriteIssue));
        assert!(ActorRole::Operator.grants(Capability::RequestBenchmark));
        assert!(!ActorRole::Operator.grants(Capability::ClaimIssue));
        assert!(!ActorRole::Operator.grants(Capability::SubmitTicket));

        assert!(ActorRole::Researcher.grants(Capability::WriteIssue));
        assert!(ActorRole::Researcher.grants(Capability::ClaimIssue));
        assert!(ActorRole::Researcher.grants(Capability::WriteExperiment));
        assert!(!ActorRole::Researcher.grants(Capability::ManageProgram));
        assert!(!ActorRole::Researcher.grants(Capability::SubmitTicket));

        assert!(ActorRole::Implementer.grants(Capability::WriteIssue));
        assert!(ActorRole::Implementer.grants(Capability::SubmitTicket));
        assert!(!ActorRole::Implementer.grants(Capability::ManageProgram));
        assert!(!ActorRole::Implementer.grants(Capability::WriteExperiment));
    }

    #[test]
    fn actors_carry_their_role_and_session() {
        let id = ActorId::new("researcher-1").unwrap();
        let actor = Actor::researcher(id.clone(), session());
        assert_eq!(actor.id(), &id);
        assert_eq!(actor.role(), ActorRole::Researcher);
        assert_eq!(actor.session(), Some(&session()));
        assert!(actor.has_capability(Capability::ClaimIssue));
        assert!(!actor.has_capability(Capability::ManageProgram));

        let operator = Actor::operator(ActorId::new("operator-1").unwrap());
        assert_eq!(operator.session(), None);
        assert!(operator.has_capability(Capability::ManageProgram));
    }

    #[test]
    fn commands_expose_their_name_capability_and_subject() {
        let command = Command::PauseProgram(Box::new(PauseProgramCommand {
            program_id: ProgramId::new("program-1").unwrap(),
        }));
        assert_eq!(command.name(), CommandName::PauseProgram);
        assert_eq!(command.capability(), Capability::ManageProgram);
        assert_eq!(command.subject().to_string(), "program:program-1");
        assert!(command.audit_detail().is_empty());

        let command = Command::CommentIssue(Box::new(CommentIssueCommand {
            issue_id: IssueId::new("issue-1").unwrap(),
            body: "comment".to_string(),
        }));
        assert_eq!(command.name(), CommandName::CommentIssue);
        assert_eq!(command.capability(), Capability::WriteIssue);
        assert_eq!(command.subject().to_string(), "issue:issue-1");
        assert_eq!(command.audit_detail(), "comment");
    }

    #[test]
    fn command_names_are_stable() {
        assert_eq!(CommandName::CreateProgram.as_str(), "program.create");
        assert_eq!(CommandName::SetProgramGoal.as_str(), "program.goal");
        assert_eq!(CommandName::ClaimIssue.as_str(), "issue.claim");
        assert_eq!(
            CommandName::ProposeExperiment.as_str(),
            "experiment.propose"
        );
        assert_eq!(CommandName::RequestBenchmark.as_str(), "benchmark.request");
        assert_eq!(CommandName::SubmitTicket.as_str(), "ticket.submit");
    }

    #[test]
    fn authorization_proofs_expose_their_command_name() {
        let proof = AuthorizationProof::<PauseProgram>::mint(CommandName::PauseProgram);
        assert_eq!(proof.name(), CommandName::PauseProgram);
        assert!(format!("{proof:?}").contains("program.pause"));
    }

    #[test]
    fn command_errors_describe_their_refusal() {
        let error = CommandError::Forbidden {
            actor: ActorId::new("actor-1").unwrap(),
            command: CommandName::PauseProgram,
            capability: Capability::ManageProgram,
        };
        assert!(error.to_string().contains("lacks capability"));
        let error = CommandError::StateConflict {
            command: CommandName::PauseProgram,
            subject: "program:program-1".to_string(),
            state: "paused".to_string(),
        };
        assert!(error.to_string().contains("while it is paused"));
    }
}
