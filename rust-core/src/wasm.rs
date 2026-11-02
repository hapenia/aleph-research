use crate::id::{
    ActorId, ArtifactId, Attempt, AuditId, BenchmarkRunId, BenchmarkSpecId, BranchName, CommentId,
    CommitSha, EnvironmentDigest, EnvironmentFile, ExperimentId, IssueId, PipelineRunId, ProgramId,
    RequestId, SessionId, SpecHash, TicketId, TriggerId,
};
use crate::stage::StageName;

fn validity(value: bool) -> u32 {
    u32::from(value)
}

fn text<'a>(pointer: *const u8, length: usize) -> Option<&'a str> {
    if length == 0 {
        return Some("");
    }
    if pointer.is_null() {
        return None;
    }
    let bytes = unsafe { std::slice::from_raw_parts(pointer, length) };
    std::str::from_utf8(bytes).ok()
}

macro_rules! validator {
    ($function:ident, $type:ty) => {
        #[unsafe(no_mangle)]
        pub extern "C" fn $function(pointer: *const u8, length: usize) -> u32 {
            validity(text(pointer, length).is_some_and(|value| <$type>::new(value).is_ok()))
        }
    };
}

validator!(aleph_program_id_is_valid, ProgramId);
validator!(aleph_issue_id_is_valid, IssueId);
validator!(aleph_experiment_id_is_valid, ExperimentId);
validator!(aleph_ticket_id_is_valid, TicketId);
validator!(aleph_benchmark_run_id_is_valid, BenchmarkRunId);
validator!(aleph_benchmark_spec_id_is_valid, BenchmarkSpecId);
validator!(aleph_artifact_id_is_valid, ArtifactId);
validator!(aleph_audit_id_is_valid, AuditId);
validator!(aleph_trigger_id_is_valid, TriggerId);
validator!(aleph_pipeline_run_id_is_valid, PipelineRunId);
validator!(aleph_session_id_is_valid, SessionId);
validator!(aleph_actor_id_is_valid, ActorId);
validator!(aleph_request_id_is_valid, RequestId);
validator!(aleph_comment_id_is_valid, CommentId);
validator!(aleph_branch_name_is_valid, BranchName);
validator!(aleph_environment_file_is_valid, EnvironmentFile);
validator!(aleph_commit_sha_is_valid, CommitSha);
validator!(aleph_spec_hash_is_valid, SpecHash);
validator!(aleph_environment_digest_is_valid, EnvironmentDigest);

#[unsafe(no_mangle)]
pub extern "C" fn aleph_core_version() -> u32 {
    crate::CORE_ABI_VERSION
}

#[unsafe(no_mangle)]
pub extern "C" fn aleph_stage_code(pointer: *const u8, length: usize) -> i32 {
    text(pointer, length)
        .and_then(StageName::parse)
        .map_or(-1, |stage| stage.code() as i32)
}

#[unsafe(no_mangle)]
pub extern "C" fn aleph_stage_successor_mask(code: u32) -> u32 {
    StageName::from_code(code).map_or(0, StageName::successor_mask)
}

#[unsafe(no_mangle)]
pub extern "C" fn aleph_stage_is_terminal(code: u32) -> u32 {
    StageName::from_code(code).map_or(0, |stage| u32::from(stage.is_terminal()))
}

#[unsafe(no_mangle)]
pub extern "C" fn aleph_stage_count() -> u32 {
    StageName::ALL.len() as u32
}

#[unsafe(no_mangle)]
pub extern "C" fn aleph_stage_name_len(code: u32) -> u32 {
    StageName::from_code(code).map_or(0, |stage| stage.as_str().len() as u32)
}

#[unsafe(no_mangle)]
pub extern "C" fn aleph_stage_name_write(code: u32, pointer: *mut u8, capacity: usize) -> u32 {
    let Some(stage) = StageName::from_code(code) else {
        return 0;
    };
    let name = stage.as_str().as_bytes();
    if pointer.is_null() || name.len() > capacity {
        return 0;
    }
    unsafe { std::ptr::copy_nonoverlapping(name.as_ptr(), pointer, name.len()) };
    name.len() as u32
}

#[unsafe(no_mangle)]
pub extern "C" fn aleph_policy_allows_retry(attempt: u32, max_attempts: u32) -> u32 {
    match Attempt::new(attempt) {
        Ok(value) => u32::from(value.get() < max_attempts),
        Err(_) => 0,
    }
}
