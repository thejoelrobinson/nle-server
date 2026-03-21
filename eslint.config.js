import js from '@eslint/js';
import globals from 'globals';

export default [
  js.configs.recommended,

  // ── Source files ──────────────────────────────────────────────────────────
  {
    files: ['src/web/**/*.js'],
    ignores: ['src/web/__tests__/**'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
      },
    },
    rules: {
      'no-undef':        'error',
      'no-unused-vars':  'error',
      'no-console':      'warn',
      'eqeqeq':          'error',
      'prefer-const':    'error',
    },
  },

  // ── Test files ────────────────────────────────────────────────────────────
  {
    files: ['src/web/__tests__/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        // Vitest globals (injected at runtime; declare here to satisfy no-undef)
        describe:   'readonly',
        it:         'readonly',
        expect:     'readonly',
        vi:         'readonly',
        beforeEach: 'readonly',
        afterEach:  'readonly',
      },
    },
    rules: {
      'no-undef':       'error',
      'no-unused-vars': 'error',
      'no-console':     'off',   // tests may log freely
      'eqeqeq':         'error',
      'prefer-const':   'error',
    },
  },
];
