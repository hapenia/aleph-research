/**
 * Client half of the AlephResearch plugin bundle.
 *
 * Registers:
 *   - main slot key `aleph`: the full-page read-only Research console
 *   - sidebar.panellist id `aleph`: the sidebar entry that opens it
 *
 * The console polls the Host route /api/aleph/snapshot every two seconds and
 * never writes anything back. All visible text goes through the Client locale
 * service; all colors and surfaces go through the host theme tokens with a
 * light-mode fallback.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-aleph-research',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'alephResearch';
    const PANEL_ID = 'aleph';
    const POLL_MS = 2000;

    const MISSION_COLUMNS = '96px minmax(84px, 120px) 76px minmax(120px, 1.4fr) 72px minmax(160px, 2fr)';
    const BRANCH_COLUMNS = 'minmax(150px, 1.6fr) 72px minmax(100px, 1fr) minmax(100px, 1fr) 64px';
    const BATCH_COLUMNS = 'minmax(90px, 0.8fr) minmax(220px, 2.4fr) 80px minmax(150px, 1fr)';

    const dict = {
      en: {
        nav: 'Aleph',
        'page.title': 'Aleph Research project',
        'section.project': 'Project',
        'section.machines': 'Machines',
        'field.research': 'Research repo',
        'field.missionRoot': 'Mission repo',
        'field.template': 'Template branch',
        'field.eval': 'Evaluator',
        'field.researcherCount': 'Researchers',
        'field.bestScore': 'Best score',
        'field.bestCommit': 'Best commit',
        'field.evaluations': 'Evaluations',
        'field.prepared': 'Research scaffold',
        'field.python': 'Shared Python',
        'field.visibleData': 'Provided data',
        'field.testset': 'Hidden testset',
        'field.submissionPython': 'Submission Python',
        'field.worktree': 'Worktree',
        'field.entrypoint': 'Entrypoint',
        'field.violations': 'Watchdog violations',
        'section.violations': 'Runtime violations',
        'section.evaluations': 'Evaluations',
        'field.score': 'Score',
        'field.evaluatedCommit': 'Scored commit',
        'field.reportCommit': 'Report commit',
        'field.evaluatedAt': 'Evaluated',
        'empty.evaluations': 'No evaluation yet.',
        'section.git': 'Git trees',
        'field.tip': 'Tip',
        'field.subject': 'Subject',
        'field.date': 'Date',
        'field.refs': 'Refs',
        'field.head': 'HEAD',
        'empty.worktrees': 'No worktrees.',
        'empty.git': 'No git repositories yet.',
        'empty.violations': 'No violations recorded.',
        'field.owner': 'Owner session',
        'field.resultCommit': 'Result commit',
        'field.preBatch': 'Pre-batch tip',
        'field.error': 'Error',
        'field.machine': 'Machine',
        'field.load': 'Load',
        'field.runningMission': 'Executing',
        'field.telemetry': 'Telemetry',
        'machine.idle': 'Idle',
        'machine.busy': 'Busy',
        'machine.unknown': 'Unknown',
        'empty.machines': 'No machines registered.',
        'page.subtitle': 'Read-only view of the DSH project, missions, batches and machines.',
        'action.back': 'Back to conversation',
        'state.loading': 'Loading campaign snapshot…',
        'state.empty.title': 'No campaign snapshot yet',
        'state.empty.detail': 'No project yet. Initialize one from Leader mode with aleph_init_project.',
        'state.error.title': 'Cannot read the campaign snapshot',
        'state.error.detail': 'The console keeps retrying every 2 seconds.',
        'state.stale': 'Showing the last snapshot; the latest poll failed.',
        'section.campaign': 'Project',
        'section.sota': 'State of the art',
        'section.counts': 'Mission counts',
        'section.missions': 'Missions',
        'section.branches': 'Branches',
        'section.infra': 'InfraOptimizer',
        'section.batches': 'Composer batches',
        'section.agents': 'Orchestration agents',
        'field.role': 'Role',
        'field.agentStatus': 'Agent status',
        'field.child': 'Child session',
        'field.summary': 'Summary',
        'field.updated': 'Updated',
        'role.composer': 'Composer',
        'role.infra': 'InfraOptimizer',
        'empty.agents': 'No Composer or InfraOptimizer run yet.',
        'field.parallel': 'Parallel limit',
        'field.activeAgents': 'Active agents',
        'field.cpu': 'CPU cores',
        'field.gpu': 'GPUs',
        'field.disk': 'Disk free',
        'field.memory': 'Memory',
        'field.limit': 'Concurrency',
        'field.vramTotal': 'GPU VRAM',
        'field.cache': 'Eval cache',
        'field.gpuSeconds': 'GPU seconds',
        'field.evalSeconds': 'Eval seconds',
        'field.runtime': 'Eval runtime',
        'field.priority': 'Priority',
        'field.vram': 'VRAM MB',
        'table.batch': 'Batch',
        'field.brief': 'Brief',
        'field.count': 'Missions',
        'field.id': 'Project',
        'field.status': 'Status',
        'field.exploration': 'Exploration',
        'field.paused': 'Paused',
        'field.budget': 'Budget',
        'field.spent': 'Spent',
        'field.workspace': 'Workspace',
        'field.generated': 'Generated at',
        'field.sotaBranch': 'SOTA branch',
        'field.sotaScore': 'SOTA score',
        'field.score': 'Score',
        'field.strategy': 'Strategy',
        'field.branch': 'Branch',
        'field.parent': 'Parent',
        'field.mission': 'Mission',
        'field.description': 'Description',
        'field.created': 'Created',
        'field.finished': 'Finished',
        'table.mission': 'Mission',
        'table.branch': 'Branch',
        'table.status': 'Status',
        'table.strategy': 'Strategy',
        'table.score': 'Score',
        'table.description': 'Description',
        'status.queued': 'Queued',
        'status.running': 'Running',
        'status.done': 'Done',
        'status.failed': 'Failed',
        'status.unknown': 'Unknown',
        'count.queued': 'Queued',
        'count.running': 'Running',
        'count.done': 'Done',
        'count.failed': 'Failed',
        'branch.sota': 'SOTA',
        'empty.missions': 'No missions recorded yet.',
        'empty.branches': 'No branches recorded yet.',
        'empty.batches': 'No composed batches yet.',
        'value.none': '—',
        'updated.at': 'Last updated',
      },
      zh: {
        nav: 'Aleph',
        'page.title': 'Aleph Research 项目',
        'section.project': '项目',
        'section.machines': '机器',
        'field.research': '研究仓库',
        'field.missionRoot': 'Mission 仓库',
        'field.template': 'Template 分支',
        'field.eval': '评测命令',
        'field.researcherCount': 'Researcher 数量',
        'field.bestScore': '最佳分数',
        'field.bestCommit': '最佳提交',
        'field.evaluations': '评测次数',
        'field.prepared': '研究工程',
        'field.python': '共享 Python',
        'field.visibleData': '提供的数据',
        'field.testset': '隐藏测试集',
        'field.submissionPython': '提交用 Python',
        'field.worktree': '工作目录',
        'field.entrypoint': '入口脚本',
        'field.violations': 'watchdog 违规',
        'section.violations': '运行时违规',
        'section.evaluations': '评测记录',
        'field.score': '分数',
        'field.evaluatedCommit': '被评提交',
        'field.reportCommit': '报告提交',
        'field.evaluatedAt': '评测时间',
        'empty.evaluations': '尚无评测记录。',
        'section.git': 'Git 树',
        'field.tip': '提交',
        'field.subject': '说明',
        'field.date': '日期',
        'field.refs': '引用',
        'field.head': 'HEAD',
        'empty.worktrees': '暂无工作目录。',
        'empty.git': '暂无 git 仓库。',
        'empty.violations': '暂无违规记录。',
        'field.owner': 'Owner 会话',
        'field.resultCommit': '结果提交',
        'field.preBatch': 'Pre-batch tip',
        'field.error': '错误',
        'field.machine': '机器',
        'field.load': '负载',
        'field.runningMission': '正在执行',
        'field.telemetry': '实测负载',
        'machine.idle': '空闲',
        'machine.busy': '忙碌',
        'machine.unknown': '未知',
        'empty.machines': '暂无注册机器。',
        'page.subtitle': '只读展示 DSH 项目、mission、batch 与机器状态。',
        'action.back': '返回对话',
        'state.loading': '正在加载战役快照…',
        'state.empty.title': '暂无战役快照',
        'state.empty.detail': '尚无项目；在 Leader 模式使用 aleph_init_project 创建。',
        'state.error.title': '无法读取战役快照',
        'state.error.detail': '控制台每 2 秒自动重试。',
        'state.stale': '正在显示最后一次快照；最近一次轮询失败。',
        'section.campaign': '项目',
        'section.sota': '当前最优',
        'section.counts': '任务计数',
        'section.missions': '任务',
        'section.branches': '分支',
        'section.infra': 'InfraOptimizer',
        'section.batches': 'Composer 批次',
        'section.agents': '编排 agent',
        'field.role': '角色',
        'field.agentStatus': 'Agent 状态',
        'field.child': '子会话',
        'field.summary': '摘要',
        'field.updated': '更新时间',
        'role.composer': 'Composer',
        'role.infra': 'InfraOptimizer',
        'empty.agents': '尚未运行 Composer 或 InfraOptimizer。',
        'field.parallel': '并发上限',
        'field.activeAgents': '活动 agent',
        'field.cpu': 'CPU 核数',
        'field.gpu': 'GPU',
        'field.disk': '磁盘可用',
        'field.memory': '内存',
        'field.limit': '并发限制',
        'field.vramTotal': 'GPU 显存',
        'field.cache': '评测缓存',
        'field.gpuSeconds': 'GPU 秒',
        'field.evalSeconds': '评测秒',
        'field.runtime': '评测运行时',
        'field.priority': '优先级',
        'field.vram': '显存 MB',
        'table.batch': '批次',
        'field.brief': '研究简述',
        'field.count': '任务数',
        'field.id': '项目',
        'field.status': '状态',
        'field.exploration': '探索度',
        'field.paused': '已暂停',
        'field.budget': '预算',
        'field.spent': '已花费',
        'field.workspace': '工作区',
        'field.generated': '生成时间',
        'field.sotaBranch': 'SOTA 分支',
        'field.sotaScore': 'SOTA 分数',
        'field.score': '分数',
        'field.strategy': '策略',
        'field.branch': '分支',
        'field.parent': '父分支',
        'field.mission': '任务',
        'field.description': '描述',
        'field.created': '创建时间',
        'field.finished': '完成时间',
        'table.mission': '任务',
        'table.branch': '分支',
        'table.status': '状态',
        'table.strategy': '策略',
        'table.score': '分数',
        'table.description': '描述',
        'status.queued': '排队中',
        'status.running': '运行中',
        'status.done': '已完成',
        'status.failed': '失败',
        'status.unknown': '未知',
        'count.queued': '排队',
        'count.running': '运行',
        'count.done': '完成',
        'count.failed': '失败',
        'branch.sota': 'SOTA',
        'empty.missions': '暂无任务记录。',
        'empty.branches': '暂无分支记录。',
        'empty.batches': '暂无 Composer 批次。',
        'value.none': '—',
        'updated.at': '最后更新',
      },
    };

    // Every color below is a host theme token with a light-mode fallback, so a
    // renamed or absent token only changes appearance and never breaks render.
    const TOKENS = {
      labelPrimary: 'var(--dsw-alias-label-primary, #1f2329)',
      labelSecondary: 'var(--dsw-alias-label-secondary, #4e5969)',
      labelTertiary: 'var(--dsw-alias-label-tertiary, #6b7280)',
      bgBase: 'var(--dsw-alias-bg-base, transparent)',
      bgLayer1: 'var(--dsw-alias-bg-layer-1, #ffffff)',
      bgLayer2: 'var(--dsw-alias-bg-layer-2, #f7f8fa)',
      borderL1: 'var(--dsw-alias-border-l1, #eef0f2)',
      borderL2: 'var(--dsw-alias-border-l2, #e5e6eb)',
      business: 'var(--dsw-alias-state-business-primary, #247bbf)',
      success: 'var(--dsw-alias-state-success-primary, #2ea121)',
      warn: 'var(--dsw-alias-state-warn-primary, #d97706)',
      error: 'var(--dsw-alias-state-error-primary, #d92d20)',
      brand: 'var(--dsw-alias-brand-primary, #247bbf)',
      hover: 'var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.04))',
    };

    const STATUS_COLORS = {
      queued: TOKENS.labelTertiary,
      running: TOKENS.business,
      done: TOKENS.success,
      failed: TOKENS.error,
    };
    const STATUS_KEYS = ['queued', 'running', 'done', 'failed'];
    const MISSING = 'value.none';

    const styles = {
      root: {
        boxSizing: 'border-box',
        height: '100%',
        width: '100%',
        overflow: 'auto',
        padding: 'calc(var(--dsh-frame-top-clearance, 0px) + 20px) 24px 32px',
        color: TOKENS.labelPrimary,
        background: TOKENS.bgBase,
        fontFamily: 'inherit',
        fontSize: 13,
        lineHeight: 1.5,
      },
      frame: { maxWidth: 1120, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 },
      header: {
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 16,
        flexWrap: 'wrap',
      },
      title: { margin: 0, fontSize: 20, fontWeight: 600, lineHeight: 1.3, color: TOKENS.labelPrimary },
      subtitle: { margin: '4px 0 0', fontSize: 12.5, color: TOKENS.labelTertiary },
      headerActions: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
      button: {
        appearance: 'none',
        border: `1px solid ${TOKENS.borderL2}`,
        borderRadius: 8,
        background: TOKENS.bgLayer1,
        color: TOKENS.labelPrimary,
        fontFamily: 'inherit',
        fontSize: 13,
        lineHeight: '20px',
        padding: '5px 12px',
        cursor: 'pointer',
      },
      card: {
        boxSizing: 'border-box',
        border: `1px solid ${TOKENS.borderL2}`,
        borderRadius: 12,
        background: TOKENS.bgLayer1,
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      },
      sectionTitle: {
        margin: 0,
        fontSize: 13,
        fontWeight: 600,
        color: TOKENS.labelSecondary,
        letterSpacing: '0.02em',
      },
      metricGrid: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
        gap: 12,
      },
      metric: { display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 },
      metricLabel: { fontSize: 11.5, color: TOKENS.labelTertiary },
      metricValue: {
        fontSize: 13.5,
        fontWeight: 500,
        color: TOKENS.labelPrimary,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 12.5 },
      badge: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '1px 8px',
        borderRadius: 999,
        border: `1px solid ${TOKENS.borderL2}`,
        background: TOKENS.bgLayer2,
        fontSize: 12,
        lineHeight: '18px',
        whiteSpace: 'nowrap',
      },
      dot: { width: 7, height: 7, borderRadius: '50%', flex: '0 0 auto' },
      barTrack: {
        position: 'relative',
        height: 6,
        borderRadius: 999,
        background: TOKENS.bgLayer2,
        border: `1px solid ${TOKENS.borderL1}`,
        overflow: 'hidden',
        minWidth: 90,
        marginTop: 3,
      },
      barFill: { position: 'absolute', inset: 0, width: '0%', background: TOKENS.brand, borderRadius: 999 },
      tableWrap: { overflowX: 'auto', border: `1px solid ${TOKENS.borderL2}`, borderRadius: 10 },
      tableHeadRow: {
        display: 'grid',
        gap: 0,
        background: TOKENS.bgLayer2,
        borderBottom: `1px solid ${TOKENS.borderL2}`,
      },
      tableRow: { display: 'grid', gap: 0, borderTop: `1px solid ${TOKENS.borderL1}` },
      headCell: {
        padding: '7px 12px',
        fontSize: 11.5,
        fontWeight: 600,
        color: TOKENS.labelTertiary,
        whiteSpace: 'nowrap',
      },
      cell: {
        padding: '8px 12px',
        fontSize: 12.5,
        color: TOKENS.labelSecondary,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        minWidth: 0,
      },
      cellPrimary: { color: TOKENS.labelPrimary, fontWeight: 500 },
      empty: {
        padding: '28px 16px',
        textAlign: 'center',
        color: TOKENS.labelTertiary,
        fontSize: 12.5,
      },
      stateCard: {
        border: `1px solid ${TOKENS.borderL2}`,
        borderRadius: 12,
        background: TOKENS.bgLayer1,
        padding: '40px 24px',
        textAlign: 'center',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 8,
      },
      stateTitle: { margin: 0, fontSize: 15, fontWeight: 600, color: TOKENS.labelPrimary },
      stateDetail: { margin: 0, fontSize: 12.5, color: TOKENS.labelTertiary, maxWidth: 560 },
      stateCode: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 11.5, color: TOKENS.labelTertiary },
      stale: {
        border: `1px solid ${TOKENS.warn}`,
        borderRadius: 8,
        padding: '6px 10px',
        fontSize: 12,
        color: TOKENS.labelSecondary,
        background: TOKENS.bgLayer2,
      },
      footer: {
        display: 'flex',
        justifyContent: 'space-between',
        gap: 16,
        flexWrap: 'wrap',
        color: TOKENS.labelTertiary,
        fontSize: 11.5,
        paddingTop: 4,
      },
      counts: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 10 },
      countTile: {
        border: `1px solid ${TOKENS.borderL1}`,
        borderRadius: 10,
        background: TOKENS.bgLayer2,
        padding: '8px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
      },
      countValue: { fontSize: 17, fontWeight: 600, color: TOKENS.labelPrimary },
      countLabel: { fontSize: 11.5, color: TOKENS.labelTertiary },
      sotaRow: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 },
      sotaValue: {
        fontSize: 18,
        fontWeight: 600,
        color: TOKENS.labelPrimary,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      twoCards: { display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(220px, 1fr)', gap: 16 },
    };

    /** Trim a numeric value to a compact, fixed-precision string. */
    function formatNumber(value, digits) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return null;
      return value.toFixed(digits);
    }

    /** Format a byte count compactly. */
    function formatBytes(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return null;
      const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
      let amount = Math.max(0, value);
      let index = 0;
      while (amount >= 1024 && index < units.length - 1) { amount /= 1024; index += 1; }
      return amount.toFixed(index === 0 ? 0 : 1) + ' ' + units[index];
    }

    /** Format an ISO timestamp in the browser locale, or return the raw string. */
    function formatDate(value) {
      if (typeof value !== 'string' || value === '') return null;
      const time = Date.parse(value);
      if (!Number.isFinite(time)) return value;
      try {
        return new Date(time).toLocaleString();
      } catch {
        return value;
      }
    }

    /** Format a poll timestamp as a wall-clock time. */
    function formatClock(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return null;
      try {
        return new Date(value).toLocaleTimeString();
      } catch {
        return null;
      }
    }

    /** Normalize a mission status to one of the four known states. */
    function normalizeStatus(value) {
      return typeof value === 'string' && STATUS_KEYS.indexOf(value) !== -1 ? value : 'unknown';
    }

    /** Read-only snapshot polling. Keeps the last good snapshot on failure. */
    function useSnapshot() {
      const [state, setState] = React.useState({ phase: 'loading', snapshot: null, error: null, fetchedAt: null });

      React.useEffect(() => {
        let stopped = false;
        let timer = null;

        async function poll() {
          try {
            const response = await fetch('/api/aleph/snapshot', {
              cache: 'no-store',
              headers: { accept: 'application/json' },
            });
            const body = await response.json().catch(() => null);
            if (stopped) return;
            // No project yet is an empty state with guidance, not a failure.
            if (response.status === 404 && body?.error?.code === 'aleph/no-project') {
              setState({ phase: 'empty', snapshot: null, error: { code: 'aleph/no-project', message: '' }, fetchedAt: Date.now() });
              return;
            }
            if (!response.ok) throw new Error('HTTP ' + response.status);
            if (body && typeof body === 'object' && body.ok === false) {
              const error = body.error && typeof body.error === 'object' ? body.error : {};
              setState({
                phase: 'empty',
                snapshot: null,
                error: {
                  code: typeof error.code === 'string' ? error.code : 'aleph/no-snapshot',
                  message: typeof error.message === 'string' ? error.message : '',
                },
                fetchedAt: Date.now(),
              });
              return;
            }
            setState({
              phase: 'ready',
              snapshot: body && typeof body === 'object' ? body : {},
              error: null,
              fetchedAt: Date.now(),
            });
          } catch (error) {
            if (stopped) return;
            const message = error instanceof Error ? error.message : String(error);
            setState((previous) => {
              const failure = { code: 'aleph/unreachable', message };
              if (previous.phase === 'ready') {
                return { ...previous, error: failure, fetchedAt: previous.fetchedAt };
              }
              return { phase: 'error', snapshot: null, error: failure, fetchedAt: null };
            });
          }
        }

        poll();
        timer = setInterval(poll, POLL_MS);
        return () => {
          stopped = true;
          if (timer !== null) clearInterval(timer);
        };
      }, []);

      return state;
    }

    /** A status pill with a colored dot; tolerates unknown statuses. */
    function statusPill(t, status) {
      const key = normalizeStatus(status);
      return h(
        'span',
        { style: styles.badge },
        h('span', { style: { ...styles.dot, background: STATUS_COLORS[key] } }),
        t('status.' + key),
      );
    }

    /** One label/value pair inside a metric grid. */
    function metric(label, value) {
      return h(
        'div',
        { style: styles.metric },
        h('span', { style: styles.metricLabel }, label),
        h('span', { style: styles.metricValue }, value === null || value === undefined || value === '' ? '—' : value),
      );
    }

    /** A metric whose value can be a rendered node. */
    function metricNode(label, node) {
      return h('div', { style: styles.metric }, h('span', { style: styles.metricLabel }, label), node);
    }

    /** Exploration bar plus percentage; clamps out-of-range and non-numeric values. */
    function explorationBlock(t, value) {
      const ratio = typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : null;
      const percent = ratio === null ? null : Math.round(ratio * 100) + '%';
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 1 } },
        h('span', { style: styles.metricValue }, percent === null ? t(MISSING) : percent),
        h(
          'div',
          { style: styles.barTrack, role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': ratio === null ? 0 : Math.round(ratio * 100) },
          h('div', { style: { ...styles.barFill, width: ratio === null ? '0%' : percent } }),
        ),
      );
    }

    /** Build one grid row of table cells from a column list. */
    function tableRow(columns, row, key, rowStyle) {
      return h(
        'div',
        { style: { ...styles.tableRow, ...(rowStyle || {}) }, key },
        columns.map((column, index) =>
          h(
            'div',
            {
              key: String(index),
              style: { ...styles.cell, ...(column.primary ? styles.cellPrimary : null), ...(column.mono ? styles.mono : null) },
              title: typeof column.title === 'function' ? column.title(row) : undefined,
            },
            column.render(row),
          ),
        ),
      );
    }

    /** A stacked-head table that tolerates missing fields and empty lists. */
    function table(t, columns, rows, emptyText) {
      const grid = { gridTemplateColumns: columns.map((column) => column.width).join(' ') };
      return h(
        'div',
        { style: styles.tableWrap },
        h(
          'div',
          { style: { ...styles.tableHeadRow, ...grid } },
          columns.map((column, index) => h('div', { key: String(index), style: styles.headCell }, column.label)),
        ),
        rows.length === 0
          ? h('div', { style: styles.empty }, emptyText)
          : rows.map((row, index) => tableRow(columns, row, String(index), grid)),
      );
    }

    /** The mission rows, filtered to plain objects and capped for the page. */
    function missionList(snapshot) {
      const list = Array.isArray(snapshot?.missions) ? snapshot.missions : [];
      return list.filter((mission) => mission && typeof mission === 'object').slice(0, 500);
    }

    /** Count missions by status, falling back to a local count if `counts` is absent. */
    function missionCounts(snapshot) {
      const counts = snapshot && typeof snapshot.counts === 'object' && snapshot.counts !== null ? snapshot.counts : {};
      const list = Array.isArray(snapshot?.missions) ? snapshot.missions : [];
      const result = {};
      for (const key of STATUS_KEYS) {
        const value = counts[key];
        result[key] = typeof value === 'number' && Number.isFinite(value)
          ? value
          : list.filter((mission) => mission && mission.status === key).length;
      }
      return result;
    }

    /** InfraOptimizer capacity card. */
    function infraSection(t, campaign) {
      const infra = campaign && typeof campaign.infra === 'object' && campaign.infra !== null ? campaign.infra : {};
      const gpu = Array.isArray(infra.gpuNames) && infra.gpuNames.length > 0 ? infra.gpuNames.join(', ') : '0';
      return h(
        'section',
        { style: styles.card },
        h('h2', { style: styles.sectionTitle }, t('section.infra')),
        h(
          'div',
          { style: styles.metricGrid },
          metric(t('field.cpu'), formatNumber(infra.cpuCount, 0) ?? '—'),
          metric(t('field.gpu'), gpu),
          metric(t('field.disk'), formatBytes(infra.diskFreeBytes) ?? '—'),
          metric(t('field.memory'), formatBytes(infra.memoryTotalBytes) ?? '—'),
          metric(t('field.limit'), formatNumber(campaign.max_parallel, 0) ?? '—'),
          metric(t('field.vramTotal'), infra.gpuMemoryTotalMb != null ? formatNumber(infra.gpuMemoryTotalMb, 0) + ' MB' : '—'),
          metric(t('field.cache'), campaign.cache ? `${campaign.cache.hits}/${campaign.cache.hits + campaign.cache.misses}` : '—'),
          metric(t('field.gpuSeconds'), campaign.cost_profile ? formatNumber(campaign.cost_profile.gpuSeconds, 1) : '—'),
          metric(t('field.evalSeconds'), campaign.cost_profile ? formatNumber(campaign.cost_profile.evalSeconds, 1) : '—'),
          metric(t('field.runtime'), campaign.runtime ? `${campaign.runtime.ompThreads || 'auto'} / ${Math.round(campaign.runtime.evalTimeoutMs / 1000)}s` : '—'),
        ),
      );
    }

    /** Composer and InfraOptimizer agent runs. */
    function agentSection(t, snapshot) {
      const agents = Array.isArray(snapshot?.agents) ? snapshot.agents : [];
      const roleName = (role) => t('role.' + role);
      const columns = [
        { label: t('field.role'), width: 'minmax(110px, 0.9fr)', primary: true, render: (agent) => roleName(agent.role) ?? agent.role ?? '—' },
        { label: t('field.agentStatus'), width: '96px', render: (agent) => statusPill(t, agent.status) },
        { label: t('field.child'), width: 'minmax(150px, 1.4fr)', mono: true, render: (agent) => agent.childId ?? '—' },
        { label: t('table.branch'), width: 'minmax(140px, 1.3fr)', mono: true, render: (agent) => agent.branch ?? '—' },
        { label: t('field.worktree'), width: 'minmax(180px, 1.8fr)', mono: true, render: (agent) => agent.worktree ?? '—' },
        { label: t('field.updated'), width: 'minmax(140px, 1fr)', render: (agent) => formatDate(agent.updatedAt) ?? '—' },
        { label: t('field.summary'), width: 'minmax(220px, 2.6fr)', render: (agent) => { const text = typeof agent.summary === 'string' ? agent.summary : ''; return h('span', { title: text || undefined }, text.length > 240 ? text.slice(0, 240) + '…' : text || '—'); } },
      ];
      return h(
        'section',
        { style: styles.card },
        h('h2', { style: styles.sectionTitle }, t('section.agents')),
        table(t, columns, agents.slice(-8), t('empty.agents')),
      );
    }

    /** Composer batch card. */
    function batchSection(t, snapshot, batches) {
      const columns = [
        { label: t('table.batch'), width: 'minmax(90px, 0.8fr)', mono: true, primary: true, render: (batch) => batch.id ?? '—' },
        { label: t('field.brief'), width: 'minmax(220px, 2.4fr)', render: (batch) => batch.brief ?? '—' },
        { label: t('field.count'), width: '80px', render: (batch) => formatNumber(batch.count, 0) ?? '—' },
        { label: t('field.created'), width: 'minmax(150px, 1fr)', render: (batch) => formatDate(batch.createdAt) ?? '—' },
      ];
      return h(
        'section',
        { style: styles.card },
        h('h2', { style: styles.sectionTitle }, t('section.batches')),
        table(t, columns, batches, t('empty.batches')),
      );
    }

    function missionDisplayStatus(status) {
      // A batched mission waits inside the batch; one batch entrypoint runs missions in order.
      if (status === 'proposed' || status === 'approved' || status === 'batched') return 'queued';
      if (status === 'running') return 'running';
      if (status === 'done' || status === 'failed') return status;
      return 'unknown';
    }

    function batchDisplayStatus(status) {
      if (status === 'forming') return 'queued';
      return ['running', 'done', 'failed'].includes(status) ? status : 'unknown';
    }

    /** Research and mission git trees. */
    function gitSection(t, snapshot) {
      const git = snapshot && typeof snapshot.git === 'object' && snapshot.git !== null ? snapshot.git : null;
      if (!git) return null;
      const branchColumns = [
        { label: t('table.branch'), width: 'minmax(150px, 1.6fr)', mono: true, primary: true, render: (item) => item.name ?? '—' },
        { label: t('field.tip'), width: '90px', mono: true, render: (item) => item.tip ?? '—' },
        { label: t('field.subject'), width: 'minmax(200px, 2.4fr)', render: (item) => item.subject ?? '—' },
        { label: t('field.date'), width: '110px', render: (item) => item.date ?? '—' },
      ];
      const worktreeColumns = [
        { label: t('field.worktree'), width: 'minmax(220px, 2.4fr)', mono: true, primary: true, render: (item) => item.path ?? '—' },
        { label: t('table.branch'), width: 'minmax(140px, 1.4fr)', mono: true, render: (item) => item.branch || 'detached' },
        { label: t('field.head'), width: '90px', mono: true, render: (item) => item.head ? item.head.slice(0, 8) : '—' },
      ];
      const commitColumns = [
        { label: t('field.tip'), width: '80px', mono: true, primary: true, render: (item) => item.hash ?? '—' },
        { label: t('field.refs'), width: 'minmax(120px, 1.4fr)', mono: true, render: (item) => item.refs ?? '—' },
        { label: t('field.subject'), width: 'minmax(220px, 2.6fr)', render: (item) => item.subject ?? '—' },
        { label: t('field.date'), width: '110px', render: (item) => item.date ?? '—' },
      ];
      const repoBlock = (repo) => {
        if (!repo) return null;
        return h('div', { key: repo.root, style: { display: 'grid', gap: '8px' } },
          h('div', { style: { ...styles.mono, fontSize: '12px', wordBreak: 'break-all' } }, repo.root),
          h('div', { style: styles.sectionTitle }, t('section.branches')),
          table(t, branchColumns, Array.isArray(repo.branches) ? repo.branches : [], t('empty.git')),
          h('div', { style: styles.sectionTitle }, 'Worktrees'),
          table(t, worktreeColumns, Array.isArray(repo.worktrees) ? repo.worktrees : [], t('empty.worktrees')),
          h('div', { style: styles.sectionTitle }, 'Commits'),
          table(t, commitColumns, Array.isArray(repo.commits) ? repo.commits : [], t('empty.git')),
        );
      };
      return h('div', { style: styles.card },
        h('h2', { style: styles.sectionTitle }, t('section.git')),
        repoBlock(git.research),
        repoBlock(git.missions),
      );
    }

    /** The project console page body; `snapshot` is untrusted JSON. */
    function consoleBody(t, snapshot) {
      const project = snapshot && typeof snapshot.project === 'object' && snapshot.project !== null ? snapshot.project : {};
      const counts = missionCounts(snapshot);
      const generated = formatDate(snapshot?.generated_at);
      const missions = missionList(snapshot);
      const batches = Array.isArray(snapshot?.batches) ? snapshot.batches.filter((batch) => batch && typeof batch === 'object') : [];
      const machines = Array.isArray(snapshot?.machines) ? snapshot.machines.filter((machine) => machine && typeof machine === 'object') : [];

      const projectCard = h(
        'div',
        { style: styles.card },
        h('h2', { style: styles.sectionTitle }, t('section.project')),
        h(
          'div',
          { style: styles.metricGrid },
          metric(t('field.id'), project.id ?? t(MISSING)),
          metricNode(t('field.status'), statusPill(t, project.status)),
          metric(t('field.template'), project.template_branch ?? t(MISSING)),
          metric(t('field.generated'), generated),
          metricNode(t('field.workspace'), h('span', { style: { ...styles.metricValue, ...styles.mono, whiteSpace: 'normal', wordBreak: 'break-all' } }, project.workspace ?? t(MISSING))),
          metricNode(t('field.research'), h('span', { style: { ...styles.metricValue, ...styles.mono, whiteSpace: 'normal', wordBreak: 'break-all' } }, project.research_root ?? t(MISSING))),
          metricNode(t('field.missionRoot'), h('span', { style: { ...styles.metricValue, ...styles.mono, whiteSpace: 'normal', wordBreak: 'break-all' } }, project.mission_root ?? t(MISSING))),
          metric(t('field.eval'), project.eval_command ?? t(MISSING)),
          metric(t('field.researcherCount'), formatNumber(project.researcher_count, 0) ?? '4'),
          metric(t('field.bestScore'), project.best && typeof project.best.score === 'number' ? project.best.score.toFixed(2) : t(MISSING)),
          metricNode(t('field.bestCommit'), h('span', { style: { ...styles.metricValue, ...styles.mono } }, project.best?.commit ? String(project.best.commit).slice(0, 8) : t(MISSING))),
          metric(t('field.evaluations'), String(Array.isArray(project.evaluations) ? project.evaluations.length : 0)),
          metric(t('field.paused'), project.paused ? 'yes' : 'no'),
          metric(t('field.prepared'), project.prepared ? 'yes' : 'no'),
          metric(t('field.python'), project.python_path ?? t(MISSING)),
          metric(t('field.visibleData'), project.visible_data ?? t(MISSING)),
          metric(t('field.testset'), project.testset_path ?? t(MISSING)),
          metric(t('field.submissionPython'), project.submission_python ?? t(MISSING)),
          metric(t('field.violations'), String(Array.isArray(project.violations) ? project.violations.length : 0)),
        ),
      );

      const machineColumns = [
        { label: t('field.machine'), width: 'minmax(100px, 1fr)', mono: true, primary: true, render: (machine) => machine.id ?? '—' },
        { label: t('field.status'), width: '96px', render: (machine) => h('span', { style: styles.badge }, t('machine.' + (machine.status ?? 'unknown'))) },
        { label: t('field.load'), width: 'minmax(180px, 2fr)', render: (machine) => {
          const loads = Array.isArray(machine.loads) ? machine.loads : [];
          if (loads.length === 0) return '—';
          return loads.map((entry) => `${entry.kind}:${entry.id}${entry.cpu ? ` cpu=${entry.cpu}` : ''}`).join(' · ');
        } },
        { label: t('field.telemetry'), width: 'minmax(200px, 2fr)', render: (machine) => {
          const tele = machine.telemetry;
          if (!tele) return '—';
          const parts = [`load ${tele.load1}/${tele.load5}/${tele.load15}`, `${tele.cores} cores`];
          if (tele.memAvailableGb != null) parts.push(`${tele.memAvailableGb}/${tele.memTotalGb} GB free`);
          const gpu = Array.isArray(tele.gpus) ? tele.gpus[0] : null;
          if (gpu) parts.push(`GPU ${gpu.utilization}% ${gpu.memoryUsedMb}/${gpu.memoryTotalMb} MB`);
          return parts.join(' · ');
        } },
        { label: t('table.batch'), width: 'minmax(120px, 1.4fr)', mono: true, render: (machine) => machine.batchId ?? '—' },
      ];
      const machineCard = h(
        'div',
        { style: styles.card },
        h('h2', { style: styles.sectionTitle }, t('section.machines')),
        table(t, machineColumns, machines, t('empty.machines')),
      );

      const countsCard = h(
        'div',
        { style: styles.card },
        h('h2', { style: styles.sectionTitle }, t('section.counts')),
        h(
          'div',
          { style: styles.counts },
          STATUS_KEYS.map((key) => h('div', { key },
            h('div', { style: styles.countTile },
              h('span', { style: styles.countValue }, String(counts[key] ?? 0)),
              h('span', { style: styles.countLabel }, t('count.' + key)),
            ),
          )),
        ),
      );

      const progress = snapshot && typeof snapshot.progress === 'object' && snapshot.progress !== null ? snapshot.progress : {};
      const batchColumns = [
        { label: t('table.batch'), width: 'minmax(100px, 1fr)', mono: true, primary: true, render: (batch) => batch.id ?? '—' },
        { label: t('field.status'), width: '96px', render: (batch) => statusPill(t, batchDisplayStatus(batch.status)) },
        { label: t('field.machine'), width: 'minmax(80px, 0.8fr)', mono: true, render: (batch) => batch.machine_id ?? '—' },
        { label: t('field.count'), width: '72px', render: (batch) => String(Array.isArray(batch.mission_ids) ? batch.mission_ids.length : 0) },
        { label: t('table.branch'), width: 'minmax(140px, 1.4fr)', mono: true, render: (batch) => batch.branch ?? '—' },
        { label: t('field.runningMission'), width: 'minmax(160px, 1.6fr)', mono: true, render: (batch) => {
          const entry = progress[batch.id];
          if (!entry) return '—';
          return entry.mission_id ? `${entry.mission_id} (${entry.phase})` : '—';
        } },
        { label: t('field.created'), width: 'minmax(140px, 1fr)', render: (batch) => formatDate(batch.created_at) ?? '—' },
      ];
      const batchCard = h(
        'div',
        { style: styles.card },
        h('h2', { style: styles.sectionTitle }, t('section.batches')),
        table(t, batchColumns, batches, t('empty.batches')),
      );

      const missionColumns = [
        { label: t('table.status'), width: '96px', render: (mission) => statusPill(t, missionDisplayStatus(mission.status)) },
        { label: t('table.mission'), width: 'minmax(92px, 120px)', mono: true, primary: true, render: (mission) => mission.id ?? '—' },
        { label: t('field.owner'), width: 'minmax(120px, 1.4fr)', mono: true, render: (mission) => mission.owner_session ?? '—' },
        { label: t('table.branch'), width: 'minmax(120px, 1.4fr)', mono: true, render: (mission) => mission.branch ?? '—' },
        { label: t('table.batch'), width: 'minmax(100px, 1fr)', mono: true, render: (mission) => mission.batch_id ?? '—' },
        { label: t('field.preBatch'), width: 'minmax(100px, 1fr)', mono: true, render: (mission) => mission.pre_batch_tip ? mission.pre_batch_tip.slice(0, 8) : '—' },
        { label: t('field.resultCommit'), width: 'minmax(100px, 1fr)', mono: true, render: (mission) => mission.result_commit ? mission.result_commit.slice(0, 8) : '—' },
        { label: t('field.entrypoint'), width: 'minmax(120px, 1fr)', mono: true, render: (mission) => mission.entrypoint ?? '—' },
        { label: t('field.error'), width: 'minmax(150px, 2fr)', render: (mission) => mission.error ?? '—' },
      ];
      const missionCard = h(
        'div',
        { style: styles.card },
        h('h2', { style: styles.sectionTitle }, t('section.missions')),
        table(t, missionColumns, missions, t('empty.missions')),
      );

      const evaluations = Array.isArray(project.evaluations) ? project.evaluations.filter((entry) => entry && typeof entry === 'object') : [];
      const evaluationColumns = [
        { label: t('field.evaluatedAt'), width: 'minmax(140px, 1fr)', render: (entry) => formatDate(entry.at) ?? '—' },
        { label: t('table.branch'), width: 'minmax(140px, 1.4fr)', mono: true, render: (entry) => entry.branch ?? '—' },
        { label: t('field.score'), width: '90px', primary: true, render: (entry) => (typeof entry.score === 'number' ? entry.score.toFixed(2) : t(MISSING)) },
        { label: t('field.evaluatedCommit'), width: 'minmax(90px, 1fr)', mono: true, render: (entry) => entry.evaluatedCommit ? String(entry.evaluatedCommit).slice(0, 8) : '—' },
        { label: t('field.reportCommit'), width: 'minmax(90px, 1fr)', mono: true, render: (entry) => entry.researchCommit ? String(entry.researchCommit).slice(0, 8) : '—' },
        { label: t('field.evaluations'), width: 'minmax(160px, 1.6fr)', mono: true, render: (entry) => entry.evaluationRef ?? '—' },
      ];
      const evaluationCard = h(
        'div',
        { style: styles.card },
        h('h2', { style: styles.sectionTitle }, t('section.evaluations')),
        table(t, evaluationColumns, evaluations.slice().reverse().slice(0, 12), t('empty.evaluations')),
      );

      const violations = Array.isArray(project.violations) ? project.violations : [];
      const violationCard = h(
        'div',
        { style: styles.card },
        h('h2', { style: styles.sectionTitle }, t('section.violations')),
        violations.length
          ? h('div', { style: { ...styles.mono, display: 'grid', gap: '4px', fontSize: '12px', wordBreak: 'break-all' } }, violations.slice(-10).map((line, index) => h('div', { key: index }, String(line))))
          : h('div', { style: styles.empty }, t('empty.violations')),
      );

      return h(
        'div',
        { style: styles.frame },
        projectCard,
        h('div', { style: styles.twoCards }, machineCard, countsCard),
        agentSection(t, snapshot),
        batchCard,
        missionCard,
        evaluationCard,
        gitSection(t, snapshot),
        violationCard,
        h(
          'div',
          { style: styles.footer },
          h('span', null, generated ? t('field.generated') + ': ' + generated : ''),
          h('span', null, snapshot?.schema !== undefined ? 'schema ' + String(snapshot.schema) : ''),
          h('span', null, 'missions: ' + String(missions.length) + ' · batches: ' + String(batches.length)),
        ),
      );
    }

    /** Centered state card for loading, empty, and error phases. */
    function stateCard(title, detail, code) {
      return h(
        'div',
        { style: styles.stateCard, role: 'status' },
        h('h2', { style: styles.stateTitle }, title),
        h('p', { style: styles.stateDetail }, detail),
        code ? h('p', { style: styles.stateCode }, code) : null,
      );
    }

    /** Root page: polling state machine around the console body. */
    function ConsoleView(props) {
      const t = props.t;
      const state = useSnapshot();
      const snapshot = state.snapshot;
      const project = snapshot && typeof snapshot.project === 'object' && snapshot.project !== null ? snapshot.project : null;
      const projectName = project ? project.title ?? project.id : null;

      let content;
      if (state.phase === 'loading') content = stateCard(t('state.loading'), '');
      else if (state.phase === 'empty') {
        const code = state.error?.code ?? '';
        const detail = state.error?.message ? t('state.empty.detail') + ' ' + state.error.message : t('state.empty.detail');
        content = stateCard(t('state.empty.title'), detail, code);
      } else if (state.phase === 'error') {
        content = stateCard(t('state.error.title'), t('state.error.detail') + ' ' + (state.error?.message ?? ''), state.error?.code);
      } else content = consoleBody(t, snapshot);

      return h(
        'div',
        { style: styles.root },
        h(
          'div',
          { style: styles.frame },
          h(
            'header',
            { style: styles.header },
            h(
              'div',
              { style: { minWidth: 0 } },
              h('h1', { style: styles.title }, projectName ? t('page.title') + ' · ' + projectName : t('page.title')),
              h('p', { style: styles.subtitle }, t('page.subtitle')),
            ),
            h(
              'div',
              { style: styles.headerActions },
              state.phase === 'ready' ? statusPill(t, project?.status) : null,
              h('span', { style: { fontSize: 11.5, color: TOKENS.labelTertiary } }, formatClock(state.fetchedAt) ? t('updated.at') + ': ' + formatClock(state.fetchedAt) : ''),
              h('button', { type: 'button', style: styles.button, onClick: props.onClose }, t('action.back')),
            ),
          ),
          state.phase === 'ready' && state.error ? h('div', { style: styles.stale }, t('state.stale') + ' ' + (state.error.message ?? '')) : null,
          content,
        ),
      );
    }

    /** Sidebar glyph. The shell owns the row; this also selects the panel on click. */
    function makePanelIcon(select) {
      return function PanelIcon(props) {
        const size = typeof props?.size === 'number' ? props.size : 16;
        return h(
          'svg',
          {
            viewBox: '0 0 16 16',
            width: size,
            height: size,
            fill: 'none',
            xmlns: 'http://www.w3.org/2000/svg',
            'aria-hidden': 'true',
            'data-dsh-panel-entry': PANEL_ID,
            onClick: select,
            style: { display: 'block', cursor: 'pointer' },
          },
          h('path', {
            d: 'M3 13.2 8 2.8l5 10.4',
            stroke: 'currentColor',
            strokeWidth: 1.6,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
          }),
          h('circle', { cx: 8, cy: 10.4, r: 1.1, fill: 'currentColor' }),
        );
      };
    }

    return {
      name: '@local/dsh-aleph-research',
      inject: ['slots', 'locale', 'layout'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, dict), 'aleph-research: locale dictionaries');

        const t = ctx.locale.bind(NS);
        const openPanel = () => ctx.layout?.selectPanel?.(PANEL_ID);
        const closePanel = () => ctx.layout?.selectPanel?.(null);
        const PanelIcon = makePanelIcon(openPanel);

        function PanelPage() {
          return h(ConsoleView, { t, onClose: closePanel });
        }

        return ctx.effect(() => {
          const disposeMain = ctx.slots.inject('main', () =>
            ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, PanelPage),
          );
          const disposeRow = ctx.slots.inject('sidebar.panellist', () =>
            ctx.slots.register(
              { name: 'sidebar.panellist', id: PANEL_ID, order: 20, label: () => t('nav'), locale: NS },
              PanelIcon,
            ),
          );
          return () => {
            disposeRow();
            disposeMain();
          };
        }, 'aleph-research: console panel and sidebar row');
      },
    };
  },
});
