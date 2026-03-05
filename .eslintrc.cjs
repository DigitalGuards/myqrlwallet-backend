module.exports = {
  root: true,
  env: {
    node: true,
    es2020: true,
    mocha: true,
  },
  extends: [
    'eslint:recommended',
    'prettier',
  ],
  parserOptions: {
    ecmaVersion: 2020,
    sourceType: 'module',
  },
  rules: {
    'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    'no-console': 'off',
  },
  ignorePatterns: ['node_modules/', 'go-qrllib/', 'merchant-api/', 'myqrlwallet-frontend/'],
};
