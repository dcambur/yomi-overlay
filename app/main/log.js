// Launched from Spotlight there is no terminal, so stdout goes nowhere and a
// startup failure is invisible. Everything is mirrored to a file.
//
// Requiring this module installs the console hooks; that is the point.

const fs = require('fs');
const { LOG_FILE: LOG } = require('../paths.js');

// Only the app mirrors into the file — Electron, its index worker included.
// Plain node is the unit suites, which have a terminal and no app to
// diagnose, and which used to write their fake Anki activity into the
// user's log.
const MIRROR = !!process.versions.electron;

/** Append, or carry on without a log — never take the app down over one. */
function write(line) {
  if (!MIRROR) return;
  try { fs.appendFileSync(LOG, line); } catch { /* /tmp full, or read-only */ }
}

// Printed through the console as it was before the hook below: logf writes
// its own timestamped line, and through the hook every one landed twice
// (352 of 910 lines of a real log were the line above without its time).
const print = console.log;

function logf(...a) {
  write(`[${new Date().toISOString()}] ${a.join(' ')}\n`);
  print(...a);
}
console.log = ((orig) => (...a) => {
  write(a.join(' ') + '\n');
  orig(...a);
})(console.log);
console.error = ((orig) => (...a) => {
  write('ERR ' + a.join(' ') + '\n');
  orig(...a);
})(console.error);
process.on('uncaughtException', e => logf('UNCAUGHT', e && e.stack || e));
process.on('unhandledRejection', e => logf('UNHANDLED', e && e.stack || e));
process.on('exit', c => logf('process exit code=' + c));

module.exports = { LOG, logf };
