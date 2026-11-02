#![allow(dead_code)]

use aleph_research_core::Plugin;
use aleph_research_core::memory::{
    InMemoryArtifacts, InMemoryBenchmark, InMemoryClock, InMemoryHttp, InMemorySessions,
    InMemoryStorage, InMemoryTicketExecutor, InMemoryTools, InMemoryTriggerSource,
};

struct Partial {
    storage: InMemoryStorage,
    trigger: InMemoryTriggerSource,
    executor: InMemoryTicketExecutor,
    sessions: InMemorySessions,
    benchmark: InMemoryBenchmark,
    artifacts: InMemoryArtifacts,
    clock: InMemoryClock,
    tools: InMemoryTools,
    http: InMemoryHttp,
}

impl Plugin for Partial {
    type Storage = InMemoryStorage;
    type Trigger = InMemoryTriggerSource;
    type Executor = InMemoryTicketExecutor;
    type Sessions = InMemorySessions;
    type Benchmark = InMemoryBenchmark;
    type Artifacts = InMemoryArtifacts;
    type Clock = InMemoryClock;
    type Tools = InMemoryTools;
    type Http = InMemoryHttp;

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
}

fn main() {}
