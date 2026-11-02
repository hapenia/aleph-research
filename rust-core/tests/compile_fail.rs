#[test]
fn invalid_stage_use_and_incomplete_plugins_do_not_compile() {
    let cases = trybuild::TestCases::new();
    cases.compile_fail("tests/compile_fail/reused_stage.rs");
    cases.compile_fail("tests/compile_fail/incomplete_plugin.rs");
    cases.compile_fail("tests/compile_fail/skipped_stage.rs");
}
