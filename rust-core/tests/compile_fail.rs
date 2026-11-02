#[test]
fn invalid_stage_and_command_use_does_not_compile() {
    let cases = trybuild::TestCases::new();
    cases.compile_fail("tests/compile_fail/reused_stage.rs");
    cases.compile_fail("tests/compile_fail/incomplete_plugin.rs");
    cases.compile_fail("tests/compile_fail/skipped_stage.rs");
    cases.compile_fail("tests/compile_fail/bare_draft.rs");
    cases.compile_fail("tests/compile_fail/forged_proof.rs");
}
