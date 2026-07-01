/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  globals: {
    'ts-jest': {
      diagnostics: false,
    },
  },
  moduleNameMapper: {
    '^baileys$': '<rootDir>/test-setup/baileys.mock.ts',
    '^baileys/lib/Utils/logger$': '<rootDir>/test-setup/baileys-logger.mock.ts',
    '^@whiskeysockets/baileys$': '<rootDir>/test-setup/baileys.mock.ts',
    '^@whiskeysockets/baileys/lib/Utils/logger$': '<rootDir>/test-setup/baileys-logger.mock.ts',
    '^audio-decode$': '<rootDir>/test-setup/audio-decode.mock.ts',
  },
};
