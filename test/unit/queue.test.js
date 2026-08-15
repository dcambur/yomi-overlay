// Dictionary work happens one at a time, in the order it was asked for.
//
// Every one of these jobs ends up writing index.db — a download rebuilds it, a
// removal prunes it, an import rebuilds it — and two at once would race over
// one file: a rebuild writes index.db.building and moves it into place while a
// prune has the same database open.
//
// The settings window used to enforce that by refusing to start anything while
// something ran, which is not enforcement at all (a second window, or the main
// process's own rebuild, would sail past it) and which made "Import a .zip you
// own…" a button that looked clickable and did nothing.
//
// This pins the property the queue exists for — no overlap, order preserved,
// one failure does not take the rest with it — against the queue ipc.js
// actually uses, with no Electron window needed to host it.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { createQueue } = require(
  path.resolve(__dirname, '../../app/main/job-queue.js'));

/** A job that takes `ms` and records when it starts and stops. */
function timed(log, name, ms, fail = false) {
  return async () => {
    log.push('start ' + name);
    await new Promise((r) => setTimeout(r, ms));
    log.push('end ' + name);
    if (fail) throw new Error(name + ' failed');
    return name;
  };
}

test('two jobs never overlap', async () => {
  const log = [];
  const enqueue = createQueue();
  // The second is deliberately quicker: without a queue it would finish first
  // and its "end" would land inside the first one's window.
  await Promise.all([
    enqueue('a', timed(log, 'a', 40)),
    enqueue('b', timed(log, 'b', 5)),
  ]);
  assert.deepStrictEqual(log, ['start a', 'end a', 'start b', 'end b']);
});

test('order is the order they were asked for', async () => {
  const log = [];
  const enqueue = createQueue();
  const jobs = ['one', 'two', 'three', 'four'];
  await Promise.all(jobs.map((n, i) => enqueue(n, timed(log, n, 20 - i * 4))));
  assert.deepStrictEqual(log.filter((l) => l.startsWith('start')),
                         jobs.map((n) => 'start ' + n));
});

test('a failure does not poison the queue behind it', async () => {
  const log = [];
  const enqueue = createQueue();
  const bad = enqueue('bad', timed(log, 'bad', 5, true));
  const good = enqueue('good', timed(log, 'good', 5));
  await assert.rejects(bad, /bad failed/, 'the caller still hears about it');
  assert.strictEqual(await good, 'good', 'and the next one ran anyway');
  assert.deepStrictEqual(log, ['start bad', 'end bad', 'start good', 'end good']);
});

test('a job that has to wait is told so, and only then', async () => {
  const events = [];
  const enqueue = createQueue((p) => events.push(p));
  await Promise.all([
    enqueue('first', timed([], 'first', 20)),
    enqueue('second', timed([], 'second', 5)),
  ]);
  // The first had nothing in front of it; the second did. Without this the row
  // sits inert with no explanation until its turn comes.
  assert.deepStrictEqual(events.filter((e) => e.phase === 'queued'),
                         [{ job: 'second', phase: 'queued' }]);
});

test('every progress event says which job it belongs to', async () => {
  const events = [];
  const enqueue = createQueue((p) => events.push(p));
  await enqueue('Jitendex', async (report) => {
    report({ phase: 'downloading', got: 1, total: 2 });
    report({ phase: 'indexing', done: 0, total: 4 });
  });
  // With a queue the window can no longer assume that whatever is happening is
  // the thing it last clicked, so an unlabelled event has no row to go to.
  assert.deepStrictEqual(events.map((e) => e.job), ['Jitendex', 'Jitendex']);
  assert.deepStrictEqual(events.map((e) => e.phase), ['downloading', 'indexing']);
});

test('the queue drains — nothing is left running', async () => {
  const enqueue = createQueue();
  const results = await Promise.all(
    ['a', 'b', 'c'].map((n) => enqueue(n, async () => n)));
  assert.deepStrictEqual(results, ['a', 'b', 'c'],
                         'each caller gets its own result back');
});
