use std::cell::RefCell;

use crate::id::{
    ActorId, ArtifactId, Attempt, AuditId, BenchmarkRunId, BenchmarkSpecId, BranchName, CommentId,
    CommitSha, EnvironmentDigest, EnvironmentFile, ExperimentId, IssueId, PipelineRunId, ProgramId,
    RequestId, SessionId, SpecHash, TicketId, TriggerId,
};
use crate::stage::StageName;

thread_local! {
    static RESPONSE: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

fn validity(value: bool) -> u32 {
    u32::from(value)
}

fn input<'a>(pointer: *const u8, length: usize) -> Option<&'a [u8]> {
    if pointer.is_null() {
        return None;
    }
    Some(unsafe { std::slice::from_raw_parts(pointer, length) })
}

fn respond(bytes: Vec<u8>) {
    RESPONSE.with(|buffer| *buffer.borrow_mut() = bytes);
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
pub extern "C" fn aleph_bridge_version() -> u32 {
    crate::bridge::version()
}

#[unsafe(no_mangle)]
pub extern "C" fn aleph_alloc(length: u32) -> *mut u8 {
    if length == 0 {
        return std::ptr::null_mut();
    }
    let mut buffer = vec![0u8; length as usize];
    let pointer = buffer.as_mut_ptr();
    std::mem::forget(buffer);
    pointer
}

#[unsafe(no_mangle)]
pub extern "C" fn aleph_free(pointer: *mut u8, length: u32) {
    if pointer.is_null() || length == 0 {
        return;
    }
    unsafe {
        drop(Vec::from_raw_parts(
            pointer,
            length as usize,
            length as usize,
        ));
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn aleph_start(pointer: *const u8, length: usize) -> u32 {
    let Some(request) = input(pointer, length) else {
        return 0;
    };
    respond(crate::bridge::start(request));
    1
}

#[unsafe(no_mangle)]
pub extern "C" fn aleph_resume(pointer: *const u8, length: usize) -> u32 {
    let Some(request) = input(pointer, length) else {
        return 0;
    };
    respond(crate::bridge::resume(request));
    1
}

#[unsafe(no_mangle)]
pub extern "C" fn aleph_command_start(pointer: *const u8, length: usize) -> u32 {
    let Some(request) = input(pointer, length) else {
        return 0;
    };
    respond(crate::bridge::start_command(request));
    1
}

#[unsafe(no_mangle)]
pub extern "C" fn aleph_command_resume(pointer: *const u8, length: usize) -> u32 {
    let Some(request) = input(pointer, length) else {
        return 0;
    };
    respond(crate::bridge::resume_command(request));
    1
}

#[unsafe(no_mangle)]
pub extern "C" fn aleph_response_len() -> u32 {
    RESPONSE.with(|buffer| buffer.borrow().len() as u32)
}

#[unsafe(no_mangle)]
pub extern "C" fn aleph_response_write(pointer: *mut u8, capacity: usize) -> u32 {
    if pointer.is_null() {
        return 0;
    }
    RESPONSE.with(|buffer| {
        let buffer = buffer.borrow();
        if buffer.len() > capacity {
            return 0;
        }
        unsafe {
            std::ptr::copy_nonoverlapping(buffer.as_ptr(), pointer, buffer.len());
        }
        buffer.len() as u32
    })
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
