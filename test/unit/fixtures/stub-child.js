// A stand-in for the yomi capture helper, so child supervision can be tested
// without a binary, a permission, or a window.
//
//   node stub-child.js <mode> [arg]
//
//   lines N        emit N NDJSON objects, then exit 0
//   chunked        emit ONE object split across three writes, then stay alive
//                  — the case a naive `JSON.parse(chunk)` gets wrong
//   garbage        emit a blank line, an unparseable line, then one good object
//   crash          emit one object, then exit 1
//   silent         emit nothing, stay alive (feeds the watchdog)
//   stderr         write one stderr line, stay alive
//   ignore-sigterm ignore SIGTERM and stay alive (feeds SIGKILL escalation)
//   echo           echo each stdin line back as {"echo": "..."} (crop channel)
const [mode, arg] = process.argv.slice(2);
const w = (s) => process.stdout.write(s);
const stay = () => setInterval(() => {}, 1 << 30);

switch (mode) {
  case 'lines': {
    const n = Number(arg || 3);
    for (let i = 0; i < n; i++) w(JSON.stringify({ seq: i, pid: process.pid }) + '\n');
    process.exit(0);
    break;   // unreachable; process.exit does not return, but say so out loud
  }
  case 'chunked': {
    const s = JSON.stringify({ seq: 0, note: 'split across writes' }) + '\n';
    const a = s.slice(0, 5), b = s.slice(5, 12), c = s.slice(12);
    w(a);
    setTimeout(() => w(b), 15);
    setTimeout(() => w(c), 30);
    stay();
    break;
  }
  case 'garbage': {
    w('\n');
    w('   \n');
    w('this is not json\n');
    w(JSON.stringify({ seq: 0, survived: true }) + '\n');
    stay();
    break;
  }
  case 'crash': {
    w(JSON.stringify({ seq: 0, pid: process.pid }) + '\n');
    setTimeout(() => process.exit(1), 5);
    break;
  }
  case 'silent':
    stay();
    break;
  case 'stderr':
    process.stderr.write('stub diagnostic line\n');
    stay();
    break;
  case 'ignore-sigterm':
    process.on('SIGTERM', () => {});
    w(JSON.stringify({ seq: 0, stubborn: true }) + '\n');
    stay();
    break;
  case 'echo': {
    let buf = '';
    process.stdin.on('data', (d) => {
      buf += d.toString();
      const parts = buf.split('\n');
      buf = parts.pop();
      for (const l of parts) if (l.trim()) w(JSON.stringify({ echo: l }) + '\n');
    });
    stay();
    break;
  }
  default:
    process.stderr.write('unknown stub mode: ' + mode + '\n');
    process.exit(2);
}
