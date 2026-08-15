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

process.on('message', (msg) => {
  if (!msg) return;
  const report = (p) => process.send({ type: 'progress', ...p });
  try {
    if (msg.type === 'build') {
      process.send({ type: 'done', result: build(msg.dictsDir, msg.outPath, report) });
    } else if (msg.type === 'prune') {
      // Deleting a dictionary's rows is seconds rather than the ~80 a rebuild
      // takes, but seconds of a frozen overlay is still a frozen overlay — and
      // a progress message cannot be painted by a main process that is busy
      // sending it.
      const { prune } = require('./dictionaries.js');
      process.send({ type: 'done', result: prune(msg.label, report) });
    } else {
      return;
    }
  } catch (e) {
    process.send({ type: 'error', message: e && e.message ? e.message : String(e) });
  }
  // Nothing else to do; leaving the process alive would hold the index file
  // open against the next rebuild.
  process.exit(0);
});
