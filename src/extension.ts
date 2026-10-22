import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { spawn } from 'child_process';
import { Form, MethodForm, MethodTarget, RouteForm, RouteTarget, Setup, Target, keyOf } from './types';
import { bodyTemplate, convert, findMethods, findRoutes, kindOf } from './parse';
import { ANY, matches, redact } from './redact';
import { caseToForm, formToCase, loadCases, removeCase, secretFields, stripSecrets, upsertCase } from './cases';
import { daemons, getDaemon } from './daemon';
import { generateJest } from './jest';
import * as views from './views';
import { resolveEnvironment } from './environment';
import { attachDiagnostic } from './diagnostics';

// ---------------------------------------------------------------- activate
export function activate(ctx: vscode.ExtensionContext) {
  try {
    ctx.subscriptions.push(
      vscode.languages.registerCodeLensProvider({ language: 'typescript' }, new LensProvider()),
      vscode.commands.registerCommand('nestRun.run', (arg?: unknown) => {
        const target = resolveTarget(arg);
        if (target) return openTarget(ctx, target, false);
      }),
      vscode.commands.registerCommand('nestRun.debug', (arg?: unknown) => {
        const target = resolveTarget(arg);
        if (target) return openTarget(ctx, target, true);
      }),
      // a saved file (or changed setting) means the warm process is out of date
      vscode.workspace.onDidSaveTextDocument((doc) => {
        const f = doc.fileName.toLowerCase();
        if (f.includes('node_modules') || f.includes('.nest-run')) return;
        for (const d of daemons.values()) if (f.startsWith(d.root.toLowerCase())) d.stale = true;
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('nestRun')) for (const d of daemons.values()) d.stale = true;
      }),
      { dispose: () => daemons.forEach((d) => d.dispose()) },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Nest Run & Debug failed to activate: ${msg}`);
    throw err;
  }
}

export function deactivate() {}

// ---------------------------------------------------------------- buttons above methods and routes
const SKIP = new Set(['constructor', 'if', 'for', 'while', 'switch', 'catch', 'function', 'return']);

interface Found {
  pos: vscode.Position; // where the buttons are drawn (start of the method / route)
  target: Target;
}

class LensProvider implements vscode.CodeLensProvider {
  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    return LensProvider.find(doc).flatMap(({ pos, target }) => {
      const range = new vscode.Range(pos, pos);
      const run = target.kind === 'route' ? '▶ Send request' : '▶ Run';
      return [
        new vscode.CodeLens(range, { title: run, command: 'nestRun.run', arguments: [target] }),
        new vscode.CodeLens(range, { title: '🐞 Debug', command: 'nestRun.debug', arguments: [target] }),
      ];
    });
  }

  /** Every runnable service method / controller route in the file, in file order. */
  static find(doc: vscode.TextDocument): Found[] {
    if (/\.(spec|test|e2e-spec)\.ts$/.test(doc.fileName)) return [];
    try {
      const text = doc.getText();
      const found: Found[] = [];

      // ---- controller routes: ▶ Send request
      if (text.includes('@Controller')) {
        for (const r of findRoutes(text)) {
          const pos = doc.positionAt(r.decoratorOffset);
          const target: RouteTarget = {
            kind: 'route',
            uri: doc.uri,
            className: r.className,
            method: r.method,
            httpMethod: r.httpMethod,
            routePath: r.routePath,
            pathParams: r.pathParams,
            hasBody: r.hasBody,
            bodyType: r.bodyType,
            bodyLine: doc.positionAt(r.bodyOffset).line,
          };
          found.push({ pos, target });
        }
      }

      // ---- service methods: ▶ Run
      if (text.includes('@Injectable') && !text.includes('@Controller')) {
        for (const method of findMethods(text)) {
          if (SKIP.has(method.method)) continue;
          const pos = doc.positionAt(method.methodOffset);
          let bodyLine = doc.positionAt(method.bodyOffset).line;
          while (bodyLine < doc.lineCount - 1 && /^\s*(\/\/.*)?$/.test(doc.lineAt(bodyLine).text)) bodyLine++;
          found.push({
            pos,
            target: { kind: 'method', uri: doc.uri, className: method.className, method: method.method, params: method.params, bodyLine },
          });
        }
      }
      return found.sort((a, b) => a.pos.line - b.pos.line);
    } catch {
      return [];
    }
  }
}

/** The method / route the cursor is in. Used when a command runs from the Command Palette or a keyboard shortcut. */
function targetAtCursor(): Target | undefined {
  const ed = vscode.window.activeTextEditor;
  if (!ed || ed.document.languageId !== 'typescript') {
    vscode.window.showInformationMessage('Open a NestJS service or controller file and put the cursor inside a method first.');
    return undefined;
  }
  const line = ed.selection.active.line;
  let best: Found | undefined;
  for (const f of LensProvider.find(ed.document)) if (f.pos.line <= line) best = f; // last one that starts on or above the cursor
  if (!best) {
    vscode.window.showInformationMessage('No service method or API route found at the cursor. Click inside a method, then try again.');
    return undefined;
  }
  return best.target;
}

/** The buttons above a method pass the target; the Command Palette passes nothing, so use the cursor. */
function resolveTarget(arg: unknown): Target | undefined {
  const isTarget = !!arg && typeof arg === 'object' && 'kind' in arg && 'uri' in arg && 'method' in arg;
  return isTarget ? (arg as Target) : targetAtCursor();
}

// ---------------------------------------------------------------- find the project
// The folder opened in VS Code may be a parent of the Nest project, so use the
// nearest package.json above the file you clicked on.
function findProjectRoot(filePath: string, fallback: string): string {
  let dir = path.dirname(filePath);
  for (;;) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return fallback;
    dir = parent;
  }
}

function resolveFrom(root: string, name: string): string | undefined {
  try {
    return require.resolve(name, { paths: [root] });
  } catch {
    return undefined;
  }
}

/** Everything needed to start the project; asks before touching something that looks like production. */
async function prepare(ctx: vscode.ExtensionContext, uri: vscode.Uri): Promise<(Setup & { db?: string; dbSafety: string }) | undefined> {
  const wsFolder = vscode.workspace.getWorkspaceFolder(uri);
  if (!wsFolder) {
    vscode.window.showErrorMessage('Open your Nest project as a folder first.');
    return undefined;
  }
  const root = findProjectRoot(uri.fsPath, wsFolder.uri.fsPath);

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (!process.execPath || !fs.existsSync(process.execPath) || nodeMajor < 18) {
    vscode.window.showErrorMessage('Nest Run & Debug requires the VS Code extension host to use Node.js 18 or newer.');
    return undefined;
  }

  const tsNode = resolveFrom(root, 'ts-node/register');
  const tsPaths = resolveFrom(root, 'tsconfig-paths/register');
  const missing = [!tsNode && 'ts-node', !tsPaths && 'tsconfig-paths'].filter(Boolean);
  if (missing.length) {
    vscode.window.showErrorMessage(
      `Not found in ${root}: ${missing.join(', ')}. Open a terminal there and run:  npm i -D ts-node tsconfig-paths`,
    );
    return undefined;
  }

  const cfg = vscode.workspace.getConfiguration('nestRun');
  const overrides: NodeJS.ProcessEnv = {
    NEST_RUN_APP_MODULE: cfg.get<string>('appModule', 'src/app.module'),
    NEST_RUN_MAIN: cfg.get<string>('mainFile', 'src/main'),
  };
  if (cfg.get<boolean>('fastMode', false)) overrides.TS_NODE_TRANSPILE_ONLY = 'true';
  const resolved = resolveEnvironment(root, overrides);
  const db = resolved.database.label;
  const words = cfg.get<string[]>('productionWords', []);
  const wordWarning = db && words.some((w) => w && db.toLowerCase().includes(w.toLowerCase()));
  if (resolved.database.safety === 'remote' || resolved.database.safety === 'unknown' || wordWarning) {
    const pick = await vscode.window.showWarningMessage(
      `Database target: ${db ?? 'unknown'}. ${resolved.database.reason} Running a service method can create, update, or delete records; this is not a rollback or dry run. Continue?`,
      { modal: true },
      'Continue',
    );
    if (pick !== 'Continue') return undefined;
  }

  const appModule = overrides.NEST_RUN_APP_MODULE!;
  const fast = cfg.get<boolean>('fastMode', false);
  const executionTimeoutMs = cfg.get<number>('executionTimeoutMs', 30_000);
  const httpTimeoutMs = cfg.get<number>('httpTimeoutMs', executionTimeoutMs);
  const startupTimeoutMs = cfg.get<number>('startupTimeoutMs', 60_000);
  const env: NodeJS.ProcessEnv = {
    ...resolved.env,
    NEST_RUN_HTTP_TIMEOUT_MS: String(httpTimeoutMs),
    NEST_RUN_STARTUP_TIMEOUT_MS: String(startupTimeoutMs),
  };

  return {
    root,
    db,
    dbSafety: resolved.database.safety,
    runner: path.join(ctx.extensionPath, 'runner', 'run-method.js'),
    preload: ['-r', tsNode as string, '-r', tsPaths as string],
    env,
    keepWarm: cfg.get<boolean>('keepWarm', true),
    fast,
    appModule,
    workspaceFolder: wsFolder,
    extensionDirName: path.basename(ctx.extensionPath),
    executionTimeoutMs,
    httpTimeoutMs,
    startupTimeoutMs,
  };
}

// ---------------------------------------------------------------- run a request (warm, one-shot, or under the debugger)
const emptyReport = (message: string, stack = '') => ({ calls: [], logs: [], ms: 0, bootMs: 0, meta: { deps: [] }, error: { message, stack } });

function readReport(outFile: string, log: string): any {
  try {
    const report = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    fs.unlinkSync(outFile);
    return report;
  } catch {
    return emptyReport('The runner did not finish. Check that ts-node and tsconfig-paths are installed in your project.', log || '(no output)');
  }
}

interface RunControl {
  id: string;
  promise: Promise<any>;
  cancel: () => void;
}

function runRequest(
  setup: Setup,
  target: Target,
  req: Record<string, unknown>,
  debug: boolean,
  status: (message: string) => void,
): RunControl {
  // ---- warm background process: starts your app once, then every run is quick
  if (!debug && setup.keepWarm) {
    const d = getDaemon(setup.root, [...setup.preload, setup.runner, '--serve'], setup.env);
    status(
      d.warm
        ? 'Running…'
        : 'Starting your app… this takes a few seconds the first time (and after you save a file). Next runs are quick.',
    );
    const handle = d.run(req, setup.executionTimeoutMs);
    return { ...handle, promise: handle.promise.then((report) => attachDiagnostic(report, handle.id)) };
  }

  const stamp = Date.now() + Math.floor(Math.random() * 1000);
  const reqFile = path.join(os.tmpdir(), `nest-run-${stamp}-in.json`);
  const outFile = path.join(os.tmpdir(), `nest-run-${stamp}.json`);
  fs.writeFileSync(reqFile, JSON.stringify(req));
  const args = [reqFile, outFile];

  // ---- one fresh process
  if (!debug) {
    const runId = `run-${stamp.toString(36)}`;
    let child: ReturnType<typeof spawn> | undefined;
    let complete: (report: any) => void = () => undefined;
    let timer: NodeJS.Timeout | undefined;
    status('Running…');
    const promise = new Promise<any>((resolve) => {
      let log = '';
      let settled = false;
      complete = (report) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        try { if (fs.existsSync(reqFile)) fs.unlinkSync(reqFile); } catch { /* ignore */ }
        try { if (fs.existsSync(outFile)) fs.unlinkSync(outFile); } catch { /* ignore */ }
        resolve(attachDiagnostic({ ...report, runId }, runId));
      };
      child = spawn(process.execPath, [...setup.preload, setup.runner, ...args], { cwd: setup.root, env: setup.env });
      child.stdout?.on('data', (d) => (log += d));
      child.stderr?.on('data', (d) => (log += d));
      child.on('error', (e) => (log += `\nCould not start "node": ${e.message}\nMake sure Node.js is installed and on your PATH.`));
      child.on('close', () => {
        complete(readReport(outFile, log));
      });
      timer = setTimeout(() => {
        try { child?.kill(); } catch { /* ignore */ }
        complete(emptyReport(`Run timed out after ${setup.executionTimeoutMs} ms.`));
      }, setup.executionTimeoutMs);
    });
    return {
      id: runId,
      promise,
      cancel: () => {
        try { child?.kill(); } catch { /* ignore */ }
        complete(emptyReport('Run cancelled by the user.'));
      },
    };
  }

  // ---- 🐞 VS Code debugger, paused on the first line of the method / route
  status('Debugging… step through in the editor. The result will show here when it finishes.');
  const sessionName = `Debug ${keyOf(target)} #${stamp}`;
  const runId = `run-${stamp.toString(36)}`;
  let debugDone = false;
  let cancelDebug = () => undefined;
  const bp = new vscode.SourceBreakpoint(new vscode.Location(target.uri, new vscode.Position(target.bodyLine, 0)));
  vscode.debug.addBreakpoints([bp]);
  const promise = new Promise<any>((resolve) => {
    const finish = () => {
      if (debugDone) return;
      debugDone = true;
      sub.dispose();
      vscode.debug.removeBreakpoints([bp]);
      try { fs.unlinkSync(reqFile); } catch { /* ignore */ }
      resolve(attachDiagnostic({ ...readReport(outFile, ''), runId }, runId));
    };
    cancelDebug = () => { void vscode.debug.stopDebugging(); };
    const sub = vscode.debug.onDidTerminateDebugSession((s) => {
      if (s.name === sessionName) finish();
    });
    vscode.debug
      .startDebugging(setup.workspaceFolder, {
        type: 'node',
        request: 'launch',
        name: sessionName,
        program: setup.runner,
        args,
        runtimeArgs: setup.preload,
        cwd: setup.root,
        // Let the VS Code JavaScript debugger resolve Node.js from PATH.
        // process.execPath may be the VS Code/Electron executable, not node.exe.
        env: setup.env,
        console: 'internalConsole',
        internalConsoleOptions: 'neverOpen',
        sourceMaps: true,
        skipFiles: ['<node_internals>/**', '**/node_modules/**', `**/${setup.extensionDirName}/runner/**`],
      })
      .then((started) => {
        if (!started && !debugDone) {
          debugDone = true;
          sub.dispose();
          vscode.debug.removeBreakpoints([bp]);
          try { if (fs.existsSync(reqFile)) fs.unlinkSync(reqFile); } catch { /* ignore */ }
          try { if (fs.existsSync(outFile)) fs.unlinkSync(outFile); } catch { /* ignore */ }
          resolve(attachDiagnostic({
            ...emptyReport('VS Code could not start the Node.js debugger. Check that the built-in JavaScript Debugger is enabled and Node.js is available on PATH.'),
            runId,
          }, runId));
        }
      }, (error: unknown) => {
        if (debugDone) return;
        debugDone = true;
        sub.dispose();
        vscode.debug.removeBreakpoints([bp]);
        try { if (fs.existsSync(reqFile)) fs.unlinkSync(reqFile); } catch { /* ignore */ }
        try { if (fs.existsSync(outFile)) fs.unlinkSync(outFile); } catch { /* ignore */ }
        const message = error instanceof Error ? error.message : String(error);
        resolve(attachDiagnostic({
          ...emptyReport(`Could not start the Node.js debugger: ${message}`),
          runId,
        }, runId));
      });
  });
  // Manual debugger sessions do not have an automatic timeout; Cancel stops the actual debug session.
  return { id: runId, promise, cancel: () => { if (!debugDone) cancelDebug(); } };
}

// ---------------------------------------------------------------- turn the form into a request
interface Built {
  req?: Record<string, unknown>;
  shown?: any;
  error?: string;
}

function buildRequest(target: Target, form: Form): Built {
  if (target.kind === 'method') {
    const f = form as MethodForm;
    const params: unknown[] = [];
    const shown: Record<string, unknown> = {};
    target.params.forEach((p, i) => {
      const typeKind = kindOf(p.type);
      const kind = typeKind === 'any' ? f.kinds[i] || 'text' : typeKind;
      const v = convert(f.values[i] ?? '', kind);
      params.push(v);
      shown[p.name] = v === undefined ? null : v;
    });
    return { req: { type: 'call', file: target.uri.fsPath, className: target.className, method: target.method, params }, shown };
  }

  const f = form as RouteForm;
  let body: unknown;
  if (target.hasBody && f.body.trim() !== '') {
    try {
      body = JSON.parse(f.body);
    } catch (e: any) {
      return { error: `The body is not valid JSON: ${e.message}` };
    }
  }
  const headers: Record<string, string> = {};
  for (const line of f.headers.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0 && line.slice(0, i).trim()) headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const token = f.token.trim();
  if (token && !Object.keys(headers).some((h) => h.toLowerCase() === 'authorization')) {
    headers['Authorization'] = /^bearer\s/i.test(token) ? token : `Bearer ${token}`;
  }
  const pathText = f.path.replace(/:(\w+)/g, (_m, n) => encodeURIComponent(f.pathParams?.[n] ?? ''));
  const query = f.query.trim().replace(/^\?/, '');
  return {
    req: { type: 'http', httpMethod: target.httpMethod, path: pathText, query, headers, body },
    shown: { method: target.httpMethod, path: pathText, query },
  };
}

// ---------------------------------------------------------------- compare a run with a saved result
function expectedOf(target: Target, report: any): any {
  if (target.kind === 'method') {
    return report.error ? { error: report.error.message } : { output: redact(report.output, ANY) };
  }
  if (report.error || !report.http) return undefined;
  return { status: report.http.status, body: redact(report.http.body, ANY) };
}

function compare(target: Target, expected: any, report: any): { status: 'pass' | 'fail' | 'none' | 'error'; note: string } {
  if (target.kind === 'method' && report.error && !(expected && expected.error !== undefined)) {
    return { status: expected ? 'fail' : 'error', note: `Error: ${report.error.message}` };
  }
  if (target.kind === 'route' && (report.error || !report.http)) {
    return { status: 'error', note: report.error ? report.error.message : 'No response' };
  }
  if (!expected) {
    return { status: 'none', note: target.kind === 'route' ? `${report.http.status}` : 'ran without error' };
  }
  if (target.kind === 'method') {
    if (expected.error !== undefined) {
      const ok = report.error && report.error.message === expected.error;
      return ok ? { status: 'pass', note: 'same error' } : { status: 'fail', note: `expected error "${expected.error}"` };
    }
    return matches(report.output, expected.output)
      ? { status: 'pass', note: 'same output' }
      : { status: 'fail', note: 'output is different from the saved one' };
  }
  if (report.http.status !== expected.status) {
    return { status: 'fail', note: `status ${report.http.status}, saved ${expected.status}` };
  }
  return matches(report.http.body, expected.body)
    ? { status: 'pass', note: `${report.http.status}, same body` }
    : { status: 'fail', note: `${report.http.status}, but the body is different` };
}

// ---------------------------------------------------------------- the panel for one method / route
function isWebviewMessage(value: unknown): value is { type: string; mode?: string; name?: string; form?: Form } {
  if (!value || typeof value !== 'object' || typeof (value as { type?: unknown }).type !== 'string') return false;
  const message = value as { type: string; mode?: unknown; name?: unknown; form?: unknown };
  if (!['again', 'submit', 'saveCase', 'loadCase', 'runCase', 'deleteCase', 'runAll', 'createTest', 'cancelRun'].includes(message.type)) return false;
  if (message.name !== undefined && (typeof message.name !== 'string' || message.name.length > 200)) return false;
  if (message.type === 'submit' && (message.mode !== 'run' && message.mode !== 'debug')) return false;
  if (message.form !== undefined && (!message.form || typeof message.form !== 'object')) return false;
  return true;
}

async function openTarget(ctx: vscode.ExtensionContext, target: Target, startInDebug: boolean) {
  const setup = await prepare(ctx, target.uri);
  if (!setup) return;

  const key = keyOf(target);
  const memKey = `nestRun:form:${key}`;
  const tokenKey = `nestRun:token:${setup.root}`;
  const base: views.Base = { className: target.className, method: target.method, db: setup.db, root: setup.root };

  const panel = vscode.window.createWebviewPanel('nestRun', key, vscode.ViewColumn.Beside, {
    enableScripts: true,
    localResourceRoots: [ctx.extensionUri],
  });
  let busy = false;
  let lastForm: Form | undefined;
  let lastReport: any;
  let lastReq: Record<string, unknown> | undefined;
  let activeRun: RunControl | undefined;

  // starter body for a route, built from the DTO class
  let template = '';
  if (target.kind === 'route' && target.hasBody && target.bodyType) {
    try {
      template = bodyTemplate(target.uri.fsPath, fs.readFileSync(target.uri.fsPath, 'utf8'), target.bodyType, setup.root) ?? '';
    } catch {
      /* no template */
    }
  }

  const defaultForm = (): Form =>
    target.kind === 'method'
      ? { values: target.params.map(() => ''), kinds: target.params.map(() => 'text') }
      : { path: target.routePath, pathParams: {}, query: '', headers: '', token: '', body: template };

  const remembered = (): Form => {
    const saved = ctx.workspaceState.get<Form>(memKey);
    const d = defaultForm();
    if (!saved) return d;
    return target.kind === 'method'
      ? { ...(d as MethodForm), ...(saved as MethodForm) }
      : { ...(d as RouteForm), ...(saved as RouteForm) };
  };

  const showForm = async (debugDefault: boolean, form?: Form) => {
    const f: Form = form ?? remembered();
    if (target.kind === 'route') (f as RouteForm).token = (await ctx.secrets.get(tokenKey)) ?? (f as RouteForm).token ?? '';
    lastForm = f;
    panel.webview.html = views.formPage(base, target, f, loadCases(setup.root, key).map((c) => c.name), debugDefault);
  };

  const remember = async (form: Form) => {
    if (target.kind === 'route') {
      const rf = form as RouteForm;
      if (rf.token.trim()) await ctx.secrets.store(tokenKey, rf.token.trim()); // the token lives in the secret store, never in a file
      await ctx.workspaceState.update(memKey, { ...rf, token: '' });
    } else await ctx.workspaceState.update(memKey, form);
  };

  // run once with a form, returns the report (does not draw anything)
  const runForm = (form: Form, debug: boolean, status: (m: string) => void) => {
    const built = buildRequest(target, form);
    if (built.error) return { built, report: emptyReport(built.error) };
    return { built, run: runRequest(setup, target, built.req!, debug, status) };
  };

  const execute = async (debug: boolean, form: Form) => {
    const built = buildRequest(target, form);
    if (built.error) {
      panel.webview.html = views.statusPage(base, built.error, true, true);
      lastForm = form;
      return;
    }
    await remember(form);
    const started = runForm(form, debug, (m) => (panel.webview.html = views.runningPage(base, m)));
    const report = 'report' in started ? started.report : await (activeRun = started.run).promise;
    activeRun = undefined;
    lastForm = form;
    lastReport = report;
    lastReq = built.req;
    panel.webview.html = views.resultPage(base, target, built.shown, report);
  };

  const runAll = async () => {
    const cases = loadCases(setup.root, key);
    if (!cases.length) return;
    const confirm = await vscode.window.showWarningMessage(
      `Run all ${cases.length} saved cases? They may create, update, or delete records and are not rolled back.`,
      { modal: true },
      'Run all',
    );
    if (confirm !== 'Run all') return;
    const token = target.kind === 'route' ? (await ctx.secrets.get(tokenKey)) ?? '' : '';
    const rows: views.CaseRow[] = [];
    for (let i = 0; i < cases.length; i++) {
      const c = cases[i];
      panel.webview.html = views.runAllPage(base, rows, `Running case ${i + 1} of ${cases.length}: ${c.name}`);
      const form = caseToForm(target, c, token, lastForm);
      const started = runForm(form, false, () => undefined);
      const report = 'report' in started ? started.report : await (activeRun = started.run).promise;
      activeRun = undefined;
      if (started.built.error) rows.push({ name: c.name, status: 'error', note: started.built.error, ms: 0 });
      else {
        const r = compare(target, c.expected, report);
        rows.push({ name: c.name, status: r.status, note: r.note, ms: report.ms ?? 0 });
      }
    }
    panel.webview.html = views.runAllPage(base, rows);
  };

  const saveCase = async (name: string, form: Form | undefined, withResult: boolean) => {
    name = (name || '').trim();
    if (!name) {
      vscode.window.showInformationMessage('Type a name for the case first, for example "wrong password".');
      return false;
    }
    if (!form) {
      vscode.window.showInformationMessage('Nothing to save yet. Run it once first.');
      return false;
    }
    let toSave = form;
    const secrets = secretFields(target, form);
    if (secrets.length) {
      const pick = await vscode.window.showWarningMessage(
        `These fields look like secrets: ${[...new Set(secrets)].join(', ')}. Cases are saved in a file inside your project, which your team may share. Save the case without those values?`,
        { modal: true },
        'Save without values',
      );
      if (!pick) return false;
      toSave = stripSecrets(target, form);
    }
    const expected = withResult && lastReport ? expectedOf(target, lastReport) : undefined;
    upsertCase(setup.root, key, formToCase(target, toSave, name, expected));
    vscode.window.showInformationMessage(`Saved case "${name}" in .nest-run/cases`);
    return true;
  };

  const createTest = async () => {
    if (!lastReport || !lastReq) {
      vscode.window.showInformationMessage('Run it first, then create the test from that run.');
      return;
    }
    if (lastReport.error && !lastReport.calls.length && (target.kind === 'route' || !lastReport.bootMs)) {
      vscode.window.showWarningMessage('The last run did not start properly, so there is nothing to make a test from.');
      return;
    }
    const testName = await vscode.window.showInputBox({
      prompt: 'Name of the test',
      value: lastReport.error ? 'throws the same error' : 'returns the recorded result',
      ignoreFocusOut: true,
    });
    if (!testName) return;

    const file = target.uri.fsPath;
    const dir = path.dirname(file);
    const stem = path.basename(file).replace(/\.ts$/, '');
    const { content, notes } = generateJest({
      kind: target.kind,
      className: target.className,
      method: target.method,
      testName,
      specDir: dir,
      targetFile: file,
      report: lastReport,
      paramNames: target.kind === 'method' ? target.params.map((p) => p.name) : undefined,
      args: target.kind === 'method' ? (lastReq.params as unknown[]) : undefined,
      http:
        target.kind === 'route' && lastReport.http
          ? { method: lastReport.http.method, headers: lastReport.sentHeaders || {}, body: lastReport.sentBody }
          : undefined,
      appModuleFile: path.join(setup.root, setup.appModule + '.ts'),
    });

    const suffix = target.kind === 'route' ? 'e2e-spec' : 'spec';
    let out = path.join(dir, `${stem}.${target.method}.${suffix}.ts`);
    for (let n = 2; fs.existsSync(out); n++) out = path.join(dir, `${stem}.${target.method}.${n}.${suffix}.ts`);
    fs.writeFileSync(out, content);
    const doc = await vscode.workspace.openTextDocument(out);
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preview: false });
    vscode.window.showInformationMessage(`Test created: ${path.basename(out)}. ${notes[0]}`);
  };

  panel.webview.onDidReceiveMessage(async (msg: unknown) => {
    try {
      if (!isWebviewMessage(msg)) return;
      if (msg.type === 'cancelRun') {
        activeRun?.cancel();
        panel.webview.html = views.runningPage(base, 'Cancelling run and cleaning up its process…');
        return;
      }
      if (msg.type === 'again') return void (await showForm(false, lastForm));
      if (busy) return;
      busy = true;
      try {
        switch (msg.type) {
          case 'submit':
            await execute(msg.mode === 'debug', msg.form as Form);
            break;
          case 'saveCase': {
            // from the form: save the typed inputs. From a result: save the inputs of that run, with its result.
            const fromForm = !!msg.form;
            const ok = await saveCase(msg.name ?? '', (msg.form as Form) ?? lastForm, !fromForm);
            if (ok && fromForm) await showForm(false, msg.form as Form);
            break;
          }
          case 'loadCase': {
            const c = loadCases(setup.root, key).find((x) => x.name === msg.name);
            if (c) {
              const token = target.kind === 'route' ? (await ctx.secrets.get(tokenKey)) ?? '' : '';
              await showForm(false, caseToForm(target, c, token, lastForm));
            }
            break;
          }
          case 'runCase': {
            const c = loadCases(setup.root, key).find((x) => x.name === msg.name);
            if (c) {
              const token = target.kind === 'route' ? (await ctx.secrets.get(tokenKey)) ?? '' : '';
              await execute(false, caseToForm(target, c, token, lastForm));
            }
            break;
          }
          case 'deleteCase': {
            const pick = await vscode.window.showWarningMessage(`Delete the case "${msg.name}"?`, { modal: true }, 'Delete');
            if (pick === 'Delete') {
              removeCase(setup.root, key, msg.name ?? '');
              await showForm(false, lastForm);
            }
            break;
          }
          case 'runAll':
            await runAll();
            break;
          case 'createTest':
            await createTest();
            break;
        }
      } finally {
        busy = false;
      }
    } catch (e: any) {
      busy = false;
      panel.webview.html = views.statusPage(base, `Something went wrong: ${e?.message ?? e}`, true, true);
    }
  });

  // nothing to ask for a method without parameters: go straight away
  if (target.kind === 'method' && target.params.length === 0) {
    busy = true;
    execute(startInDebug, defaultForm()).finally(() => (busy = false));
  } else {
    await showForm(startInDebug);
  }
}
