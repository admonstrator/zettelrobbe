import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import globals from 'globals';
import pluginJs from '@eslint/js';
import prettier from 'eslint-config-prettier';
import jsdoc from 'eslint-plugin-jsdoc';

// The type-checked files: tsconfig.json lists them under `files`. Reading the
// list here means a module joins the JSDoc rules below the moment it joins
// the type check, and legacy files stay out until they are cleaned up.
const typeCheckedFiles = JSON.parse(
  readFileSync(new URL('./tsconfig.json', import.meta.url), 'utf8')
).files.filter((file) => file.endsWith('.js'));

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
  {
    // JSDoc is the type system of the type-checked files, so it has to be
    // well-formed: real tag names, parseable types, @param names that match
    // the signature, a type on every @param, @property and @returns. What a
    // comment says, and whether a function has one, is left to review.
    // no-undefined-types stays off: tsc resolves the types (imports,
    // typedefs from other files, globals) and the rule cannot.
    files: typeCheckedFiles,
    plugins: { jsdoc },
    settings: { jsdoc: { mode: 'typescript' } },
    rules: {
      'jsdoc/check-access': 'error',
      'jsdoc/check-param-names': 'error',
      'jsdoc/check-property-names': 'error',
      'jsdoc/check-tag-names': 'error',
      'jsdoc/check-types': 'error',
      'jsdoc/check-values': 'error',
      'jsdoc/empty-tags': 'error',
      'jsdoc/implements-on-classes': 'error',
      'jsdoc/no-multi-asterisks': 'error',
      'jsdoc/require-param': 'error',
      'jsdoc/require-param-name': 'error',
      'jsdoc/require-param-type': 'error',
      'jsdoc/require-property-name': 'error',
      'jsdoc/require-property-type': 'error',
      'jsdoc/require-returns-check': 'error',
      'jsdoc/require-returns-type': 'error',
      'jsdoc/valid-types': 'error',
      'jsdoc/no-undefined-types': 'off',
    },
  },
  prettier, // disables formatting rules that would conflict with Prettier
];
