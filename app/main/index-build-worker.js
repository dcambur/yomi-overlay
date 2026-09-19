// Building an index, off the main process.
//
// node:sqlite is synchronous and a full rebuild is ~80 seconds on the twelve
// dictionaries here. Doing that in the main process would freeze the overlay
// panel, the tray and the settings window for the duration — and the overlay is
// drawn over whatever the user is reading, so a frozen one is worse than a
// missing one.
//
// Forked with ELECTRON_RUN_AS_NODE, so it is the same binary and needs no
// separate Node on the machine.

const { build } = require('./index-builder.js');

// Nothing else to do once the answer is sent; leaving the process alive would
// hold the index file open against the next rebuild. Exit from send's
// callback, not after it: send is asynchronous, and exiting first could drop
// the 'done' of an 80-second build that had already landed on disk.
const finish = (msg) => process.send(msg, () => process.exit(0));

process.on('message', (msg) => {
  if (!msg) return;
  const report = (p) => process.send({ type: 'progress', ...p });
  try {
    if (msg.type === 'build') {
      finish({ type: 'done', result: build(msg.dictsDir, msg.outPath, report) });
    } else if (msg.type === 'prune') {
      // Deleting a dictionary's rows is seconds rather than the ~80 a rebuild
      // takes, but seconds of a frozen overlay is still a frozen overlay — and
      // a progress message cannot be painted by a main process that is busy
      // sending it.
      const { prune } = require('./dictionaries.js');
      finish({ type: 'done', result: prune(msg.label, report) });
    }
  } catch (e) {
    finish({ type: 'error', message: e && e.message ? e.message : String(e) });
  }
});
