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
  if (!msg || msg.type !== 'build') return;
  try {
    const result = build(msg.dictsDir, msg.outPath, (p) => {
      process.send({ type: 'progress', ...p });
    });
    process.send({ type: 'done', result });
  } catch (e) {
    process.send({ type: 'error', message: e && e.message ? e.message : String(e) });
  }
  // Nothing else to do; leaving the process alive would hold the index file
  // open against the next rebuild.
  process.exit(0);
});
