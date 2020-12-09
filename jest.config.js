module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    clearMocks: true,
    coverageProvider: 'v8',
    setupFilesAfterEnv: ['./jest.setup.pg-mock.js', './jest.setup.redis-mock.js', './jest.setup.fetch-mock.js'],
    testMatch: ['<rootDir>/tests/**/*.test.ts'],
}
