// How many files this process has open, for the descriptor-leak tests.
//
// It throws when lsof is missing rather than answering 0: three tests pin
// leaks against this number, and "0 before, 0 after" would pass every one of
// them on a machine that cannot count. A tool that is missing is reported,
// never skipped silently (CONVENTIONS).

const { execSync } = require('child_process');

function openFiles() {
  let out;
  try {
    out = execSync(`lsof -p ${process.pid}`, { stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    throw new Error('lsof is needed to count open files: ' + e.message);
  }
  return out.toString().split('\n').filter(Boolean).length;
}

module.exports = { openFiles };
