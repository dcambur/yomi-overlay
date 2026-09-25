// The suites that need Chromium — the overlay page and the settings page — in
// ONE Electron process.
//
// They used to be two, each a regular app for a few seconds: two Dock tiles
// and a menu-bar switch per run, on the user's own screen. An accessory app
// has neither (measured: lsappinfo reports it UIElement on every sample, where
// a plain `electron` run reports Foreground), and never takes focus. Their
// windows stay hidden either way.
//
//   test/run.sh pages          VERBOSE=1 for the pages' own console output

const { app } = require('electron');

app.setActivationPolicy('accessory');
app.on('window-all-closed', () => {});

// Both suites take under 10 s; one that hangs fails the lane here, loudly.
const LIMIT_MS = 60000;

app.whenReady().then(async () => {
  setTimeout(() => {
    console.log(`FAIL  the page suites ran past ${LIMIT_MS / 1000}s — stopped`);
    app.exit(1);
  }, LIMIT_MS);
  // Side by side, in a window each: their IPC channels do not overlap, and
  // each asserts only on what reached its own handlers. Most of either suite
  // is fixed settle time, so together they take as long as the slower one.
  const failed = await Promise.all(['renderer', 'settings'].map((s) => require(`./${s}.js`)()));
  app.exit(failed.some(Boolean) ? 1 : 0);
});
