module.exports = {
  root: true,
  env: {
    node: true,
    es2022: true,
    mocha: true,
  },
  extends: ['eslint:recommended', 'prettier'],
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  rules: {
    'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    'no-console': 'off',
  },
  overrides: [
    {
      files: ['src/**/*.ts'],
      parser: '@typescript-eslint/parser',
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        project: './tsconfig.eslint.json',
        tsconfigRootDir: __dirname,
      },
      plugins: ['@typescript-eslint'],
      extends: [
        'eslint:recommended',
        'plugin:@typescript-eslint/strict-type-checked',
        'plugin:@typescript-eslint/stylistic-type-checked',
        'prettier',
      ],
      rules: {
        '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
        'no-console': 'off',

        // ── No type laundering (mandate) ──────────────────────────
        // The compiler's view of a value must never be widened or rewritten
        // by hand. Wire/env input gets runtime guards, not assertions.
        '@typescript-eslint/no-explicit-any': 'error',
        '@typescript-eslint/no-non-null-assertion': 'error',
        '@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'never' }],
        '@typescript-eslint/ban-ts-comment': [
          'error',
          {
            'ts-ignore': true,
            'ts-nocheck': true,
            'ts-expect-error': 'allow-with-description',
            minimumDescriptionLength: 10,
          },
        ],

        // This service guards untrusted wire input (Socket.IO payloads, RPC
        // bodies) at runtime even where the static type says it can't be
        // malformed; don't flag those defensive checks as dead.
        '@typescript-eslint/no-unnecessary-condition': 'off',

        // Numbers in log/error messages are idiomatic; only ban the
        // genuinely lossy stringifications.
        '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      },
    },
    {
      // ── Crypto primitive fence (mandate) ──────────────────────
      // Only src/crypto/ may import node:crypto or any crypto library.
      // Today the backend's sole primitive is the timing-safe token compare;
      // the relay routes E2E ciphertext and must never grow inline crypto.
      files: ['src/**/*.ts'],
      excludedFiles: ['src/crypto/**'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            paths: [
              {
                name: 'crypto',
                message: 'Crypto primitives may only be used inside src/crypto/ (the boundary).',
              },
              {
                name: 'node:crypto',
                message: 'Crypto primitives may only be used inside src/crypto/ (the boundary).',
              },
            ],
            patterns: [
              {
                group: ['@noble/*', '@theqrl/*'],
                message: 'Crypto implementations may only be imported inside src/crypto/.',
              },
            ],
          },
        ],
        'no-restricted-syntax': [
          'error',
          {
            selector: 'CallExpression[callee.object.name="Math"][callee.property.name="random"]',
            message: 'Math.random is not a CSPRNG; use src/crypto/ if randomness is ever needed.',
          },
          {
            selector: 'MemberExpression[property.name="subtle"]',
            message: 'WebCrypto SubtleCrypto may only be used inside src/crypto/.',
          },
          {
            selector: 'MemberExpression[property.name="randomUUID"]',
            message: 'Randomness must flow through src/crypto/ (the boundary).',
          },
        ],
      },
    },
  ],
  ignorePatterns: [
    'node_modules/',
    'dist/',
    'myqrlwallet-frontend/',
    'go-qrllib/',
    'merchant-api/',
  ],
};
