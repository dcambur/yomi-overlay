// What "correct" means for the JavaScript here, so it stops being a matter of
// whose turn it was to write the file.
//
// The app ships ZERO runtime dependencies and that is not changing; this is a
// dev dependency, run by tools/lint.sh from the pre-commit hook and from CI, so
// the same rules apply on a laptop and on a runner.
//
// Two kinds of rule, and the distinction matters when you are deciding whether
// to silence one:
//
//   correctness  an undefined variable, an unused binding, a promise nobody
//                awaits. These are bugs the file cannot show you by reading it.
//   layout       two-space indent, 96 columns, no trailing whitespace. These
//                are not opinions worth arguing per-file; they are what makes a
//                diff readable.
//
// Everything here runs in one of three worlds, and each gets its own globals so
// that a typo cannot pass as "probably from the environment".

'use strict';

const js = require('@eslint/js');

/** Names the browser gives a page, plus what our own pages put on window. */
const BROWSER = {
  window: 'readonly', document: 'readonly', navigator: 'readonly',
  console: 'readonly', getComputedStyle: 'readonly', requestAnimationFrame: 'readonly',
  setTimeout: 'readonly', clearTimeout: 'readonly',
  setInterval: 'readonly', clearInterval: 'readonly',
  Node: 'readonly', Element: 'readonly', CSS: 'readonly',
  performance: 'readonly', fetch: 'readonly', URL: 'readonly',
};

/** Node's own globals, for the main process, the tools and the tests. */
const NODE = {
  require: 'readonly', module: 'writable', exports: 'writable',
  __dirname: 'readonly', __filename: 'readonly',
  process: 'readonly', console: 'readonly', Buffer: 'readonly',
  setTimeout: 'readonly', clearTimeout: 'readonly',
  setInterval: 'readonly', clearInterval: 'readonly', setImmediate: 'readonly',
  URL: 'readonly', TextDecoder: 'readonly', TextEncoder: 'readonly',
  structuredClone: 'readonly', fetch: 'readonly', AbortController: 'readonly',
};

const LAYOUT = {
  // Two spaces per level, but a continuation may line up under whatever it is
  // continuing — `first` — because that is what this codebase already does and
  // it is the more readable of the two for a long argument list:
  //
  //     assert.strictEqual(schemaOf(db), 'flat',
  //                        'the Python one is the old shape');
  indent: ['error', 2, {
    SwitchCase: 1,
    CallExpression: { arguments: 'first' },
    FunctionDeclaration: { parameters: 'first' },
    FunctionExpression: { parameters: 'first' },
    ArrayExpression: 'first',
    ObjectExpression: 'first',
    ImportDeclaration: 'first',
    flatTernaryExpressions: true,
    ignoredNodes: ['TemplateLiteral *', 'ConditionalExpression'],
  }],
  'max-len': ['error', { code: 96, ignoreUrls: true, ignoreRegExpLiterals: true }],
  'no-trailing-spaces': 'error',
  'eol-last': 'error',
  semi: ['error', 'always'],
  quotes: ['error', 'single', { avoidEscape: true }],
  'comma-dangle': ['error', 'always-multiline'],
  'object-curly-spacing': ['error', 'always'],
  'space-before-blocks': 'error',
  'keyword-spacing': 'error',
  'arrow-spacing': 'error',
  'no-multiple-empty-lines': ['error', { max: 2, maxBOF: 0, maxEOF: 1 }],
};

const CORRECTNESS = {
  // An unused argument is often the signal that a callback's contract changed.
  'no-unused-vars': ['error', { args: 'after-used', argsIgnorePattern: '^_' }],
  'no-var': 'error',
  'prefer-const': 'error',
  eqeqeq: ['error', 'always', { null: 'ignore' }],
  'no-implicit-coercion': ['error', { boolean: false }],
  'no-return-await': 'error',
  // Deliberately NOT require-await: a stand-in for an async bridge has to
  // return a promise whether or not it awaits anything, and that is most of
  // the test doubles here.
  'no-shadow': 'error',
  // An empty catch is how "the file was already gone" gets written; it has to
  // say so, which the codebase already does.
  'no-empty': ['error', { allowEmptyCatch: false }],
  // Japanese text is full of ideographic spaces and they are not a mistake in a
  // comment or a string — only in code.
  'no-irregular-whitespace': ['error', { skipComments: true, skipStrings: true,
                                         skipTemplates: true }],
};

module.exports = [
  { ignores: ['**/node_modules/**', 'app/vendor/**', 'data/**', 'bin/**'] },

  js.configs.recommended,

  {
    rules: { ...LAYOUT, ...CORRECTNESS },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
  },

  // The main process, the build tools and the tests: Node, CommonJS.
  {
    files: ['app/*.js', 'app/main/**/*.js', 'app/shell/**/*.js', 'tools/**/*.js',
            'test/**/*.js', 'eslint.config.js'],
    languageOptions: { sourceType: 'commonjs', globals: NODE },
  },

  // Preload scripts see both sides — that is what they are for.
  {
    files: ['app/preload/**/*.js'],
    languageOptions: { sourceType: 'commonjs', globals: { ...NODE, ...BROWSER } },
  },

  // Page scripts: classic scripts sharing one global scope, so a name defined
  // in one file is legitimately used in another (see index.html's load order).
  {
    files: ['app/renderer/**/*.js', 'app/settings/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      // Page scripts hang their exports on `window` and read them back off it,
      // so there are no bare cross-file globals to declare — and declaring any
      // would collide with the local names the reader destructures them into.
      globals: BROWSER,
    },
    rules: {
      // They are top-level functions in a shared scope by design.
      'no-unused-vars': ['error', { args: 'after-used', argsIgnorePattern: '^_',
                                    varsIgnorePattern: '^(init)$' }],
    },
  },
];
