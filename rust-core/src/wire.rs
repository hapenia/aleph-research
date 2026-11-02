use std::collections::BTreeMap;

use crate::domain::{
    BenchmarkMetric, BenchmarkRecord, BenchmarkRecordInput, BenchmarkSpec, Environment,
    Exploration, Metric, MetricDirection, MetricWeight, Program, ProgramInput, ProgramStatus,
    ResearchPolicy, ResearcherDecision, StopReason, Usage, Versioned,
};
use crate::id::{
    ActorId, BenchmarkRunId, BenchmarkSpecId, CommitSha, EnvironmentDigest, EnvironmentFile,
    ExperimentId, ProgramId, SpecHash, TicketId, Version,
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
    let program = versioned.value();
    encoder.u64(versioned.version().get());
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
    let exploration = match decoder.u8()? {
        0 => Exploration::Low,
        1 => Exploration::Normal,
        2 => Exploration::High,
        _ => return Err(DecodeError::new()),
    };
    let policy = ResearchPolicy::new(
        decoder.u32()?,
        decoder.u64()?,
        decoder.u64()?,
        decoder.u32()?,
    )
    .map_err(|_| DecodeError::new())?;
    let usage = Usage::new(decoder.u32()?, decoder.u64()?, decoder.u64()?);
    let status = match decoder.u8()? {
        0 => ProgramStatus::Running,
        1 => ProgramStatus::Paused,
        2 => ProgramStatus::Stopped,
        _ => return Err(DecodeError::new()),
    };
    let created_at = decode_timestamp(decoder)?;
    let program = Program::new(ProgramInput {
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
    .map_err(|_| DecodeError::new())?;
    Ok(Versioned::new(program, version))
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
