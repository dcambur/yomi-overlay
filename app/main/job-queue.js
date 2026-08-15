// One thing at a time, in the order it was asked for.
//
// Every job that adds or removes a dictionary ends up writing index.db — a
// download rebuilds it, a removal prunes it — and two at once race over one
// file: a rebuild writes index.db.building and moves it into place while a
// prune has the same database open.
//
// The settings window used to enforce that by refusing to start anything while
// something ran. That is not enforcement — a second window, or a rebuild the
// main process starts on its own, sails straight past it — and it made
// "Import a .zip you own…" a button that looked clickable and did nothing.
//
// Its own file, small as it is, so that the tests exercise the queue the app
// runs rather than a copy of its shape.

/**
 * A queue of jobs that must not overlap.
 *
 * `report` receives every progress event, stamped with the `job` it belongs
 * to: with a queue, a window can no longer assume that whatever is happening
 * is the thing it last clicked.
 */
function createQueue(report = () => {}) {
  let chain = Promise.resolve();
  let running = 0;

  /**
   * Run `work` after everything already asked for. `work` is handed a
   * reporting function of its own. The returned promise is that job's, so
   * each caller gets its own result and its own failure.
   */
  return function enqueue(job, work) {
    // Waiting behind something: say so, or the row sits inert with no
    // explanation until its turn comes.
    if (running) report({ job, phase: 'queued' });
    running++;
    const run = chain.then(() => work((p) => report({ ...p, job })));
    // A failed job must not poison the queue for the ones behind it, and its
    // rejection belongs to its own caller, not to the chain.
    chain = run.then(() => {}, () => {});
    return run.finally(() => { running--; });
  };
}

module.exports = { createQueue };
