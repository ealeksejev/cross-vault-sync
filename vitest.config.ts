import { defineConfig } from 'vitest/config';

export default defineConfig({
	resolve: {
		// The obsidian package has types only. Source and tests then share one instance of the mocks.
		alias: [{ find: /^obsidian$/, replacement: 'obsidian-test-mocks/obsidian' }],
	},
	test: {
		include: ['test/unit/**/*.test.ts'],
		// obsidian-test-mocks patches DOM classes and replaces the 'obsidian' module with its mocks
		environment: 'jsdom',
		setupFiles: ['obsidian-test-mocks/vitest-setup', 'test/unit/setup.ts'],
		// Some tests wait for real timers: the debounce, the state save delay and write retries
		testTimeout: 15_000,
		coverage: {
			provider: 'v8',
			include: ['src/**/*.ts'],
			// Types only, nothing runs
			exclude: ['src/host.ts'],
			reporter: ['text', 'text-summary'],
			// npm run test:unit fails when any of these drops below 100%
			thresholds: { lines: 100, branches: 100, functions: 100, statements: 100 },
		},
	},
});
