import globals from 'globals';
import pluginJs from '@eslint/js';
import prettier from 'eslint-config-prettier';

/** @type {import('eslint').Linter.Config[]} */
export default [
  {
    ignores: ['public/vendor/**', 'OPENAPI/**', 'data/**'],
  },
  {
    // Server code. Node globals only: with the browser set, names such as
    // `history`, `document`, `status` or `name` would count as defined, and
    // no-undef could not catch a forgotten require after code moves.
    files: ['**/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: globals.node,
    },
  },
  {
    // Tests drive pages in a browser (page.evaluate) and fake a DOM, so they
    // legitimately use both sets.
    files: ['tests/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
  },
  {
    // Browser assets are native ES modules loaded with <script type="module">.
    files: ['public/js/**/*.js'],
    languageOptions: {
      sourceType: 'module',
      globals: globals.browser,
    },
  },
  pluginJs.configs.recommended,
  prettier, // disables formatting rules that would conflict with Prettier
];
