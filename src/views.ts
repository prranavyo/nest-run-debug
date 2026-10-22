import { Form, MethodForm, MethodTarget, RouteForm, RouteTarget, Target } from './types';
import { kindOf } from './parse';
import { maskReport, redact } from './redact';
import { randomBytes } from 'crypto';

export const esc = (s: unknown) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
export const pretty = (v: unknown) => esc(JSON.stringify(v ?? null, null, 2));

export type Base = { className: string; method: string; db?: string; root: string };

const STYLE = `
  body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:12px}
  pre{background:var(--vscode-textCodeBlock-background);padding:8px;border-radius:4px;overflow:auto;white-space:pre-wrap;word-break:break-word}
  .card{border:1px solid var(--vscode-panel-border);border-radius:6px;padding:8px 12px;margin:2px 0}
  .arrow{text-align:center;opacity:.6;margin:4px 0}
  .muted{opacity:.7;font-size:.9em}
  .err{color:var(--vscode-errorForeground)}
  .ok{color:var(--vscode-testing-iconPassed,#3fb950)}
  .tag{display:inline-block;font-size:.75em;padding:0 6px;border-radius:8px;margin-right:4px;
    background:var(--vscode-badge-background);color:var(--vscode-badge-foreground)}
  table{border-collapse:collapse;margin-top:6px}
  th,td{border:1px solid var(--vscode-panel-border);padding:3px 8px;text-align:left;vertical-align:top}
  label{display:block;margin:12px 0 4px;font-weight:600}
  input,select,textarea{width:100%;box-sizing:border-box;padding:6px;color:var(--vscode-input-foreground);
    background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,var(--vscode-panel-border));
    border-radius:3px;font-family:var(--vscode-editor-font-family)}
  button{margin:12px 8px 0 0;padding:6px 14px;border:0;border-radius:3px;cursor:pointer;
    color:var(--vscode-button-foreground);background:var(--vscode-button-background)}
  button.second{color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground)}
  .bar{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:12px;padding:8px;
    border:1px dashed var(--vscode-panel-border);border-radius:6px}
  .bar select,.bar input{width:auto;flex:1;min-width:140px}
  .bar button{margin:0}
`;

const SCRIPT_BASE = `const vscode = acquireVsCodeApi();
function post(type, extra){ vscode.postMessage(Object.assign({type}, extra || {})); }
// CSP blocks inline onclick attributes. Delegate clicks from this nonce-authorized script.
document.addEventListener('click', (event) => {
  const target = event.target;
  const button = target instanceof Element ? target.closest('button[data-action]') : null;
  if (!button) return;
  const action = button.dataset.action;
  const selectedCase = () => document.getElementById('caseSel')?.value || '';
  const caseName = () => document.getElementById('caseName')?.value || '';
  switch (action) {
    case 'again': post('again'); break;
    case 'cancel-run': post('cancelRun'); break;
    case 'create-test': post('createTest'); break;
    case 'run-all': post('runAll'); break;
    case 'case-load': post('loadCase', {name: selectedCase()}); break;
    case 'case-run': post('runCase', {name: selectedCase()}); break;
    case 'case-delete': post('deleteCase', {name: selectedCase()}); break;
    case 'case-open': post('loadCase', {name: button.dataset.name || ''}); break;
    case 'save-case-form': {
      const payload = {name: caseName()};
      if (typeof collect === 'function') payload.form = collect();
      post('saveCase', payload);
      break;
    }
    case 'save-case-result': post('saveCase', {name: caseName()}); break;
    case 'submit-run': if (typeof send === 'function') send('run'); break;
    case 'submit-debug': if (typeof send === 'function') send('debug'); break;
    case 'toggle-secrets': if (typeof toggle === 'function') toggle(); break;
  }
});`;

function topInfo(b: Base): string {
  return `<h2>${esc(b.className)}.${esc(b.method)}</h2>
    <div class="muted">Project: ${esc(b.root)}</div>
    <div class="muted">Database: ${esc(b.db ?? 'unknown (no DATABASE_URL in .env)')}</div>`;
}

const wrap = (inner: string, script = '') => {
  const nonce = randomBytes(16).toString('base64');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src vscode-resource: data:; font-src vscode-resource:"><style>${STYLE}</style></head><body>${inner}<script nonce="${nonce}">${SCRIPT_BASE}\n${script}</script></body></html>`;
};

// ---------------------------------------------------------------- simple status page
export function statusPage(b: Base, message: string, isError = false, again = false, canCancel = false): string {
  return wrap(
    `${topInfo(b)}${again ? `<button data-action="again">↻ Back to inputs</button>` : ''}<p class="${isError ? 'err' : 'muted'}">${esc(message)}</p>`,
  );
}

/** Status rendered while an active or queued run can still be cancelled. */
export function runningPage(b: Base, message: string): string {
  return wrap(`${topInfo(b)}<button class="second" data-action="cancel-run">Cancel run</button><p class="muted">${esc(message)}</p>`);
}

// ---------------------------------------------------------------- the input form
function casesBar(caseNames: string[]): string {
  const select = caseNames.length
    ? `<select id="caseSel">${caseNames.map((n) => `<option>${esc(n)}</option>`).join('')}</select>
       <button class="second" data-action="case-load">Load</button>
       <button class="second" data-action="case-run">▶ Run case</button>
       <button class="second" data-action="run-all">▶ Run all (${caseNames.length})</button>
       <button class="second" data-action="case-delete">🗑</button>`
    : '<span class="muted">No saved cases yet.</span>';
  return `<div class="bar"><b>Cases</b> ${select}
    <input id="caseName" placeholder="Save these inputs as… e.g. wrong password">
    <button data-action="save-case-form">💾 Save case</button></div>
    <div class="muted" style="margin-top:4px">Cases are saved in <code>.nest-run/cases</code> inside your project, so your team can share them. Tokens are never saved.</div>`;
}

function methodFields(target: MethodTarget, form: MethodForm): { html: string; collect: string } {
  const html = target.params
    .map((p, i) => {
      const v = form.values[i] ?? '';
      const kind = kindOf(p.type);
      const label = `<label for="f${i}">${esc(p.name)} <span class="muted">(${esc(p.type === 'any' ? 'no type' : p.type)})</span></label>`;
      let input: string;
      if (kind === 'number') input = `<input id="f${i}" type="number" step="any" value="${esc(v)}">`;
      else if (kind === 'boolean')
        input = `<select id="f${i}"><option>true</option><option${v === 'false' ? ' selected' : ''}>false</option></select>`;
      else if (kind === 'text') input = `<input id="f${i}" type="text" value="${esc(v)}">`;
      else if (kind === 'json')
        input = `<textarea id="f${i}" rows="4" placeholder="JSON, e.g. {&quot;id&quot;: 1}">${esc(v)}</textarea>`;
      else {
        const chosen = form.kinds[i] || 'text';
        const opt = (val: string, name: string) => `<option value="${val}"${chosen === val ? ' selected' : ''}>${name}</option>`;
        input =
          `<div style="display:flex;gap:6px"><input id="f${i}" type="text" value="${esc(v)}" style="flex:1">` +
          `<select id="k${i}" style="width:auto" title="How to read this value">` +
          `${opt('text', 'as Text')}${opt('number', 'as Number')}${opt('boolean', 'as True/False')}${opt('json', 'as JSON')}` +
          `</select></div>`;
      }
      return label + input;
    })
    .join('');
  const collect = `function collect(){const values=[],kinds=[];
    for(let i=0;i<${target.params.length};i++){values.push(document.getElementById('f'+i).value);
      const k=document.getElementById('k'+i);kinds.push(k?k.value:'');}
    return {values,kinds};}`;
  return { html, collect };
}

function routeFields(target: RouteTarget, form: RouteForm): { html: string; collect: string } {
  const params = target.pathParams
    .map((n) => `<label for="p_${esc(n)}">:${esc(n)} <span class="muted">(path value)</span></label>
      <input id="p_${esc(n)}" type="text" value="${esc(form.pathParams?.[n] ?? '')}">`)
    .join('');
  const body = target.hasBody
    ? `<label for="body">Body <span class="muted">(JSON${target.bodyType ? ', ' + esc(target.bodyType) : ''})</span></label>
       <textarea id="body" rows="9" placeholder="{ }">${esc(form.body)}</textarea>`
    : '';
  const html = `
    <div class="muted">${esc(target.httpMethod)} /${esc(target.routePath)}</div>
    <label for="path">Path <span class="muted">(no leading “/”: your global prefix, like /api, is added)</span></label>
    <input id="path" type="text" value="${esc(form.path)}">
    ${params}
    <label for="query">Query <span class="muted">(optional)</span></label>
    <input id="query" type="text" placeholder="page=1&amp;limit=10" value="${esc(form.query)}">
    <label for="token">Login token <span class="muted">(optional, sent as Authorization: Bearer …, never saved in files)</span></label>
    <input id="token" type="password" autocomplete="off" value="${esc(form.token)}">
    <label for="headers">Other headers <span class="muted">(optional, one “Name: value” per line)</span></label>
    <textarea id="headers" rows="2">${esc(form.headers)}</textarea>
    ${body}`;
  const names = JSON.stringify(target.pathParams).replace(/</g, '\\u003c');
  const collect = `function collect(){const pp={};
    for(const n of ${names}){pp[n]=document.getElementById('p_'+n).value;}
    const g=(id)=>{const e=document.getElementById(id);return e?e.value:'';};
    return {path:g('path'),pathParams:pp,query:g('query'),headers:g('headers'),token:g('token'),body:g('body')};}`;
  return { html, collect };
}

export function formPage(b: Base, target: Target, form: Form, caseNames: string[], debugDefault: boolean): string {
  const parts =
    target.kind === 'method' ? methodFields(target, form as MethodForm) : routeFields(target, form as RouteForm);
  const go = target.kind === 'method' ? 'Run' : 'Send request';
  const runBtn = `<button${debugDefault ? ' class="second"' : ''} data-action="submit-run">▶ ${go}</button>`;
  const dbgBtn = `<button${debugDefault ? '' : ' class="second"'} data-action="submit-debug">🐞 Debug</button>`;
  const noInputs = target.kind === 'method' && target.params.length === 0 ? '<p class="muted">This method has no inputs.</p>' : '';
  return wrap(
    `${topInfo(b)}
    ${casesBar(caseNames)}
    <h3>${target.kind === 'method' ? 'Inputs' : 'Request'}</h3>
    ${noInputs}${parts.html}
    <div>${debugDefault ? dbgBtn + runBtn : runBtn + dbgBtn}</div>`,
    `${parts.collect}
    function send(mode){ post('submit',{mode, form:collect()}); }
    function caseAct(type){ const s=document.getElementById('caseSel'); if(s) post(type,{name:s.value}); }
    document.addEventListener('keydown',(e)=>{ if(e.key==='Enter' && e.target.tagName!=='TEXTAREA' && e.target.id!=='caseName') send('${debugDefault ? 'debug' : 'run'}'); });
    const first=document.querySelector('input[type=text],input[type=number],textarea'); if(first) first.focus();`,
  );
}

// ---------------------------------------------------------------- the result screen
function table(rows: any[]): string {
  if (!rows.length) return '<i class="muted">no rows</i>';
  if (typeof rows[0] !== 'object' || rows[0] === null) return `<pre>${pretty(rows)}</pre>`;
  const cols = Object.keys(rows[0]);
  const cell = (v: unknown) => esc(typeof v === 'object' ? JSON.stringify(v) : v);
  return (
    `<table><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr>` +
    rows.map((r) => `<tr>${cols.map((c) => `<td>${cell(r[c])}</td>`).join('')}</tr>`).join('') +
    '</table>'
  );
}

function callHtml(c: any, i: number): string {
  let tag: string;
  let title: string;
  let detail = '';
  if (c.kind === 'raw') {
    tag = 'DB';
    title = 'Raw SQL';
    detail = `<pre>${esc(c.sql)}</pre><div class="muted">values: ${esc(JSON.stringify(c.params))}</div>`;
  } else if (c.kind === 'model') {
    tag = 'DB';
    title = `${c.model}.${c.action}`;
    detail = `<pre>${pretty(c.args)}</pre>`;
  } else {
    tag = 'Service';
    title = `${c.service}.${c.method}`;
    detail = c.args && c.args.length ? `<div class="muted">arguments</div><pre>${pretty(c.args)}</pre>` : '';
  }
  let res = '';
  if (c.error) res = `<div class="err">Error: ${esc(c.error)}</div>`;
  else if (c.result && c.result.rows) res = `<div class="muted">${c.result.rowCount} row(s)</div>${table(c.result.rows)}`;
  else if (c.result && c.result.value !== undefined && c.result.value !== null) res = `<div class="muted">result</div><pre>${pretty(c.result.value)}</pre>`;
  return `<div class="card" style="margin-left:${(c.depth || 0) * 18}px"><span class="tag">${tag}</span><b>${i + 1}. ${esc(title)}</b> <span class="muted">${c.ms ?? '?'} ms</span>${detail}${res}</div>`;
}

function requestSection(r: any, shown: any, isRoute: boolean): string {
  if (!isRoute) return `<h3>Input</h3><pre>${pretty(shown)}</pre>`;
  const line = r.http
    ? `${r.http.method} ${r.http.url}`
    : `${shown.method} ${shown.path}${shown.query ? '?' + shown.query : ''}`;
  const hs = r.sentHeaders && Object.keys(r.sentHeaders).length ? `<div class="muted">headers</div><pre>${pretty(r.sentHeaders)}</pre>` : '';
  const bd = r.sentBody !== undefined && r.sentBody !== null ? `<div class="muted">body</div><pre>${pretty(r.sentBody)}</pre>` : '';
  return `<h3>Request</h3><pre>${esc(line)}</pre>${hs}${bd}`;
}

function renderBody(r: any, shown: any, isRoute: boolean): string {
  const calls = r.calls && r.calls.length ? r.calls.map(callHtml).join('') : '<p class="muted">No DB or service calls were recorded.</p>';
  let end: string;
  if (r.error) {
    const diagnosis = r.diagnostic ? `<p class="muted">${esc(r.diagnostic.category)}: ${esc(r.diagnostic.summary)} ${esc(r.diagnostic.troubleshooting || '')}</p>` : '';
    end = `<h3>Error</h3><div class="err">${esc(r.error.message)}</div>${diagnosis}<pre>${esc(r.error.stack || '')}</pre>`;
  }
  else if (isRoute && r.http) {
    const good = r.http.status < 400;
    end = `<h3>Response <span class="${good ? 'ok' : 'err'}">${r.http.status} ${esc(r.http.statusText || '')}</span> <span class="muted">${r.ms} ms</span></h3><pre>${
      typeof r.http.body === 'string' ? esc(r.http.body) : pretty(r.http.body)
    }</pre>`;
  } else end = `<h3>Output <span class="muted">${r.ms} ms</span></h3><pre>${pretty(r.output)}</pre>`;
  const startup =
    r.bootMs > 300
      ? `<div class="muted">App start-up: ${(r.bootMs / 1000).toFixed(1)} s (only after a code change; the next runs skip this)</div>`
      : '';
  const logs = r.logs && r.logs.length ? `<h3>Console output</h3><pre>${esc(r.logs.join('\n'))}</pre>` : '';
  return `${startup}${requestSection(r, shown, isRoute)}<div class="arrow">↓</div><h3>Steps</h3>${calls}<div class="arrow">↓</div>${end}${logs}`;
}

/** Shows the sanitized run. Raw credential values never enter this webview. */
export function resultPage(b: Base, target: Target, shown: any, report: any): string {
  const isRoute = target.kind === 'route';
  const masked = maskReport(report);
  const inner = `${topInfo(b)}
    <button data-action="again">↻ Edit inputs / run again</button>
    <button class="second" data-action="create-test">🧪 Create Jest test</button>
    <button id="tg" class="second" data-action="toggle-secrets">👁 Show secrets</button>
    <div class="bar"><input id="caseName" placeholder="Save this run as a case… e.g. wrong password">
      <button class="second" data-action="save-case-result">💾 Save case (with this result)</button></div>
    <div id="masked">${renderBody(masked, redact(shown), isRoute)}</div>
    <div id="plain" style="display:none">${renderBody(report, shown, isRoute)}</div>`;
  return wrap(
    inner,
    `function toggle(){const m=document.getElementById('masked'),p=document.getElementById('plain'),b=document.getElementById('tg');
      const show=p.style.display==='none';p.style.display=show?'block':'none';m.style.display=show?'none':'block';
      b.textContent=show?'🙈 Hide secrets':'👁 Show secrets';}`,
  );
}

// ---------------------------------------------------------------- run all saved cases
export interface CaseRow {
  name: string;
  status: 'pass' | 'fail' | 'none' | 'error';
  note: string;
  ms: number;
}

export function runAllPage(b: Base, rows: CaseRow[], running?: string): string {
  const icon = { pass: '✔', fail: '✖', none: '•', error: '⚠' } as const;
  const cls = { pass: 'ok', fail: 'err', none: 'muted', error: 'err' } as const;
  const passed = rows.filter((r) => r.status === 'pass').length;
  const failed = rows.filter((r) => r.status === 'fail' || r.status === 'error').length;
  const rowsHtml = rows
    .map(
      (r) => `<tr><td class="${cls[r.status]}">${icon[r.status]}</td><td>${esc(r.name)}</td><td>${esc(r.note)}</td><td>${r.ms} ms</td>
        <td><button class="second" style="margin:0" data-action="case-open" data-name="${esc(r.name)}">Open</button></td></tr>`,
    )
    .join('');
  return wrap(
    `${topInfo(b)}
     <button data-action="again">↻ Back to inputs</button>
     <h3>All saved cases ${running ? '' : `<span class="${failed ? 'err' : 'ok'}">${passed} passed${failed ? `, ${failed} failed` : ''}</span>`}</h3>
     ${running ? `<p class="muted">${esc(running)}</p>` : ''}
     <table><tr><th></th><th>Case</th><th>Result</th><th>Time</th><th></th></tr>${rowsHtml}</table>
     <p class="muted">✔ result matches what was saved · ✖ different · • no saved result to compare · ⚠ could not run</p>`,
  );
}
