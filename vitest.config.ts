import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        printConsoleTrace: true,
        silent: false,
        include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
        environment: 'node',
        fileParallelism: false
    }
});
