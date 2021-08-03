module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    clearMocks: true,
    bail: 1,
    coverageProvider: 'v8',
    setupFilesAfterEnv: ['./jest.setup.fetch-mock.js'],
    testMatch: ['<rootDir>/tests/**/*.test.ts', '<rootDir>/benchmarks/**/*.benchmark.ts'],
}
