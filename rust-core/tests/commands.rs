mod support;

use aleph_research_core::command::*;
use aleph_research_core::memory::InMemoryPlugin;
use aleph_research_core::{
    ActorId, BranchName, CommitSha, Environment, EnvironmentFile, ExperimentId, ExperimentStatus,
    Exploration, IssueId, IssueStatus, Lineage, LineageStrategy, MetricDirection, MetricWeight,
    ProgramId, ProgramStatus, RequestId, ResearchPolicy, ResearcherDecision, SessionId, Storage,
    Ticket, TicketAssignment, TicketId, TicketStatus, Timestamp, Version,
};
use support::{block_on, spec};

fn program_id() -> ProgramId {
    ProgramId::new("program-1").unwrap()
}

fn issue_id() -> IssueId {
    IssueId::new("issue-1").unwrap()
}

fn experiment_id() -> ExperimentId {
    ExperimentId::new("experiment-1").unwrap()
}

fn ticket_id() -> TicketId {
    TicketId::new("ticket-1").unwrap()
}

fn request(sequence: u64) -> RequestId {
    RequestId::new(format!("request-{sequence}")).unwrap()
}

fn operator_actor(id: &str) -> Actor {
    Actor::operator(ActorId::new(id).unwrap())
}

fn researcher_actor(id: &str, session: &str) -> Actor {
    Actor::researcher(ActorId::new(id).unwrap(), SessionId::new(session).unwrap())
}

fn implementer_actor(id: &str, session: &str) -> Actor {
    Actor::implementer(ActorId::new(id).unwrap(), SessionId::new(session).unwrap())
}

fn create_program_draft() -> CommandDraft {
    CommandDraft::CreateProgram(Box::new(CreateProgramCommand {
        id: program_id(),
        name: "Program".to_string(),
        goal: "Improve the benchmark".to_string(),
        methodology: "Propose, run, review".to_string(),
        benchmark: spec(),
        utility: vec![MetricWeight::new("score", MetricDirection::Maximize, 1.0).unwrap()],
        exploration: Exploration::Normal,
        policy: ResearchPolicy::default(),
    }))
}

fn pause_program_draft() -> CommandDraft {
    CommandDraft::PauseProgram(Box::new(PauseProgramCommand {
        program_id: program_id(),
    }))
}

fn resume_program_draft() -> CommandDraft {
    CommandDraft::ResumeProgram(Box::new(ResumeProgramCommand {
        program_id: program_id(),
    }))
}

fn stop_program_draft() -> CommandDraft {
    CommandDraft::StopProgram(Box::new(StopProgramCommand {
        program_id: program_id(),
    }))
}

fn set_goal_draft(goal: &str) -> CommandDraft {
    CommandDraft::SetProgramGoal(Box::new(SetProgramGoalCommand {
        program_id: program_id(),
        goal: goal.to_string(),
    }))
}

fn set_methodology_draft(methodology: &str) -> CommandDraft {
    CommandDraft::SetProgramMethodology(Box::new(SetProgramMethodologyCommand {
        program_id: program_id(),
        methodology: methodology.to_string(),
    }))
}

fn set_exploration_draft() -> CommandDraft {
    CommandDraft::SetProgramExploration(Box::new(SetProgramExplorationCommand {
        program_id: program_id(),
        exploration: Exploration::High,
    }))
}

fn create_issue_draft() -> CommandDraft {
    CommandDraft::CreateIssue(Box::new(CreateIssueCommand {
        id: issue_id(),
        program_id: program_id(),
        title: "Find a better model".to_string(),
        body: "The benchmark can improve.".to_string(),
        labels: vec!["research".to_string()],
    }))
}

fn claim_issue_draft() -> CommandDraft {
    CommandDraft::ClaimIssue(Box::new(ClaimIssueCommand {
        issue_id: issue_id(),
    }))
}

fn comment_issue_draft(body: &str) -> CommandDraft {
    CommandDraft::CommentIssue(Box::new(CommentIssueCommand {
        issue_id: issue_id(),
        body: body.to_string(),
    }))
}

fn close_issue_draft() -> CommandDraft {
    CommandDraft::CloseIssue(Box::new(CloseIssueCommand {
        issue_id: issue_id(),
    }))
}

fn propose_experiment_draft() -> CommandDraft {
    CommandDraft::ProposeExperiment(Box::new(ProposeExperimentCommand {
        id: experiment_id(),
        program_id: program_id(),
        issue_id: issue_id(),
        branch: BranchName::new("experiment/one").unwrap(),
        head: CommitSha::zero(),
        environment: Environment::requirements(EnvironmentFile::new("requirements.txt").unwrap()),
        lineage: Lineage::new(LineageStrategy::Continue, CommitSha::zero(), 0.0).unwrap(),
        plan_comment_id: None,
    }))
}

fn review_experiment_draft() -> CommandDraft {
    CommandDraft::ReviewExperiment(Box::new(ReviewExperimentCommand {
        experiment_id: experiment_id(),
        decision: ResearcherDecision::Propose,
    }))
}

fn close_experiment_draft() -> CommandDraft {
    CommandDraft::CloseExperiment(Box::new(CloseExperimentCommand {
        experiment_id: experiment_id(),
    }))
}

fn request_benchmark_draft() -> CommandDraft {
    CommandDraft::RequestBenchmark(Box::new(RequestBenchmarkCommand {
        experiment_id: experiment_id(),
    }))
}

fn submit_ticket_draft() -> CommandDraft {
    CommandDraft::SubmitTicket(Box::new(SubmitTicketCommand {
        ticket_id: ticket_id(),
        commit: CommitSha::new("b".repeat(40)).unwrap(),
    }))
}

fn seed_ticket(plugin: &InMemoryPlugin, session: &SessionId, status: TicketStatus) {
    let ticket = Ticket::restore(
        ticket_id(),
        experiment_id(),
        TicketAssignment::new(
            BranchName::new("experiment/one").unwrap(),
            CommitSha::zero(),
        ),
        status,
        None,
        Some(session.clone()),
    );
    block_on(plugin.storage.save_ticket(&ticket, None)).unwrap();
}

macro_rules! run_command {
    ($gate:expr, $executor:expr, $actor:expr, $request:expr, $kind:ty, $draft:expr) => {{
        let authorized: AuthorizedCommand<$kind> =
            block_on($gate.authorize($actor, $request, $draft)).unwrap();
        block_on($executor.execute(authorized)).unwrap()
    }};
}

#[test]
fn every_blueprint_command_executes_through_the_store() {
    let plugin = InMemoryPlugin::default();
    let gate = HostGate::new(&plugin);
    let executor = CommandExecutor::new(&plugin);
    let operator = operator_actor("operator-1");
    let researcher = researcher_actor("researcher-1", "session-1");
    let implementer = implementer_actor("implementer-1", "session-2");

    let outcome = run_command!(
        gate,
        executor,
        &operator,
        request(1),
        CreateProgram,
        create_program_draft()
    );
    assert_eq!(
        outcome,
        CommandOutcome::ProgramCreated {
            program: program_id(),
            version: Version::first(),
        }
    );
    let stored = block_on(plugin.storage.load_program(&program_id())).unwrap();
    assert_eq!(stored.value().owner(), operator.id());
    assert_eq!(stored.value().status(), ProgramStatus::Running);
    assert_eq!(stored.version(), Version::first());

    let outcome = run_command!(
        gate,
        executor,
        &operator,
        request(2),
        PauseProgram,
        pause_program_draft()
    );
    assert_eq!(
        outcome,
        CommandOutcome::ProgramUpdated {
            program: program_id(),
            version: Version::new(2).unwrap(),
        }
    );
    assert_eq!(
        block_on(plugin.storage.load_program(&program_id()))
            .unwrap()
            .value()
            .status(),
        ProgramStatus::Paused
    );

    let outcome = run_command!(
        gate,
        executor,
        &operator,
        request(3),
        ResumeProgram,
        resume_program_draft()
    );
    assert_eq!(
        outcome,
        CommandOutcome::ProgramUpdated {
            program: program_id(),
            version: Version::new(3).unwrap(),
        }
    );

    let outcome = run_command!(
        gate,
        executor,
        &operator,
        request(4),
        SetProgramGoal,
        set_goal_draft("Improve the score")
    );
    assert_eq!(
        outcome,
        CommandOutcome::ProgramUpdated {
            program: program_id(),
            version: Version::new(4).unwrap(),
        }
    );
    assert_eq!(
        block_on(plugin.storage.load_program(&program_id()))
            .unwrap()
            .value()
            .goal(),
        "Improve the score"
    );

    let outcome = run_command!(
        gate,
        executor,
        &operator,
        request(5),
        SetProgramMethodology,
        set_methodology_draft("Benchmark-driven research")
    );
    assert_eq!(
        outcome,
        CommandOutcome::ProgramUpdated {
            program: program_id(),
            version: Version::new(5).unwrap(),
        }
    );

    let outcome = run_command!(
        gate,
        executor,
        &operator,
        request(6),
        SetProgramExploration,
        set_exploration_draft()
    );
    assert_eq!(
        outcome,
        CommandOutcome::ProgramUpdated {
            program: program_id(),
            version: Version::new(6).unwrap(),
        }
    );
    assert_eq!(
        block_on(plugin.storage.load_program(&program_id()))
            .unwrap()
            .value()
            .exploration(),
        Exploration::High
    );

    let outcome = run_command!(
        gate,
        executor,
        &operator,
        request(7),
        CreateIssue,
        create_issue_draft()
    );
    assert_eq!(
        outcome,
        CommandOutcome::IssueCreated {
            issue: issue_id(),
            version: Version::first(),
        }
    );
    let stored = block_on(plugin.storage.load_issue(&issue_id())).unwrap();
    assert_eq!(stored.value().author(), operator.id());
    assert_eq!(stored.value().status(), IssueStatus::Open);

    let outcome = run_command!(
        gate,
        executor,
        &researcher,
        request(8),
        ClaimIssue,
        claim_issue_draft()
    );
    assert_eq!(
        outcome,
        CommandOutcome::IssueUpdated {
            issue: issue_id(),
            version: Version::new(2).unwrap(),
        }
    );
    let stored = block_on(plugin.storage.load_issue(&issue_id())).unwrap();
    assert_eq!(stored.value().status(), IssueStatus::Assigned);
    assert_eq!(
        stored.value().assignee(),
        Some(&SessionId::new("session-1").unwrap())
    );

    let outcome = run_command!(
        gate,
        executor,
        &researcher,
        request(9),
        ProposeExperiment,
        propose_experiment_draft()
    );
    assert_eq!(
        outcome,
        CommandOutcome::ExperimentCreated {
            experiment: experiment_id(),
            version: Version::first(),
        }
    );
    let experiment = block_on(plugin.storage.load_experiment(&experiment_id())).unwrap();
    assert_eq!(experiment.value().created_by(), researcher.id());
    assert_eq!(experiment.value().status(), ExperimentStatus::Open);
    let issue = block_on(plugin.storage.load_issue(&issue_id())).unwrap();
    assert_eq!(issue.value().experiments(), &[experiment_id()]);

    let outcome = run_command!(
        gate,
        executor,
        &researcher,
        request(10),
        ReviewExperiment,
        review_experiment_draft()
    );
    assert_eq!(
        outcome,
        CommandOutcome::ExperimentReviewed {
            experiment: experiment_id(),
            decision: ResearcherDecision::Propose,
        }
    );

    let outcome = run_command!(
        gate,
        executor,
        &researcher,
        request(11),
        RequestBenchmark,
        request_benchmark_draft()
    );
    assert_eq!(
        outcome,
        CommandOutcome::BenchmarkRequested {
            experiment: experiment_id(),
        }
    );

    seed_ticket(
        &plugin,
        &SessionId::new("session-2").unwrap(),
        TicketStatus::Running,
    );
    let commit = CommitSha::new("b".repeat(40)).unwrap();
    let outcome = run_command!(
        gate,
        executor,
        &implementer,
        request(12),
        SubmitTicket,
        submit_ticket_draft()
    );
    assert_eq!(
        outcome,
        CommandOutcome::TicketSubmitted {
            ticket: ticket_id(),
            commit: commit.clone(),
            version: Version::new(2).unwrap(),
        }
    );
    let ticket = block_on(plugin.storage.load_ticket(&ticket_id())).unwrap();
    assert_eq!(ticket.value().status(), TicketStatus::Succeeded);
    assert_eq!(ticket.value().commit(), Some(&commit));

    let outcome = run_command!(
        gate,
        executor,
        &researcher,
        request(13),
        CloseExperiment,
        close_experiment_draft()
    );
    assert_eq!(
        outcome,
        CommandOutcome::ExperimentUpdated {
            experiment: experiment_id(),
            version: Version::new(2).unwrap(),
        }
    );
    assert_eq!(
        block_on(plugin.storage.load_experiment(&experiment_id()))
            .unwrap()
            .value()
            .status(),
        ExperimentStatus::Cancelled
    );

    let outcome = run_command!(
        gate,
        executor,
        &researcher,
        request(14),
        CommentIssue,
        comment_issue_draft("The experiment is closed")
    );
    assert_eq!(
        outcome,
        CommandOutcome::IssueCommented { issue: issue_id() }
    );

    let outcome = run_command!(
        gate,
        executor,
        &researcher,
        request(15),
        CloseIssue,
        close_issue_draft()
    );
    assert_eq!(
        outcome,
        CommandOutcome::IssueUpdated {
            issue: issue_id(),
            version: Version::new(4).unwrap(),
        }
    );
    assert_eq!(
        block_on(plugin.storage.load_issue(&issue_id()))
            .unwrap()
            .value()
            .status(),
        IssueStatus::Closed
    );

    let outcome = run_command!(
        gate,
        executor,
        &operator,
        request(16),
        StopProgram,
        stop_program_draft()
    );
    assert_eq!(
        outcome,
        CommandOutcome::ProgramUpdated {
            program: program_id(),
            version: Version::new(7).unwrap(),
        }
    );
    assert_eq!(
        block_on(plugin.storage.load_program(&program_id()))
            .unwrap()
            .value()
            .status(),
        ProgramStatus::Stopped
    );

    let audits = plugin.storage.audits();
    let actions: Vec<&str> = audits.iter().map(|entry| entry.action()).collect();
    assert_eq!(
        actions,
        [
            "program.create",
            "program.pause",
            "program.resume",
            "program.goal",
            "program.methodology",
            "program.exploration",
            "issue.create",
            "issue.claim",
            "experiment.propose",
            "experiment.review",
            "benchmark.request",
            "ticket.submit",
            "experiment.close",
            "issue.comment",
            "issue.close",
            "program.stop",
        ]
    );
    assert_eq!(plugin.storage.audits().len(), 16);
}

#[test]
fn an_unauthorized_command_never_reaches_the_executor() {
    let plugin = InMemoryPlugin::default();
    let gate = HostGate::new(&plugin);
    let executor = CommandExecutor::new(&plugin);
    let operator = operator_actor("operator-1");
    let other_operator = operator_actor("operator-2");
    let implementer = implementer_actor("implementer-1", "session-2");
    let researcher_without_session = Actor::new(
        ActorId::new("researcher-2").unwrap(),
        ActorRole::Researcher,
        None,
    );

    run_command!(
        gate,
        executor,
        &operator,
        request(1),
        CreateProgram,
        create_program_draft()
    );
    run_command!(
        gate,
        executor,
        &operator,
        request(2),
        CreateIssue,
        create_issue_draft()
    );

    let forbidden =
        block_on(gate.authorize::<PauseProgram>(&implementer, request(3), pause_program_draft()))
            .unwrap_err();
    assert!(matches!(
        forbidden,
        CommandError::Forbidden {
            capability: Capability::ManageProgram,
            ..
        }
    ));

    let ownership = block_on(gate.authorize::<PauseProgram>(
        &other_operator,
        request(4),
        pause_program_draft(),
    ))
    .unwrap_err();
    assert!(matches!(ownership, CommandError::Ownership { .. }));

    let unauthorized = block_on(gate.authorize::<ClaimIssue>(
        &researcher_without_session,
        request(5),
        claim_issue_draft(),
    ))
    .unwrap_err();
    assert!(matches!(unauthorized, CommandError::Unauthorized { .. }));

    let forbidden = block_on(gate.authorize::<CreateProgram>(
        &researcher_actor("researcher-1", "session-1"),
        request(6),
        create_program_draft(),
    ))
    .unwrap_err();
    assert!(matches!(
        forbidden,
        CommandError::Forbidden {
            capability: Capability::ManageProgram,
            ..
        }
    ));

    assert_eq!(plugin.storage.audits().len(), 2);
}

#[test]
fn wrong_actors_are_refused_by_ownership() {
    let plugin = InMemoryPlugin::default();
    let gate = HostGate::new(&plugin);
    let executor = CommandExecutor::new(&plugin);
    let operator = operator_actor("operator-1");
    let researcher = researcher_actor("researcher-1", "session-1");
    let other_researcher = researcher_actor("researcher-2", "session-2");
    let implementer = implementer_actor("implementer-1", "session-3");

    run_command!(
        gate,
        executor,
        &operator,
        request(1),
        CreateProgram,
        create_program_draft()
    );
    run_command!(
        gate,
        executor,
        &operator,
        request(2),
        CreateIssue,
        create_issue_draft()
    );
    run_command!(
        gate,
        executor,
        &researcher,
        request(3),
        ClaimIssue,
        claim_issue_draft()
    );
    run_command!(
        gate,
        executor,
        &researcher,
        request(4),
        ProposeExperiment,
        propose_experiment_draft()
    );

    let comment = block_on(gate.authorize::<CommentIssue>(
        &other_researcher,
        request(5),
        comment_issue_draft("Unrelated comment"),
    ))
    .unwrap_err();
    assert!(matches!(comment, CommandError::Ownership { .. }));

    let review = block_on(gate.authorize::<ReviewExperiment>(
        &other_researcher,
        request(6),
        review_experiment_draft(),
    ))
    .unwrap_err();
    assert!(matches!(review, CommandError::Ownership { .. }));

    seed_ticket(
        &plugin,
        &SessionId::new("session-2").unwrap(),
        TicketStatus::Running,
    );
    let submit =
        block_on(gate.authorize::<SubmitTicket>(&implementer, request(7), submit_ticket_draft()))
            .unwrap_err();
    assert!(matches!(submit, CommandError::Ownership { .. }));

    assert_eq!(plugin.storage.audits().len(), 4);
}

#[test]
fn wrong_aggregate_states_are_refused() {
    let plugin = InMemoryPlugin::default();
    let gate = HostGate::new(&plugin);
    let executor = CommandExecutor::new(&plugin);
    let operator = operator_actor("operator-1");
    let researcher = researcher_actor("researcher-1", "session-1");
    let other_researcher = researcher_actor("researcher-2", "session-2");

    run_command!(
        gate,
        executor,
        &operator,
        request(1),
        CreateProgram,
        create_program_draft()
    );
    run_command!(
        gate,
        executor,
        &operator,
        request(2),
        PauseProgram,
        pause_program_draft()
    );

    let duplicate =
        block_on(gate.authorize::<CreateProgram>(&operator, request(3), create_program_draft()))
            .unwrap_err();
    assert!(matches!(
        duplicate,
        CommandError::StateConflict { state, .. } if state == "exists"
    ));

    let pause =
        block_on(gate.authorize::<PauseProgram>(&operator, request(4), pause_program_draft()))
            .unwrap_err();
    assert!(matches!(
        pause,
        CommandError::StateConflict { state, .. } if state == "paused"
    ));

    run_command!(
        gate,
        executor,
        &operator,
        request(5),
        ResumeProgram,
        resume_program_draft()
    );
    run_command!(
        gate,
        executor,
        &operator,
        request(6),
        CreateIssue,
        create_issue_draft()
    );
    run_command!(
        gate,
        executor,
        &researcher,
        request(7),
        ClaimIssue,
        claim_issue_draft()
    );

    let claim =
        block_on(gate.authorize::<ClaimIssue>(&other_researcher, request(8), claim_issue_draft()))
            .unwrap_err();
    assert!(matches!(
        claim,
        CommandError::StateConflict { state, .. } if state == "assigned"
    ));

    run_command!(
        gate,
        executor,
        &researcher,
        request(9),
        ProposeExperiment,
        propose_experiment_draft()
    );
    run_command!(
        gate,
        executor,
        &researcher,
        request(10),
        CloseExperiment,
        close_experiment_draft()
    );

    let review = block_on(gate.authorize::<ReviewExperiment>(
        &researcher,
        request(11),
        review_experiment_draft(),
    ))
    .unwrap_err();
    assert!(matches!(
        review,
        CommandError::StateConflict { state, .. } if state == "cancelled"
    ));

    run_command!(
        gate,
        executor,
        &researcher,
        request(12),
        CloseIssue,
        close_issue_draft()
    );
    let comment = block_on(gate.authorize::<CommentIssue>(
        &researcher,
        request(13),
        comment_issue_draft("Too late"),
    ))
    .unwrap_err();
    assert!(matches!(
        comment,
        CommandError::StateConflict { state, .. } if state == "closed"
    ));

    seed_ticket(
        &plugin,
        &SessionId::new("session-2").unwrap(),
        TicketStatus::Succeeded,
    );
    let submit = block_on(gate.authorize::<SubmitTicket>(
        &implementer_actor("implementer-1", "session-2"),
        request(14),
        submit_ticket_draft(),
    ))
    .unwrap_err();
    assert!(matches!(
        submit,
        CommandError::StateConflict { state, .. } if state == "succeeded"
    ));

    run_command!(
        gate,
        executor,
        &operator,
        request(15),
        StopProgram,
        stop_program_draft()
    );
    let goal = block_on(gate.authorize::<SetProgramGoal>(
        &operator,
        request(16),
        set_goal_draft("Too late"),
    ))
    .unwrap_err();
    assert!(matches!(
        goal,
        CommandError::StateConflict { state, .. } if state == "stopped"
    ));
}

#[test]
fn command_draft_kinds_are_checked_by_the_gate() {
    let plugin = InMemoryPlugin::default();
    let gate = HostGate::new(&plugin);
    let operator = operator_actor("operator-1");
    let error =
        block_on(gate.authorize::<PauseProgram>(&operator, request(1), create_program_draft()))
            .unwrap_err();
    assert!(matches!(
        error,
        CommandError::InvalidDraft {
            command: CommandName::PauseProgram,
            ..
        }
    ));
}

#[test]
fn invalid_draft_fields_are_refused_before_storage() {
    let plugin = InMemoryPlugin::default();
    let gate = HostGate::new(&plugin);
    let operator = operator_actor("operator-1");

    let mut draft = match create_program_draft() {
        CommandDraft::CreateProgram(command) => command,
        _ => unreachable!(),
    };
    draft.name = " ".to_string();
    let error = block_on(gate.authorize::<CreateProgram>(
        &operator,
        request(1),
        CommandDraft::CreateProgram(draft),
    ))
    .unwrap_err();
    assert!(matches!(error, CommandError::InvalidDraft { .. }));

    let error =
        block_on(gate.authorize::<SetProgramGoal>(&operator, request(2), set_goal_draft(" ")))
            .unwrap_err();
    assert!(matches!(error, CommandError::InvalidDraft { .. }));

    let error =
        block_on(gate.authorize::<CommentIssue>(&operator, request(3), comment_issue_draft(" ")))
            .unwrap_err();
    assert!(matches!(error, CommandError::InvalidDraft { .. }));

    assert!(plugin.storage.audits().is_empty());
}

#[test]
fn command_execution_uses_the_clock_for_created_aggregates() {
    let now = Timestamp::parse("2026-11-02T11:26:39.000Z").unwrap();
    let plugin = InMemoryPlugin {
        clock: aleph_research_core::memory::InMemoryClock::default().with_now(now),
        ..InMemoryPlugin::default()
    };
    let gate = HostGate::new(&plugin);
    let executor = CommandExecutor::new(&plugin);
    let operator = operator_actor("operator-1");
    run_command!(
        gate,
        executor,
        &operator,
        request(1),
        CreateProgram,
        create_program_draft()
    );
    run_command!(
        gate,
        executor,
        &operator,
        request(2),
        CreateIssue,
        create_issue_draft()
    );
    let program = block_on(plugin.storage.load_program(&program_id())).unwrap();
    let issue = block_on(plugin.storage.load_issue(&issue_id())).unwrap();
    assert_eq!(program.value().created_at(), now);
    assert_eq!(issue.value().created_at(), now);
}
