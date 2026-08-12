// Minimal stand-in for Yomitan's extension logger.
export const log = {
  log: (...a) => console.log(...a),
  warn: (...a) => console.warn(...a),
  error: (...a) => console.error(...a),
};
