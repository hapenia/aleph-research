/**
 * Client half of the AlephResearch extension for the dsh-superagent bundle.
 *
 * Registers two entries in the Harness Web UI:
 *   - main slot key `aleph-research`: the research panel page itself;
 *   - sidebar.panellist id `aleph-research`: the sidebar row that opens it.
 * The layout service selects the page by that key, so the entry needs no extra
 * Host route: mounting this bundle is enough for the panel to appear.
 *
 * While the page is mounted it polls same-origin Host routes every 10 s. The
 * "Research runtime" tab polls the compiled research runtime:
 *   GET /aleph/api/research/health    -> { ok, version, persistent }
 *   GET /aleph/api/research/programs  -> { ok, count, programs }
 * and fetches one Program snapshot on demand:
 *   GET /aleph/api/research/programs/:id -> { ok, value: ProgramSnapshot, audit }
 * The older "Legacy loop" tab keeps the prototype routes:
 *   GET /aleph/api/results       -> { ok, count, best, brief, recent }
 *   GET /aleph/api/state         -> { ok, openTickets, tickets }
 *   GET /orchestrator/api/state  -> { setup, load, masterId, paused, health }
 * The orchestrator route belongs to the dsh-superagent prototype and requires
 * the header `x-orchestrator-request: 1`. Each route degrades to a localized
 * warning card when it is unreachable, so a partially wired Host still shows
 * whatever it does serve.
 *
 * A research Host whose `research-core/dist` is missing answers the health route
 * with 503 `research/build-missing`; a deployment without the research plugin
 * answers 404. Both are rendered as a "runtime not mounted/built" state instead
 * of a generic error. The research poll is skipped while the document is hidden,
 * never overlaps an earlier request, and releases its interval and visibility
 * listener when the page unmounts.
 *
 * "Reload research extension" posts to RELOAD_PATH. That Host route is not part
 * of this client deliverable; the Lead wires it later. Contract:
 *   POST /aleph/api/reload -> 200 { ok: true, reloaded: true, at?: string }
 * Any other status, or `{ ok: false, error }`, is shown in the panel. A 404 is
 * reported as "the Host has no reload route yet" and leaves polling untouched.
 * The Host side should re-read the Source configuration and re-register the
 * `aleph` Source kind (or restart the extension) without restarting the process.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-aleph-superagent',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'alephSuperagent';
    const PANEL_ID = 'aleph-research';
    const POLL_MS = 10000;
    const RELOAD_PATH = '/aleph/api/reload';
    const RESULTS_PATH = '/aleph/api/results';
    const STATE_PATH = '/aleph/api/state';
    const ORCHESTRATOR_PATH = '/orchestrator/api/state';
    const RESEARCH_HEALTH_PATH = '/aleph/api/research/health';
    const RESEARCH_PROGRAMS_PATH = '/aleph/api/research/programs';
    const RESEARCH_BUILD_MISSING = 'research/build-missing';

    const dict = {
      en: {
        nav: 'Aleph',
        'page.title': 'AlephResearch panel',
        'page.subtitle': 'Read-only view of research programs, runtime health, results and open tickets.',
        'action.refresh': 'Refresh',
        'action.reload': 'Reload research extension',
        'action.reloading': 'Reloading…',
        'action.back': 'Back to conversation',
        'tab.research': 'Research runtime',
        'tab.legacy': 'Legacy loop',
        'section.research': 'Research runtime',
        'section.health': 'Runtime health',
        'section.programs': 'Research programs',
        'section.audit': 'Recent audit',
        'section.attention': 'Attention',
        'section.results': 'Results',
        'section.trajectory': 'Recent evaluations',
        'section.tickets': 'Open tickets',
        'section.orchestrator': 'Orchestrator',
        'field.bestScore': 'Best score',
        'field.bestCommit': 'Best commit',
        'field.bestTicket': 'Best ticket',
        'field.bestAt': 'Best at',
        'field.evaluations': 'Evaluations',
        'field.openTickets': 'Open tickets',
        'field.title': 'Title',
        'field.ticketId': 'Ticket',
        'field.directory': 'Directory',
        'field.at': 'Time',
        'field.score': 'Score',
        'field.commit': 'Commit',
        'field.running': 'Running',
        'field.queued': 'Queued',
        'field.maxWorkers': 'Worker limit',
        'field.masterId': 'Main Session',
        'field.paused': 'Paused',
        'field.health': 'Health',
        'field.updated': 'Updated',
        'field.programs': 'Programs',
        'field.persistent': 'Persistent',
        'field.version': 'Version',
        'field.status': 'Status',
        'field.exploration': 'Exploration',
        'field.issues': 'Issues',
        'field.experiments': 'Experiments',
        'field.ciRecords': 'CI records',
        'field.attention': 'Attention',
        'field.createdAt': 'Created',
        'field.action': 'Action',
        'field.actor': 'Actor',
        'field.subject': 'Subject',
        'field.severity': 'Severity',
        'field.reason': 'Reason',
        'value.none': '—',
        'value.yes': 'yes',
        'value.no': 'no',
        'health.reachable': 'reachable',
        'empty.programs': 'No research program yet.',
        'empty.audit': 'No audit entry for this program.',
        'empty.attention': 'No attention entry for this program.',
        'empty.results': 'No evaluation recorded yet.',
        'empty.trajectory': 'No scored evaluation yet.',
        'empty.tickets': 'No open ticket.',
        'error.results': 'Cannot read the research results.',
        'error.tickets': 'Cannot read the open tickets.',
        'error.orchestrator': 'Cannot read the orchestrator state; this deployment may not mount that route.',
        'error.health': 'Cannot read the research runtime health.',
        'error.programs': 'Cannot read the research programs.',
        'error.program': 'Cannot read this research program.',
        'error.programBody': 'The research runtime returned an unexpected program snapshot.',
        'runtime.buildMissing': 'Research runtime not built',
        'runtime.buildMissingHint': 'The Host is mounted but research-core has no compiled dist. Run "npm run build" in research-core, then reload the Host.',
        'runtime.notMounted': 'Research runtime not mounted',
        'runtime.notMountedHint': 'This deployment does not serve /aleph/api/research. Mount the aleph-research-host plugin to see programs here.',
        'state.loading': 'Loading the research panel…',
        'state.researchLoading': 'Loading the research runtime…',
        'state.detailLoading': 'Loading program details…',
        'reload.ok': 'The Host accepted the reload request.',
        'reload.missing': 'The Host has no reload route yet.',
        'reload.error': 'Reload failed.',
        'status.ready': 'ready',
        'status.starting': 'starting',
        'status.paused': 'paused',
        'status.running': 'running',
        'status.stopped': 'stopped',
        'status.completed': 'completed',
        'status.error': 'error',
        'status.unknown': 'unknown',
        'severity.info': 'info',
        'severity.warning': 'warning',
        'severity.blocked': 'blocked',
        'exploration.low': 'low',
        'exploration.normal': 'normal',
        'exploration.high': 'high',
      },
      zh: {
        nav: 'Aleph',
        'page.title': 'AlephResearch 研究面板',
        'page.subtitle': '研究计划、运行时健康状态、研究结果与开放工单的只读视图。',
        'action.refresh': '刷新',
        'action.reload': '重新加载研究扩展',
        'action.reloading': '正在重新加载…',
        'action.back': '返回对话',
        'tab.research': '研究运行时',
        'tab.legacy': '旧版研究循环',
        'section.research': '研究运行时',
        'section.health': '运行时健康',
        'section.programs': '研究计划',
        'section.audit': '最近审计',
        'section.attention': '待关注事项',
        'section.results': '研究结果',
        'section.trajectory': '最近评测',
        'section.tickets': '开放工单',
        'section.orchestrator': '编排器',
        'field.bestScore': '最高分',
        'field.bestCommit': '最高分提交',
        'field.bestTicket': '最高分工单',
        'field.bestAt': '最高分时间',
        'field.evaluations': '评测次数',
        'field.openTickets': '开放工单数',
        'field.title': '标题',
        'field.ticketId': '工单',
        'field.directory': '目录',
        'field.at': '时间',
        'field.score': '分数',
        'field.commit': '提交',
        'field.running': '运行中',
        'field.queued': '排队中',
        'field.maxWorkers': 'Worker 上限',
        'field.masterId': '主会话',
        'field.paused': '暂停',
        'field.health': '健康状态',
        'field.updated': '最后更新',
        'field.programs': '研究计划数',
        'field.persistent': '持久化',
        'field.version': '版本',
        'field.status': '状态',
        'field.exploration': '探索级别',
        'field.issues': '议题数',
        'field.experiments': '实验数',
        'field.ciRecords': 'CI 记录数',
        'field.attention': '待关注数',
        'field.createdAt': '创建时间',
        'field.action': '动作',
        'field.actor': '操作者',
        'field.subject': '对象',
        'field.severity': '严重级别',
        'field.reason': '原因',
        'value.none': '—',
        'value.yes': '是',
        'value.no': '否',
        'health.reachable': '可达',
        'empty.programs': '暂无研究计划。',
        'empty.audit': '该计划暂无审计记录。',
        'empty.attention': '该计划暂无待关注事项。',
        'empty.results': '暂无评测结果。',
        'empty.trajectory': '暂无带分数的评测记录。',
        'empty.tickets': '暂无开放工单。',
        'error.results': '无法读取研究结果。',
        'error.tickets': '无法读取开放工单。',
        'error.orchestrator': '无法读取编排器状态；当前部署可能没有挂载该路由。',
        'error.health': '无法读取研究运行时健康状态。',
        'error.programs': '无法读取研究计划列表。',
        'error.program': '无法读取该研究计划。',
        'error.programBody': '研究运行时返回了无法识别的计划快照。',
        'runtime.buildMissing': '研究运行时尚未构建',
        'runtime.buildMissingHint': 'Host 已挂载，但 research-core 没有编译产物。请在 research-core 运行 "npm run build"，然后重新加载 Host。',
        'runtime.notMounted': '研究运行时未挂载',
        'runtime.notMountedHint': '当前部署没有提供 /aleph/api/research。挂载 aleph-research-host 插件后即可在此查看研究计划。',
        'state.loading': '正在加载研究面板…',
        'state.researchLoading': '正在加载研究运行时…',
        'state.detailLoading': '正在加载计划详情…',
        'reload.ok': 'Host 已接受重新加载请求。',
        'reload.missing': 'Host 尚未提供重新加载路由。',
        'reload.error': '重新加载失败。',
        'status.ready': '就绪',
        'status.starting': '启动中',
        'status.paused': '已暂停',
        'status.running': '运行中',
        'status.stopped': '已停止',
        'status.completed': '已完成',
        'status.error': '错误',
        'status.unknown': '未知',
        'severity.info': '提示',
        'severity.warning': '警告',
        'severity.blocked': '阻塞',
        'exploration.low': '低',
        'exploration.normal': '常规',
        'exploration.high': '高',
      },
    };

    // Every color is a host theme token with a light-mode fallback, so a renamed
    // or absent token only changes appearance and never breaks the render.
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
    };

    const HEALTH_COLORS = {
      ready: TOKENS.success,
      starting: TOKENS.business,
      paused: TOKENS.warn,
      error: TOKENS.error,
      unknown: TOKENS.labelTertiary,
    };

    const PROGRAM_STATUS_COLORS = {
      running: TOKENS.success,
      paused: TOKENS.warn,
      stopped: TOKENS.labelTertiary,
      completed: TOKENS.business,
      unknown: TOKENS.labelTertiary,
    };

    const SEVERITY_COLORS = {
      info: TOKENS.business,
      warning: TOKENS.warn,
      blocked: TOKENS.error,
    };

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
      updated: { fontSize: 11.5, color: TOKENS.labelTertiary },
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
      buttonBusy: { opacity: 0.6, cursor: 'default' },
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
      sectionTitle: { margin: 0, fontSize: 13, fontWeight: 600, color: TOKENS.labelSecondary, letterSpacing: '0.02em' },
      subTitle: { margin: 0, fontSize: 12, fontWeight: 600, color: TOKENS.labelTertiary },
      metricGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12 },
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
      wrap: { whiteSpace: 'normal', wordBreak: 'break-all' },
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
      tableWrap: { overflowX: 'auto', border: `1px solid ${TOKENS.borderL2}`, borderRadius: 10 },
      tableHeadRow: { display: 'grid', background: TOKENS.bgLayer2, borderBottom: `1px solid ${TOKENS.borderL2}` },
      tableRow: { display: 'grid', borderTop: `1px solid ${TOKENS.borderL1}` },
      headCell: { padding: '7px 12px', fontSize: 11.5, fontWeight: 600, color: TOKENS.labelTertiary, whiteSpace: 'nowrap' },
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
      empty: { padding: '22px 16px', textAlign: 'center', color: TOKENS.labelTertiary, fontSize: 12.5 },
      warning: {
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        border: `1px solid ${TOKENS.warn}`,
        borderRadius: 8,
        background: TOKENS.bgLayer2,
        padding: '8px 10px',
        fontSize: 12,
        color: TOKENS.labelSecondary,
      },
      warningTitle: { fontWeight: 600, color: TOKENS.labelPrimary },
      warningDetail: { color: TOKENS.labelTertiary, overflowWrap: 'anywhere' },
      stateCard: {
        border: `1px solid ${TOKENS.borderL2}`,
        borderRadius: 12,
        background: TOKENS.bgLayer1,
        padding: '40px 24px',
        textAlign: 'center',
        color: TOKENS.labelTertiary,
        fontSize: 12.5,
      },
      stateTitle: { fontSize: 14, fontWeight: 600, color: TOKENS.labelPrimary, marginBottom: 6 },
      stateHint: { color: TOKENS.labelTertiary, fontSize: 12, lineHeight: 1.6, maxWidth: 680, margin: '0 auto' },
      stateError: { color: TOKENS.labelSecondary, fontSize: 11.5, marginTop: 8, overflowWrap: 'anywhere' },
      reloadOk: { border: `1px solid ${TOKENS.success}`, borderRadius: 8, padding: '6px 10px', fontSize: 12, color: TOKENS.labelSecondary },
      reloadWarn: { border: `1px solid ${TOKENS.warn}`, borderRadius: 8, padding: '6px 10px', fontSize: 12, color: TOKENS.labelSecondary },
      reloadError: { border: `1px solid ${TOKENS.error}`, borderRadius: 8, padding: '6px 10px', fontSize: 12, color: TOKENS.labelSecondary },
      tabs: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 2,
        padding: 2,
        borderRadius: 10,
        border: `1px solid ${TOKENS.borderL2}`,
        background: TOKENS.bgLayer2,
        alignSelf: 'flex-start',
      },
      tab: {
        appearance: 'none',
        border: 0,
        borderRadius: 8,
        background: 'transparent',
        color: TOKENS.labelSecondary,
        fontFamily: 'inherit',
        fontSize: 12.5,
        lineHeight: '18px',
        padding: '4px 12px',
        cursor: 'pointer',
      },
      tabActive: {
        background: TOKENS.bgLayer1,
        color: TOKENS.labelPrimary,
        fontWeight: 600,
        boxShadow: '0 1px 2px rgba(0, 0, 0, 0.08)',
      },
      programList: { display: 'flex', flexDirection: 'column', gap: 8 },
      programRow: {
        border: `1px solid ${TOKENS.borderL1}`,
        borderRadius: 10,
        background: TOKENS.bgBase,
        overflow: 'hidden',
      },
      programButton: {
        appearance: 'none',
        border: 0,
        width: '100%',
        background: 'transparent',
        color: TOKENS.labelPrimary,
        fontFamily: 'inherit',
        fontSize: 12.5,
        textAlign: 'left',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '10px 12px',
        cursor: 'pointer',
        flexWrap: 'wrap',
      },
      programName: {
        flex: '1 1 200px',
        minWidth: 0,
        fontWeight: 500,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      programMeta: { color: TOKENS.labelTertiary, whiteSpace: 'nowrap' },
      programChevron: { color: TOKENS.labelTertiary, flex: '0 0 auto' },
      programDetail: {
        borderTop: `1px solid ${TOKENS.borderL1}`,
        padding: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      },
      detailState: { padding: '18px 12px', textAlign: 'center', color: TOKENS.labelTertiary, fontSize: 12.5 },
      attentionList: { display: 'flex', flexDirection: 'column', gap: 8 },
      attentionRow: {
        border: `1px solid ${TOKENS.borderL1}`,
        borderRadius: 8,
        padding: '8px 10px',
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
        background: TOKENS.bgLayer2,
      },
      attentionHead: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      attentionReason: { fontWeight: 600, color: TOKENS.labelPrimary, fontSize: 12.5 },
      attentionDetail: { color: TOKENS.labelSecondary, fontSize: 12, overflowWrap: 'anywhere' },
      attentionMeta: { color: TOKENS.labelTertiary, fontSize: 11.5 },
      footer: { display: 'flex', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', color: TOKENS.labelTertiary, fontSize: 11.5, paddingTop: 4 },
    };

    /** Format a score without float noise; null when the value is not a finite number. */
    function formatScore(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return null;
      return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)));
    }

    /** Shorten a git commit to its usual eight characters; null when absent. */
    function shortCommit(value) {
      if (typeof value !== 'string') return null;
      const trimmed = value.trim();
      if (trimmed === '') return null;
      return trimmed.length > 8 ? trimmed.slice(0, 8) : trimmed;
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

    /** A count as a display string, or null when the field is absent. */
    function countText(value) {
      return typeof value === 'number' && Number.isFinite(value) ? String(value) : null;
    }

    /**
     * Fetch one JSON Host route; failures become data instead of exceptions.
     * A non-2xx answer keeps its status and the Host error code so the caller can
     * distinguish 404/503 "not mounted/built" from a real failure.
     */
    async function readEndpoint(path, headers) {
      try {
        const response = await fetch(path, {
          cache: 'no-store',
          headers: { accept: 'application/json', ...(headers ?? {}) },
        });
        const status = response.status;
        const body = await response.json().catch(() => null);
        const reported = body && typeof body === 'object' && body.error && typeof body.error === 'object'
          ? body.error
          : null;
        const code = reported && typeof reported.code === 'string' && reported.code !== '' ? reported.code : null;
        const reportedMessage = reported && typeof reported.message === 'string' && reported.message !== ''
          ? reported.message
          : null;
        if (!response.ok) {
          return {
            ok: false,
            status,
            data: body,
            error: { status, code, message: reportedMessage ?? 'HTTP ' + status },
          };
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('unexpected response body');
        if (body.ok === false) {
          return {
            ok: false,
            status,
            data: body,
            error: { status, code, message: reportedMessage ?? 'the Host reported a failure' },
          };
        }
        return { ok: true, status, data: body, error: null };
      } catch (error) {
        return {
          ok: false,
          status: 0,
          data: null,
          error: {
            status: 0,
            code: null,
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
    }

    /** A localizable one-line description of a failed endpoint read. */
    function describeFailure(result) {
      if (!result || result.ok) return null;
      const error = result.error && typeof result.error === 'object' ? result.error : {};
      const parts = [];
      if (typeof error.status === 'number' && error.status > 0) parts.push('HTTP ' + error.status);
      if (typeof error.code === 'string' && error.code !== '') parts.push(error.code);
      if (typeof error.message === 'string' && error.message !== '') parts.push(error.message);
      return parts.length === 0 ? null : parts.join(' · ');
    }

    /**
     * Whether the research route family is absent rather than merely failing.
     * `build-missing` wins: the Host is mounted but `research-core/dist` is absent.
     * A 404 list route only counts as unmounted when health is not reachable either,
     * because an injected Host may serve health but be unable to list programs.
     */
    function runtimeUnavailable(health, programs) {
      const failed = (result, status) => Boolean(
        result && result.ok === false && result.status === status,
      );
      const buildMissing = (result) => failed(result, 503)
        && result.error?.code === RESEARCH_BUILD_MISSING;
      if (buildMissing(health) || buildMissing(programs)) return 'build-missing';
      if (health?.ok !== true && (failed(health, 404) || failed(programs, 404))) return 'not-mounted';
      return null;
    }

    /**
     * Poll the three legacy routes while that tab is active.
     * Returns the last snapshot plus a stable manual-refresh function.
     */
    function usePanelData(active) {
      const [state, setState] = React.useState({
        phase: 'loading',
        results: null,
        tickets: null,
        orchestrator: null,
        fetchedAt: null,
      });
      const pollRef = React.useRef(null);

      React.useEffect(() => {
        if (!active) return undefined;
        let stopped = false;
        let timer = null;
        let inFlight = false;

        async function poll() {
          if (stopped || inFlight) return;
          inFlight = true;
          try {
            const [results, tickets, orchestrator] = await Promise.all([
              readEndpoint(RESULTS_PATH),
              readEndpoint(STATE_PATH),
              readEndpoint(ORCHESTRATOR_PATH, { 'x-orchestrator-request': '1' }),
            ]);
            if (stopped) return;
            setState({ phase: 'ready', results, tickets, orchestrator, fetchedAt: Date.now() });
          } catch (error) {
            // readEndpoint already absorbs failures; this only keeps a future
            // change from leaving the panel blank.
            if (stopped) return;
            setState((previous) => ({ ...previous, phase: 'ready' }));
          } finally {
            inFlight = false;
          }
        }

        pollRef.current = poll;
        void poll();
        timer = setInterval(() => { void poll(); }, POLL_MS);
        return () => {
          stopped = true;
          pollRef.current = null;
          if (timer !== null) clearInterval(timer);
        };
      }, [active]);

      const refresh = React.useCallback(() => {
        const poll = pollRef.current;
        if (poll) void poll();
      }, []);

      return { ...state, refresh };
    }

    /**
     * Poll the compiled research runtime while its tab is visible.
     *
     * The list and health routes share one interval; a detail snapshot is fetched
     * when a Program row is expanded and again on a manual refresh. Every request
     * path is guarded by an in-flight flag, so a slow Host can never build a queue,
     * and the interval plus the `visibilitychange` listener are released on cleanup.
     */
    function useResearchData(active) {
      const [state, setState] = React.useState({
        phase: 'loading',
        health: null,
        programs: null,
        fetchedAt: null,
        unavailable: null,
        expandedId: null,
        details: {},
      });
      const pollRef = React.useRef(null);
      const expandedRef = React.useRef(null);
      const detailInFlight = React.useRef(new Set());

      React.useEffect(() => {
        expandedRef.current = state.expandedId;
      }, [state.expandedId]);

      const loadDetail = React.useCallback(async (programId) => {
        if (typeof programId !== 'string' || programId === '' || detailInFlight.current.has(programId)) return;
        detailInFlight.current.add(programId);
        setState((previous) => ({
          ...previous,
          details: {
            ...previous.details,
            [programId]: { phase: 'loading', result: previous.details[programId]?.result ?? null },
          },
        }));
        try {
          const result = await readEndpoint(RESEARCH_PROGRAMS_PATH + '/' + encodeURIComponent(programId));
          setState((previous) => ({
            ...previous,
            details: { ...previous.details, [programId]: { phase: 'ready', result } },
          }));
        } catch (error) {
          // readEndpoint absorbs transport errors; keep a renderable state if that changes.
          setState((previous) => ({
            ...previous,
            details: {
              ...previous.details,
              [programId]: {
                phase: 'ready',
                result: {
                  ok: false,
                  status: 0,
                  data: null,
                  error: { status: 0, code: null, message: error instanceof Error ? error.message : String(error) },
                },
              },
            },
          }));
        } finally {
          detailInFlight.current.delete(programId);
        }
      }, []);

      const toggle = React.useCallback((programId) => {
        if (typeof programId !== 'string' || programId === '') return;
        setState((previous) => ({
          ...previous,
          expandedId: previous.expandedId === programId ? null : programId,
        }));
      }, []);

      React.useEffect(() => {
        const programId = state.expandedId;
        if (typeof programId === 'string' && programId !== '') void loadDetail(programId);
      }, [state.expandedId, loadDetail]);

      React.useEffect(() => {
        if (!active) return undefined;
        let stopped = false;
        let timer = null;
        let inFlight = false;
        const documentVisible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';

        async function poll() {
          if (stopped || inFlight || !documentVisible()) return;
          inFlight = true;
          try {
            const [health, programs] = await Promise.all([
              readEndpoint(RESEARCH_HEALTH_PATH),
              readEndpoint(RESEARCH_PROGRAMS_PATH),
            ]);
            if (stopped) return;
            setState((previous) => ({
              ...previous,
              phase: 'ready',
              health,
              programs,
              unavailable: runtimeUnavailable(health, programs),
              fetchedAt: Date.now(),
            }));
          } catch (error) {
            // readEndpoint absorbs failures; keep the panel rendered if that changes.
            if (stopped) return;
            setState((previous) => ({ ...previous, phase: 'ready' }));
          } finally {
            inFlight = false;
          }
        }

        pollRef.current = poll;
        void poll();
        timer = setInterval(() => { void poll(); }, POLL_MS);
        const onVisibilityChange = () => { if (documentVisible()) void poll(); };
        if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
          document.addEventListener('visibilitychange', onVisibilityChange);
        }
        return () => {
          stopped = true;
          pollRef.current = null;
          if (timer !== null) clearInterval(timer);
          if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
            document.removeEventListener('visibilitychange', onVisibilityChange);
          }
        };
      }, [active]);

      const refresh = React.useCallback(() => {
        const poll = pollRef.current;
        if (poll) void poll();
        const programId = expandedRef.current;
        if (typeof programId === 'string' && programId !== '') void loadDetail(programId);
      }, [loadDetail]);

      return { ...state, refresh, toggle };
    }

    /** Localized "reload research extension" action and its last outcome. */
    function useReloader(onReloaded) {
      const [state, setState] = React.useState({ phase: 'idle', message: null });
      const alive = React.useRef(true);

      React.useEffect(() => () => { alive.current = false; }, []);

      const reload = React.useCallback(async () => {
        setState({ phase: 'running', message: null });
        try {
          const response = await fetch(RELOAD_PATH, {
            method: 'POST',
            cache: 'no-store',
            headers: { accept: 'application/json' },
          });
          const body = await response.json().catch(() => null);
          if (!alive.current) return;
          if (response.status === 404) {
            // The Host route is wired later; say so instead of reporting a hard error.
            setState({ phase: 'missing', message: null });
            return;
          }
          if (!response.ok) throw new Error('HTTP ' + response.status);
          if (body && typeof body === 'object' && body.ok === false) {
            throw new Error(typeof body.error === 'string' && body.error !== '' ? body.error : 'reload refused');
          }
          setState({ phase: 'done', message: null });
          onReloaded();
        } catch (error) {
          if (!alive.current) return;
          setState({ phase: 'error', message: error instanceof Error ? error.message : String(error) });
        }
      }, [onReloaded]);

      return [state, reload];
    }

    /** One label/value pair inside a metric grid. */
    function metric(label, value) {
      return h(
        'div',
        { style: styles.metric },
        h('span', { style: styles.metricLabel }, label),
        h('span', { style: styles.metricValue, title: typeof value === 'string' ? value : undefined },
          value === null || value === undefined || value === '' ? '—' : value),
      );
    }

    /** A metric whose value uses the monospace face (commits, ids, directories). */
    function metricMono(label, value) {
      return h(
        'div',
        { style: styles.metric },
        h('span', { style: styles.metricLabel }, label),
        h('span', { style: { ...styles.metricValue, ...styles.mono, ...styles.wrap }, title: typeof value === 'string' ? value : undefined },
          value === null || value === undefined || value === '' ? '—' : value),
      );
    }

    /** A metric whose value is a rendered node, such as a health badge. */
    function metricNode(label, node) {
      return h('div', { style: styles.metric }, h('span', { style: styles.metricLabel }, label), node);
    }

    /** A localized warning block inside a card. */
    function warning(title, detail) {
      return h(
        'div',
        { style: styles.warning, role: 'status' },
        h('span', { style: styles.warningTitle }, title),
        detail ? h('span', { style: styles.warningDetail }, detail) : null,
      );
    }

    /**
     * The runtime's own health wins over an off optional Source: the disabled GitHub
     * Source reports `paused`, but the orchestrator is still ready. Mirrors the tested
     * `panel-state.js` helper; the client bundle uses a plain function.
     */
    function healthState(health) {
      const entries = health && typeof health === 'object' && !Array.isArray(health)
        ? Object.values(health).filter((entry) => entry && typeof entry === 'object')
        : [];
      if (entries.length === 0) return { state: 'none', errors: 0 };
      const errors = entries.filter((entry) => entry.state === 'error').length;
      const runtime = health.runtime && typeof health.runtime === 'object' ? health.runtime.state : undefined;
      let state = typeof runtime === 'string' ? runtime : 'ready';
      if (errors > 0) state = 'error';
      else if (typeof runtime !== 'string') {
        if (entries.some((entry) => entry.state === 'starting')) state = 'starting';
        else if (entries.some((entry) => entry.state === 'paused')) state = 'paused';
      }
      return { state, errors };
    }

    /** A status pill for the orchestrator health board. */
    function healthBadge(t, health) {
      const { state, errors } = healthState(health);
      if (state === 'none') return h('span', { style: styles.metricValue }, t('value.none'));
      const text = t('status.' + state) + (errors > 0 ? ' · ' + String(errors) : '');
      return h(
        'span',
        { style: styles.badge },
        h('span', { style: { ...styles.dot, background: HEALTH_COLORS[state] ?? HEALTH_COLORS.unknown } }),
        text,
      );
    }

    /** One grid row of a stacked-head table. */
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
    function table(columns, rows, emptyText) {
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

    /** A generic colored pill used by the research runtime cards. */
    function badge(text, color) {
      return h(
        'span',
        { style: styles.badge },
        h('span', { style: { ...styles.dot, background: color } }),
        text,
      );
    }

    /** A Program status pill; unknown statuses are shown verbatim. */
    function statusBadge(t, value) {
      const status = typeof value === 'string' && value !== '' ? value : 'unknown';
      const known = ['ready', 'starting', 'paused', 'running', 'stopped', 'completed', 'error', 'unknown'];
      const text = known.includes(status) ? t('status.' + status) : status;
      return badge(text, PROGRAM_STATUS_COLORS[status] ?? HEALTH_COLORS.unknown);
    }

    /** An attention severity pill. */
    function severityBadge(t, value) {
      const severity = typeof value === 'string' && value !== '' ? value : 'info';
      const known = ['info', 'warning', 'blocked'];
      const text = known.includes(severity) ? t('severity.' + severity) : severity;
      return badge(text, SEVERITY_COLORS[severity] ?? SEVERITY_COLORS.info);
    }

    /** The runtime's storage mode; absent for an older Host that does not report it. */
    function persistentBadge(t, value) {
      if (typeof value !== 'boolean') return h('span', { style: styles.metricValue }, t('value.none'));
      return badge(value ? t('value.yes') : t('value.no'), value ? TOKENS.success : TOKENS.warn);
    }

    /** Translate the three exploration levels; an unknown level is shown verbatim. */
    function explorationText(t, value) {
      if (typeof value !== 'string' || value === '') return null;
      const known = ['low', 'normal', 'high'];
      return known.includes(value) ? t('exploration.' + value) : value;
    }

    /**
     * Unwrap the runtime's `ApiResponse<ProgramSnapshot>` body. The list route and the
     * snapshot route are the only readers; a malformed body yields null, never a throw.
     */
    function snapshotOf(result) {
      if (!result || !result.ok || !result.data || typeof result.data !== 'object') return null;
      const body = result.data;
      const value = body.value && typeof body.value === 'object' ? body.value : null;
      if (value && value.program && typeof value.program === 'object') return value;
      if (body.program && typeof body.program === 'object') return body;
      return null;
    }

    /** Render an audit subject as `kind:id`, tolerating a missing id. */
    function subjectText(subject) {
      if (!subject || typeof subject !== 'object') return '—';
      const kind = typeof subject.kind === 'string' && subject.kind !== '' ? subject.kind : 'subject';
      const id = typeof subject.id === 'string' ? subject.id : '';
      return id === '' ? kind : kind + ':' + id;
    }

    /** Render an audit actor by its kind; the principal id is not needed in a list. */
    function actorText(actor) {
      if (!actor || typeof actor !== 'object') return '—';
      return typeof actor.kind === 'string' && actor.kind !== '' ? actor.kind : '—';
    }

    /** One expandable Program row plus its lazily fetched snapshot. */
    function programRow(t, program, detail, expanded, onToggle) {
      const id = typeof program.id === 'string' ? program.id : '';
      const name = typeof program.name === 'string' && program.name !== '' ? program.name : (id || '—');
      const createdAt = formatDate(program.createdAt);
      return h(
        'div',
        { key: id === '' ? 'program' : id, style: styles.programRow },
        h(
          'button',
          {
            type: 'button',
            style: styles.programButton,
            onClick: () => onToggle(id),
            'aria-expanded': expanded,
            'data-program-id': id,
          },
          h('span', { style: styles.programName, title: typeof program.id === 'string' ? program.id : undefined }, name),
          statusBadge(t, program.status),
          h('span', { style: { ...styles.programMeta, ...styles.mono } }, id || '—'),
          h('span', { style: styles.programMeta }, createdAt ?? '—'),
          h('span', { style: styles.programChevron, 'aria-hidden': 'true' }, expanded ? '▾' : '▸'),
        ),
        expanded ? h('div', { style: styles.programDetail }, programDetail(t, detail)) : null,
      );
    }

    /** One attention entry in the Program detail. */
    function attentionRow(t, entry, index) {
      const key = typeof entry.id === 'string' && entry.id !== '' ? entry.id : 'attention-' + String(index);
      const reason = typeof entry.reason === 'string' && entry.reason !== '' ? entry.reason : '—';
      const detail = typeof entry.detail === 'string' && entry.detail !== '' ? entry.detail : null;
      const meta = [formatDate(entry.at), subjectText(entry.subject), formatDate(entry.acknowledgedAt)]
        .filter((part) => typeof part === 'string' && part !== '')
        .join(' · ');
      return h(
        'div',
        { key, style: styles.attentionRow },
        h(
          'div',
          { style: styles.attentionHead },
          severityBadge(t, entry.severity),
          h('span', { style: styles.attentionReason }, reason),
        ),
        detail ? h('div', { style: styles.attentionDetail }, detail) : null,
        meta !== '' ? h('div', { style: styles.attentionMeta }, meta) : null,
      );
    }

    /** The snapshot body of one Program: metrics, recent audit and attention. */
    function programDetail(t, detail) {
      if (!detail || detail.phase === 'loading') {
        return h('div', { style: styles.detailState, role: 'status' }, t('state.detailLoading'));
      }
      if (!detail.result || !detail.result.ok) {
        return warning(t('error.program'), describeFailure(detail.result));
      }
      const snapshot = snapshotOf(detail.result);
      if (snapshot === null) return warning(t('error.program'), t('error.programBody'));

      const program = snapshot.program && typeof snapshot.program === 'object' ? snapshot.program : {};
      const issues = Array.isArray(snapshot.issues) ? snapshot.issues : [];
      const experiments = Array.isArray(snapshot.experiments) ? snapshot.experiments : [];
      const ciRecords = Array.isArray(snapshot.ciRecords) ? snapshot.ciRecords : [];
      const attention = Array.isArray(snapshot.attention)
        ? snapshot.attention.filter((entry) => entry && typeof entry === 'object')
        : [];
      const audit = Array.isArray(snapshot.audit)
        ? snapshot.audit.filter((entry) => entry && typeof entry === 'object').slice(-8).reverse()
        : [];
      const auditColumns = [
        { label: t('field.at'), width: 'minmax(140px, 1.2fr)', render: (entry) => formatDate(entry.at) ?? '—' },
        { label: t('field.action'), width: 'minmax(150px, 1.3fr)', primary: true, render: (entry) => (typeof entry.action === 'string' && entry.action !== '' ? entry.action : '—') },
        { label: t('field.actor'), width: 'minmax(90px, 0.7fr)', render: (entry) => actorText(entry.actor) },
        { label: t('field.subject'), width: 'minmax(180px, 1.6fr)', mono: true, title: (entry) => subjectText(entry.subject), render: (entry) => subjectText(entry.subject) },
      ];

      return h(
        React.Fragment,
        null,
        h(
          'div',
          { style: styles.metricGrid },
          metricNode(t('field.status'), statusBadge(t, program.status)),
          metric(t('field.exploration'), explorationText(t, program.exploration)),
          metric(t('field.issues'), countText(issues.length)),
          metric(t('field.experiments'), countText(experiments.length)),
          metric(t('field.ciRecords'), countText(ciRecords.length)),
          metric(t('field.attention'), countText(attention.length)),
        ),
        h('h3', { style: styles.subTitle }, t('section.audit')),
        table(auditColumns, audit, t('empty.audit')),
        h('h3', { style: styles.subTitle }, t('section.attention')),
        attention.length === 0
          ? h('div', { style: styles.empty }, t('empty.attention'))
          : h('div', { style: styles.attentionList }, attention.map((entry, index) => attentionRow(t, entry, index))),
      );
    }

    /** Health card: build/mount state first, then version and persistence. */
    function researchHealthCard(t, research) {
      const result = research.health;
      const data = result && result.ok ? result.data : null;
      let body;
      if (research.unavailable === 'build-missing') {
        body = h(
          'div',
          { style: styles.stateCard, role: 'status' },
          h('div', { style: styles.stateTitle }, t('runtime.buildMissing')),
          h('div', { style: styles.stateHint }, t('runtime.buildMissingHint')),
          describeFailure(result) ? h('div', { ...styles.stateError, ...styles.mono }, describeFailure(result)) : null,
        );
      } else if (research.unavailable === 'not-mounted') {
        body = h(
          'div',
          { style: styles.stateCard, role: 'status' },
          h('div', { style: styles.stateTitle }, t('runtime.notMounted')),
          h('div', { style: styles.stateHint }, t('runtime.notMountedHint')),
          describeFailure(result) ? h('div', { ...styles.stateError, ...styles.mono }, describeFailure(result)) : null,
        );
      } else if (result === null) {
        body = h('div', { style: styles.detailState, role: 'status' }, t('state.researchLoading'));
      } else if (!result.ok) {
        body = warning(t('error.health'), describeFailure(result));
      } else {
        body = h(
          'div',
          { style: styles.metricGrid },
          metricNode(t('field.health'), badge(t('health.reachable'), TOKENS.success)),
          metricNode(t('field.persistent'), persistentBadge(t, data?.persistent)),
          metricMono(t('field.version'), data && typeof data.version === 'string' ? data.version : null),
        );
      }
      return h(
        'section',
        { style: styles.card },
        h('h2', { style: styles.sectionTitle }, t('section.health')),
        body,
      );
    }

    /** Programs card: count plus one expandable row per Program. */
    function researchProgramsCard(t, research) {
      if (research.unavailable !== null) return null;
      const result = research.programs;
      if (result === null) return null;
      const data = result.ok ? result.data : null;
      const programs = data && Array.isArray(data.programs)
        ? data.programs.filter((program) => program && typeof program === 'object')
        : [];
      const count = data ? (countText(data.count) ?? String(programs.length)) : null;
      return h(
        'section',
        { style: styles.card },
        h('h2', { style: styles.sectionTitle }, t('section.programs')),
        result.ok
          ? h('div', { style: styles.metricGrid }, metric(t('field.programs'), count))
          : warning(t('error.programs'), describeFailure(result)),
        result.ok
          ? (programs.length === 0
            ? h('div', { style: styles.empty }, t('empty.programs'))
            : h(
              'div',
              { style: styles.programList },
              programs.map((program) => {
                const id = typeof program.id === 'string' ? program.id : '';
                const expanded = id !== '' && research.expandedId === id;
                return programRow(t, program, research.details[id], expanded, research.toggle);
              }),
            ))
          : null,
      );
    }

    /** The new runtime view: health (including persistence) and the Program list. */
    function researchSection(t, research) {
      return h(
        React.Fragment,
        null,
        researchHealthCard(t, research),
        researchProgramsCard(t, research),
      );
    }

    /** The pre-runtime view, kept so existing results/tickets/orchestrator users lose nothing. */
    function legacySection(t, panel) {
      return h(
        React.Fragment,
        null,
        resultsCard(t, panel.results),
        ticketsCard(t, panel.tickets),
        orchestratorCard(t, panel.orchestrator),
      );
    }

    /** Results card: best score and commit, count, then the recent score trajectory. */
    function resultsCard(t, result) {
      const data = result.ok ? result.data : null;
      const best = data && data.best && typeof data.best === 'object' ? data.best : null;
      const count = data ? countText(data.count) : null;
      const recent = data && Array.isArray(data.recent)
        ? data.recent.filter((record) => record && typeof record === 'object')
        : [];
      const scored = recent.filter((record) => typeof record.score === 'number' && Number.isFinite(record.score));
      const trajectory = scored.slice(-10).reverse();
      const columns = [
        { label: t('field.at'), width: 'minmax(150px, 1.2fr)', render: (record) => formatDate(record.at) ?? '—' },
        { label: t('field.score'), width: '80px', primary: true, render: (record) => formatScore(record.score) ?? '—' },
        { label: t('field.commit'), width: 'minmax(90px, 0.8fr)', mono: true, title: (record) => (typeof record.commit === 'string' ? record.commit : undefined), render: (record) => shortCommit(record.commit) ?? '—' },
        { label: t('field.ticketId'), width: 'minmax(110px, 1fr)', mono: true, render: (record) => (typeof record.ticketId === 'string' && record.ticketId !== '' ? record.ticketId : '—') },
      ];
      return h(
        'section',
        { style: styles.card },
        h('h2', { style: styles.sectionTitle }, t('section.results')),
        result.ok
          ? h(
            'div',
            { style: styles.metricGrid },
            metric(t('field.bestScore'), best ? formatScore(best.score) : null),
            metricMono(t('field.bestCommit'), best ? shortCommit(best.commit) : null),
            metric(t('field.evaluations'), count),
            metricMono(t('field.bestTicket'), best && typeof best.ticketId === 'string' ? best.ticketId : null),
            metric(t('field.bestAt'), best ? formatDate(best.at) : null),
          )
          : warning(t('error.results'), result.error?.message),
        result.ok ? h('h3', { style: styles.subTitle }, t('section.trajectory')) : null,
        result.ok ? table(columns, trajectory, recent.length === 0 ? t('empty.results') : t('empty.trajectory')) : null,
      );
    }

    /** Open-ticket card: count plus title and worktree directory per ticket. */
    function ticketsCard(t, result) {
      const data = result.ok ? result.data : null;
      const list = data && Array.isArray(data.tickets)
        ? data.tickets.filter((ticket) => ticket && typeof ticket === 'object')
        : [];
      const open = data ? countText(data.openTickets) : null;
      const columns = [
        { label: t('field.title'), width: 'minmax(160px, 1.8fr)', primary: true, render: (ticket) => (typeof ticket.title === 'string' && ticket.title !== '' ? ticket.title : '—') },
        { label: t('field.ticketId'), width: 'minmax(130px, 1.2fr)', mono: true, render: (ticket) => (typeof ticket.id === 'string' && ticket.id !== '' ? ticket.id : '—') },
        {
          label: t('field.directory'),
          width: 'minmax(220px, 2.4fr)',
          mono: true,
          title: (ticket) => (ticket.execution && typeof ticket.execution.directory === 'string' ? ticket.execution.directory : undefined),
          render: (ticket) => (ticket.execution && typeof ticket.execution.directory === 'string' && ticket.execution.directory !== '' ? ticket.execution.directory : '—'),
        },
      ];
      return h(
        'section',
        { style: styles.card },
        h('h2', { style: styles.sectionTitle }, t('section.tickets')),
        result.ok
          ? h('div', { style: styles.metricGrid }, metric(t('field.openTickets'), open))
          : warning(t('error.tickets'), result.error?.message),
        result.ok ? table(columns, list, t('empty.tickets')) : null,
      );
    }

    /** Orchestrator card: executor load, main Session id, paused flag and health board. */
    function orchestratorCard(t, result) {
      const data = result.ok ? result.data : null;
      const load = data && data.load && typeof data.load === 'object' ? data.load : {};
      return h(
        'section',
        { style: styles.card },
        h('h2', { style: styles.sectionTitle }, t('section.orchestrator')),
        result.ok
          ? h(
            'div',
            { style: styles.metricGrid },
            metric(t('field.running'), countText(load.running)),
            metric(t('field.queued'), countText(load.queued)),
            metric(t('field.maxWorkers'), countText(load.maxWorkers)),
            metricMono(t('field.masterId'), data && typeof data.masterId === 'string' && data.masterId !== '' ? data.masterId : null),
            metric(t('field.paused'), data && data.paused ? t('value.yes') : t('value.no')),
            metricNode(t('field.health'), healthBadge(t, data && data.health)),
          )
          : warning(t('error.orchestrator'), result.error?.message),
      );
    }

    /** One tab button; the two views share the panel header and refresh action. */
    function tabButton(t, key, active, onSelect) {
      return h(
        'button',
        {
          type: 'button',
          role: 'tab',
          'aria-selected': active,
          style: { ...styles.tab, ...(active ? styles.tabActive : null) },
          onClick: () => onSelect(key),
        },
        t(key === 'research' ? 'tab.research' : 'tab.legacy'),
      );
    }

    /** The active tab's body: the runtime view or the pre-runtime loop. */
    function panelBody(t, panel, research, tab) {
      if (tab === 'research') return researchSection(t, research);
      if (panel.phase === 'loading') {
        return h('div', { style: styles.stateCard, role: 'status' }, t('state.loading'));
      }
      return legacySection(t, panel);
    }

    /** Full panel page: header actions, reload feedback, tabs and the polling sections. */
    function PanelView(props) {
      const t = props.t;
      const [tab, setTab] = React.useState('research');
      const legacyActive = tab === 'legacy';
      const panel = usePanelData(legacyActive);
      const research = useResearchData(!legacyActive);
      const refreshActive = React.useCallback(() => {
        if (legacyActive) panel.refresh();
        else research.refresh();
      }, [legacyActive, panel.refresh, research.refresh]);
      const [reload, reloadNow] = useReloader(refreshActive);

      const updated = formatClock(legacyActive ? panel.fetchedAt : research.fetchedAt);
      const reloadRunning = reload.phase === 'running';
      let reloadText = null;
      let reloadStyle = null;
      if (reload.phase === 'done') { reloadText = t('reload.ok'); reloadStyle = styles.reloadOk; }
      else if (reload.phase === 'missing') { reloadText = t('reload.missing'); reloadStyle = styles.reloadWarn; }
      else if (reload.phase === 'error') {
        reloadText = t('reload.error') + (reload.message ? ' ' + reload.message : '');
        reloadStyle = styles.reloadError;
      }

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
              h('h1', { style: styles.title }, t('page.title')),
              h('p', { style: styles.subtitle }, t('page.subtitle')),
            ),
            h(
              'div',
              { style: styles.headerActions },
              updated ? h('span', { style: styles.updated }, t('field.updated') + ': ' + updated) : null,
              h('button', { type: 'button', style: styles.button, onClick: refreshActive }, t('action.refresh')),
              h(
                'button',
                {
                  type: 'button',
                  style: { ...styles.button, ...(reloadRunning ? styles.buttonBusy : null) },
                  disabled: reloadRunning,
                  onClick: () => { void reloadNow(); },
                },
                reloadRunning ? t('action.reloading') : t('action.reload'),
              ),
              h('button', { type: 'button', style: styles.button, onClick: props.onClose }, t('action.back')),
            ),
          ),
          h(
            'div',
            { style: styles.tabs, role: 'tablist', 'aria-label': t('page.title') },
            tabButton(t, 'research', !legacyActive, setTab),
            tabButton(t, 'legacy', legacyActive, setTab),
          ),
          reloadText ? h('div', { style: reloadStyle, role: 'status' }, reloadText) : null,
          panelBody(t, panel, research, tab),
          h(
            'div',
            { style: styles.footer },
            h('span', null, t('field.updated') + ': ' + (updated ?? t('value.none'))),
            h('span', null, 'AlephResearch · dsh-superagent'),
          ),
        ),
      );
    }

    /** Sidebar glyph. The shell owns the row; the glyph also selects the panel. */
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
          h('path', { d: 'M6 2.2h4M7 2.2v4.1L3.9 12.3A1.1 1.1 0 0 0 4.9 14h6.2a1.1 1.1 0 0 0 1-1.7L9 6.3V2.2', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' }),
          h('circle', { cx: 8, cy: 10.6, r: 1.1, fill: 'currentColor' }),
        );
      };
    }

    return {
      name: '@local/dsh-aleph-superagent',
      inject: ['slots', 'locale', 'layout'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, dict), 'aleph-research: locale dictionaries');

        const t = ctx.locale.bind(NS);
        const openPanel = () => ctx.layout?.selectPanel?.(PANEL_ID);
        const closePanel = () => ctx.layout?.selectPanel?.(null);
        const PanelIcon = makePanelIcon(openPanel);

        function PanelPage() {
          return h(PanelView, { t, onClose: closePanel });
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
        }, 'aleph-research: panel page and sidebar row');
      },
    };
  },
});
