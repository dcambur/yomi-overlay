// Launched from Spotlight there is no terminal, so stdout goes nowhere and a
// startup failure is invisible. Everything is mirrored to a file.
//
// Requiring this module installs the console hooks; that is the point.

const fs = require('fs');

const LOG = '/tmp/yomi-overlay.log';
function logf(...a) {
  const line = `[${new Date().toISOString()}] ${a.join(' ')}\n`;
  try { require('fs').appendFileSync(LOG, line); } catch {}
  console.log(...a);
}
console.log = ((orig) => (...a) => {
  try { require('fs').appendFileSync(LOG, a.join(' ') + '\n'); } catch {}
  orig(...a);
})(console.log);
console.error = ((orig) => (...a) => {
  try { require('fs').appendFileSync(LOG, 'ERR ' + a.join(' ') + '\n'); } catch {}
  orig(...a);
})(console.error);
process.on('uncaughtException', e => logf('UNCAUGHT', e && e.stack || e));
process.on('unhandledRejection', e => logf('UNHANDLED', e && e.stack || e));
process.on('exit', c => logf('process exit code=' + c));

module.exports = { LOG, logf };
