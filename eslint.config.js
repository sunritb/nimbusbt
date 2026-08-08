import globals from 'globals'
import js from '@eslint/js'

export default [
  {
    ignores: ['node_modules/**', 'data/**', 'downloads/**']
  },
  js.configs.recommended,
  {
    files: ['src/**/*.js', 'test/**/*.js', 'test/**/*.mjs', 'desktop/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: globals.node
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-console': 'off'
    }
  },
  {
    files: ['src/webui/js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: globals.browser
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }]
    }
  },
  {
    files: ['src/webui/sw.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: {
        self: 'readonly',
        caches: 'readonly',
        skipWaiting: 'readonly',
        clients: 'readonly'
      }
    }
  }
]
