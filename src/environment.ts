import * as fs from 'fs';
import * as path from 'path';
import { redactText } from './redact';

export type DatabaseSafety = 'local' | 'test' | 'remote' | 'unknown';

export interface DatabaseTarget {
  safety: DatabaseSafety;
  label?: string;
  source?: string;
  reason: string;
}

export interface ResolvedEnvironment {
  env: NodeJS.ProcessEnv;
  loadedFiles: string[];
  database: DatabaseTarget;
}

function parseEnvFile(file: string): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (!match) continue;
      let value = match[2];
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      else value = value.replace(/\s+#.*$/, '');
      result[match[1]] = value;
    }
  } catch {
    // A missing optional .env file is normal.
  }
  return result;
}

function databaseUrl(env: NodeJS.ProcessEnv): { key: string; value: string } | undefined {
  for (const key of ['DATABASE_URL', 'PRISMA_DATABASE_URL', 'DIRECT_URL', 'SHADOW_DATABASE_URL']) {
    if (env[key]) return { key, value: env[key] as string };
  }
  return undefined;
}

export function inspectDatabaseTarget(env: NodeJS.ProcessEnv): DatabaseTarget {
  const found = databaseUrl(env);
  if (!found) return { safety: 'unknown', reason: 'No supported database URL was found in the resolved environment.' };
  
  if (/^(?:file:|sqlite:)/i.test(found.value)) {
    const filePath = found.value.replace(/^(?:file:|sqlite:)\/{0,3}/i, '');
    const label = `sqlite:${filePath || 'memory'}`;
    const isTest = /(?:^|[-_./])(test|testing|spec|e2e)(?:$|[-_./])/i.test(filePath) || env.NODE_ENV === 'test';
    return {
      safety: isTest ? 'test' : 'local',
      label,
      source: found.key,
      reason: isTest ? 'The SQLite database file or NODE_ENV identifies a test environment.' : 'SQLite / local file database.',
    };
  }

  try {
    const url = new URL(found.value);
    const host = url.hostname.toLowerCase();
    const database = url.pathname.replace(/^\//, '') || undefined;
    const label = `${host || 'local socket'}${url.port ? `:${url.port}` : ''}${database ? `/${database}` : ''}`;
    const testName = /(?:^|[-_./])(test|testing|spec|e2e)(?:$|[-_./])/i.test(database || '') || env.NODE_ENV === 'test';
    if (testName) return { safety: 'test', label, source: found.key, reason: 'The database name or NODE_ENV identifies a test environment.' };
    if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '::1' || host === '[::1]' || host.endsWith('.local') || host.endsWith('.test')) {
      return { safety: 'local', label, source: found.key, reason: 'The database host is local.' };
    }
    return { safety: 'remote', label, source: found.key, reason: 'The database host is not local.' };
  } catch {
    return { safety: 'unknown', source: found.key, reason: `The ${found.key} value is not a parseable connection URL: ${redactText(found.value)}.` };
  }
}

/**
 * Precedence is .env (lowest), .env.local, .env.test (if test), inherited process environment, then extension overrides.
 * We intentionally never mutate process.env or rewrite a project .env file.
 */
export function resolveEnvironment(root: string, overrides: NodeJS.ProcessEnv = {}, inherited: NodeJS.ProcessEnv = process.env): ResolvedEnvironment {
  const envFiles = ['.env', '.env.local'];
  if (inherited.NODE_ENV === 'test' || overrides.NODE_ENV === 'test') {
    envFiles.push('.env.test');
  }
  const fileValues: NodeJS.ProcessEnv = {};
  const loadedFiles: string[] = [];
  for (const name of envFiles) {
    const file = path.join(root, name);
    if (fs.existsSync(file)) {
      Object.assign(fileValues, parseEnvFile(file));
      loadedFiles.push(name);
    }
  }
  const env = { ...fileValues, ...inherited, ...overrides };
  return { env, loadedFiles, database: inspectDatabaseTarget(env) };
}
