import * as vscode from 'vscode';

export interface Param {
  name: string;
  type: string;
}

/** A service method (shows ▶ Run / 🐞 Debug). */
export interface MethodTarget {
  kind: 'method';
  uri: vscode.Uri;
  className: string;
  method: string;
  params: Param[];
  bodyLine: number; // 0-based line where the debugger pauses
}

/** A controller route (shows ▶ Send request / 🐞 Debug request). */
export interface RouteTarget {
  kind: 'route';
  uri: vscode.Uri;
  className: string;
  method: string;
  httpMethod: string; // GET, POST...
  routePath: string; // controller prefix + route, no leading slash, e.g. "auth/:id"
  pathParams: string[];
  hasBody: boolean;
  bodyType?: string;
  bodyLine: number;
}

export type Target = MethodTarget | RouteTarget;

/** What the person typed into the form. */
export interface MethodForm {
  values: string[];
  kinds: string[]; // for untyped parameters: text | number | boolean | json
}

export interface RouteForm {
  path: string;
  pathParams: Record<string, string>;
  query: string;
  headers: string;
  token: string;
  body: string;
}

export type Form = MethodForm | RouteForm;

/** A saved test case (stored in .nest-run/cases/*.json). */
export interface SavedCase {
  /** Stable identifier introduced with schema version 2. */
  id?: string;
  name: string;
  inputs: any; // method: { paramName: "text" } | route: { path, pathParams, query, headers, body }
  kinds?: Record<string, string>;
  expected?: any; // method: { output } or { error } | route: { status, body }
}

/** The settings and paths needed to start your project. */
export interface Setup {
  root: string;
  runner: string;
  preload: string[];
  env: NodeJS.ProcessEnv;
  keepWarm: boolean;
  fast: boolean;
  appModule: string;
  workspaceFolder: import('vscode').WorkspaceFolder | undefined;
  extensionDirName: string;
  executionTimeoutMs: number;
  startupTimeoutMs: number;
  httpTimeoutMs: number;
}

export const keyOf = (t: Target) => `${t.className}.${t.method}`;
