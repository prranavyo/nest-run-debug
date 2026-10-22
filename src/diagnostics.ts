import { redactText, sanitizeError } from './redact';

export type DiagnosticCategory =
  | 'configuration'
  | 'missing-dependency'
  | 'compilation'
  | 'bootstrap'
  | 'resolution'
  | 'invalid-input'
  | 'http'
  | 'database'
  | 'timeout'
  | 'cancelled'
  | 'application'
  | 'internal';

export interface Diagnostic {
  category: DiagnosticCategory;
  summary: string;
  troubleshooting: string;
  cause: { message: string; stack?: string };
  runId?: string;
}

export function classifyDiagnostic(error: unknown, runId?: string): Diagnostic {
  const cause = sanitizeError(error);
  const msg = (cause.message || '').toLowerCase();
  const stackHeader = (cause.stack || '').split('\n')[0].toLowerCase();
  const text = `${msg}\n${stackHeader}`;
  let category: DiagnosticCategory = 'application';
  let summary = 'The application threw an exception while handling this run.';
  let troubleshooting = 'Inspect the sanitized stack trace and the recorded calls.';
  if (/cancel(?:led|ed)/.test(text)) [category, summary, troubleshooting] = ['cancelled', 'The run was cancelled.', 'Start a new run when you are ready.'];
  else if (/timed? out|timeout|did not start.*time/.test(text)) [category, summary, troubleshooting] = ['timeout', 'The run exceeded its configured time limit.', 'Check the operation, increase the local timeout if appropriate, or debug it interactively.'];
  else if (/cannot find module|not found.*(?:ts-node|tsconfig-paths|@nestjs)|require stack|err_module_not_found/.test(text)) [category, summary, troubleshooting] = ['missing-dependency', 'A project dependency required by the runner is missing.', 'Install the named dependency in the target project and run again.'];
  else if (/ts\d{4}|typescript error|syntaxerror|compilation error/.test(text)) [category, summary, troubleshooting] = ['compilation', 'TypeScript transformation or compilation failed.', 'Fix the reported TypeScript error, or use Fast mode only when that is intentional.'];
  else if (/createapplication|bootstrap failed|failed to bootstrap|appmodule|main file.*did not start|nestfactory/.test(text)) [category, summary, troubleshooting] = ['bootstrap', 'Nest application bootstrap failed.', 'Check AppModule, main file, and required environment configuration.'];
  else if (/is not registered in any module|is not exported from|is not a method of|cannot resolve dependencies/.test(text)) [category, summary, troubleshooting] = ['resolution', 'The selected service, method, or provider could not be resolved.', 'Confirm the class is exported and registered in the Nest application.'];
  else if (/invalid json|body is not valid json|the supplied input is invalid/.test(text)) [category, summary, troubleshooting] = ['invalid-input', 'The supplied input is invalid.', 'Correct the input form and run again.'];
  else if (/fetch failed|econnrefused|econnreset|status code \d{3}|httpexception|http request timed out|network error/.test(text)) [category, summary, troubleshooting] = ['http', 'The HTTP request could not complete.', 'Check the route, local app startup, and request data.'];
  else if (/\bprisma(?:client)?\b|queryfailed|unique constraint|foreign key constraint|relation ".*" does not exist|database connection failed/.test(text)) [category, summary, troubleshooting] = ['database', 'The database provider reported an error.', 'Check the sanitized database target and provider configuration.'];
  else if (/nest_run_|runner configuration|environment configuration/.test(text)) [category, summary, troubleshooting] = ['configuration', 'Runner configuration is incomplete or invalid.', 'Review the extension settings and resolved project environment.'];
  return { category, summary, troubleshooting, cause: { message: redactText(cause.message), ...(cause.stack ? { stack: redactText(cause.stack) } : {}) }, runId };
}

export function attachDiagnostic(report: any, runId?: string): any {
  if (!report?.error) return report;
  return { ...report, runId: runId || report.runId, diagnostic: classifyDiagnostic(report.error, runId || report.runId) };
}
