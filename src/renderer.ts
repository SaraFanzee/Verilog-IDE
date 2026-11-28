import * as monaco from 'monaco-editor/esm/vs/editor/editor.main.js';
import './style.css';
import { errorMessage, getLocale, isEnglish, localeStorageKey, message, setLocale, startupLocale, t, translate } from './i18n';
import type { Message, MessageKey } from './i18n';
import { compile, formatValue, parseValue, radixShort } from './design';
import type { Design, Logic, Part, Radix, Signal, Vector } from './design';
import type { BuildOptions, BuildResult, Desktop, Diagnostic, Source } from './protocol';
import { Schematic, defaultPalette } from './schematic';
import type { Palette } from './schematic';
import type { Frame, Request } from './sim-worker';
import { defaultDelay } from './simulation';
import { criticalPath } from './critical-path';
import type { Duration } from './simulation';
import { Waveform } from './wave';

declare global {
  interface Window { desktop: Desktop; }
}
Object.assign(globalThis, { MonacoEnvironment: { getWorker: () => new Worker('./editor-worker.js') } });

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const button = (id: string) => el<HTMLButtonElement>(id);
const input = (id: string) => el<HTMLInputElement>(id);
const select = (id: string) => el<HTMLSelectElement>(id);
const dialog = (id: string) => el<HTMLDialogElement>(id);
const on = (id: string, event: string, handler: () => void) => el(id).addEventListener(event, handler);
const languageControl = button('interface-language');
const languageMenu = el('language-options');
const languageChoices = languageMenu.querySelectorAll('button');
const modes = ['rtl', 'gate'] as const;
let selectedMode: BuildOptions['mode'] = 'rtl';
const options = (): BuildOptions => ({
  standard: select('standard').value as BuildOptions['standard'],
  top: input('top').value.trim(),
  mode: selectedMode,
  hierarchy: input('hierarchy').checked,
  optimize: input('optimize').checked,
  abc: input('abc').checked,
  observe: input('observe').checked,
  extraCommands: lines('extra-commands'), includes: lines('includes'), defines: lines('defines'), parameters: lines('parameters'),
});
function lines(id: string) { return el<HTMLTextAreaElement>(id).value.split(/\r?\n/).map(line => line.trim()).filter(Boolean); }

const sample = `module counter (
    input  logic       clk,
    input  logic       reset,
    input  logic       enable,
    input  logic [3:0] data_in,
    input  logic       drive,
    output logic [3:0] count,
    output wire  [3:0] data_out
);
    logic [3:0] next_count;
    assign next_count = count + 4'd1;

    always_ff @(posedge clk or posedge reset)
        if (reset) count <= 4'd0;
        else if (enable) count <= next_count;

    assign data_out = drive ? data_in : 4'bzzzz;
endmodule
`;

monaco.editor.defineTheme('workbench', {
  base: 'vs-dark', inherit: true, rules: [], colors: {
    'editor.background': '#171d26', 'editorLineNumber.foreground': '#728094',
    'editor.lineHighlightBackground': '#202a37', 'editorCursor.foreground': '#60dfc6',
  },
});
const editor = monaco.editor.create(el('editor'), {
  theme: 'workbench', automaticLayout: true, fontSize: 13, minimap: { enabled: false },
  fontFamily: 'Consolas, Liberation Mono, monospace', padding: { top: 11 }, scrollBeyondLastLine: false,
});
// Monaco already contributes Cut, Copy and Paste to its editor context menu.
for (const [command, label, order] of [
  ['undo', 'undo', -2], ['redo', 'redo', -1], ['deleteRight', 'delete', 5], ['editor.action.selectAll', 'selectAll', 6],
] as const) {
  editor.addAction({
    id: 'workbench.' + command, label: t(label), contextMenuGroupId: '9_cutcopypaste', contextMenuOrder: order,
    run: target => { target.focus(); target.trigger('contextMenu', command, null); },
  });
}
interface FileTab { source: Source; model: monaco.editor.ITextModel; saved: string; view?: monaco.editor.ICodeEditorViewState | null }
const files = new Map<string, FileTab>();
let active: string;
let revision = 0;
let jobSequence = 0;
let lintTimer: ReturnType<typeof setTimeout>;
let lintBusy = false;
let lintQueued = false;
let synthesisBusy = false;
let synthesisQueued = false;
let logMode: 'lint' | 'synth' = 'lint';
let design: Design | undefined;
let scopes: string[] = [];
let watched = new Set<string>();
const probes = new Map<string, Signal>();
const displayRadices = new Map<string, Radix>();
let chipType = '';
let inspector: 'signals' | 'parts' = 'signals';
let palette: Palette = { ...defaultPalette };
const clockOverrides = new Map<string, number>();
const cellDelays = new Map<string, number>();
try {
  const saved = JSON.parse(localStorage.getItem('verilog-palette') ?? '{}');
  for (const state of Object.keys(defaultPalette) as Logic[]) if (/^#[0-9a-f]{6}$/i.test(saved[state] ?? '')) palette[state] = saved[state];
} catch { /* Defaults also work when storage is unavailable. */ }

const worker = new Worker('./sim-worker.js');
let version = 0;
let frame: Frame | undefined;
let pendingFrame: Frame | undefined;
let framePaint = 0;
let simulationError: Message | string = '';
let cursor = 0;
let viewStart = 0;
let stepPs = 50;
let period = 20;
let end = 2000;
let viewSpan = end;
const nsAt = (tick: number) => tick * stepPs / 1000;
const simTiming = () => ({ period, end });
let playing = false;
let playTimer: ReturnType<typeof setInterval> | undefined;
let buildRevision = -1;
let builtMode: BuildOptions['mode'] | undefined;
const watchedSignals = () => [...watched].flatMap(id => probes.get(id) ?? design?.signals.find(signal => signal.id === id) ?? []);
const radixFor = (signal: Signal): Radix => displayRadices.get(signal.id) ?? (signal.width === 1 ? 'bin' : 'hex');
const viewEnd = () => Math.min(end, viewStart + viewSpan);
const schematic = new Schematic(el('schematic'), handlePart, (signal, x, y, aliases) => signalMenu(signal, x, y, false, aliases));
const waveform = new Waveform(el('wave'), el('wave-scroll'), handleWave, zoomWave, openRadixMenu, signal => {
  setWatched(signal, false);
  renderInspector();
});

const radixLabels: Record<Radix, MessageKey> = { bin: 'binary', hex: 'hex', uint: 'unsigned', int: 'signed' };
function setDisplayRadix(signal: Signal, format: Radix) {
  displayRadices.set(signal.id, format);
  draw();
  renderInspector();
}
function openRadixMenu(signal: Signal, x: number, y: number) { signalMenu(signal, x, y, true); }

function setWatched(signal: Signal, watch: boolean) {
  if (watch) {
    if (!design?.signals.some(item => item.id === signal.id)) probes.set(signal.id, signal);
    watched.add(signal.id);
  } else watched.delete(signal.id);
  draw();
  request();
}

function signalMenu(signal: Signal, x: number, y: number, radixOnly = false, aliases?: Signal[]) {
  if (!signal.bits) return;
  const menu = el('signal-menu');
  const title = document.createElement('div');
  title.className = 'signal-menu-title';
  title.textContent = signal.name;
  menu.replaceChildren(title);
  if (aliases && aliases.length > 1) {
    const variable = document.createElement('select');
    variable.setAttribute('aria-label', t('chooseWireSignal'));
    for (const alias of aliases) variable.add(new Option(alias.name, alias.id));
    variable.value = signal.id;
    variable.onchange = () => signalMenu(aliases.find(s => s.id === variable.value)!, x, y, radixOnly, aliases);
    menu.replaceChildren(variable);
  }
  const action = (label: string, run: () => void, checked?: boolean) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.textContent = label;
    item.setAttribute('role', checked === undefined ? 'menuitem' : 'menuitemradio');
    if (checked !== undefined) item.setAttribute('aria-checked', String(checked));
    item.onclick = () => { menu.hidden = true; run(); };
    menu.append(item);
  };
  const added = watched.has(signal.id);
  if (!radixOnly) action(added ? t('unwatch') : t('watch'), () => {
    setWatched(signal, !added);
    renderInspector();
    if (!added) el('wave-scroll').scrollTop = el('wave-scroll').scrollHeight;
  });
  for (const [format, label] of Object.entries(radixLabels) as [Radix, MessageKey][]) action(t(label), () => {
    setDisplayRadix(signal, format);
  }, radixFor(signal) === format);
  menu.hidden = false;
  menu.style.left = Math.max(0, Math.min(x, innerWidth - menu.offsetWidth - 8)) + 'px';
  menu.style.top = Math.max(0, Math.min(y, innerHeight - menu.offsetHeight - 8)) + 'px';
  menu.querySelector('button')?.focus();
}

document.addEventListener('pointerdown', event => {
  const menu = el('signal-menu');
  if (!menu.contains(event.target as Node)) menu.hidden = true;
});
document.addEventListener('keydown', event => {
  const menu = el('signal-menu');
  if (menu.hidden) return;
  if (event.key === 'Escape') menu.hidden = true;
  if (event.target instanceof HTMLSelectElement) return;
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  event.preventDefault();
  const items = [...menu.querySelectorAll('button')];
  const index = items.indexOf(document.activeElement as HTMLButtonElement);
  items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
});

let statusContent: Message | string = message('ready');
function status(content: Message | string, error = false) {
  statusContent = content;
  el('status').textContent = el('status').title = translate(content);
  el('status').classList.toggle('error', error);
}

function snapshot() { return [...files.values()].map(({ source, model }) => ({ ...source, text: model.getValue() })); }
function addFile(source: Source) {
  const existing = [...files.values()].find(file => source.path && file.source.path === source.path);
  if (existing) return existing.source.id;
  const language = 'verilog';
  const model = monaco.editor.createModel(source.text, language, monaco.Uri.from({ scheme: 'hdl', path: '/' + source.id + '/' + source.name }));
  const tab = { source, model, saved: source.text };
  files.set(source.id, tab);
  model.onDidChangeContent(() => { renderTabs(); inputsChanged(); });
  return source.id;
}
function switchTab(id: string) {
  const next = files.get(id);
  if (!next) return;
  const current = files.get(active);
  if (current) current.view = editor.saveViewState();
  active = id;
  editor.setModel(next.model);
  if (next.view) editor.restoreViewState(next.view);
  renderTabs();
}
function renderTabs() {
  el('tabs').replaceChildren(...[...files.values()].map(file => {
    const group = document.createElement('div');
    group.className = 'file-tab';
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(file.source.id === active));
    tab.textContent = file.source.name;
    const dirty = file.saved !== file.model.getValue();
    tab.toggleAttribute('data-dirty', dirty);
    if (dirty) tab.setAttribute('aria-label', t('dirtyFile', { name: file.source.name }));
    tab.title = file.source.path ?? file.source.name;
    tab.onclick = () => switchTab(file.source.id);
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'close-tab close-icon';
    close.setAttribute('aria-label', t('closeFile', { name: file.source.name }));
    close.onclick = () => closeTab(file);
    group.append(tab, close);
    return group;
  }));
}
function closeTab(file: FileTab) {
  if (file.saved !== file.model.getValue() && !window.confirm(t('discardFile', { name: file.source.name }))) return;
  const id = file.source.id;
  const before = [...files.keys()];
  files.delete(id);
  if (active === id) {
    const index = before.indexOf(id);
    const next = before[index + 1] ?? before[index - 1];
    if (next) switchTab(next);
    else { active = ''; editor.setModel(null); }
  }
  file.model.dispose();
  renderTabs();
  inputsChanged();
}
function renderSynthesisStatus() {
  el('net-status').textContent = !design ? t('unsynthesized') : buildRevision !== revision
    ? t('staleSynthesis') : design.scopes[0].label + ' · ' + (builtMode === 'gate' ? t('gate') : 'RTL');
}
function inputsChanged() {
  revision++;
  if (design && buildRevision !== revision) renderSynthesisStatus();
  queueLint();
}
async function save(as = false) {
  const file = files.get(active);
  if (!file) return;
  const text = file.model.getValue();
  try {
    const path = await window.desktop.save({ ...file.source, text }, as);
    if (!path) return;
    file.source.path = path;
    file.source.name = path.split(/[\\/]/).at(-1)!;
    file.saved = text;
    renderTabs();
    inputsChanged();
    status(message('savedFile', { name: file.source.name }));
  } catch (error) { status(errorMessage(error), true); }
}

let lintContent: Message | string = '';
function lintStatus(content: Message | string) {
  lintContent = content;
  el('lint-status').textContent = translate(content);
}
function queueLint() {
  clearTimeout(lintTimer);
  if (!files.size) {
    lintStatus('');
    applyDiagnostics([]);
    return;
  }
  if (!input('live-lint').checked) {
    lintStatus(message('lintOff'));
    applyDiagnostics([]);
    return;
  }
  lintStatus(message('lintPending'));
  lintTimer = setTimeout(() => { void lint(); }, 420);
}

async function lint() {
  if (!input('live-lint').checked) return;
  if (lintBusy) { lintQueued = true; return; }
  lintBusy = true;
  const started = revision;
  const job = ++jobSequence;
  lintStatus(message('lintRunning'));
  try {
    const result = await window.desktop.hdl(snapshot(), options(), true);
    if (started !== revision || job !== jobSequence) return;
    applyDiagnostics(result.diagnostics);
    const errors = result.diagnostics.filter(item => item.severity === 'error').length;
    lintStatus(errors ? message('lintErrors', { count: errors }) : !result.ok ? message('lintFailed')
      : result.diagnostics.length ? message('lintDiagnostics', { count: result.diagnostics.length }) : message('lintPassed'));
    el('lint-status').classList.toggle('error', !result.ok);
    if (logMode === 'lint') renderLog(result);
  } catch (error) {
    if (started === revision) { lintStatus(message('lintFailed')); status(errorMessage(error), true); }
  } finally {
    lintBusy = false;
    if (lintQueued) { lintQueued = false; void lint(); }
  }
}

function applyDiagnostics(diagnostics: Diagnostic[]) {
  for (const [id, file] of files) monaco.editor.setModelMarkers(file.model, 'hdl', diagnostics.filter(item => item.id === id).map(item => ({
    startLineNumber: item.line, endLineNumber: item.line, startColumn: item.column, endColumn: item.column + 1,
    message: item.message, severity: item.severity === 'error' ? monaco.MarkerSeverity.Error : item.severity === 'warning' ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Info,
  })));
  el('problem-count').textContent = diagnostics.length ? String(diagnostics.length) : '';
  el('diagnostics').replaceChildren(...diagnostics.map(item => {
    const control = document.createElement('button');
    control.textContent = `${files.get(item.id)?.source.name}:${item.line}:${item.column} · ${item.message}`;
    control.classList.toggle('error', item.severity === 'error');
    control.onclick = () => { switchTab(item.id); editor.revealPositionInCenter({ lineNumber: item.line, column: item.column }); editor.setPosition({ lineNumber: item.line, column: item.column }); editor.focus(); };
    return control;
  }));
}

async function synthesize() {
  if (synthesisBusy) { synthesisQueued = true; return; }
  const currentOptions = options();
  const started = revision;
  synthesisBusy = true;
  button('synthesize').disabled = true;
  el('schematic').setAttribute('aria-busy', 'true');
  ++jobSequence;
  logMode = 'synth';
  status(message('synthRunning'));
  try {
    const result = await window.desktop.hdl(snapshot(), currentOptions, false);
    if (synthesisQueued) return;
    if (started !== revision) { status(message('synthInputsChanged')); return; }
    renderLog(result);
    if (result.diagnostics.length) applyDiagnostics(result.diagnostics);
    if (!result.ok || !result.netlist || !result.top) {
      showLog(true);
      status(message('synthFailed'), true);
      return;
    }
    const nextDesign = compile(result.netlist, result.top, result.sourceNetlist);
    const sameTop = nextDesign.root === design?.root && !simulationError;
    stop();
    design = nextDesign;
    for (const id of probes.keys()) displayRadices.delete(id);
    probes.clear();
    buildRevision = revision;
    builtMode = currentOptions.mode;
    scopes = [design.root];
    if (sameTop) watched = new Set([...watched].filter(id => nextDesign.signals.some(signal => signal.id === id && signal.bits)));
    else {
      watched = new Set(design.signals.filter(signal => signal.direction && (signal.editable || !signal.name.includes('.'))).slice(0, 16).map(signal => signal.id));
      cursor = viewStart = 0; viewSpan = end;
      clockOverrides.clear(); cellDelays.clear();
      displayRadices.clear();
    }
    frame = undefined;
    chipType = ''; simulationError = '';
    renderSynthesisStatus();
    renderInspector();
    showScope();
    updateNavigation();
    draw();
    request({ type: 'load', design, timing: simTiming() });
    status(message('synthDone', { count: design.cells.length }));
  } catch (error) {
    if (synthesisQueued) return;
    showLog(true);
    status(errorMessage(error), true);
  } finally {
    synthesisBusy = false;
    if (synthesisQueued) {
      synthesisQueued = false;
      void synthesize();
    } else {
      if (builtMode && selectedMode !== builtMode) setModeTab(builtMode);
      button('synthesize').disabled = false;
      el('schematic').setAttribute('aria-busy', 'false');
    }
  }
}

let currentLog: Pick<BuildResult, 'log' | 'logMessage'> = { log: '' };
function renderLog(result = currentLog) {
  currentLog = result;
  el('log').textContent = result.logMessage
    ? [translate(result.logMessage), result.log].filter(Boolean).join('\n') : result.log;
}

function showLog(visible: boolean) {
  el('log-pane').hidden = !visible;
  button('log-toggle').setAttribute('aria-expanded', String(visible));
}

const signalGlyphs = {
  clock: ['clock', 'M2.5 9.75H5v-5h6v5h2.5v1.5H9.5v-5h-3v5h-4z'],
  input: ['input', 'M5 4h6v1.5H8.75v5H11V12H5v-1.5h2.25v-5H5z'],
  output: ['output', 'M8 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8z M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z'],
} as const;

function signalIcon(kind: keyof typeof signalGlyphs) {
  const [label, glyph] = signalGlyphs[kind];
  const namespace = 'http://www.w3.org/2000/svg';
  const icon = document.createElementNS(namespace, 'svg');
  icon.setAttribute('class', `signal-icon ${kind}`);
  icon.setAttribute('viewBox', '0 0 16 16');
  icon.setAttribute('role', 'img');
  icon.setAttribute('aria-label', t(label));
  const shape = document.createElementNS(namespace, 'path');
  shape.setAttribute('fill-rule', 'evenodd');
  shape.setAttribute('d', `M1 1h14v14H1z ${glyph}`);
  const outline = document.createElementNS(namespace, 'rect');
  outline.setAttribute('x', '1'); outline.setAttribute('y', '1');
  outline.setAttribute('width', '14'); outline.setAttribute('height', '14');
  icon.append(shape, outline);
  return icon;
}

function renderInspector() {
  const filter = input('signal-filter').value.trim().toLowerCase();
  const signals = (design?.signals ?? []).filter(signal => signal.name.toLowerCase().includes(filter));
  const partCounts = new Map<string, number>();
  for (const cell of design?.cells ?? []) partCounts.set(cell.type, (partCounts.get(cell.type) ?? 0) + 1);
  el('inspector-count').textContent = String(inspector === 'signals' ? signals.length : design?.cells.length ?? 0);
  el('signal-pane').hidden = inspector !== 'signals';
  el('part-pane').hidden = inspector !== 'parts';
  button('zero-delays').disabled = button('reset-delays').disabled = !partCounts.size;
  button('show-signals').classList.toggle('selected', inspector === 'signals');
  button('show-parts').classList.toggle('selected', inspector === 'parts');
  el('signals').replaceChildren(...signals.map(signal => {
    const li = document.createElement('li');
    li.className = 'signal-row';
    const control = document.createElement('button');
    control.disabled = !signal.bits;
    control.className = 'signal-control';
    control.title = signal.bits ? t('watchToggle') : t('unobservable');
    const name = document.createElement('span');
    name.className = 'signal-name';
    name.textContent = signal.name;
    const tag = document.createElement('span');
    tag.className = 'tag';
    const kind = signal.clock ? 'clock' : signal.direction;
    if (kind === 'clock' || kind === 'input' || kind === 'output') control.append(signalIcon(kind));
    const watchMark = document.createElement('span');
    watchMark.className = 'watch-mark';
    watchMark.setAttribute('aria-hidden', 'true');
    tag.append(`${kind === 'inout' ? t('bidirectional') + ' ' : ''}${signal.width}b`, watchMark);
    control.append(name, tag);
    const updateWatch = () => {
      const active = watched.has(signal.id);
      control.setAttribute('aria-pressed', String(active));
      watchMark.dataset.state = signal.bits ? (active ? 'added' : 'available') : 'unavailable';
      tag.classList.toggle('watched', active);
    };
    updateWatch();
    control.onclick = () => { setWatched(signal, !watched.has(signal.id)); updateWatch(); };
    li.append(control);
    if (signal.bits) {
      const display = document.createElement('button');
      display.type = 'button';
      display.className = 'radix-chip';
      display.textContent = radixShort[radixFor(signal)];
      display.setAttribute('aria-label', t('signalRadix', { name: signal.name }));
      display.onclick = () => {
        const rect = display.getBoundingClientRect();
        openRadixMenu(signal, rect.left, rect.bottom);
      };
      li.append(display);
    }
    return li;
  }));
  el('parts').replaceChildren(...[...partCounts].sort(([a], [b]) => a.localeCompare(b)).map(([type, count]) => {
    const li = document.createElement('li');
    li.className = 'part-row';
    const control = document.createElement('button');
    control.title = type;
    const label = document.createElement('span');
    label.className = 'part-name'; label.textContent = type;
    const quantity = document.createElement('span'); quantity.textContent = '×' + count;
    control.append(label, quantity);
    control.classList.toggle('selected', chipType === type);
    control.onclick = () => {
      chipType = chipType === type ? '' : type;
      const existing = design?.scopes.find(scope => scope.id === scopes.at(-1));
      const containing = chipType && !existing?.parts.some(part => part.type === chipType) && design?.scopes.find(scope => scope.parts.some(part => part.type === chipType));
      if (containing) {
        const path = JSON.parse(containing.id) as string[];
        scopes = path.map((_, index) => JSON.stringify(path.slice(0, index + 1)));
        showScope();
      }
      renderInspector(); draw();
    };
    const delay = document.createElement('input');
    delay.type = 'number'; delay.min = '0'; delay.max = '10000'; delay.step = '1';
    delay.value = String(cellDelays.get(type) ?? defaultDelay(type));
    delay.setAttribute('aria-label', t('componentDelay', { type }));
    delay.onchange = () => {
      if (!delay.checkValidity() || delay.value === '') { delay.reportValidity(); delay.value = String(cellDelays.get(type) ?? defaultDelay(type)); return; }
      cellDelays.set(type, delay.valueAsNumber);
      refreshCriticalPath();
      simulationError = '';
      request({ type: 'delay', cell: type, delay: delay.valueAsNumber });
    };
    li.append(control, delay);
    return li;
  }));
}

function showScope() {
  if (!design) return;
  el('scope-path').replaceChildren(...scopes.map((id, index) => {
    const element = document.createElement(index === scopes.length - 1 ? 'span' : 'button');
    element.textContent = (JSON.parse(id) as string[]).at(-1)!;
    element.title = element.textContent;
    if (element instanceof HTMLButtonElement) element.onclick = () => { scopes = scopes.slice(0, index + 1); showScope(); };
    return element;
  }));
  const scope = design.scopes.find(item => item.id === scopes.at(-1))!;
  const ids = new Set(scope.signalIds);
  void schematic.show(scope, design.signals.filter(signal => ids.has(signal.id)));
  refreshCriticalPath();
}

function refreshCriticalPath() {
  const toggle = button('critical-path');
  const label = el('critical-delay');
  toggle.disabled = !design;
  label.hidden = !design || toggle.getAttribute('aria-pressed') !== 'true';
  const scope = design?.scopes.find(item => item.id === scopes.at(-1));
  if (!design || !scope || label.hidden) { schematic.setCriticalPath(); return; }
  const result = criticalPath(design, scope, cellDelays);
  if ('path' in result) {
    const { ticks, steps } = result.path;
    const ps = ticks * stepPs;
    label.textContent = t('criticalPath') + ' · ' + (ps >= 1000 ? ps / 1000 + ' ns' : ps + ' ps');
    label.title = t('pathTicks', { count: ticks }) + '\n' + steps.join(' → ');
    schematic.setCriticalPath(result.path);
  } else {
    label.textContent = label.title = translate(result.message);
    schematic.setCriticalPath();
  }
}

function bindWorker() {
  worker.onmessage = ({ data }: MessageEvent<Frame>) => {
    if (data.version !== version) return;
    pendingFrame = data;
    if (framePaint) return;
    framePaint = requestAnimationFrame(() => {
      framePaint = 0;
      if (!pendingFrame || pendingFrame.version !== version) return;
      frame = pendingFrame;
      pendingFrame = undefined;
      if (frame.error) { stop(); simulationError = frame.error; status(frame.error, true); }
      draw();
    });
  };
  worker.onerror = event => {
    stop();
    simulationError = event.message || message('simWorkerFailed');
    status(simulationError, true);
  };
}

function request(mutation?: Request['mutation']) {
  if (!design) return;
  const data: Request = { version: ++version, mutation, view: {
    cursor, start: viewStart, end: viewEnd(), watched: watchedSignals().map(({ id, bits }) => ({ id, bits })),
  } };
  worker.postMessage(data);
}
function draw() {
  const displayCursor = frame?.cursor ?? cursor;
  const values = frame?.values ?? [];
  schematic.update(values, palette, radixFor, chipType);
  waveform.update({ signals: watchedSignals(), start: viewStart, end: viewEnd(), cursor: displayCursor, stepPs, frame, palette, radixFor });
  el('time-readout').textContent = `${nsAt(displayCursor)} / ${nsAt(end)} ns`;
  el('preview').textContent = !design ? '' : simulationError ? t('simUnavailable') : (frame?.computed ?? -1) < viewEnd()
    ? t('computing', { time: Math.max(0, nsAt(frame?.computed ?? 0)) })
    : t('computed', { time: nsAt(Math.min(end, frame!.computed)) });
  for (const name of ['step', 'cycle', 'play', 'rewind']) button(name).disabled = !design || !!simulationError;
  button('step').disabled ||= playing;
  button('cycle').disabled ||= playing;
}

function updateNavigation() {
  const band = el('range-window');
  band.style.left = (100 * viewStart / end) + '%';
  band.style.width = (100 * viewSpan / end) + '%';
  for (const [control, position, min, max] of [
    [band, viewStart, 0, end - viewSpan], [el('range-start'), viewStart, 0, viewEnd() - 1],
    [el('range-end'), viewEnd(), viewStart + 1, end],
  ] as const) {
    control.setAttribute('aria-valuemin', String(nsAt(min)));
    control.setAttribute('aria-valuemax', String(nsAt(max)));
    control.setAttribute('aria-valuenow', String(nsAt(position)));
    control.setAttribute('aria-valuetext', nsAt(position) + ' ns');
  }
  el('range-label').textContent = `${nsAt(viewStart)}–${nsAt(viewEnd())} ns`;
}
function setView(start: number, span: number) {
  viewSpan = Math.max(1, Math.min(end, Math.round(span)));
  viewStart = Math.max(0, Math.min(end - viewSpan, Math.round(start)));
  updateNavigation();
  frame = frame && { ...frame, waves: {} };
  draw();
  request();
}
function bindWaveRange() {
  const track = el('wave-range');
  let drag: { handle: string; x: number; start: number; finish: number } | undefined;
  const adjust = (handle: string, start: number, finish: number, delta: number) => {
    if (handle === 'range-start') {
      const next = Math.max(0, Math.min(finish - 1, start + delta));
      setView(next, finish - next);
    } else if (handle === 'range-end') setView(start, Math.max(1, Math.min(end - start, finish + delta - start)));
    else setView(start + delta, finish - start);
  };
  track.onpointerdown = event => {
    if (event.button !== 0) return;
    const handle = (event.target as HTMLElement).id;
    if (handle === track.id) return;
    drag = { handle, x: event.clientX, start: viewStart, finish: viewEnd() };
    track.setPointerCapture(event.pointerId);
  };
  track.onpointermove = event => {
    if (!drag || !track.hasPointerCapture(event.pointerId)) return;
    adjust(drag.handle, drag.start, drag.finish, Math.round((event.clientX - drag.x) * end / Math.max(1, track.clientWidth)));
  };
  track.onlostpointercapture = () => { drag = undefined; };
  track.onkeydown = event => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    adjust((event.target as HTMLElement).id, viewStart, viewEnd(), (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? period : 1));
  };
}
function zoomWave(scale: number, anchor?: number) {
  const focal = anchor ?? (cursor >= viewStart && cursor <= viewEnd() ? cursor : Math.round((viewStart + viewEnd()) / 2));
  const next = Math.max(1, Math.min(end, Math.round(viewSpan * scale)));
  if (next !== viewSpan) setView(focal - (focal - viewStart) * next / viewSpan, next);
}
function focusCursor() {
  if (button('follow').getAttribute('aria-pressed') !== 'true' || (cursor >= viewStart && cursor < viewEnd())) return;
  viewStart = Math.max(0, Math.min(end - viewSpan, cursor - Math.floor(viewSpan * .2)));
  updateNavigation();
}
function seek(time: number) {
  cursor = Math.max(0, Math.min(end, time));
  focusCursor();
  request();
}
function stop() {
  playing = false;
  clearInterval(playTimer);
  button('play').classList.remove('playing');
  el('play-label').textContent = t('run');
  button('step').disabled = !design || !!simulationError;
  button('cycle').disabled = !design || !!simulationError;
}
function toggleRun() {
  if (playing) { stop(); return; }
  if (!design || simulationError) return;
  if (cursor >= end) seek(0);
  playing = true;
  button('play').classList.add('playing');
  el('play-label').textContent = t('pause');
  button('step').disabled = true;
  button('cycle').disabled = true;
  let last = performance.now();
  let accruedPs = 0;
  playTimer = setInterval(() => {
    const now = performance.now();
    accruedPs += (now - last) * input('speed').valueAsNumber;
    last = now;
    if (frame?.cursor !== cursor || frame.computed < cursor) return;
    if (cursor >= end) { stop(); return; }
    const ticks = Math.floor(accruedPs / stepPs);
    if (ticks) {
      accruedPs -= ticks * stepPs;
      seek(cursor + ticks);
    }
  }, 30);
}

function shownValue(signal: Signal, time: number) {
  if (!frame || frame.computed < time) return undefined;
  const bits = signal.bits ?? [];
  if (frame.cursor === time && (frame.values.length || bits.every(bit => typeof bit !== 'number'))) {
    return bits.map(bit => typeof bit === 'number' ? frame!.values[bit] : bit);
  }
  return frame.waves[signal.id]?.findLast(change => change.time <= time)?.value;
}
function submitEdit(signal: Signal, time: number, value: Vector, duration: Duration) {
  const start = duration === 'period' ? time - time % period : time;
  cursor = Math.min(cursor, start);
  focusCursor();
  simulationError = '';
  request({ type: 'edit', id: signal.id, time, value, duration });
  status(message('stimulusUpdated', { name: signal.name, time: nsAt(start) }));
}
function handlePart(part: Part, alternate: boolean) {
  if (part.child) { scopes.push(part.child); showScope(); return; }
  const signal = design?.signals.find(item => item.id === part.signal);
  if (!signal?.editable || simulationError) return;
  if (signal.clock) { showClock(signal); return; }
  const time = cursor;
  const value = shownValue(signal, time);
  if (signal.width === 1 && !alternate && value) submitEdit(signal, time, [value[0] === '1' ? '0' : '1'], 'end');
  else showValue(signal, time, 'end', true, value);
}
function handleWave(time: number, signal?: Signal, alternate = false) {
  if (!design || simulationError || playing) return;
  if (!signal?.editable || signal.clock) { if (!alternate) seek(time); return; }
  const duration = select('duration').value as Duration;
  const value = shownValue(signal, time);
  if (!alternate && signal.width === 1 && value) submitEdit(signal, time, [value[0] === '1' ? '0' : '1'], duration);
  else showValue(signal, time, duration, false, value);
}

let editing: { signal: Signal; time: number; diagram: boolean; changedRadix: boolean } | undefined;
let valueBase: Radix = 'bin';
function showValue(signal: Signal, time: number, duration: Duration, diagram: boolean, value?: Vector) {
  editing = { signal, time, diagram, changedRadix: false };
  el('value-title').textContent = signal.name + ' · ' + signal.width + ' bit';
  el('value-time').textContent = nsAt(time) + ' ns' + (diagram ? ' · ' + t('effectiveUntilEnd') : '');
  el('value-duration-label').hidden = diagram;
  select('value-duration').value = duration;
  valueBase = radixFor(signal);
  if (value?.some(bit => bit === 'x' || bit === 'z')) valueBase = 'bin';
  select('value-radix').value = valueBase;
  input('value-input').value = value ? formatValue(value, valueBase) : '';
  el('value-error').textContent = '';
  dialog('value-dialog').showModal();
  input('value-input').focus();
  input('value-input').select();
}
on('value-radix', 'change', () => {
  if (!editing) return;
  const next = select('value-radix').value as Radix;
  editing.changedRadix = true;
  try {
    const value = parseValue(input('value-input').value, editing.signal.width, valueBase);
    input('value-input').value = formatValue(value, next);
  } catch { /* Keep unfinished input while selecting a new radix. */ }
  valueBase = next;
});
el<HTMLFormElement>('value-form').onsubmit = event => {
  event.preventDefault();
  if (!editing) return;
  try {
    const { signal, time, diagram } = editing;
    const value = parseValue(input('value-input').value, signal.width, valueBase);
    if (editing.changedRadix) setDisplayRadix(signal, valueBase);
    const duration = diagram ? 'end' : select('value-duration').value as Duration;
    submitEdit(signal, time, value, duration);
    dialog('value-dialog').close();
  } catch (error) { el('value-error').textContent = translate(errorMessage(error)); }
};

let clockTarget: Signal | undefined;
function showClock(signal: Signal) {
  clockTarget = signal;
  el('clock-title').textContent = signal.name + ' · ' + t('clockInput');
  const ticks = clockOverrides.get(signal.id);
  input('clock-period').value = ticks === undefined ? '' : String(nsAt(ticks));
  el('clock-error').textContent = '';
  dialog('clock-dialog').showModal();
}
el<HTMLFormElement>('clock-form').onsubmit = event => {
  event.preventDefault();
  if (!clockTarget) return;
  const value = input('clock-period').value === '' ? undefined : Math.round(input('clock-period').valueAsNumber * 1000) / stepPs;
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 2 || value % 2)) {
    el('clock-error').textContent = t('invalidClock');
    return;
  }
  if (value === undefined) clockOverrides.delete(clockTarget.id);
  else clockOverrides.set(clockTarget.id, value);
  simulationError = '';
  request({ type: 'clock', id: clockTarget.id, period: value });
  status(message('clockUpdated'));
  dialog('clock-dialog').close();
};

function renderPalette() {
  const names = { '0': t('logicLow'), '1': t('logicHigh'), x: t('logicUnknown'), z: t('logicHighZ') };
  const entries = Object.entries(palette) as [Logic, string][];
  el('legend').replaceChildren(...entries.map(([state, color]) => {
    const key = document.createElement('span');
    const dot = document.createElement('i');
    dot.className = 'legend-dot'; dot.style.backgroundColor = color;
    key.append(dot, names[state]);
    return key;
  }));
}
const componentColors = [
  ['input', 'inputColor', '#5b8fb2', '#1b374d'], ['output', 'output', '#bb8b56', '#4a3220'],
  ['inout', 'inoutColor', '#5c9c90', '#203d38'], ['other', 'otherColor', '#445368', '#1c2633'],
] as const;
function diagramColorControl(variable: string, captionText: () => string, initial: string) {
  const label = document.createElement('label');
  const control = document.createElement('input');
  control.type = 'color';
  let color = initial;
  try { color = localStorage.getItem(variable) ?? initial; } catch { /* Use the session color. */ }
  control.value = color;
  document.documentElement.style.setProperty(variable, control.value);
  control.oninput = () => {
    document.documentElement.style.setProperty(variable, control.value);
    try { localStorage.setItem(variable, control.value); } catch { /* Keep the session color. */ }
  };
  const caption = document.createElement('span');
  label.append(caption, control);
  return { label, refresh: () => { caption.textContent = captionText(); } };
}
const componentControls = componentColors.flatMap(([kind, name, stroke, fill]) => [
  diagramColorControl('--' + kind + '-stroke', () => t('colorBorder', { name: t(name) }), stroke),
  diagramColorControl('--' + kind + '-fill', () => t('colorFill', { name: t(name) }), fill),
]);
componentControls.push(
  diagramColorControl('--bus-outline', () => t('busBorder'), '#d4dbea'),
  diagramColorControl('--critical-color', () => t('criticalPath'), '#ff73b5'),
  diagramColorControl('--diagram-background', () => t('canvasColor'), '#121820'),
);
function showPalette() {
  el('color-controls').replaceChildren(...(Object.keys(palette) as Logic[]).map(state => {
    const label = document.createElement('label');
    const control = document.createElement('input');
    control.type = 'color'; control.value = palette[state];
    control.oninput = () => {
      palette[state] = control.value;
      try { localStorage.setItem('verilog-palette', JSON.stringify(palette)); } catch { /* Session palette remains available. */ }
      renderPalette(); draw();
    };
    label.append(state.toUpperCase(), control);
    return label;
  }));
  el('color-controls').append(...componentControls.map(control => control.label));
  dialog('color-dialog').showModal();
}

function split(id: string, variable: string, measure: (event: PointerEvent) => number) {
  const bar = el(id);
  bar.onpointerdown = event => { bar.setPointerCapture(event.pointerId); };
  bar.onpointermove = event => {
    if (bar.hasPointerCapture(event.pointerId)) document.documentElement.style.setProperty(variable, measure(event) + 'px');
  };
}

bindWorker();
on('new', 'click', () => {
  const demo = files.get('demo');
  if (demo && demo.model.getValue() === demo.saved) {
    files.delete('demo');
    demo.model.dispose();
  }
  let index = files.size;
  while ([...files.values()].some(file => file.source.name === `design${index}.sv`)) index++;
  switchTab(addFile({ id: crypto.randomUUID(), name: `design${index}.sv`, text: '' }));
  inputsChanged();
});
on('open', 'click', () => { void (async () => {
  try {
    const sources = await window.desktop.open();
    // Replace the untouched demo when opening a project.
    const demo = files.get('demo');
    if (sources.length && demo && demo.model.getValue() === demo.saved) {
      files.delete('demo');
      demo.model.dispose();
    }
    for (const source of sources) switchTab(addFile(source));
    if (sources.length) inputsChanged();
  } catch (error) { status(errorMessage(error), true); }
})(); });
on('save', 'click', () => { void save(); });
editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => { void save(); });
editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyS, () => { void save(true); });
const optionHints: Record<string, MessageKey> = {
  'mode-rtl': 'rtlHint',
  'mode-gate': 'gateHint',
  standard: 'standardHint',
  top: 'topHint',
  hierarchy: 'hierarchyHint',
  optimize: 'optimizeHint',
  observe: 'observeHint',
  abc: 'abcHint',
  'live-lint': 'lintHint',
  includes: 'includesHint',
  defines: 'definesHint',
  parameters: 'parametersHint',
  'extra-commands': 'commandsHint',
};
function renderOptionHints() {
  for (const [id, hint] of Object.entries(optionHints)) {
    el(id).title = t(hint);
    const label = el(id).closest('label');
    if (label) label.title = t(hint);
  }
}
on('settings', 'click', () => {
  const form = el<HTMLFormElement>('settings-form');
  const settingsBefore = JSON.stringify(options());
  const checked = input('live-lint').checked;
  const values = [...form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input,textarea,select')]
    .map(control => ({ control, value: control.value, checked: control instanceof HTMLInputElement && control.checked }));
  const panel = dialog('settings-dialog');
  panel.returnValue = '';
  form.onsubmit = event => {
    if ((event.submitter as HTMLButtonElement)?.value === 'apply'
      && (settingsBefore !== JSON.stringify(options()) || checked !== input('live-lint').checked)) inputsChanged();
  };
  panel.addEventListener('close', () => {
    if (panel.returnValue !== 'apply') for (const saved of values) {
      saved.control.value = saved.value;
      if (saved.control instanceof HTMLInputElement) saved.control.checked = saved.checked;
    }
  }, { once: true });
  panel.showModal();
});
on('add-include', 'click', () => { void (async () => {
  const path = await window.desktop.directory();
  if (path) el<HTMLTextAreaElement>('includes').value = [...lines('includes'), path].join('\n');
})(); });
function setModeTab(mode: BuildOptions['mode']) {
  const focusTab = document.activeElement?.closest('.mode-tabs');
  selectedMode = mode;
  for (const level of modes) {
    const tab = button('mode-' + level);
    tab.setAttribute('aria-selected', String(level === mode));
    tab.tabIndex = level === mode ? 0 : -1;
  }
  el('schematic').setAttribute('aria-labelledby', 'mode-' + mode);
  if (focusTab) button('mode-' + mode).focus();
}
for (const mode of modes) {
  const tab = button('mode-' + mode);
  tab.onclick = () => {
    if (selectedMode === mode) return;
    setModeTab(mode);
    void synthesize();
  };
  tab.onkeydown = event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const target = event.key === 'Home' ? 'rtl' : event.key === 'End' ? 'gate' : modes.find(level => level !== mode)!;
    button('mode-' + target).click();
  };
}
on('synthesize', 'click', () => { setEditorWidth(.25); void synthesize(); });
on('log-toggle', 'click', () => showLog(el('log-pane').hidden));
on('show-signals', 'click', () => { inspector = 'signals'; renderInspector(); });
on('show-parts', 'click', () => { inspector = 'parts'; renderInspector(); });
on('signal-filter', 'input', renderInspector);
on('rewind', 'click', () => { stop(); seek(0); });
on('step', 'click', () => seek(cursor + 1));
on('cycle', 'click', () => seek(cursor + period));
on('play', 'click', toggleRun);
on('diagram-in', 'click', () => schematic.scale(1.25));
on('diagram-out', 'click', () => schematic.scale(.8));
on('diagram-fit', 'click', () => schematic.fit());
on('critical-path', 'click', () => {
  const toggle = button('critical-path');
  toggle.setAttribute('aria-pressed', String(toggle.getAttribute('aria-pressed') !== 'true'));
  refreshCriticalPath();
});
on('wave-in', 'click', () => zoomWave(.5));
on('wave-out', 'click', () => zoomWave(2));
on('wave-fit', 'click', () => setView(0, end));
on('speed', 'input', () => { el('speed-label').textContent = input('speed').value + ' ns/s'; });
bindWaveRange();
on('follow', 'click', () => {
  const toggle = button('follow');
  toggle.setAttribute('aria-pressed', String(toggle.getAttribute('aria-pressed') !== 'true'));
  focusCursor(); request();
});
function changeAllDelays(zero: boolean) {
  if (!design) return;
  stop();
  cellDelays.clear();
  if (zero) for (const { type } of design.cells) cellDelays.set(type, 0);
  refreshCriticalPath();
  frame = undefined;
  simulationError = '';
  request({ type: 'delays', values: Object.fromEntries(cellDelays) });
  renderInspector();
  draw();
  status(zero ? message('delaysZeroed') : message('delaysRestored'));
}
on('zero-delays', 'click', () => changeAllDelays(true));
on('reset-delays', 'click', () => changeAllDelays(false));
on('colors', 'click', showPalette);
on('value-cancel', 'click', () => dialog('value-dialog').close());
on('clock-cancel', 'click', () => dialog('clock-dialog').close());
const timingErrors = { 'step-size': 'invalidStepField', period: 'invalidPeriodField', end: 'invalidEndField' } as Record<string, MessageKey>;
const timingForm = el<HTMLFormElement>('timing');
let timingTimer: ReturnType<typeof setTimeout> | undefined;
let timingError: Message | undefined;
function applyTiming() {
  clearTimeout(timingTimer);
  const invalid = timingForm.querySelector<HTMLInputElement>('input:invalid');
  const step = input('step-size').valueAsNumber;
  const nextEnd = Math.round(input('end').valueAsNumber * 1000) / step;
  const nextPeriod = Math.round(input('period').valueAsNumber * 1000) / step;
  let error: Message | undefined;
  if (invalid) error = message(timingErrors[invalid.id]);
  else if (!Number.isSafeInteger(nextPeriod) || nextPeriod < 2 || nextPeriod % 2) error = message('invalidClock');
  else if (!Number.isSafeInteger(nextEnd) || nextEnd < 1 || nextEnd > 100_000) error = message('invalidEnd');
  if (error) {
    timingError = error;
    status(error, true);
    return;
  }
  const previousError = timingError;
  timingError = undefined;
  if (step === stepPs && nextPeriod === period && nextEnd === end) {
    if (previousError && statusContent === previousError) status(message('timingApplied'));
    return;
  }
  stop();
  const resetInputs = stepPs !== step;
  stepPs = step; period = nextPeriod; end = nextEnd;
  refreshCriticalPath();
  if (resetInputs) { cursor = 0; clockOverrides.clear(); }
  cursor = Math.min(cursor, end);
  viewStart = 0; viewSpan = end;
  frame = undefined; simulationError = '';
  updateNavigation();
  draw();
  request({ type: 'timing', timing: simTiming(), resetInputs });
  status(resetInputs ? message('stepChanged') : message('timingUpdated'));
}
// Let multi-digit edits settle before rescaling time and resetting the stimulus.
timingForm.oninput = () => {
  clearTimeout(timingTimer);
  timingTimer = setTimeout(applyTiming, 450);
};
timingForm.onchange = applyTiming;
timingForm.onkeydown = event => {
  if (event.key === 'Enter') { event.preventDefault(); applyTiming(); }
};
timingForm.onsubmit = event => { event.preventDefault(); applyTiming(); };

const workspace = el('workspace');
let editorFraction = 1;
function setEditorWidth(fraction: number) {
  editorFraction = Math.max(0, Math.min(1, fraction));
  workspace.dataset.editor = editorFraction === 0 ? 'hidden' : editorFraction === 1 ? 'full' : 'split';
  workspace.style.setProperty('--editor-width', editorFraction * 100 + '%');
}
on('editor-less', 'click', () => setEditorWidth(editorFraction > .2501 ? .25 : 0));
on('editor-more', 'click', () => setEditorWidth(editorFraction < .2499 ? .25 : 1));
const divider = el('editor-split');
divider.onpointerdown = event => {
  if (event.button === 0 && event.target === divider) divider.setPointerCapture(event.pointerId);
};
divider.onpointermove = event => {
  if (!divider.hasPointerCapture(event.pointerId)) return;
  const bounds = workspace.getBoundingClientRect();
  const fraction = (event.clientX - bounds.left) / bounds.width;
  setEditorWidth(fraction < .02 ? 0 : fraction > .98 ? 1 : fraction);
};
split('inspect-split', '--inspect-width', event => Math.max(174, Math.min(innerWidth - 580, innerWidth - event.clientX - 9)));
split('wave-split', '--wave-height', event => Math.max(130, Math.min(innerHeight - 310, innerHeight - event.clientY - 27)));
function renderLanguage() {
  const locale = getLocale();
  document.documentElement.lang = locale;
  for (const choice of languageChoices) choice.setAttribute('aria-pressed', String(choice.value === locale));
  el('editor-language-note').hidden = locale === startupLocale;
  for (const element of document.querySelectorAll<HTMLElement>('[data-i18n]')) {
    element.textContent = t(element.dataset.i18n as MessageKey);
  }
  for (const name of ['title', 'aria-label', 'placeholder']) {
    for (const element of document.querySelectorAll(`[data-i18n-${name}]`)) {
      element.setAttribute(name, t(element.getAttribute(`data-i18n-${name}`) as MessageKey));
    }
  }
  renderOptionHints();
  renderLog();
  status(statusContent, el('status').classList.contains('error'));
  lintStatus(lintContent);
  renderSynthesisStatus();
  el('play-label').textContent = t(playing ? 'pause' : 'run');
  el('signal-menu').hidden = true;
  renderTabs();
  renderInspector();
  renderPalette();
  for (const control of componentControls) control.refresh();
  refreshCriticalPath();
  schematic.refreshLanguage();
  waveform.refreshLanguage();
  draw();
}
for (const choice of languageChoices) {
  choice.onclick = () => {
    languageMenu.hidePopover();
    const locale = isEnglish(choice.value) ? 'en' : 'zh-CN';
    if (locale !== getLocale()) {
      setLocale(locale);
      try { localStorage.setItem(localeStorageKey, locale); } catch { /* Keep the session preference. */ }
      renderLanguage();
    }
    languageControl.focus();
  };
}

switchTab(addFile({ id: 'demo', name: 'counter.sv', text: sample }));
updateNavigation();
renderLanguage();
queueLint();
