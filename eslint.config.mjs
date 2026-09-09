import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      // Harness-local, never committed (see .git/info/exclude): AI worktrees
      // and session scratch. Linting them reports on files that are not part
      // of the repo, and the noise masks a real warning in code that is.
      '.claude/**',
      'data/**',
      'docs/**',
      'due-diligence/**',
      'spike/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Plain Node ESM scripts (scripts/*.mjs, config files).
    files: ['**/*.mjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        URL: 'readonly',
      },
    },
  },
  prettierConfig,
);
