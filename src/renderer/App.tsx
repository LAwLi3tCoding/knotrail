import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Activity, ArrowDownToLine, ArrowUp, BookOpen, Check, ChevronDown, ChevronRight, Clock3, Code2, FileCode2, Files, Folder, FolderOpen, GitBranch, GitCompareArrows, Globe2, List, LoaderCircle, Network, PanelLeftClose, PanelLeftOpen, PanelRight, Pause, Play, Plus, Search, Settings2, ShieldCheck, Sparkles, Square, SquarePen, Terminal, X } from 'lucide-react';
import type { AppCommand, AppSettings, Artifact, Bootstrap, CheckSpec, Decision, ImpactPreview, Locale, PlanNode, PlanRevision, Task, TaskEvent, TaskPreferences, TaskSnapshot } from '../shared/contracts';
import { resolveLocale, translator, type TextKey } from './i18n';

type T = ReturnType<typeof translator>;
type Page = 'task' | 'new' | 'settings' | 'capabilities' | 'scheduled';
const defaults = (): TaskPreferences => ({ panelView: 'process', detailTab: 'overview', mainView: 'chat', toolPanel: null, graphView: 'graph', draft: '' });
const uid = () => crypto.randomUUID();
const activeStatuses = new Set(['planning', 'executing', 'verifying', 'reconciling']);
const resumableStatuses = new Set(['ready', 'paused', 'blocked', 'waiting_external', 'unhealthy']);
const terminalStatuses = new Set(['cancelled', 'expired', 'completed']);
const dateText = (value: string | undefined, locale: Locale) => value ? new Intl.DateTimeFormat(resolveLocale(locale), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : '—';
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

function IconButton({ label, children, onClick, pressed, disabled, className = '' }: { label: string; children: ReactNode; onClick?: () => void; pressed?: boolean; disabled?: boolean; className?: string }) {
  return <button type="button" className={`icon-button ${className}`} title={label} aria-label={label} aria-pressed={pressed} onClick={onClick} disabled={disabled}>{children}</button>;
}
function Tabs<K extends string>({ values, current, set, t }: { values: readonly [K, TextKey][]; current: K; set: (value: K) => void; t: T }) {
  return <div className="tabs">{values.map(([value, label]) => <button type="button" key={value} aria-pressed={value === current} className="tab" onClick={() => set(value)}>{t(label)}</button>)}</div>;
}
function Status({ value, t }: { value: string; t: T }) { return <span className={`status status-${value}`}><span />{t(value as TextKey)}</span>; }
function Empty({ children }: { children: ReactNode }) { return <p className="empty">{children}</p>; }
function Output({ content, truncated, t }: { content: string; truncated?: boolean; t: T }) {
  return <>{truncated && <p className="warning compact">{t('Truncated')}</p>}<pre>{content}</pre></>;
}
function ArtifactRow({ artifact, t }: { artifact: Artifact; t: T }) {
  return <details className="artifact"><summary><FileCode2 /><span>{artifact.name}</span><small>{artifact.kind}</small></summary><Output content={artifact.content} truncated={artifact.truncated} t={t} /><small className="digest">{artifact.runId} · {artifact.digest.slice(0, 16)}</small></details>;
}

export default function App() {
  const [boot, setBoot] = useState<Bootstrap>();
  const [snapshot, setSnapshot] = useState<TaskSnapshot>();
  const [selected, setSelected] = useState<string>();
  const selectedRef = useRef(selected); selectedRef.current = selected;
  const [prefs, setPrefs] = useState<TaskPreferences>(defaults);
  const prefsRef = useRef(prefs); prefsRef.current = prefs;
  const [page, setPage] = useState<Page>('task');
  const [settingsTab, setSettingsTab] = useState<'general' | 'models' | 'permissions'>('general');
  const [navCollapsed, setNavCollapsed] = useState(() => window.innerWidth <= 900);
  const [search, setSearch] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(0);
  const [impact, setImpact] = useState<ImpactPreview>();
  const [cancelOpen, setCancelOpen] = useState(false);
  const [narrow, setNarrow] = useState(() => window.innerWidth <= 900);
  const planRef = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const sideRef = useRef<HTMLElement>(null);
  const prefTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const selectionEpoch = useRef(0);
  const locale = boot?.settings.locale ?? 'system';
  const t = translator(locale);
  const task = snapshot?.task;
  const planOpen = !!boot?.settings.planningOpen;
  const drawer = planOpen && narrow && page === 'task' && !!task;

  const acceptSnapshot = useCallback((next: TaskSnapshot) => {
    setBoot(previous => previous ? { ...previous, tasks: [...previous.tasks.filter(item => item.id !== next.task.id), next.task].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) } : previous);
    if (next.task.id !== selectedRef.current) return;
    setSnapshot(previous => previous && previous.task.id === next.task.id && previous.lastSequence > next.lastSequence ? previous : next);
  }, []);
  const refresh = useCallback(async () => {
    const initial = await window.knotrail.command<Bootstrap>({ type: 'bootstrap' });
    setBoot(initial);
    const id = selectedRef.current;
    if (id) acceptSnapshot(await window.knotrail.command<TaskSnapshot>({ type: 'task.snapshot', taskId: id }));
  }, [acceptSnapshot]);
  useEffect(() => {
    if (!window.knotrail) { setError('Desktop bridge unavailable. Start this interface through the Knotrail desktop app.'); return; }
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false; let queued = false;
    const sync = async () => {
      if (inFlight) { queued = true; return; }
      inFlight = true;
      try { if (alive) await refresh(); } catch (cause) { if (alive) setError(errorText(cause)); }
      finally { inFlight = false; if (alive && queued) { queued = false; void sync(); } }
    };
    void sync();
    const unsubscribe = window.knotrail.subscribe(() => {
      if (timer) return;
      timer = setTimeout(() => { timer = undefined; void sync(); }, 80);
    });
    return () => { alive = false; clearTimeout(timer); unsubscribe(); };
  }, [refresh]);
  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth <= 900);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  useEffect(() => { document.documentElement.lang = resolveLocale(locale); }, [locale]);
  useEffect(() => {
    mainRef.current?.toggleAttribute('inert', drawer);
    sideRef.current?.toggleAttribute('inert', drawer);
    if (drawer) planRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
  }, [drawer]);

  async function perform<R>(command: AppCommand): Promise<R | undefined> {
    setBusy(value => value + 1); setError(''); setNotice('');
    try {
      const result = await window.knotrail.command<R>(command);
      if (result && typeof result === 'object' && 'task' in result) acceptSnapshot(result as unknown as TaskSnapshot);
      return result;
    } catch (cause) { setError(errorText(cause)); return undefined; }
    finally { setBusy(value => value - 1); }
  }
  function updatePrefs(patch: Partial<TaskPreferences>) {
    const next = { ...prefsRef.current, ...patch };
    prefsRef.current = next; setPrefs(next);
    clearTimeout(prefTimer.current);
    const id = selectedRef.current;
    if (id) prefTimer.current = setTimeout(() => { void window.knotrail.command({ type: 'preferences.save', taskId: id, value: next }).catch(cause => setError(errorText(cause))); }, 160);
  }
  async function selectTask(id: string) {
    const previousId = selectedRef.current;
    clearTimeout(prefTimer.current);
    if (previousId) void window.knotrail.command({ type: 'preferences.save', taskId: previousId, value: prefsRef.current }).catch(cause => setError(errorText(cause)));
    const epoch = ++selectionEpoch.current;
    selectedRef.current = id; setSelected(id); setPage('task'); if (narrow) setNavCollapsed(true); setSnapshot(undefined); setImpact(undefined); setPrefs(defaults()); prefsRef.current = defaults();
    try {
      const [next, saved] = await Promise.all([
        window.knotrail.command<TaskSnapshot>({ type: 'task.snapshot', taskId: id }),
        window.knotrail.command<TaskPreferences>({ type: 'preferences.get', taskId: id }),
      ]);
      if (epoch !== selectionEpoch.current) return;
      acceptSnapshot(next); const value = { ...defaults(), ...saved }; setPrefs(value); prefsRef.current = value;
    } catch (cause) { if (epoch === selectionEpoch.current) setError(errorText(cause)); }
  }
  async function saveSettings(patch: Extract<AppCommand, { type: 'settings.save' }>['patch']) {
    const saved = await perform<AppSettings>({ type: 'settings.save', patch });
    if (saved) setBoot(previous => previous ? { ...previous, settings: saved } : previous);
    return saved;
  }
  async function togglePlanning(open: boolean) {
    const saved = await saveSettings({ planningOpen: open });
    if (saved && !open) toggleRef.current?.focus();
  }
  async function addProject() {
    try { const path = await window.knotrail.chooseProject(); if (path) { const result = await perform({ type: 'project.add', path }); if (result) { await refresh(); setPage('new'); } } }
    catch (cause) { setError(errorText(cause)); }
  }
  function showSettings(tab: typeof settingsTab) { setSettingsTab(tab); setPage('settings'); }
  async function previewRequirement(event?: FormEvent) {
    event?.preventDefault(); if (!task || !prefs.draft.trim()) return;
    const result = await perform<ImpactPreview>({ type: 'task.previewRevision', taskId: task.id, expectedRevision: task.revision, objective: `${task.objective}\n\n${prefs.draft.trim()}` });
    if (result) setImpact(result);
  }
  async function answer(decision: Decision, answerValue: string) {
    if (!task) return;
    await perform({ type: 'decision.answer', requestId: uid(), taskId: task.id, decisionId: decision.id, answer: answerValue, expectedRevision: task.revision });
  }
  const taskAction = (type: 'task.pause' | 'task.resume' | 'task.cancel') => task && perform({ type, taskId: task.id, expectedRevision: task.revision });
  const planKeyHandler = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); void togglePlanning(false); return; }
    if (event.key !== 'Tab' || !drawer || !planRef.current) return;
    const focusable = [...planRef.current.querySelectorAll<HTMLElement>('button:not(:disabled), select, input, textarea, summary, [tabindex="0"]')].filter(element => element.getClientRects().length > 0);
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (event.shiftKey && (document.activeElement === first || !planRef.current.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
    if (!event.shiftKey && (document.activeElement === last || !planRef.current.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
  };
  const selectedProject = boot?.projects.find(project => project.id === task?.projectId);
  const matchingTasks = boot?.tasks.filter(item => `${item.title} ${item.objective}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())) ?? [];
  const chosenNode = snapshot?.plan?.nodes.find(node => node.id === prefs.selectedNode);


  if (!boot) return <div className="startup"><Sparkles size={28} /><h1>Knotrail</h1>{error ? <><p role="alert">{t(error as TextKey) ?? error}</p><button className="button" onClick={() => window.location.reload()}>{t('Reload')}</button></> : <p>{t('Connecting to the desktop runtime…')}</p>}</div>;
  return <div className={`app ${navCollapsed ? 'nav-collapsed' : ''}`}>
    {narrow && !navCollapsed && <button className="navigation-backdrop" aria-label={t('Collapse navigation')} onClick={() => setNavCollapsed(true)} />}
    <aside className="sidebar" ref={sideRef}>
      <div className="sidebar-window-space"><IconButton label={t(navCollapsed ? 'Expand navigation' : 'Collapse navigation')} onClick={() => setNavCollapsed(value => !value)}>{navCollapsed ? <PanelLeftOpen /> : <PanelLeftClose />}</IconButton></div>
      <div className="brand"><span className="brand-mark">k</span><span className="nav-copy">Knotrail <small>{boot.version}</small></span></div>
      <nav aria-label={t('Tasks')}>
        <button className="nav-item" aria-current={page === 'new' ? 'page' : undefined} onClick={() => setPage('new')} title={t('New task')}><SquarePen /><span className="nav-copy">{t('New task')}</span></button>
        <button className="nav-item" onClick={() => { setNavCollapsed(false); setSearchOpen(value => !value); }} title={t('Search tasks')}><Search /><span className="nav-copy">{t('Search tasks')}</span></button>
        <button className="nav-item" aria-current={page === 'capabilities' ? 'page' : undefined} onClick={() => setPage('capabilities')} title={t('Capabilities')}><BookOpen /><span className="nav-copy">{t('Capabilities')}</span></button>
        <button className="nav-item" aria-current={page === 'scheduled' ? 'page' : undefined} onClick={() => setPage('scheduled')} title={t('Scheduled tasks')}><Clock3 /><span className="nav-copy">{t('Scheduled tasks')}</span></button>
      </nav>
      <div className="project-scroll nav-copy">
        {searchOpen && <input className="search-input" autoFocus aria-label={t('Search tasks')} placeholder={t('Search tasks')} value={search} onChange={event => setSearch(event.target.value)} />}
        <div className="section-label"><span>{t('Projects')}</span><IconButton label={t('Add project')} onClick={() => void addProject()}><Plus /></IconButton></div>
        {boot.projects.map(project => <details className="project" key={project.id} open><summary><ChevronRight /><Folder /><span>{project.name}</span><small>{matchingTasks.filter(item => item.projectId === project.id).length}</small></summary>
          {matchingTasks.filter(item => item.projectId === project.id).map(item => <button key={item.id} className="task-row" aria-current={selected === item.id && page === 'task' ? 'page' : undefined} onClick={() => void selectTask(item.id)} title={item.title}>
            <span className={`task-dot dot-${item.status}`} /><span><strong>{item.title}</strong><small>{t(item.status)} · {dateText(item.updatedAt, locale)}</small></span>
          </button>)}
        </details>)}
        {!!search && !matchingTasks.length && <Empty>{t('No matching tasks')}</Empty>}
        {!boot.projects.length && <button className="nav-item" onClick={() => void addProject()}><Plus /><span>{t('Add project')}</span></button>}
      </div>
      <div className="sidebar-bottom"><button className="nav-item" aria-current={page === 'settings' ? 'page' : undefined} onClick={() => showSettings('general')} title={t('Settings')}><Settings2 /><span className="nav-copy">{t('Settings')}</span></button>
        <label className="language-control nav-copy"><Globe2 /><select aria-label={t('Language')} value={locale} onChange={event => void saveSettings({ locale: event.target.value as Locale })}><option value="system">{t('System')}</option><option value="zh-CN">简体中文</option><option value="en">English</option></select></label>
      </div>
    </aside>
    <div className="workspace">
      <header className="titlebar"><div className="titlebar-heading"><h1>{page === 'task' ? task?.title ?? t('Select a task') : t(({ new: 'New task', settings: 'Settings', capabilities: 'Capabilities', scheduled: 'Scheduled tasks' } as const)[page])}</h1>
        {task && page === 'task' && <div className="subtitle"><span>{selectedProject?.name}</span><Status value={task.status} t={t} /><span>{t('Version')} {task.revision}</span></div>}</div>
        {page === 'task' && task && <div className="header-actions">
          {activeStatuses.has(task.status) && <IconButton label={t('Pause')} disabled={!!busy} onClick={() => void taskAction('task.pause')}><Pause /></IconButton>}
          {resumableStatuses.has(task.status) && <button className="button compact" disabled={!!busy} onClick={() => void taskAction('task.resume')}><Play />{t(task.status === 'ready' ? 'Start execution' : 'Resume')}</button>}
          {!terminalStatuses.has(task.status) && <IconButton label={t('Cancel task')} disabled={!!busy} onClick={() => setCancelOpen(true)}><Square /></IconButton>}
          <IconButton label={t('Export report')} onClick={() => { void window.knotrail.exportReport(task.id).then(path => { if (path) setNotice(`${t('Report exported')}: ${path}`); }).catch(cause => setError(errorText(cause))); }}><ArrowDownToLine /></IconButton>
          <button ref={toggleRef} className="button plan-toggle" aria-label={t('Planning')} aria-expanded={planOpen} aria-controls="planning-panel" aria-pressed={planOpen} onClick={() => void togglePlanning(!planOpen)}><PanelRight /><span>{t('Planning')}</span></button>
        </div>}
      </header>
      {error && <div className="banner error" role="alert"><span><strong>{t('Could not complete the action')}</strong><br />{error}</span><IconButton label={t('Close')} onClick={() => setError('')}><X /></IconButton></div>}
      {notice && <div className="banner notice" role="status"><span>{notice}</span><IconButton label={t('Close')} onClick={() => setNotice('')}><X /></IconButton></div>}
      {page === 'task' ? task && snapshot ? <div className={`workgrid ${planOpen ? 'planning-open' : ''}`}>
        <div className="center" ref={mainRef}>
          <div className="subbar"><Tabs values={[[ 'chat', 'Chat'], ['activity', 'Activity'], ['changes', 'Changes']]} current={prefs.mainView} set={mainView => updatePrefs({ mainView })} t={t} />
            <div className="tool-toggles"><IconButton label={t('Files')} pressed={prefs.toolPanel === 'files'} onClick={() => updatePrefs({ toolPanel: prefs.toolPanel === 'files' ? null : 'files' })}><Files /></IconButton><IconButton label={t('Terminal')} pressed={prefs.toolPanel === 'terminal'} onClick={() => updatePrefs({ toolPanel: prefs.toolPanel === 'terminal' ? null : 'terminal' })}><Terminal /></IconButton><IconButton label={t('Preview')} pressed={prefs.toolPanel === 'preview'} onClick={() => updatePrefs({ toolPanel: prefs.toolPanel === 'preview' ? null : 'preview' })}><Code2 /></IconButton></div>
          </div>
          <div className="main-scroll">
            {prefs.mainView === 'chat' && <Conversation snapshot={snapshot} locale={locale} t={t} busy={!!busy} onAnswer={answer} onInspect={nodeId => { updatePrefs({ panelView: 'steps', selectedNode: nodeId }); void togglePlanning(true); }} onChanges={() => updatePrefs({ mainView: 'changes' })} />}
            {prefs.mainView === 'activity' && <ActivityView snapshot={snapshot} locale={locale} t={t} onInspect={nodeId => { updatePrefs({ panelView: 'steps', selectedNode: nodeId }); void togglePlanning(true); }} />}
            {prefs.mainView === 'changes' && <div className="inspection"><div className="view-heading"><GitCompareArrows /><h2>{t('Changes')}</h2></div>{snapshot.artifacts.filter(artifact => artifact.kind === 'diff').map(artifact => <ArtifactRow key={artifact.id} artifact={artifact} t={t} />)}{!snapshot.artifacts.some(artifact => artifact.kind === 'diff') && <Empty>{t('No changes yet')}</Empty>}</div>}
          </div>
          <form className="composer" onSubmit={event => void previewRequirement(event)}>
            {chosenNode && <span className="context-chip"><Network />{chosenNode.title}</span>}
            <textarea aria-label={t('Describe a requirement change…')} maxLength={32000} placeholder={t('Describe a requirement change…')} value={prefs.draft} onChange={event => updatePrefs({ draft: event.target.value })} onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void previewRequirement(); } }} />
            <div className="composer-row"><IconButton label={t('Add selected step to draft')} disabled={!chosenNode} onClick={() => chosenNode && updatePrefs({ draft: `${prefs.draft}${prefs.draft ? '\n' : ''}${chosenNode.title}: ` })}><Plus /></IconButton>
              <button type="button" className="composer-option" onClick={() => showSettings('models')}>{boot.settings.model.modelId || t('Model settings')}<ChevronDown /></button>
              <button type="button" className="composer-option permission-chip" onClick={() => showSettings('permissions')}><ShieldCheck />{t(task.executionPolicy === 'reviewBeforeExecute' ? 'Review plan first' : 'Execute within grant')}</button>
              <button type="submit" className="send-button" aria-label={t('Preview requirement change')} title={t('Preview requirement change')} disabled={!!busy || !prefs.draft.trim()}><ArrowUp /></button>
            </div>
          </form>
          <div className="composer-footer"><span>{t('Requirement changes create an impact preview before execution.')}</span><details><summary>{t('Context')}</summary><dl><dt>{t('Turn budget')}</dt><dd>{task.turnCount} / {task.maxTurns}</dd><dt>{t('Input tokens')}</dt><dd>{snapshot.runs.reduce((sum, run) => sum + (run.usage?.input ?? 0), 0).toLocaleString(resolveLocale(locale))}</dd><dt>{t('Output tokens')}</dt><dd>{snapshot.runs.reduce((sum, run) => sum + (run.usage?.output ?? 0), 0).toLocaleString(resolveLocale(locale))}</dd><dt>{t('Thinking')}</dt><dd>{t(({ off: 'Off', low: 'Low', medium: 'Medium', high: 'High' } as const)[boot.settings.model.thinking])}</dd></dl></details></div>
          {prefs.toolPanel && <ToolsPanel snapshot={snapshot} panel={prefs.toolPanel} setPanel={toolPanel => updatePrefs({ toolPanel })} t={t} onError={setError} />}
        </div>
        {drawer && <button className="drawer-backdrop" aria-label={t('Close planning')} onClick={() => void togglePlanning(false)} tabIndex={-1} />}
        {planOpen && <aside id="planning-panel" ref={planRef} className="planning-panel" role={drawer ? 'dialog' : undefined} aria-modal={drawer || undefined} aria-label={t('Planning')} onKeyDown={planKeyHandler}>
          <div className="panel-heading"><h2><Network />{t('Planning')}</h2><IconButton label={t('Close planning')} onClick={() => void togglePlanning(false)}><X /></IconButton></div>
          <Tabs values={[[ 'process', 'Process'], ['steps', 'Steps']]} current={prefs.panelView} set={panelView => updatePrefs({ panelView })} t={t} />
          <div className="plan-scroll"><PlanningPanel snapshot={snapshot} prefs={prefs} updatePrefs={updatePrefs} t={t} locale={locale} busy={!!busy} onAnswer={answer} onRetry={async nodeId => { const result = await perform<ImpactPreview>({ type: 'task.previewRetry', taskId: task.id, nodeId, expectedRevision: task.revision }); if (result) setImpact(result); }} /></div>
        </aside>}
      </div> : selected ? <div className="welcome"><LoaderCircle className="spin" /><p>{t('Working…')}</p></div> : <div className="welcome"><span className="welcome-mark">k</span><h2>{t('Choose a project to start')}</h2><p>{t('Open a Git project, describe your goal, and inspect the plan as work progresses.')}</p><button className="button primary" onClick={() => boot.projects.length ? setPage('new') : void addProject()}><Plus />{t(boot.projects.length ? 'New task' : 'Open project')}</button></div>
        : page === 'new' ? <NewTask projects={boot.projects} selectedProjectId={task?.projectId} busy={!!busy} t={t} onAddProject={addProject} onError={setError} onCreate={async command => { const result = await perform<TaskSnapshot>(command); if (result) { await refresh(); await selectTask(result.task.id); } }} />
        : page === 'settings' ? <SettingsPage settings={boot.settings} capabilities={boot.capabilities} tab={settingsTab} setTab={setSettingsTab} t={t} busy={!!busy} save={saveSettings} onTest={async () => { const result = await perform<{ ok: true; message?: string }>({ type: 'model.check' }); if (result) setNotice(result.message || t('Available')); }} onSaved={() => setNotice(t('Settings saved'))} />
        : page === 'capabilities' ? <Capabilities t={t} />
        : <div className="utility"><p className="muted">{t('Create a finite or maintenance task to schedule checks while the app is running.')}</p><div className="schedule-list">{boot.tasks.filter(item => item.mode !== 'once').map(item => <button key={item.id} className="schedule-row" onClick={() => void selectTask(item.id)}><Clock3 /><span><strong>{item.title}</strong><small>{boot.projects.find(project => project.id === item.projectId)?.name} · {t(item.mode === 'finite' ? 'Finite' : 'Maintain')}</small><small>{t('Next check')}: {item.nextCheckAt ? dateText(item.nextCheckAt, locale) : t('No next check')}{item.expiresAt && ` · ${t('Expires at')}: ${dateText(item.expiresAt, locale)}`}</small></span><Status value={item.status} t={t} /><ChevronRight /></button>)}</div>{!boot.tasks.some(item => item.mode !== 'once') && <Empty>{t('No scheduled tasks')}</Empty>}<button className="button" onClick={() => setPage('new')}><Plus />{t('New task')}</button></div>}
    </div>
    {impact && <Modal title={t('Review impact')} t={t} onClose={() => setImpact(undefined)}><p>{impact.reason}</p><p className="muted">{t('Generating an impact preview safely pauses the task. Dismissing it leaves the task paused; use Resume to continue unchanged.')}</p><ImpactList label={t('Affected steps')} ids={impact.affected} plan={snapshot?.plan} t={t} /><ImpactList label={t('Retained steps')} ids={impact.retained} plan={snapshot?.plan} t={t} /><p className="muted">{t('The workspace will keep its current files. Historical attempts remain available.')}</p><div className="dialog-actions"><button className="button" onClick={() => setImpact(undefined)}>{t('Dismiss')}</button><button className="button primary" disabled={!!busy} onClick={async () => { const result = await perform({ type: 'task.applyImpact', requestId: uid(), preview: impact }); if (result) { setImpact(undefined); updatePrefs({ draft: '' }); } }}>{t('Apply and continue')}</button></div></Modal>}
    {cancelOpen && <Modal title={t('Cancel task')} t={t} onClose={() => setCancelOpen(false)}><p>{t('Cancel this task? Work already saved in its worktree will be kept.')}</p><div className="dialog-actions"><button className="button" onClick={() => setCancelOpen(false)}>{t('Keep task')}</button><button className="button danger" disabled={!!busy} onClick={async () => { const result = await taskAction('task.cancel'); if (result) setCancelOpen(false); }}>{t('Confirm cancellation')}</button></div></Modal>}
  </div>;
}

function ImpactList({ label, ids, plan, t }: { label: string; ids: string[]; plan?: PlanRevision; t: T }) {
  return <div className="impact-list"><h3>{label}</h3>{ids.length ? <ul>{ids.map(id => <li key={id}>{plan?.nodes.find(node => node.id === id)?.title ?? id}</li>)}</ul> : <p className="muted">{t('None')}</p>}</div>;
}
function Modal({ title, children, onClose, t }: { title: string; children: ReactNode; onClose: () => void; t: T }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const prior = document.activeElement as HTMLElement; ref.current?.showModal(); return () => prior?.focus(); }, []);
  return <dialog ref={ref} className="dialog" aria-label={title} onCancel={event => { event.preventDefault(); onClose(); }}><div className="panel-heading"><h2>{title}</h2><IconButton label={t('Close')} onClick={onClose}><X /></IconButton></div><div className="dialog-body">{children}</div></dialog>;
}

function DecisionCard({ decision, t, busy, onAnswer }: { decision: Decision; t: T; busy: boolean; onAnswer: (decision: Decision, answer: string) => Promise<void> }) {
  const [answer, setAnswer] = useState('');
  return <section className="decision-card"><div className="eyebrow"><span className="decision-dot" />{t('Answer required')}</div><p>{decision.question}</p>{decision.options.length ? <div className="decision-options">{decision.options.map(option => <button className="button" key={option} disabled={busy} onClick={() => void onAnswer(decision, option)}>{option}</button>)}</div> : <form onSubmit={event => { event.preventDefault(); if (answer.trim()) void onAnswer(decision, answer.trim()); }}><textarea aria-label={t('Your answer')} value={answer} onChange={event => setAnswer(event.target.value)} /><button className="button primary" disabled={busy || !answer.trim()}>{t('Answer')}</button></form>}</section>;
}
function conversationEvents(events: TaskEvent[]): TaskEvent[] {
  const result: TaskEvent[] = [];
  for (const event of events) {
    if (event.kind === 'assistant.delta') {
      const last = result[result.length - 1];
      if (last?.kind === 'assistant.delta' && last.runId === event.runId) { last.text += event.text; continue; }
    }
    result.push({ ...event });
  }
  return result;
}
function Conversation({ snapshot, locale, t, busy, onAnswer, onInspect, onChanges }: { snapshot: TaskSnapshot; locale: Locale; t: T; busy: boolean; onAnswer: (decision: Decision, answer: string) => Promise<void>; onInspect: (id: string) => void; onChanges: () => void }) {
  const messages = conversationEvents(snapshot.events).filter(event => event.kind === 'assistant.delta' || /summary|completed|blocked|waiting|revision|plan\.ready|run\.finished|failed|paused|cancelled/.test(event.kind));
  const diffCount = snapshot.artifacts.filter(artifact => artifact.kind === 'diff').length;
  const activeRun = snapshot.runs.find(run => run.status === 'running');
  return <div className="conversation">
    <div className="user-message">{snapshot.task.revisionHistory[0]?.objective ?? snapshot.task.objective}</div>
    {!!snapshot.actions.length && <details className="compact-activity"><summary><Terminal /><span>{t('Activity')} · {snapshot.actions.length}</span><ChevronRight /></summary><div>{snapshot.actions.slice(-8).map(action => <div className="compact-action" key={action.id}><span>{action.name}</span><Status value={action.status} t={t} />{action.nodeId && <button className="text-button" onClick={() => onInspect(action.nodeId!)}>{t('Inspect step')}</button>}{action.output && <pre>{action.output.slice(0, 600)}</pre>}</div>)}</div></details>}
    {messages.map(event => <article className={`message ${event.kind.includes('revision') ? 'revision-message' : ''}`} key={event.id}><div className="message-meta"><time>{dateText(event.createdAt, locale)}</time>{event.nodeId && <button className="text-button" onClick={() => onInspect(event.nodeId!)}>{snapshot.plan?.nodes.find(node => node.id === event.nodeId)?.title ?? event.nodeId}</button>}</div><p>{event.text}</p></article>)}
    {!messages.length && snapshot.draft?.summary && <article className="message"><p>{snapshot.draft.summary}</p></article>}
    {!messages.length && !snapshot.draft && <p className="muted">{t(snapshot.task.status)}</p>}
    {snapshot.task.error && <div className="warning">{snapshot.task.error}</div>}
    {!!diffCount && <button className="change-summary" onClick={onChanges}><GitCompareArrows /><span>{t('Changes')}</span><span className="muted">{diffCount}</span><ChevronRight /></button>}
    {snapshot.decisions.filter(decision => snapshot.task.status === 'waiting_user' && !decision.answer && decision.taskRevision === snapshot.task.revision).map(decision => <DecisionCard key={decision.id} decision={decision} t={t} busy={busy} onAnswer={onAnswer} />)}
    {activeRun && <div className="running-line" role="status"><LoaderCircle className="spin" /><span>{activeRun.nodeId ? snapshot.plan?.nodes.find(node => node.id === activeRun.nodeId)?.title ?? activeRun.nodeId : t('planning')}</span><small>{t('Attempt')} {activeRun.attempt}</small></div>}
    {snapshot.task.revisionHistory.length > 1 && <details className="history-section"><summary>{t('Task revisions')} · {snapshot.task.revisionHistory.length}</summary>{snapshot.task.revisionHistory.map(revision => <details key={revision.revision}><summary>v{revision.revision} · {dateText(revision.createdAt, locale)}</summary><p>{revision.objective}</p></details>)}</details>}
  </div>;
}
function ActivityView({ snapshot, t, locale, onInspect }: { snapshot: TaskSnapshot; t: T; locale: Locale; onInspect: (id: string) => void }) {
  return <div className="inspection"><div className="view-heading"><Activity /><h2>{t('Activity')}</h2><span className="muted">{snapshot.lastSequence}</span></div>{!snapshot.events.length && <Empty>{t('No records yet')}</Empty>}{conversationEvents(snapshot.events).map(event => <details className="event-row" key={event.id}><summary><span className="event-seq">{event.seq}</span><span className="event-copy"><strong>{event.kind}</strong><span>{event.text.slice(0, 180)}</span></span><time>{dateText(event.createdAt, locale)}</time></summary><div className="event-body"><pre>{event.text}</pre>{event.data !== undefined && <details><summary>{t('Raw event')}</summary><pre>{JSON.stringify(event.data, null, 2)}</pre></details>}<div className="event-footer"><code>{event.runId ?? event.id}</code>{event.nodeId && <button className="text-button" onClick={() => onInspect(event.nodeId!)}>{t('Inspect step')}</button>}</div></div></details>)}</div>;
}

function PlanningPanel({ snapshot, prefs, updatePrefs, t, locale, busy, onAnswer, onRetry }: { snapshot: TaskSnapshot; prefs: TaskPreferences; updatePrefs: (patch: Partial<TaskPreferences>) => void; t: T; locale: Locale; busy: boolean; onAnswer: (decision: Decision, answer: string) => Promise<void>; onRetry: (id: string) => Promise<void> }) {
  const [versionId, setVersionId] = useState<string>('current');
  useEffect(() => setVersionId('current'), [snapshot.task.id]);
  const historical = versionId !== 'current';
  const plan = historical ? snapshot.plans.find(item => item.id === versionId) : snapshot.plan;
  const source = plan ?? snapshot.draft;
  const selectedNode = source?.nodes.find(node => node.id === prefs.selectedNode) ?? source?.nodes[0];
  const nodeState = historical ? undefined : snapshot.nodes.find(node => node.nodeId === selectedNode?.id);
  const planEvents = snapshot.events.filter(event => /plan|decision|revision|impact|observation/.test(event.kind));
  const selectedRuns = snapshot.runs.filter(run => run.nodeId === selectedNode?.id && (!historical || run.planId === plan?.id));
  const runIds = new Set(selectedRuns.map(run => run.id));
  const artifacts = snapshot.artifacts.filter(artifact => artifact.nodeId === selectedNode?.id && (!historical || runIds.has(artifact.runId)));
  const checks = snapshot.checks.filter(check => check.nodeId === selectedNode?.id && (!historical || runIds.has(check.runId)));
  return <>
    <div className="plan-summary"><span>{plan ? `${historical ? t('Historical plan') : t('Current plan')} · v${plan.revision}` : t('Draft · not executable')}</span>{source && <span>{source.nodes.length} {t('Steps')}</span>}</div>
    {prefs.panelView === 'process' ? <div className="process-content">
      {source?.summary && <p className="plan-description">{source.summary}</p>}
      {!!source?.observations.length && <ol className="planning-log">{source.observations.map((observation, index) => <li key={`${index}-${observation.kind}`}><span className="eyebrow">{t(({ fact: 'Fact', constraint: 'Constraint', proposal: 'Proposal' } as const)[observation.kind])}</span><p>{observation.text}</p>{observation.source && <small>{t('Source')}: {observation.source}</small>}</li>)}</ol>}
      {planEvents.map(event => <details className="process-event" key={event.id}><summary><span>{event.text.slice(0, 120)}</span><small>{dateText(event.createdAt, locale)}</small></summary><p>{event.text}</p>{event.data !== undefined && <pre>{JSON.stringify(event.data, null, 2)}</pre>}</details>)}
      {!source && !planEvents.length && <Empty>{t('The plan will appear here as it is recorded.')}</Empty>}
      {snapshot.decisions.filter(decision => snapshot.task.status === 'waiting_user' && !decision.answer && decision.taskRevision === snapshot.task.revision).map(decision => <DecisionCard key={decision.id} decision={decision} t={t} busy={busy} onAnswer={onAnswer} />)}
      <section className="conditions"><h3>{t('Checks')}</h3>{snapshot.task.checks.map(check => <details key={check.id}><summary>{check.label}</summary><code>{JSON.stringify(check.command)}</code>{!!check.protectedPaths.length && <p>{check.protectedPaths.join(', ')}</p>}</details>)}{!snapshot.task.checks.length && <Empty>{t('No automated checks. Completion will require your acceptance.')}</Empty>}</section>
    </div> : <>
      <div className="graph-toolbar"><select aria-label={t('Plan versions')} value={versionId} onChange={event => setVersionId(event.target.value)}><option value="current">{t('Current plan')}{snapshot.plan ? ` · v${snapshot.plan.revision}` : ''}</option>{snapshot.plans.filter(item => item.id !== snapshot.plan?.id).map(item => <option key={item.id} value={item.id}>v{item.revision} · {dateText(item.createdAt, locale)}</option>)}</select><div className="row"><IconButton label={t('Graph')} pressed={prefs.graphView === 'graph'} onClick={() => updatePrefs({ graphView: 'graph' })}><Network /></IconButton><IconButton label={t('List')} pressed={prefs.graphView === 'list'} onClick={() => updatePrefs({ graphView: 'list' })}><List /></IconButton></div></div>
      {source?.nodes.length ? <div className={`node-graph ${prefs.graphView === 'list' ? 'node-list' : ''}`}>
        {prefs.graphView === 'graph' && <svg className="dependency-lines" viewBox={`0 0 34 ${source.nodes.length * 88}`} preserveAspectRatio="none" aria-hidden="true">{source.nodes.flatMap((node, index) => node.dependsOn.map(dependency => { const from = source.nodes.findIndex(item => item.id === dependency); return from >= 0 ? <path key={`${dependency}-${node.id}`} d={`M32 ${from * 88 + 38} H${8 + (index % 3) * 6} V${index * 88 + 38} H32`} /> : null; }))}</svg>}
        {source.nodes.map((node, index) => { const state = !historical && snapshot.nodes.find(item => item.nodeId === node.id); return <button key={node.id} className={`plan-node ${state ? `node-${state.status}` : ''}`} aria-pressed={selectedNode?.id === node.id} onClick={() => updatePrefs({ selectedNode: node.id })}><span className="node-index">{state && state.status === 'verified' ? <Check /> : String(index + 1).padStart(2, '0')}</span><span className="node-copy"><strong>{node.title}</strong><small>{t(({ research: 'Research', edit: 'Edit', verify: 'Verify' } as const)[node.kind])}{state ? ` · ${t(state.status)}` : ` · ${t(historical ? 'Historical plan' : 'Draft · not executable')}`}</small></span></button>; })}
      </div> : <div className="panel-padding"><Empty>{t('No steps yet')}</Empty></div>}
      {selectedNode && <section className="node-detail"><div className="detail-heading"><h3>{selectedNode.title}</h3>{nodeState && <Status value={nodeState.status} t={t} />}</div><small className="muted">{selectedNode.id}{nodeState && ` · ${t('Attempt')} ${nodeState.attempt}`}</small>
        <Tabs values={[[ 'overview', 'Overview'], ['artifacts', 'Artifacts'], ['checks', 'Checks'], ['history', 'History']]} current={prefs.detailTab} set={detailTab => updatePrefs({ detailTab })} t={t} />
        <div className="detail-content">
          {prefs.detailTab === 'overview' && <><dl><dt>{t('Goal')}</dt><dd>{selectedNode.goal}</dd><dt>{t('Inputs')}</dt><dd>{selectedNode.inputs.join('\n') || t('None')}</dd><dt>{t('Depends on')}</dt><dd>{selectedNode.dependsOn.map(id => source?.nodes.find(node => node.id === id)?.title ?? id).join('\n') || t('None')}</dd><dt>{t('Expected outputs')}</dt><dd>{selectedNode.outputs.join('\n') || t('None')}</dd><dt>{t('Checks')}</dt><dd>{selectedNode.checkIds.map(id => snapshot.task.checks.find(check => check.id === id)?.label ?? id).join('\n') || t('None')}</dd></dl>{nodeState?.reason && <p className="warning">{nodeState.reason}</p>}{!historical && plan && <button className="button retry-button" disabled={busy} onClick={() => void onRetry(selectedNode.id)}><Play />{t('Retry step')}</button>}</>}
          {prefs.detailTab === 'artifacts' && <>{artifacts.map(artifact => <ArtifactRow key={artifact.id} artifact={artifact} t={t} />)}{!artifacts.length && <Empty>{t('No artifacts yet')}</Empty>}</>}
          {prefs.detailTab === 'checks' && <>{checks.map(check => <details key={check.id} className="receipt"><summary><Status value={check.result} t={t} /><span>{snapshot.task.checks.find(item => item.id === check.conditionId)?.label ?? check.conditionId}</span></summary><Output content={check.output} t={t} /><small>{dateText(check.checkedAt, locale)}<br />{check.runId}<br />{check.inputDigest}</small></details>)}{!checks.length && <Empty>{t('No checks yet')}</Empty>}</>}
          {prefs.detailTab === 'history' && <>{selectedRuns.map(run => <details className="receipt" key={run.id}><summary><span>{t('Attempt')} {run.attempt}</span><Status value={run.status} t={t} /></summary><p>{run.summary}</p><small>{run.id}<br />{dateText(run.startedAt, locale)}<br />{run.planId}</small>{snapshot.actions.filter(action => action.runId === run.id).map(action => <details key={action.id} className="tool-receipt"><summary>{action.name} · {t(action.status)}</summary><pre>{action.output ?? t('No records yet')}</pre></details>)}</details>)}{!selectedRuns.length && <Empty>{t('No records yet')}</Empty>}</>}
        </div>
      </section>}
    </>}
  </>;
}

function ToolsPanel({ snapshot, panel, setPanel, t, onError }: { snapshot: TaskSnapshot; panel: NonNullable<TaskPreferences['toolPanel']>; setPanel: (panel: TaskPreferences['toolPanel']) => void; t: T; onError: (error: string) => void }) {
  const [files, setFiles] = useState<string[]>([]);
  const [selectedFile, setSelectedFile] = useState('');
  const [content, setContent] = useState<{ content: string; truncated: boolean }>();
  const [artifactId, setArtifactId] = useState('');
  const [loading, setLoading] = useState(false);
  const taskIdRef = useRef(snapshot.task.id); taskIdRef.current = snapshot.task.id;
  const readSequence = useRef(0);
  useEffect(() => { setFiles([]); setSelectedFile(''); setContent(undefined); setArtifactId(''); readSequence.current++; }, [snapshot.task.id]);
  async function loadFiles() {
    const id = snapshot.task.id;
    try { const result = await window.knotrail.command<{ files: string[] }>({ type: 'task.files', taskId: id }); if (taskIdRef.current === id) setFiles(result.files); }
    catch (cause) { if (taskIdRef.current === id) onError(errorText(cause)); }
  }
  useEffect(() => { if (panel === 'files') void loadFiles(); }, [snapshot.task.id, panel]);
  async function readFile(path: string) {
    const id = snapshot.task.id; const sequence = ++readSequence.current;
    setSelectedFile(path); setLoading(true); setContent(undefined);
    try { const result = await window.knotrail.command<{ content: string; truncated: boolean }>({ type: 'task.readFile', taskId: id, path }); if (taskIdRef.current === id && sequence === readSequence.current) setContent(result); }
    catch (cause) { if (taskIdRef.current === id && sequence === readSequence.current) onError(errorText(cause)); }
    finally { if (taskIdRef.current === id && sequence === readSequence.current) setLoading(false); }
  }
  const artifact = snapshot.artifacts.find(item => item.id === artifactId) ?? snapshot.artifacts.at(-1);
  return <section className="tool-panel" aria-label={t(panel === 'files' ? 'Files' : panel === 'terminal' ? 'Terminal' : 'Preview')}><div className="tool-heading"><Tabs values={[[ 'files', 'Files'], ['terminal', 'Terminal'], ['preview', 'Preview']]} current={panel} set={setPanel} t={t} /><div className="row">{panel === 'files' && <IconButton label={t('Refresh files')} onClick={() => void loadFiles()}><FolderOpen /></IconButton>}<IconButton label={t('Close tools')} onClick={() => setPanel(null)}><X /></IconButton></div></div>
    <div className="tool-content">{panel === 'files' ? <div className="file-browser"><div className="file-list">{files.map(file => <button key={file} aria-pressed={file === selectedFile} onClick={() => void readFile(file)} title={file}><FileCode2 /><span>{file}</span></button>)}{!files.length && <Empty>{t('No files available')}</Empty>}</div><div className="file-content"><div className="file-heading">{selectedFile || t('Select a file')}</div>{loading ? <LoaderCircle className="spin" /> : content && <Output {...content} t={t} />}</div></div> : panel === 'terminal' ? <div className="terminal-output"><div className="terminal-caption"><Terminal /><span>{t('Command output')}</span><code>{snapshot.task.baseline.slice(0, 10)}</code></div>{snapshot.actions.filter(action => /bash|shell|command|check|exec|run/i.test(action.name)).map(action => <details className="terminal-record" key={action.id} open><summary><code>{action.name}</code><Status value={action.status} t={t} /><small>{action.nodeId}</small></summary><pre>{action.output ?? '…'}</pre></details>)}{snapshot.checks.map(check => <details className="terminal-record" key={check.id}><summary><code>{snapshot.task.checks.find(item => item.id === check.conditionId)?.command.join(' ') ?? check.conditionId}</code><Status value={check.result} t={t} /></summary><pre>{check.output}</pre></details>)}{!snapshot.actions.some(action => /bash|shell|command|check|exec|run/i.test(action.name)) && !snapshot.checks.length && <Empty>{t('No command output yet')}</Empty>}</div> : <div className="artifact-preview"><div className="preview-toolbar"><label>{t('Read-only artifact preview')}<select aria-label={t('Select an artifact')} value={artifact?.id ?? ''} onChange={event => setArtifactId(event.target.value)}>{!snapshot.artifacts.length && <option value="">{t('No artifacts yet')}</option>}{snapshot.artifacts.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label></div>{artifact ? <Output content={artifact.content} truncated={artifact.truncated} t={t} /> : <Empty>{t('No artifacts yet')}</Empty>}</div>}</div>
  </section>;
}

type CheckInput = { id: string; label: string; argv: string; protectedPaths: string };
function NewTask({ projects, selectedProjectId, busy, t, onAddProject, onError, onCreate }: { projects: Bootstrap['projects']; selectedProjectId?: string; busy: boolean; t: T; onAddProject: () => Promise<void>; onError: (error: string) => void; onCreate: (command: Extract<AppCommand, { type: 'task.create' }>) => Promise<void> }) {
  const [projectId, setProjectId] = useState(selectedProjectId ?? projects[0]?.id ?? '');
  const [objective, setObjective] = useState('');
  const [mode, setMode] = useState<Task['mode']>('once');
  const [policy, setPolicy] = useState<Task['executionPolicy']>('autoWithinGrant');
  const [checks, setChecks] = useState<CheckInput[]>([]);
  const [turns, setTurns] = useState(40);
  const [minutes, setMinutes] = useState(15);
  const [interval, setInterval] = useState(30);
  const [expiry, setExpiry] = useState('');
  const [submitting, setSubmitting] = useState(false);
  useEffect(() => { if (!projectId && projects[0]) setProjectId(projects[0].id); }, [projects, projectId]);
  function updateCheck(id: string, patch: Partial<CheckInput>) { setChecks(previous => previous.map(check => check.id === id ? { ...check, ...patch } : check)); }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!objective.trim() || !projectId) return;
    let parsed: CheckSpec[];
    try {
      parsed = checks.map(check => {
        const command: unknown = JSON.parse(check.argv);
        if (!Array.isArray(command) || !command.length || command.some(arg => typeof arg !== 'string' || !arg.length)) throw new Error(t('Each command must be a nonempty JSON array of strings.'));
        return { id: check.id, label: check.label.trim() || (command as string[]).join(' '), command: command as string[], protectedPaths: check.protectedPaths.split('\n').map(path => path.trim()).filter(Boolean) };
      });
    } catch { onError(t('Each command must be a nonempty JSON array of strings.')); return; }
    if (mode === 'finite' && (!expiry || new Date(expiry).getTime() <= Date.now())) { onError(t('Enter a future expiry time for a finite task.')); return; }
    setSubmitting(true);
    try { await onCreate({ type: 'task.create', requestId: uid(), projectId, objective: objective.trim(), checks: parsed, executionPolicy: policy, mode, maxTurns: turns, maxRunMs: minutes * 60_000, ...(mode !== 'once' ? { intervalMinutes: interval } : {}), ...(mode === 'finite' ? { expiresAt: new Date(expiry).toISOString() } : {}) }); }
    finally { setSubmitting(false); }
  }
  return <div className="utility new-task-page"><form onSubmit={event => void submit(event)}><div className="form-intro"><SquarePen /><h2>{t('New task')}</h2><p>{t('What should change, and how will you know it works?')}</p></div>
    <div className="field"><label htmlFor="project-choice">{t('Project')}</label><div className="row"><select id="project-choice" value={projectId} required onChange={event => setProjectId(event.target.value)}>{!projects.length && <option value="">{t('Choose a project')}</option>}{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select><button type="button" className="button" onClick={() => void onAddProject()}><FolderOpen />{t('Open project')}</button></div></div>
    <div className="field"><label htmlFor="task-objective">{t('Objective')}</label><textarea id="task-objective" required rows={5} maxLength={32000} value={objective} placeholder={t('What should change, and how will you know it works?')} onChange={event => setObjective(event.target.value)} /></div>
    <div className="form-columns"><div className="field"><label htmlFor="task-policy">{t('Execution policy')}</label><select id="task-policy" value={policy} onChange={event => setPolicy(event.target.value as typeof policy)}><option value="autoWithinGrant">{t('Execute within grant')}</option><option value="reviewBeforeExecute">{t('Review plan first')}</option></select></div><div className="field"><label htmlFor="task-mode">{t('Task mode')}</label><select id="task-mode" value={mode} onChange={event => setMode(event.target.value as typeof mode)}><option value="once">{t('Once')}</option><option value="finite">{t('Finite')}</option><option value="maintain">{t('Maintain')}</option></select></div></div>
    <p className="field-hint">{t('Once runs to completion. Finite resumes external waits until expiry. Maintain checks on a schedule.')}</p>
    <section className="form-section"><div className="section-heading"><h3>{t('Check commands')}</h3><button type="button" className="button compact" onClick={() => setChecks(previous => [...previous, { id: `check-${uid().slice(0, 8)}`, label: '', argv: '', protectedPaths: '' }])}><Plus />{t('Add check')}</button></div><p className="field-hint">{t('Commands are argv arrays, not shell scripts. Use project tests that verify the requested behavior.')}</p><p className="field-hint">{t('Only run trusted repositories and commands. The macOS file/network sandbox is not a VM; deliberately detached daemons may escape process cleanup.')}</p>
      {checks.map((check, index) => <fieldset className="check-editor" key={check.id}><legend>{t('Condition')} {index + 1}</legend><IconButton className="check-remove" label={`${t('Remove check')} ${index + 1}`} onClick={() => setChecks(previous => previous.filter(item => item.id !== check.id))}><X /></IconButton><div className="field"><label htmlFor={`label-${check.id}`}>{t('Check label')}</label><input id={`label-${check.id}`} value={check.label} onChange={event => updateCheck(check.id, { label: event.target.value })} /></div><div className="field"><label htmlFor={`argv-${check.id}`}>{t('Command argv (JSON array)')}</label><input id={`argv-${check.id}`} className="mono" value={check.argv} required placeholder='["npm", "test"]' onChange={event => updateCheck(check.id, { argv: event.target.value })} /></div><div className="field"><label htmlFor={`paths-${check.id}`}>{t('Protected paths (one per line)')}</label><textarea id={`paths-${check.id}`} rows={2} value={check.protectedPaths} onChange={event => updateCheck(check.id, { protectedPaths: event.target.value })} /><small>{t('These files are protected from agent edits while running the check.')}</small></div></fieldset>)}
      {!checks.length && <p className="warning">{t('No automated checks. Completion will require your acceptance.')}</p>}
    </section>
    <section className="form-section"><h3>{t('Turn budget')}</h3><div className="form-columns"><div className="field"><label htmlFor="max-turns">{t('Maximum turns')}</label><input id="max-turns" type="number" min={1} max={500} step={1} value={turns} required onChange={event => setTurns(Number(event.target.value))} /></div><div className="field"><label htmlFor="max-minutes">{t('Maximum run time (minutes)')}</label><input id="max-minutes" type="number" min={1} max={60} value={minutes} required onChange={event => setMinutes(Number(event.target.value))} /></div></div>
      {mode !== 'once' && <div className="form-columns"><div className="field"><label htmlFor="interval">{t('Check interval (minutes)')}</label><input id="interval" type="number" min={1} max={10080} value={interval} required onChange={event => setInterval(Number(event.target.value))} /></div>{mode === 'finite' && <div className="field"><label htmlFor="expires">{t('Expires at')}</label><input id="expires" type="datetime-local" value={expiry} required onChange={event => setExpiry(event.target.value)} /></div>}</div>}
    </section><div className="form-actions"><button type="submit" className="button primary" disabled={busy || submitting || !objective.trim() || !projectId}>{submitting ? <LoaderCircle className="spin" /> : <Sparkles />}{t(submitting ? 'Creating task…' : 'Create and plan')}</button></div>
  </form></div>;
}
function SettingsPage({ settings, capabilities, tab, setTab, t, busy, save, onTest, onSaved }: { settings: AppSettings; capabilities: Bootstrap['capabilities']; tab: 'general' | 'models' | 'permissions'; setTab: (tab: 'general' | 'models' | 'permissions') => void; t: T; busy: boolean; save: (patch: Extract<AppCommand, { type: 'settings.save' }>['patch']) => Promise<AppSettings | undefined>; onTest: () => Promise<void>; onSaved: () => void }) {
  const [model, setModel] = useState({ baseUrl: settings.model.baseUrl, modelId: settings.model.modelId, thinking: settings.model.thinking, contextWindow: settings.model.contextWindow, maxTokens: settings.model.maxTokens });
  const [key, setKey] = useState('');
  async function saveModel(event: FormEvent) {
    event.preventDefault();
    const result = await save({ model: { ...model, ...(key ? { apiKey: key } : {}) } });
    if (result) { setKey(''); onSaved(); }
  }
  return <div className="utility settings-page"><div className="settings-layout"><nav className="settings-navigation" aria-label={t('Settings')}>{([['general', 'General', Settings2], ['models', 'Models', Sparkles], ['permissions', 'Permissions', ShieldCheck]] as const).map(([value, label, Icon]) => <button className="nav-item" key={value} aria-current={tab === value ? 'page' : undefined} onClick={() => setTab(value)}><Icon />{t(label)}</button>)}</nav><div className="settings-content">
    {tab === 'general' && <><h2>{t('General')}</h2><div className="setting-row"><div><label htmlFor="settings-locale">{t('Language')}</label><p>{t('UI language changes preserve task content and unsent drafts.')}</p></div><select id="settings-locale" value={settings.locale} onChange={event => void save({ locale: event.target.value as Locale })}><option value="system">{t('System')}</option><option value="zh-CN">简体中文</option><option value="en">English</option></select></div><div className="setting-row"><div><label htmlFor="response-language">{t('Response language')}</label></div><select id="response-language" value={settings.responseLanguage} onChange={event => void save({ responseLanguage: event.target.value as AppSettings['responseLanguage'] })}><option value="task">{t('Follow task')}</option><option value="zh-CN">简体中文</option><option value="en">English</option></select></div><div className="setting-row"><div><label htmlFor="show-planning">{t('Planning sidebar')}</label><p>{t('Hiding the sidebar never pauses a task.')}</p></div><input id="show-planning" type="checkbox" aria-label={t('Show planning sidebar')} checked={settings.planningOpen} onChange={event => void save({ planningOpen: event.target.checked })} /></div></>}
    {tab === 'models' && <form onSubmit={event => void saveModel(event)}><h2>{t('Models')}</h2><p className="field-hint">{t('OpenAI-compatible Chat Completions endpoint with tool calling is required. Use an available provider model ID.')}</p><div className="model-card"><Sparkles /><div><strong>{settings.model.modelId || t('Model ID')}</strong><small>{t(settings.model.hasApiKey ? 'Key stored' : 'No key stored')}</small></div></div><div className="field"><label htmlFor="base-url">{t('Base URL')}</label><input id="base-url" type="url" required value={model.baseUrl} onChange={event => setModel(previous => ({ ...previous, baseUrl: event.target.value }))} placeholder="https://api.openai.com/v1" /></div><div className="field"><label htmlFor="model-id">{t('Model ID')}</label><input id="model-id" required value={model.modelId} onChange={event => setModel(previous => ({ ...previous, modelId: event.target.value }))} /></div><div className="field"><label htmlFor="api-key">{t('API key')}</label><input id="api-key" type="password" autoComplete="new-password" spellCheck={false} value={key} onChange={event => setKey(event.target.value)} placeholder={settings.model.hasApiKey ? '••••••••' : ''} /><small>{t('Leave blank to keep the saved key. The saved key is never returned to this screen.')}</small></div><div className="field"><label htmlFor="model-thinking">{t('Thinking')}</label><select id="model-thinking" value={model.thinking} onChange={event => setModel(previous => ({ ...previous, thinking: event.target.value as typeof model.thinking }))}><option value="off">{t('Off')}</option><option value="low">{t('Low')}</option><option value="medium">{t('Medium')}</option><option value="high">{t('High')}</option></select></div><div className="form-columns"><div className="field"><label htmlFor="model-context">{t('Context window')}</label><input id="model-context" type="number" min={4096} max={2000000} step={1} required value={model.contextWindow} onChange={event => setModel(previous => ({ ...previous, contextWindow: Number(event.target.value) }))} /></div><div className="field"><label htmlFor="model-output">{t('Maximum output tokens')}</label><input id="model-output" type="number" min={128} max={100000} step={1} required value={model.maxTokens} onChange={event => setModel(previous => ({ ...previous, maxTokens: Number(event.target.value) }))} /></div></div><div className="row wrap"><button className="button primary" disabled={busy} type="submit">{t('Save settings')}</button><button className="button" disabled={busy} type="button" onClick={() => void onTest()}>{t('Test saved connection')}</button></div><p className="field-hint">{t('The connection test checks the provider model list and exact model ID. It does not verify tool calling. Save changes first.')}</p></form>}
    {tab === 'permissions' && <><h2>{t('Permissions')}</h2><div className="setting-row"><div><label htmlFor="allow-network">{t('Allow network during execution')}</label><p>{t('Task tools run within the project worktree and the configured network policy.')}</p></div><input id="allow-network" type="checkbox" checked={settings.allowNetwork} onChange={event => void save({ allowNetwork: event.target.checked })} /></div><div className="setting-row"><div><h3>{t('Execution sandbox')}</h3><p>{capabilities.reason}</p></div><span className={`status ${capabilities.sandbox ? 'status-verified' : 'status-blocked'}`}><span />{t(capabilities.sandbox ? 'Available' : 'Unavailable')}</span></div><p className="muted">{t('Only run trusted repositories and commands. The macOS file/network sandbox is not a VM; deliberately detached daemons may escape process cleanup.')}</p></>}
  </div></div></div>;
}
function Capabilities({ t }: { t: T }) {
  return <div className="utility capabilities-page"><p className="muted">{t('Only real built-in capabilities are listed here.')}</p>{([
    ['Project sources', 'Reads project instructions and repository files as planning evidence.', FolderOpen],
    ['Bounded context', 'Carries the objective, saved plan, upstream evidence, and current workspace into each run.', Network],
    ['Workspace tools', 'Reads and edits project files and runs scoped commands through pi.', Terminal],
    ['Fixed verification', 'Runs the commands agreed at task creation and records their results separately from model claims.', ShieldCheck],
  ] as const).map(([label, description, Icon]) => <article className="capability-row" key={label}><div className="capability-icon"><Icon /></div><div><h2>{t(label)}</h2><p>{t(description)}</p></div><span className="badge">{t('Built in')}</span></article>)}</div>;
}
