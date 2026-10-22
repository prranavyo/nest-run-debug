import { spawn, ChildProcess } from 'child_process';

// The runner instruments a live Nest application. It therefore has one active request per
// project process; independent project daemons still run in parallel.
const MARK = '@@NESTRUN@@';
const emptyReport = (message: string, runId: string) => ({
  runId,
  calls: [],
  logs: [],
  ms: 0,
  bootMs: 0,
  meta: { deps: [] },
  error: { message, stack: '' },
});

export interface RunHandle {
  id: string;
  promise: Promise<any>;
  cancel: () => void;
}

interface Job {
  id: string;
  wireId: number;
  req: Record<string, unknown>;
  timeoutMs: number;
  resolve: (report: any) => void;
  timer?: NodeJS.Timeout;
}

export class Daemon {
  private child: ChildProcess | undefined;
  private buf = '';
  private nextId = 1;
  private queue: Job[] = [];
  private active: Job | undefined;
  private restartRequested = false;
  private disposed = false;
  private log = '';
  warm = false;
  stale = false;
  dead = false;

  constructor(public root: string, private readonly args: string[], private readonly env: NodeJS.ProcessEnv) {
    this.start();
  }

  private start() {
    if (this.disposed) return;
    this.dead = false;
    this.buf = '';
    const child = spawn(process.execPath, this.args, { cwd: this.root, env: this.env, stdio: 'pipe' });
    this.child = child;
    child.stdout?.on('data', (data) => this.onData(String(data)));
    child.stderr?.on('data', (data) => (this.log += String(data)));
    child.on('error', (error) => this.onExit(child, `Could not start Node.js: ${error.message}`));
    child.on('exit', (code, signal) => this.onExit(child, `The background process stopped (${signal ? `signal ${signal}` : `exit code ${code}`}).`));
  }

  private onData(text: string) {
    this.buf += text;
    let end: number;
    while ((end = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, end);
      this.buf = this.buf.slice(end + 1);
      if (!line.startsWith(MARK)) {
        this.log += `${line}\n`;
        continue;
      }
      try {
        const { id, report } = JSON.parse(line.slice(MARK.length));
        if (!this.active || this.active.wireId !== id) continue;
        const job = this.active;
        this.active = undefined;
        if (job.timer) clearTimeout(job.timer);
        this.warm = true;
        job.resolve({ ...report, runId: report?.runId || job.id });
        this.pump();
      } catch {
        this.log += 'Runner sent an unreadable response.\n';
      }
    }
  }

  private onExit(child: ChildProcess, message: string) {
    if (!this.child || this.child !== child) return; // stale exit from a restarted process
    this.child = undefined;
    if (this.restartRequested && !this.disposed) {
      this.restartRequested = false;
      this.start();
      this.pump();
      return;
    }
    this.dead = true;
    if (this.active) {
      const job = this.active;
      this.active = undefined;
      if (job.timer) clearTimeout(job.timer);
      job.resolve(emptyReport(message, job.id));
    }
    while (this.queue.length) {
      const job = this.queue.shift()!;
      job.resolve(emptyReport(message, job.id));
    }
  }

  private pump() {
    if (this.dead || this.disposed || this.active || !this.child) return;
    const job = this.queue.shift();
    if (!job) return;
    this.active = job;
    job.timer = setTimeout(() => this.stopActive(job, `Run timed out after ${job.timeoutMs} ms.`), job.timeoutMs);
    try {
      this.child.stdin?.write(`${JSON.stringify({ id: job.wireId, runId: job.id, ...job.req })}\n`);
    } catch (error) {
      this.stopActive(job, `Could not send the run to the background process: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private stopActive(job: Job, message: string) {
    if (this.active !== job) return;
    this.active = undefined;
    if (job.timer) clearTimeout(job.timer);
    job.resolve(emptyReport(message, job.id));
    // Killing the process is deliberate: a timed-out method must not keep mutating the app.
    if (this.child) {
      this.restartRequested = !this.disposed;
      try {
        this.child.kill();
      } catch {
        this.onExit(this.child, message);
      }
    } else this.pump();
  }

  run(req: Record<string, unknown>, timeoutMs = 30_000): RunHandle {
    const wireId = this.nextId++;
    const id = `run-${Date.now().toString(36)}-${wireId.toString(36)}`;
    let job: Job | undefined;
    const promise = new Promise<any>((resolve) => {
      job = { id, wireId, req, timeoutMs: Math.max(1, timeoutMs), resolve };
      if (this.dead || this.disposed) {
        resolve(emptyReport('The background process is not running.', id));
        return;
      }
      this.queue.push(job);
      this.pump();
    });
    return {
      id,
      promise,
      cancel: () => {
        if (!job) return;
        const queued = this.queue.indexOf(job);
        if (queued >= 0) {
          this.queue.splice(queued, 1);
          job.resolve(emptyReport('Run cancelled before it started.', job.id));
          return;
        }
        this.stopActive(job, 'Run cancelled by the user.');
      },
    };
  }

  dispose() {
    this.disposed = true;
    this.dead = true;
    if (this.active) this.stopActive(this.active, 'Run cancelled because the extension was disposed.');
    while (this.queue.length) {
      const job = this.queue.shift()!;
      job.resolve(emptyReport('Run cancelled because the extension was disposed.', job.id));
    }
    try {
      this.child?.stdin?.destroy();
      this.child?.kill();
    } catch {
      /* ignore */
    }
  }
}

export const daemons = new Map<string, Daemon>();

export function getDaemon(root: string, args: string[], env: NodeJS.ProcessEnv): Daemon {
  let daemon = daemons.get(root);
  if (daemon && (daemon.stale || daemon.dead)) {
    daemon.dispose();
    daemons.delete(root);
    daemon = undefined;
  }
  if (!daemon) {
    daemon = new Daemon(root, args, env);
    daemons.set(root, daemon);
  }
  return daemon;
}
