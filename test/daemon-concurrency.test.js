const assert = require('node:assert/strict');
const { afterEach, test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Daemon, getDaemon, daemons } = require('../out/daemon.js');

const tempRoots = [];
function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nest-run-daemon-'));
  tempRoots.push(root);
  return root;
}
afterEach(async () => {
  for (const d of daemons.values()) {
    d.dispose();
  }
  daemons.clear();

  while (tempRoots.length) {
    const dir = tempRoots.pop();
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        break;
      } catch (e) {
        if (attempt === 9) throw e;
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  }
});

test('daemon executes requests sequentially without mixing logs or calls', async () => {
  const root = tempRoot();
  const runner = path.join(root, 'mock-runner.js');
  fs.writeFileSync(
    runner,
    `
    const rl = require('readline').createInterface({ input: process.stdin });
    rl.on('line', (line) => {
      const req = JSON.parse(line);
      setTimeout(() => {
        const report = {
          runId: req.runId,
          calls: [{ marker: req.marker }],
          logs: ['log-' + req.marker],
          meta: { deps: [] },
          ms: 1,
        };
        process.stdout.write('@@NESTRUN@@' + JSON.stringify({ id: req.id, report }) + '\\n');
      }, req.delay || 5);
    });
  `,
  );

  const daemon = new Daemon(root, [runner, '--serve'], process.env);
  const run1 = daemon.run({ marker: 'job1', delay: 40 }, 1000);
  const run2 = daemon.run({ marker: 'job2', delay: 10 }, 1000);
  const run3 = daemon.run({ marker: 'job3', delay: 5 }, 1000);

  const [res1, res2, res3] = await Promise.all([run1.promise, run2.promise, run3.promise]);

  assert.equal(res1.logs[0], 'log-job1');
  assert.equal(res1.calls[0].marker, 'job1');

  assert.equal(res2.logs[0], 'log-job2');
  assert.equal(res2.calls[0].marker, 'job2');

  assert.equal(res3.logs[0], 'log-job3');
  assert.equal(res3.calls[0].marker, 'job3');

  daemon.dispose();
});

test('queued run can be cancelled before execution without affecting other runs', async () => {
  const root = tempRoot();
  const runner = path.join(root, 'mock-runner.js');
  fs.writeFileSync(
    runner,
    `
    const rl = require('readline').createInterface({ input: process.stdin });
    rl.on('line', (line) => {
      const req = JSON.parse(line);
      setTimeout(() => {
        process.stdout.write('@@NESTRUN@@' + JSON.stringify({ id: req.id, report: { runId: req.runId, logs: [req.marker], calls: [], ms: 1 } }) + '\\n');
      }, req.delay || 5);
    });
  `,
  );

  const daemon = new Daemon(root, [runner, '--serve'], process.env);
  const activeRun = daemon.run({ marker: 'active', delay: 50 }, 1000);
  const queuedRunToCancel = daemon.run({ marker: 'cancelled-job', delay: 10 }, 1000);
  const subsequentRun = daemon.run({ marker: 'subsequent', delay: 10 }, 1000);

  queuedRunToCancel.cancel();

  const [resActive, resCancelled, resSubsequent] = await Promise.all([
    activeRun.promise,
    queuedRunToCancel.promise,
    subsequentRun.promise,
  ]);

  assert.equal(resActive.logs[0], 'active');
  assert.match(resCancelled.error.message, /cancelled before it started/);
  assert.equal(resSubsequent.logs[0], 'subsequent');

  daemon.dispose();
});

test('independent project roots get separate daemon instances', () => {
  const rootA = tempRoot();
  const rootB = tempRoot();

  const daemonA = getDaemon(rootA, ['dummy.js'], process.env);
  const daemonB = getDaemon(rootB, ['dummy.js'], process.env);

  assert.notEqual(daemonA, daemonB);
  assert.equal(getDaemon(rootA, ['dummy.js'], process.env), daemonA);

  daemonA.dispose();
  daemonB.dispose();
});
