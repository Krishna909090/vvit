module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleFileExtensions: ['ts', 'js'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.test.json' }],
  },
  testMatch: ['**/tests/**/*.test.ts', '**/__tests__/**/*.test.ts'],
  moduleNameMapper: {
    '^../../config/prisma$': '<rootDir>/src/config/prisma',
    '^../../utils/(.*)$': '<rootDir>/src/utils/$1',
    '^../../middlewares/(.*)$': '<rootDir>/src/middlewares/$1',
    '^../../constants/(.*)$': '<rootDir>/src/constants/$1',
    '^../../types/(.*)$': '<rootDir>/src/types/$1',
    '^../../../integration/(.*)$': '<rootDir>/src/modules/integration/$1', 
    '^../../../../config/prisma$': '<rootDir>/src/config/prisma',
    '^../../../../utils/(.*)$': '<rootDir>/src/utils/$1',
    '^uuid$': '<rootDir>/src/__mocks__/uuid.ts'
    // Remove the aggressive relative catch-all
  },
  coverageDirectory: 'coverage',

  collectCoverageFrom: [
    'src/modules/**/*.ts',
    '!src/modules/**/*.routes.ts', 
    '!src/**/*.d.ts',
  ],
  modulePathIgnorePatterns: ['<rootDir>/dist/'],
  rootDir: '.',
};
