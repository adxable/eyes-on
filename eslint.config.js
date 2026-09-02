// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      'no-console': 'off',
      eqeqeq: ['error', 'always'],
    },
  },
  {
    // Plain JavaScript that runs under Node outside the TypeScript build: the
    // bin shim, this file, and the one-off measurement script behind
    // docs/stage-2-acceptance.md.
    files: ['bin/*.js', 'eslint.config.js', 'docs/*.mjs'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly', URL: 'readonly' } },
  },
);
