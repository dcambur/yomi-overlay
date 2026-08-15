// Launched from Spotlight there is no terminal, so stdout goes nowhere and a
// startup failure is invisible. Everything is mirrored to a file.
//
// Requiring this module installs the console hooks; that is the point.

const fs = require('fs');

const LOG = '/tmp/yomi-overlay.log';
/** Append, or carry on without a log — never take the app down over one. */
function write(line) {
  try { fs.appendFileSync(LOG, line); } catch { /* /tmp full, or read-only */ }
}

function logf(...a) {
  write(`[${new Date().toISOString()}] ${a.join(' ')}\n`);
  console.log(...a);
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
