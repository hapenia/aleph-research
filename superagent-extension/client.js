/**
 * Client half of the AlephResearch extension for the dsh-superagent bundle.
 *
 * Registers two entries in the Harness Web UI:
 *   - main slot key `aleph-research`: the research panel page itself;
 *   - sidebar.panellist id `aleph-research`: the sidebar row that opens it.
 * The layout service selects the page by that key, so the entry needs no extra
 * Host route: mounting this bundle is enough for the panel to appear.
 *
 * While the page is mounted it polls three same-origin Host routes every 10 s:
 *   GET /aleph/api/results       -> { ok, count, best, brief, recent }
 *   GET /aleph/api/state         -> { ok, openTickets, tickets }
 *   GET /orchestrator/api/state  -> { setup, load, masterId, paused, health }
 * The orchestrator route belongs to the dsh-superagent prototype and requires
 * the header `x-orchestrator-request: 1`. Each route degrades to a localized
 * warning card when it is unreachable, so a partially wired Host still shows
 * whatever it does serve.
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

    const dict = {
      en: {
        nav: 'Aleph',
        'page.title': 'AlephResearch panel',
        'page.subtitle': 'Read-only view of research results, open tickets and orchestrator load.',
        'action.refresh': 'Refresh',
        'action.reload': 'Reload research extension',
        'action.reloading': 'Reloading…',
        'action.back': 'Back to conversation',
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
        'value.none': '—',
        'value.yes': 'yes',
        'value.no': 'no',
        'empty.results': 'No evaluation recorded yet.',
        'empty.trajectory': 'No scored evaluation yet.',
        'empty.tickets': 'No open ticket.',
        'error.results': 'Cannot read the research results.',
        'error.tickets': 'Cannot read the open tickets.',
        'error.orchestrator': 'Cannot read the orchestrator state; this deployment may not mount that route.',
        'state.loading': 'Loading the research panel…',
        'reload.ok': 'The Host accepted the reload request.',
        'reload.missing': 'The Host has no reload route yet.',
        'reload.error': 'Reload failed.',
        'status.ready': 'ready',
        'status.starting': 'starting',
        'status.paused': 'paused',
        'status.error': 'error',
        'status.unknown': 'unknown',
      },
      zh: {
        nav: 'Aleph',
        'page.title': 'AlephResearch 研究面板',
        'page.subtitle': '研究结果、开放工单与编排器负载的只读视图。',
        'action.refresh': '刷新',
        'action.reload': '重新加载研究扩展',
        'action.reloading': '正在重新加载…',
        'action.back': '返回对话',
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
        'value.none': '—',
        'value.yes': '是',
        'value.no': '否',
        'empty.results': '暂无评测结果。',
        'empty.trajectory': '暂无带分数的评测记录。',
        'empty.tickets': '暂无开放工单。',
        'error.results': '无法读取研究结果。',
        'error.tickets': '无法读取开放工单。',
        'error.orchestrator': '无法读取编排器状态；当前部署可能没有挂载该路由。',
        'state.loading': '正在加载研究面板…',
        'reload.ok': 'Host 已接受重新加载请求。',
        'reload.missing': 'Host 尚未提供重新加载路由。',
        'reload.error': '重新加载失败。',
        'status.ready': '就绪',
        'status.starting': '启动中',
        'status.paused': '已暂停',
        'status.error': '错误',
        'status.unknown': '未知',
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
      reloadOk: { border: `1px solid ${TOKENS.success}`, borderRadius: 8, padding: '6px 10px', fontSize: 12, color: TOKENS.labelSecondary },
      reloadWarn: { border: `1px solid ${TOKENS.warn}`, borderRadius: 8, padding: '6px 10px', fontSize: 12, color: TOKENS.labelSecondary },
      reloadError: { border: `1px solid ${TOKENS.error}`, borderRadius: 8, padding: '6px 10px', fontSize: 12, color: TOKENS.labelSecondary },
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

    /** Fetch one JSON Host route; failures become data instead of exceptions. */
    async function readEndpoint(path, headers) {
      try {
        const response = await fetch(path, {
          cache: 'no-store',
          headers: { accept: 'application/json', ...(headers ?? {}) },
        });
        const body = await response.json().catch(() => null);
        if (!response.ok) throw new Error('HTTP ' + response.status);
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('unexpected response body');
        if (body.ok === false) {
          throw new Error(typeof body.error === 'string' && body.error !== '' ? body.error : 'the Host reported a failure');
        }
        return { ok: true, data: body, error: null };
      } catch (error) {
        return { ok: false, data: null, error: { message: error instanceof Error ? error.message : String(error) } };
      }
    }

    /**
     * Poll the three routes while the panel is mounted.
     * Returns the last snapshot plus a stable manual-refresh function.
     */
    function usePanelData() {
      const [state, setState] = React.useState({
        phase: 'loading',
        results: null,
        tickets: null,
        orchestrator: null,
        fetchedAt: null,
      });
      const pollRef = React.useRef(null);

      React.useEffect(() => {
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
      }, []);

      const refresh = React.useCallback(() => {
        const poll = pollRef.current;
        if (poll) void poll();
      }, []);

      return { ...state, refresh };
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

    /** The panel page body: loading state, then the three read-only sections. */
    function panelBody(t, panel) {
      if (panel.phase === 'loading') {
        return h('div', { style: styles.stateCard, role: 'status' }, t('state.loading'));
      }
      return h(
        React.Fragment,
        null,
        resultsCard(t, panel.results),
        ticketsCard(t, panel.tickets),
        orchestratorCard(t, panel.orchestrator),
      );
    }

    /** Full panel page: header actions, reload feedback, and the polling sections. */
    function PanelView(props) {
      const t = props.t;
      const panel = usePanelData();
      const [reload, reloadNow] = useReloader(panel.refresh);

      const updated = formatClock(panel.fetchedAt);
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
              h('button', { type: 'button', style: styles.button, onClick: () => panel.refresh() }, t('action.refresh')),
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
          reloadText ? h('div', { style: reloadStyle, role: 'status' }, reloadText) : null,
          panelBody(t, panel),
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
