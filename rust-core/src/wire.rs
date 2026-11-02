use std::collections::BTreeMap;

use crate::command::{
    Actor, ActorRole, ClaimIssueCommand, CloseExperimentCommand, CloseIssueCommand, CommandDraft,
    CommandName, CommandOutcome, CommentIssueCommand, CreateIssueCommand, CreateProgramCommand,
    PauseProgramCommand, ProposeExperimentCommand, RequestBenchmarkCommand, ResumeProgramCommand,
    ReviewExperimentCommand, SetProgramExplorationCommand, SetProgramGoalCommand,
    SetProgramMethodologyCommand, StopProgramCommand, SubmitTicketCommand,
};
use crate::domain::{
    AuditEntry, BenchmarkMetric, BenchmarkRecord, BenchmarkRecordInput, BenchmarkSpec, Environment,
    Experiment, ExperimentInput, ExperimentStatus, Exploration, Issue, IssueInput, IssueStatus,
    Lineage, LineageStrategy, Metric, MetricDirection, MetricWeight, Program, ProgramInput,
    ProgramStatus, ResearchPolicy, ResearcherDecision, StopReason, Ticket, TicketAssignment,
    TicketStatus, Usage, Versioned,
};
use crate::id::{
    ActorId, Attempt, AuditId, BenchmarkRunId, BenchmarkSpecId, CommentId, CommitSha,
    EnvironmentDigest, EnvironmentFile, ExperimentId, IssueId, ProgramId, RequestId, SessionId,
    SpecHash, TicketId, Version,
};
use crate::time::Timestamp;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DecodeError;

impl DecodeError {
    const fn new() -> Self {
        Self
    }
}

#[derive(Debug, Default)]
pub struct Encoder {
    bytes: Vec<u8>,
}

impl Encoder {
    pub fn new() -> Self {
        Self { bytes: Vec::new() }
    }

    pub fn u8(&mut self, value: u8) {
        self.bytes.push(value);
    }

    pub fn u32(&mut self, value: u32) {
        self.bytes.extend_from_slice(&value.to_le_bytes());
    }

    pub fn u64(&mut self, value: u64) {
        self.bytes.extend_from_slice(&value.to_le_bytes());
    }

    pub fn f64(&mut self, value: f64) {
        self.bytes.extend_from_slice(&value.to_le_bytes());
    }

    pub fn string(&mut self, value: &str) {
        self.bytes(value.as_bytes());
    }

    pub fn bytes(&mut self, value: &[u8]) {
        self.u32(value.len() as u32);
        self.bytes.extend_from_slice(value);
    }

    pub fn finish(self) -> Vec<u8> {
        self.bytes
    }
}

pub struct Decoder<'a> {
    bytes: &'a [u8],
    position: usize,
}

impl<'a> Decoder<'a> {
    pub const fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, position: 0 }
    }

    fn take(&mut self, length: usize) -> Result<&'a [u8], DecodeError> {
        let end = self
            .position
            .checked_add(length)
            .ok_or(DecodeError::new())?;
        let slice = self
            .bytes
            .get(self.position..end)
            .ok_or(DecodeError::new())?;
        self.position = end;
        Ok(slice)
    }

    pub fn u8(&mut self) -> Result<u8, DecodeError> {
        self.take(1)?.first().copied().ok_or(DecodeError::new())
    }

    pub fn u32(&mut self) -> Result<u32, DecodeError> {
        let bytes = self.take(4)?;
        Ok(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
    }

    pub fn u64(&mut self) -> Result<u64, DecodeError> {
        let bytes = self.take(8)?;
        Ok(u64::from_le_bytes([
            bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
        ]))
    }

    pub fn f64(&mut self) -> Result<f64, DecodeError> {
        let bytes = self.take(8)?;
        Ok(f64::from_le_bytes([
            bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
        ]))
    }

    pub fn string(&mut self) -> Result<&'a str, DecodeError> {
        let bytes = self.bytes()?;
        std::str::from_utf8(bytes).map_err(|_| DecodeError::new())
    }

    pub fn bytes(&mut self) -> Result<&'a [u8], DecodeError> {
        let length = self.u32()? as usize;
        self.take(length)
    }

    pub fn finish(self) -> Result<(), DecodeError> {
        if self.position == self.bytes.len() {
            Ok(())
        } else {
            Err(DecodeError::new())
        }
    }
}

pub fn encode_environment(encoder: &mut Encoder, environment: &Environment) {
    encoder.u8(match environment.kind() {
        crate::domain::EnvironmentKind::Requirements => 0,
        crate::domain::EnvironmentKind::UvLock => 1,
    });
    encoder.string(environment.file().as_str());
}

pub fn decode_environment(decoder: &mut Decoder<'_>) -> Result<Environment, DecodeError> {
    let kind = decoder.u8()?;
    let file = EnvironmentFile::new(decoder.string()?).map_err(|_| DecodeError::new())?;
    match kind {
        0 => Ok(Environment::requirements(file)),
        1 => Ok(Environment::uv_lock(file)),
        _ => Err(DecodeError::new()),
    }
}

fn encode_direction(encoder: &mut Encoder, direction: MetricDirection) {
    encoder.u8(match direction {
        MetricDirection::Maximize => 0,
        MetricDirection::Minimize => 1,
    });
}

fn decode_direction(decoder: &mut Decoder<'_>) -> Result<MetricDirection, DecodeError> {
    match decoder.u8()? {
        0 => Ok(MetricDirection::Maximize),
        1 => Ok(MetricDirection::Minimize),
        _ => Err(DecodeError::new()),
    }
}

fn encode_optional_f64(encoder: &mut Encoder, value: Option<f64>) {
    match value {
        Some(value) => {
            encoder.u8(1);
            encoder.f64(value);
        }
        None => encoder.u8(0),
    }
}

fn decode_optional_f64(decoder: &mut Decoder<'_>) -> Result<Option<f64>, DecodeError> {
    match decoder.u8()? {
        0 => Ok(None),
        1 => Ok(Some(decoder.f64()?)),
        _ => Err(DecodeError::new()),
    }
}

pub fn encode_spec(encoder: &mut Encoder, spec: &BenchmarkSpec) {
    encoder.string(spec.id().as_str());
    encoder.string(spec.entry());
    encoder.u64(spec.timeout_ms());
    encoder.u32(spec.metrics().len() as u32);
    for metric in spec.metrics() {
        encoder.string(metric.name());
        encode_direction(encoder, metric.direction());
        encoder.u8(u8::from(metric.required()));
        encode_optional_f64(encoder, metric.tolerance());
    }
    encoder.u32(spec.max_retries());
    encoder.u32(spec.baseline().len() as u32);
    for (name, value) in spec.baseline() {
        encoder.string(name);
        encoder.f64(*value);
    }
    match spec.dataset() {
        Some(dataset) => {
            encoder.u8(1);
            encoder.string(dataset);
        }
        None => encoder.u8(0),
    }
}

pub fn decode_spec(decoder: &mut Decoder<'_>) -> Result<BenchmarkSpec, DecodeError> {
    let id = BenchmarkSpecId::new(decoder.string()?).map_err(|_| DecodeError::new())?;
    let entry = decoder.string()?.to_string();
    let timeout_ms = decoder.u64()?;
    let count = decoder.u32()?;
    let mut metrics = Vec::new();
    for _ in 0..count {
        let name = decoder.string()?.to_string();
        let direction = decode_direction(decoder)?;
        let required = match decoder.u8()? {
            0 => false,
            1 => true,
            _ => return Err(DecodeError::new()),
        };
        let tolerance = decode_optional_f64(decoder)?;
        metrics.push(
            BenchmarkMetric::new(name, direction, required, tolerance)
                .map_err(|_| DecodeError::new())?,
        );
    }
    let max_retries = decoder.u32()?;
    let count = decoder.u32()?;
    let mut baseline = BTreeMap::new();
    for _ in 0..count {
        let name = decoder.string()?.to_string();
        let value = decoder.f64()?;
        baseline.insert(name, value);
    }
    let dataset = match decoder.u8()? {
        0 => None,
        1 => Some(decoder.string()?.to_string()),
        _ => return Err(DecodeError::new()),
    };
    BenchmarkSpec::new(
        id,
        entry,
        timeout_ms,
        metrics,
        max_retries,
        baseline,
        dataset,
    )
    .map_err(|_| DecodeError::new())
}

fn encode_metric(encoder: &mut Encoder, metric: &Metric) {
    encoder.string(metric.name());
    encoder.f64(metric.value());
}

fn decode_metric(decoder: &mut Decoder<'_>) -> Result<Metric, DecodeError> {
    let name = decoder.string()?.to_string();
    let value = decoder.f64()?;
    Metric::new(name, value).map_err(|_| DecodeError::new())
}

pub fn encode_timestamp(encoder: &mut Encoder, timestamp: Timestamp) {
    encoder.string(&timestamp.to_string());
}

pub fn decode_timestamp(decoder: &mut Decoder<'_>) -> Result<Timestamp, DecodeError> {
    Timestamp::parse(decoder.string()?).map_err(|_| DecodeError::new())
}

pub fn encode_record(encoder: &mut Encoder, record: &BenchmarkRecord) {
    encoder.string(record.id().as_str());
    encoder.string(record.experiment_id().as_str());
    encoder.string(record.ticket_id().as_str());
    encoder.string(record.commit().as_str());
    encoder.string(record.spec_hash().as_str());
    encoder.string(record.environment_digest().as_str());
    encoder.u32(record.metrics().len() as u32);
    for metric in record.metrics() {
        encode_metric(encoder, metric);
    }
    encoder.u8(match record.status() {
        crate::domain::BenchmarkStatus::Passed => 0,
        crate::domain::BenchmarkStatus::Failed => 1,
        crate::domain::BenchmarkStatus::Retryable => 2,
    });
    encoder.u32(record.attempt().get());
    encoder.u32(record.max_attempts().get());
    encoder.string(record.stdout());
    encoder.string(record.stderr());
    encoder.u32(record.artifacts().len() as u32);
    for artifact in record.artifacts() {
        encoder.string(artifact.as_str());
    }
    encode_timestamp(encoder, record.created_at());
}

pub fn decode_record(decoder: &mut Decoder<'_>) -> Result<BenchmarkRecord, DecodeError> {
    let id = BenchmarkRunId::new(decoder.string()?).map_err(|_| DecodeError::new())?;
    let experiment_id = ExperimentId::new(decoder.string()?).map_err(|_| DecodeError::new())?;
    let ticket_id = TicketId::new(decoder.string()?).map_err(|_| DecodeError::new())?;
    let commit = CommitSha::new(decoder.string()?).map_err(|_| DecodeError::new())?;
    let spec_hash = SpecHash::new(decoder.string()?).map_err(|_| DecodeError::new())?;
    let environment_digest =
        EnvironmentDigest::new(decoder.string()?).map_err(|_| DecodeError::new())?;
    let count = decoder.u32()?;
    let mut metrics = Vec::new();
    for _ in 0..count {
        metrics.push(decode_metric(decoder)?);
    }
    let status = match decoder.u8()? {
        0 => crate::domain::BenchmarkStatus::Passed,
        1 => crate::domain::BenchmarkStatus::Failed,
        2 => crate::domain::BenchmarkStatus::Retryable,
        _ => return Err(DecodeError::new()),
    };
    let attempt = crate::id::Attempt::new(decoder.u32()?).map_err(|_| DecodeError::new())?;
    let max_attempts = crate::id::Attempt::new(decoder.u32()?).map_err(|_| DecodeError::new())?;
    let stdout = decoder.string()?.to_string();
    let stderr = decoder.string()?.to_string();
    let count = decoder.u32()?;
    let mut artifacts = Vec::new();
    for _ in 0..count {
        artifacts
            .push(crate::id::ArtifactId::new(decoder.string()?).map_err(|_| DecodeError::new())?);
    }
    let created_at = decode_timestamp(decoder)?;
    BenchmarkRecord::new(BenchmarkRecordInput {
        id,
        experiment_id,
        ticket_id,
        commit,
        spec_hash,
        environment_digest,
        metrics,
        status,
        attempt,
        max_attempts,
        stdout,
        stderr,
        artifacts,
        created_at,
    })
    .map_err(|_| DecodeError::new())
}

pub fn encode_program(encoder: &mut Encoder, versioned: &Versioned<Program>) {
    encoder.u64(versioned.version().get());
    encode_program_value(encoder, versioned.value());
}

pub fn encode_program_value(encoder: &mut Encoder, program: &Program) {
    encoder.string(program.id().as_str());
    encoder.string(program.owner().as_str());
    encoder.string(program.name());
    encoder.string(program.goal());
    encoder.string(program.methodology());
    encode_spec(encoder, program.benchmark());
    encoder.u32(program.utility().len() as u32);
    for metric in program.utility() {
        encoder.string(metric.name());
        encode_direction(encoder, metric.direction());
        encoder.f64(metric.weight());
    }
    encoder.u8(match program.exploration() {
        Exploration::Low => 0,
        Exploration::Normal => 1,
        Exploration::High => 2,
    });
    let policy = program.policy();
    encoder.u32(policy.max_experiments());
    encoder.u64(policy.max_compute_minutes());
    encoder.u64(policy.max_tokens());
    encoder.u32(policy.max_attempts_per_experiment());
    let usage = program.usage();
    encoder.u32(usage.experiments());
    encoder.u64(usage.compute_minutes());
    encoder.u64(usage.tokens());
    encoder.u8(match program.status() {
        ProgramStatus::Running => 0,
        ProgramStatus::Paused => 1,
        ProgramStatus::Stopped => 2,
    });
    encode_timestamp(encoder, program.created_at());
}

pub fn decode_program(decoder: &mut Decoder<'_>) -> Result<Versioned<Program>, DecodeError> {
    let version = Version::new(decoder.u64()?).map_err(|_| DecodeError::new())?;
    let program = decode_program_value(decoder)?;
    Ok(Versioned::new(program, version))
}

pub fn decode_program_value(decoder: &mut Decoder<'_>) -> Result<Program, DecodeError> {
    let id = ProgramId::new(decoder.string()?).map_err(|_| DecodeError::new())?;
    let owner = ActorId::new(decoder.string()?).map_err(|_| DecodeError::new())?;
    let name = decoder.string()?.to_string();
    let goal = decoder.string()?.to_string();
    let methodology = decoder.string()?.to_string();
    let benchmark = decode_spec(decoder)?;
    let count = decoder.u32()?;
    let mut utility = Vec::new();
    for _ in 0..count {
        let name = decoder.string()?.to_string();
        let direction = decode_direction(decoder)?;
        let weight = decoder.f64()?;
        utility.push(MetricWeight::new(name, direction, weight).map_err(|_| DecodeError::new())?);
    }
    let exploration = decode_exploration(decoder)?;
    let policy = decode_policy(decoder)?;
    let usage = Usage::new(decoder.u32()?, decoder.u64()?, decoder.u64()?);
    let status = decode_program_status(decoder)?;
    let created_at = decode_timestamp(decoder)?;
    Program::new(ProgramInput {
        id,
        owner,
        name,
        goal,
        methodology,
        benchmark,
        utility,
        exploration,
        policy,
        usage,
        status,
        created_at,
    })
    .map_err(|_| DecodeError::new())
}

fn decode_exploration(decoder: &mut Decoder<'_>) -> Result<Exploration, DecodeError> {
    match decoder.u8()? {
        0 => Ok(Exploration::Low),
        1 => Ok(Exploration::Normal),
        2 => Ok(Exploration::High),
        _ => Err(DecodeError::new()),
    }
}

fn decode_program_status(decoder: &mut Decoder<'_>) -> Result<ProgramStatus, DecodeError> {
    match decoder.u8()? {
        0 => Ok(ProgramStatus::Running),
        1 => Ok(ProgramStatus::Paused),
        2 => Ok(ProgramStatus::Stopped),
        _ => Err(DecodeError::new()),
    }
}

fn decode_policy(decoder: &mut Decoder<'_>) -> Result<ResearchPolicy, DecodeError> {
    ResearchPolicy::new(
        decoder.u32()?,
        decoder.u64()?,
        decoder.u64()?,
        decoder.u32()?,
    )
    .map_err(|_| DecodeError::new())
}

pub fn decode_decision(decoder: &mut Decoder<'_>) -> Result<ResearcherDecision, DecodeError> {
    match decoder.u8()? {
        0 => Ok(ResearcherDecision::Propose),
        1 => Ok(ResearcherDecision::Revise),
        2 => {
            let reason = match decoder.u8()? {
                0 => StopReason::GoalMet,
                1 => StopReason::PolicyExhausted,
                2 => StopReason::NoHypothesis,
                3 => StopReason::Cancelled,
                _ => return Err(DecodeError::new()),
            };
            Ok(ResearcherDecision::Stop(reason))
        }
        _ => Err(DecodeError::new()),
    }
}

fn encode_optional_string(encoder: &mut Encoder, value: Option<&str>) {
    match value {
        Some(value) => {
            encoder.u8(1);
            encoder.string(value);
        }
        None => encoder.u8(0),
    }
}

fn decode_optional_string(decoder: &mut Decoder<'_>) -> Result<Option<String>, DecodeError> {
    match decoder.u8()? {
        0 => Ok(None),
        1 => Ok(Some(decoder.string()?.to_string())),
        _ => Err(DecodeError::new()),
    }
}

pub fn encode_optional_version(encoder: &mut Encoder, value: Option<Version>) {
    match value {
        Some(value) => {
            encoder.u8(1);
            encoder.u64(value.get());
        }
        None => encoder.u8(0),
    }
}

pub fn decode_optional_version(decoder: &mut Decoder<'_>) -> Result<Option<Version>, DecodeError> {
    match decoder.u8()? {
        0 => Ok(None),
        1 => Ok(Some(
            Version::new(decoder.u64()?).map_err(|_| DecodeError::new())?,
        )),
        _ => Err(DecodeError::new()),
    }
}

fn encode_optional_session(encoder: &mut Encoder, value: Option<&SessionId>) {
    encode_optional_string(encoder, value.map(SessionId::as_str));
}

fn decode_optional_session(decoder: &mut Decoder<'_>) -> Result<Option<SessionId>, DecodeError> {
    match decode_optional_string(decoder)? {
        Some(value) => Ok(Some(SessionId::new(value).map_err(|_| DecodeError::new())?)),
        None => Ok(None),
    }
}

fn encode_utility(encoder: &mut Encoder, utility: &[MetricWeight]) {
    encoder.u32(utility.len() as u32);
    for metric in utility {
        encoder.string(metric.name());
        encode_direction(encoder, metric.direction());
        encoder.f64(metric.weight());
    }
}

fn decode_utility(decoder: &mut Decoder<'_>) -> Result<Vec<MetricWeight>, DecodeError> {
    let count = decoder.u32()?;
    let mut utility = Vec::new();
    for _ in 0..count {
        let name = decoder.string()?.to_string();
        let direction = decode_direction(decoder)?;
        let weight = decoder.f64()?;
        utility.push(MetricWeight::new(name, direction, weight).map_err(|_| DecodeError::new())?);
    }
    Ok(utility)
}

fn encode_policy(encoder: &mut Encoder, policy: ResearchPolicy) {
    encoder.u32(policy.max_experiments());
    encoder.u64(policy.max_compute_minutes());
    encoder.u64(policy.max_tokens());
    encoder.u32(policy.max_attempts_per_experiment());
}

fn encode_lineage(encoder: &mut Encoder, lineage: &Lineage) {
    encoder.u8(match lineage.strategy() {
        LineageStrategy::Continue => 0,
        LineageStrategy::Branch => 1,
        LineageStrategy::Fresh => 2,
    });
    encoder.string(lineage.base_commit().as_str());
    encoder.f64(lineage.fresh_start_probability());
}

fn decode_lineage(decoder: &mut Decoder<'_>) -> Result<Lineage, DecodeError> {
    let strategy = match decoder.u8()? {
        0 => LineageStrategy::Continue,
        1 => LineageStrategy::Branch,
        2 => LineageStrategy::Fresh,
        _ => return Err(DecodeError::new()),
    };
    let base_commit = CommitSha::new(decoder.string()?).map_err(|_| DecodeError::new())?;
    let probability = decoder.f64()?;
    Lineage::new(strategy, base_commit, probability).map_err(|_| DecodeError::new())
}

fn encode_issue_status(encoder: &mut Encoder, status: IssueStatus) {
    encoder.u8(match status {
        IssueStatus::Open => 0,
        IssueStatus::Assigned => 1,
        IssueStatus::Closed => 2,
    });
}

fn decode_issue_status(decoder: &mut Decoder<'_>) -> Result<IssueStatus, DecodeError> {
    match decoder.u8()? {
        0 => Ok(IssueStatus::Open),
        1 => Ok(IssueStatus::Assigned),
        2 => Ok(IssueStatus::Closed),
        _ => Err(DecodeError::new()),
    }
}

fn encode_experiment_status(encoder: &mut Encoder, status: ExperimentStatus) {
    encoder.u8(match status {
        ExperimentStatus::Open => 0,
        ExperimentStatus::Concluded => 1,
        ExperimentStatus::Failed => 2,
        ExperimentStatus::Cancelled => 3,
    });
}

fn decode_experiment_status(decoder: &mut Decoder<'_>) -> Result<ExperimentStatus, DecodeError> {
    match decoder.u8()? {
        0 => Ok(ExperimentStatus::Open),
        1 => Ok(ExperimentStatus::Concluded),
        2 => Ok(ExperimentStatus::Failed),
        3 => Ok(ExperimentStatus::Cancelled),
        _ => Err(DecodeError::new()),
    }
}

fn encode_ticket_status(encoder: &mut Encoder, status: TicketStatus) {
    encoder.u8(match status {
        TicketStatus::Open => 0,
        TicketStatus::Running => 1,
        TicketStatus::Succeeded => 2,
        TicketStatus::Failed => 3,
        TicketStatus::Abandoned => 4,
    });
}

fn decode_ticket_status(decoder: &mut Decoder<'_>) -> Result<TicketStatus, DecodeError> {
    match decoder.u8()? {
        0 => Ok(TicketStatus::Open),
        1 => Ok(TicketStatus::Running),
        2 => Ok(TicketStatus::Succeeded),
        3 => Ok(TicketStatus::Failed),
        4 => Ok(TicketStatus::Abandoned),
        _ => Err(DecodeError::new()),
    }
}

pub fn encode_issue(encoder: &mut Encoder, versioned: &Versioned<Issue>) {
    encoder.u64(versioned.version().get());
    encode_issue_value(encoder, versioned.value());
}

pub fn encode_issue_value(encoder: &mut Encoder, issue: &Issue) {
    encoder.string(issue.id().as_str());
    encoder.string(issue.program_id().as_str());
    encoder.string(issue.title());
    encoder.string(issue.body());
    encoder.u32(issue.labels().len() as u32);
    for label in issue.labels() {
        encoder.string(label);
    }
    encoder.string(issue.author().as_str());
    encode_timestamp(encoder, issue.created_at());
    encode_issue_status(encoder, issue.status());
    encode_optional_session(encoder, issue.assignee());
    encoder.u32(issue.experiments().len() as u32);
    for experiment in issue.experiments() {
        encoder.string(experiment.as_str());
    }
}

pub fn decode_issue(decoder: &mut Decoder<'_>) -> Result<Versioned<Issue>, DecodeError> {
    let version = Version::new(decoder.u64()?).map_err(|_| DecodeError::new())?;
    let issue = decode_issue_value(decoder)?;
    Ok(Versioned::new(issue, version))
}

pub fn decode_issue_value(decoder: &mut Decoder<'_>) -> Result<Issue, DecodeError> {
    let id = IssueId::new(decoder.string()?).map_err(|_| DecodeError::new())?;
    let program_id = ProgramId::new(decoder.string()?).map_err(|_| DecodeError::new())?;
    let title = decoder.string()?.to_string();
    let body = decoder.string()?.to_string();
    let count = decoder.u32()?;
    let mut labels = Vec::new();
    for _ in 0..count {
        labels.push(decoder.string()?.to_string());
    }
    let author = ActorId::new(decoder.string()?).map_err(|_| DecodeError::new())?;
    let created_at = decode_timestamp(decoder)?;
    let status = decode_issue_status(decoder)?;
    let assignee = decode_optional_session(decoder)?;
    let count = decoder.u32()?;
    let mut experiments = Vec::new();
    for _ in 0..count {
        experiments.push(ExperimentId::new(decoder.string()?).map_err(|_| DecodeError::new())?);
    }
    Issue::restore(
        IssueInput {
            id,
            program_id,
            title,
            body,
            labels,
            author,
            created_at,
        },
        status,
        assignee,
        experiments,
    )
    .map_err(|_| DecodeError::new())
}

pub fn encode_experiment(encoder: &mut Encoder, versioned: &Versioned<Experiment>) {
    encoder.u64(versioned.version().get());
    encode_experiment_value(encoder, versioned.value());
}

pub fn encode_experiment_value(encoder: &mut Encoder, experiment: &Experiment) {
    encoder.string(experiment.id().as_str());
    encoder.string(experiment.program_id().as_str());
    encoder.string(experiment.issue_id().as_str());
    encoder.string(experiment.branch().as_str());
    encoder.string(experiment.head().as_str());
    encode_environment(encoder, experiment.environment());
    encode_lineage(encoder, experiment.lineage());
    encode_optional_string(encoder, experiment.plan_comment_id().map(CommentId::as_str));
    encoder.string(experiment.created_by().as_str());
    encode_timestamp(encoder, experiment.created_at());
    encode_experiment_status(encoder, experiment.status());
}

pub fn decode_experiment(decoder: &mut Decoder<'_>) -> Result<Versioned<Experiment>, DecodeError> {
    let version = Version::new(decoder.u64()?).map_err(|_| DecodeError::new())?;
    let experiment = decode_experiment_value(decoder)?;
    Ok(Versioned::new(experiment, version))
}

pub fn decode_experiment_value(decoder: &mut Decoder<'_>) -> Result<Experiment, DecodeError> {
    let id = ExperimentId::new(decoder.string()?).map_err(|_| DecodeError::new())?;
    let program_id = ProgramId::new(decoder.string()?).map_err(|_| DecodeError::new())?;
    let issue_id = IssueId::new(decoder.string()?).map_err(|_| DecodeError::new())?;
    let branch = crate::id::BranchName::new(decoder.string()?).map_err(|_| DecodeError::new())?;
    let head = CommitSha::new(decoder.string()?).map_err(|_| DecodeError::new())?;
    let environment = decode_environment(decoder)?;
    let lineage = decode_lineage(decoder)?;
    let plan_comment_id = match decode_optional_string(decoder)? {
        Some(value) => Some(CommentId::new(value).map_err(|_| DecodeError::new())?),
        None => None,
    };
    let created_by = ActorId::new(decoder.string()?).map_err(|_| DecodeError::new())?;
    let created_at = decode_timestamp(decoder)?;
    let status = decode_experiment_status(decoder)?;
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
        status,
    }))
}

pub fn encode_ticket(encoder: &mut Encoder, versioned: &Versioned<Ticket>) {
    encoder.u64(versioned.version().get());
    encode_ticket_value(encoder, versioned.value());
}

pub fn encode_ticket_value(encoder: &mut Encoder, ticket: &Ticket) {
    encoder.string(ticket.id().as_str());
    encoder.string(ticket.experiment_id().as_str());
    encoder.string(ticket.assignment().branch().as_str());
    encoder.string(ticket.assignment().base_commit().as_str());
    encode_ticket_status(encoder, ticket.status());
    encode_optional_string(encoder, ticket.commit().map(CommitSha::as_str));
    encode_optional_session(encoder, ticket.worker_session_id());
}

pub fn decode_ticket(decoder: &mut Decoder<'_>) -> Result<Versioned<Ticket>, DecodeError> {
    let version = Version::new(decoder.u64()?).map_err(|_| DecodeError::new())?;
    let ticket = decode_ticket_value(decoder)?;
    Ok(Versioned::new(ticket, version))
}

pub fn decode_ticket_value(decoder: &mut Decoder<'_>) -> Result<Ticket, DecodeError> {
    let id = TicketId::new(decoder.string()?).map_err(|_| DecodeError::new())?;
    let experiment_id = ExperimentId::new(decoder.string()?).map_err(|_| DecodeError::new())?;
    let branch = crate::id::BranchName::new(decoder.string()?).map_err(|_| DecodeError::new())?;
    let base_commit = CommitSha::new(decoder.string()?).map_err(|_| DecodeError::new())?;
    let status = decode_ticket_status(decoder)?;
    let commit = match decode_optional_string(decoder)? {
        Some(value) => Some(CommitSha::new(value).map_err(|_| DecodeError::new())?),
        None => None,
    };
    let worker_session_id = decode_optional_session(decoder)?;
    Ok(Ticket::restore(
        id,
        experiment_id,
        TicketAssignment::new(branch, base_commit),
        status,
        commit,
        worker_session_id,
    ))
}

pub fn encode_audit_entry(encoder: &mut Encoder, entry: &AuditEntry) {
    encoder.string(entry.id().as_str());
    encoder.string(entry.actor().as_str());
    encoder.string(entry.action());
    encoder.string(entry.subject());
    encoder.string(entry.detail());
    encoder.string(entry.request_id().as_str());
    encode_timestamp(encoder, entry.created_at());
}

pub fn encode_audit_id(encoder: &mut Encoder, id: &AuditId) {
    encoder.string(id.as_str());
}

pub fn encode_actor(encoder: &mut Encoder, actor: &Actor) {
    encoder.string(actor.id().as_str());
    encoder.u8(match actor.role() {
        ActorRole::Operator => 0,
        ActorRole::Researcher => 1,
        ActorRole::Implementer => 2,
    });
    encode_optional_session(encoder, actor.session());
}

pub fn decode_actor(decoder: &mut Decoder<'_>) -> Result<Actor, DecodeError> {
    let id = ActorId::new(decoder.string()?).map_err(|_| DecodeError::new())?;
    let role = match decoder.u8()? {
        0 => ActorRole::Operator,
        1 => ActorRole::Researcher,
        2 => ActorRole::Implementer,
        _ => return Err(DecodeError::new()),
    };
    let session = decode_optional_session(decoder)?;
    Ok(Actor::new(id, role, session))
}

pub fn encode_request_id(encoder: &mut Encoder, id: &RequestId) {
    encoder.string(id.as_str());
}

pub fn decode_request_id(decoder: &mut Decoder<'_>) -> Result<RequestId, DecodeError> {
    RequestId::new(decoder.string()?).map_err(|_| DecodeError::new())
}

pub fn encode_command(encoder: &mut Encoder, draft: &CommandDraft) {
    encoder.u8(draft.name().code());
    match draft {
        CommandDraft::CreateProgram(command) => {
            encoder.string(command.id.as_str());
            encoder.string(&command.name);
            encoder.string(&command.goal);
            encoder.string(&command.methodology);
            encode_spec(encoder, &command.benchmark);
            encode_utility(encoder, &command.utility);
            encoder.u8(match command.exploration {
                Exploration::Low => 0,
                Exploration::Normal => 1,
                Exploration::High => 2,
            });
            encode_policy(encoder, command.policy);
        }
        CommandDraft::PauseProgram(command) => encoder.string(command.program_id.as_str()),
        CommandDraft::ResumeProgram(command) => encoder.string(command.program_id.as_str()),
        CommandDraft::StopProgram(command) => encoder.string(command.program_id.as_str()),
        CommandDraft::SetProgramGoal(command) => {
            encoder.string(command.program_id.as_str());
            encoder.string(&command.goal);
        }
        CommandDraft::SetProgramMethodology(command) => {
            encoder.string(command.program_id.as_str());
            encoder.string(&command.methodology);
        }
        CommandDraft::SetProgramExploration(command) => {
            encoder.string(command.program_id.as_str());
            encoder.u8(match command.exploration {
                Exploration::Low => 0,
                Exploration::Normal => 1,
                Exploration::High => 2,
            });
        }
        CommandDraft::CreateIssue(command) => {
            encoder.string(command.id.as_str());
            encoder.string(command.program_id.as_str());
            encoder.string(&command.title);
            encoder.string(&command.body);
            encoder.u32(command.labels.len() as u32);
            for label in &command.labels {
                encoder.string(label);
            }
        }
        CommandDraft::ClaimIssue(command) => encoder.string(command.issue_id.as_str()),
        CommandDraft::CommentIssue(command) => {
            encoder.string(command.issue_id.as_str());
            encoder.string(&command.body);
        }
        CommandDraft::CloseIssue(command) => encoder.string(command.issue_id.as_str()),
        CommandDraft::ProposeExperiment(command) => {
            encoder.string(command.id.as_str());
            encoder.string(command.program_id.as_str());
            encoder.string(command.issue_id.as_str());
            encoder.string(command.branch.as_str());
            encoder.string(command.head.as_str());
            encode_environment(encoder, &command.environment);
            encode_lineage(encoder, &command.lineage);
            encode_optional_string(
                encoder,
                command.plan_comment_id.as_ref().map(CommentId::as_str),
            );
        }
        CommandDraft::ReviewExperiment(command) => {
            encoder.string(command.experiment_id.as_str());
            encode_decision(encoder, command.decision);
        }
        CommandDraft::CloseExperiment(command) => encoder.string(command.experiment_id.as_str()),
        CommandDraft::RequestBenchmark(command) => {
            encoder.string(command.experiment_id.as_str());
        }
        CommandDraft::SubmitTicket(command) => {
            encoder.string(command.ticket_id.as_str());
            encoder.string(command.commit.as_str());
        }
    }
}

pub fn decode_command(decoder: &mut Decoder<'_>) -> Result<CommandDraft, DecodeError> {
    let name = CommandName::from_code(decoder.u8()?).ok_or(DecodeError::new())?;
    match name {
        CommandName::CreateProgram => {
            let id = ProgramId::new(decoder.string()?).map_err(|_| DecodeError::new())?;
            let name = decoder.string()?.to_string();
            let goal = decoder.string()?.to_string();
            let methodology = decoder.string()?.to_string();
            let benchmark = decode_spec(decoder)?;
            let utility = decode_utility(decoder)?;
            let exploration = decode_exploration(decoder)?;
            let policy = decode_policy(decoder)?;
            Ok(CommandDraft::CreateProgram(Box::new(
                CreateProgramCommand {
                    id,
                    name,
                    goal,
                    methodology,
                    benchmark,
                    utility,
                    exploration,
                    policy,
                },
            )))
        }
        CommandName::PauseProgram => {
            Ok(CommandDraft::PauseProgram(Box::new(PauseProgramCommand {
                program_id: ProgramId::new(decoder.string()?).map_err(|_| DecodeError::new())?,
            })))
        }
        CommandName::ResumeProgram => Ok(CommandDraft::ResumeProgram(Box::new(
            ResumeProgramCommand {
                program_id: ProgramId::new(decoder.string()?).map_err(|_| DecodeError::new())?,
            },
        ))),
        CommandName::StopProgram => Ok(CommandDraft::StopProgram(Box::new(StopProgramCommand {
            program_id: ProgramId::new(decoder.string()?).map_err(|_| DecodeError::new())?,
        }))),
        CommandName::SetProgramGoal => Ok(CommandDraft::SetProgramGoal(Box::new(
            SetProgramGoalCommand {
                program_id: ProgramId::new(decoder.string()?).map_err(|_| DecodeError::new())?,
                goal: decoder.string()?.to_string(),
            },
        ))),
        CommandName::SetProgramMethodology => Ok(CommandDraft::SetProgramMethodology(Box::new(
            SetProgramMethodologyCommand {
                program_id: ProgramId::new(decoder.string()?).map_err(|_| DecodeError::new())?,
                methodology: decoder.string()?.to_string(),
            },
        ))),
        CommandName::SetProgramExploration => Ok(CommandDraft::SetProgramExploration(Box::new(
            SetProgramExplorationCommand {
                program_id: ProgramId::new(decoder.string()?).map_err(|_| DecodeError::new())?,
                exploration: decode_exploration(decoder)?,
            },
        ))),
        CommandName::CreateIssue => {
            let id = IssueId::new(decoder.string()?).map_err(|_| DecodeError::new())?;
            let program_id = ProgramId::new(decoder.string()?).map_err(|_| DecodeError::new())?;
            let title = decoder.string()?.to_string();
            let body = decoder.string()?.to_string();
            let count = decoder.u32()?;
            let mut labels = Vec::new();
            for _ in 0..count {
                labels.push(decoder.string()?.to_string());
            }
            Ok(CommandDraft::CreateIssue(Box::new(CreateIssueCommand {
                id,
                program_id,
                title,
                body,
                labels,
            })))
        }
        CommandName::ClaimIssue => Ok(CommandDraft::ClaimIssue(Box::new(ClaimIssueCommand {
            issue_id: IssueId::new(decoder.string()?).map_err(|_| DecodeError::new())?,
        }))),
        CommandName::CommentIssue => {
            Ok(CommandDraft::CommentIssue(Box::new(CommentIssueCommand {
                issue_id: IssueId::new(decoder.string()?).map_err(|_| DecodeError::new())?,
                body: decoder.string()?.to_string(),
            })))
        }
        CommandName::CloseIssue => Ok(CommandDraft::CloseIssue(Box::new(CloseIssueCommand {
            issue_id: IssueId::new(decoder.string()?).map_err(|_| DecodeError::new())?,
        }))),
        CommandName::ProposeExperiment => {
            let id = ExperimentId::new(decoder.string()?).map_err(|_| DecodeError::new())?;
            let program_id = ProgramId::new(decoder.string()?).map_err(|_| DecodeError::new())?;
            let issue_id = IssueId::new(decoder.string()?).map_err(|_| DecodeError::new())?;
            let branch =
                crate::id::BranchName::new(decoder.string()?).map_err(|_| DecodeError::new())?;
            let head = CommitSha::new(decoder.string()?).map_err(|_| DecodeError::new())?;
            let environment = decode_environment(decoder)?;
            let lineage = decode_lineage(decoder)?;
            let plan_comment_id = match decode_optional_string(decoder)? {
                Some(value) => Some(CommentId::new(value).map_err(|_| DecodeError::new())?),
                None => None,
            };
            Ok(CommandDraft::ProposeExperiment(Box::new(
                ProposeExperimentCommand {
                    id,
                    program_id,
                    issue_id,
                    branch,
                    head,
                    environment,
                    lineage,
                    plan_comment_id,
                },
            )))
        }
        CommandName::ReviewExperiment => {
            let experiment_id =
                ExperimentId::new(decoder.string()?).map_err(|_| DecodeError::new())?;
            let decision = decode_decision(decoder)?;
            Ok(CommandDraft::ReviewExperiment(Box::new(
                ReviewExperimentCommand {
                    experiment_id,
                    decision,
                },
            )))
        }
        CommandName::CloseExperiment => Ok(CommandDraft::CloseExperiment(Box::new(
            CloseExperimentCommand {
                experiment_id: ExperimentId::new(decoder.string()?)
                    .map_err(|_| DecodeError::new())?,
            },
        ))),
        CommandName::RequestBenchmark => Ok(CommandDraft::RequestBenchmark(Box::new(
            RequestBenchmarkCommand {
                experiment_id: ExperimentId::new(decoder.string()?)
                    .map_err(|_| DecodeError::new())?,
            },
        ))),
        CommandName::SubmitTicket => {
            Ok(CommandDraft::SubmitTicket(Box::new(SubmitTicketCommand {
                ticket_id: TicketId::new(decoder.string()?).map_err(|_| DecodeError::new())?,
                commit: CommitSha::new(decoder.string()?).map_err(|_| DecodeError::new())?,
            })))
        }
    }
}

pub fn encode_decision(encoder: &mut Encoder, decision: ResearcherDecision) {
    match decision {
        ResearcherDecision::Propose => encoder.u8(0),
        ResearcherDecision::Revise => encoder.u8(1),
        ResearcherDecision::Stop(reason) => {
            encoder.u8(2);
            encoder.u8(match reason {
                StopReason::GoalMet => 0,
                StopReason::PolicyExhausted => 1,
                StopReason::NoHypothesis => 2,
                StopReason::Cancelled => 3,
            });
        }
    }
}

pub fn encode_command_outcome(encoder: &mut Encoder, outcome: &CommandOutcome) {
    match outcome {
        CommandOutcome::ProgramCreated { program, version } => {
            encoder.u8(0);
            encoder.string(program.as_str());
            encoder.u64(version.get());
        }
        CommandOutcome::ProgramUpdated { program, version } => {
            encoder.u8(1);
            encoder.string(program.as_str());
            encoder.u64(version.get());
        }
        CommandOutcome::IssueCreated { issue, version } => {
            encoder.u8(2);
            encoder.string(issue.as_str());
            encoder.u64(version.get());
        }
        CommandOutcome::IssueUpdated { issue, version } => {
            encoder.u8(3);
            encoder.string(issue.as_str());
            encoder.u64(version.get());
        }
        CommandOutcome::IssueCommented { issue } => {
            encoder.u8(4);
            encoder.string(issue.as_str());
        }
        CommandOutcome::ExperimentCreated {
            experiment,
            version,
        } => {
            encoder.u8(5);
            encoder.string(experiment.as_str());
            encoder.u64(version.get());
        }
        CommandOutcome::ExperimentUpdated {
            experiment,
            version,
        } => {
            encoder.u8(6);
            encoder.string(experiment.as_str());
            encoder.u64(version.get());
        }
        CommandOutcome::ExperimentReviewed {
            experiment,
            decision,
        } => {
            encoder.u8(7);
            encoder.string(experiment.as_str());
            encode_decision(encoder, *decision);
        }
        CommandOutcome::BenchmarkRequested { experiment } => {
            encoder.u8(8);
            encoder.string(experiment.as_str());
        }
        CommandOutcome::TicketSubmitted {
            ticket,
            commit,
            version,
        } => {
            encoder.u8(9);
            encoder.string(ticket.as_str());
            encoder.string(commit.as_str());
            encoder.u64(version.get());
        }
    }
}

pub fn encode_attempt(encoder: &mut Encoder, attempt: Attempt) {
    encoder.u32(attempt.get());
}
