import globals from 'globals';
import pluginJs from '@eslint/js';
import prettier from 'eslint-config-prettier';

/** @type {import('eslint').Linter.Config[]} */
export default [
  {
    ignores: ['public/vendor/**', 'OPENAPI/**', 'data/**'],
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
  },
  pluginJs.configs.recommended,
  prettier, // disables formatting rules that would conflict with Prettier
];
