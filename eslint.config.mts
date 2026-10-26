import obsidianmd from 'eslint-plugin-obsidianmd';
// Not part of the package's public entry point: custom brands replace the defaults, so they are added to them
import { DEFAULT_BRANDS } from 'eslint-plugin-obsidianmd/dist/lib/rules/ui/brands.js';
import globals from 'globals';
import { globalIgnores, defineConfig } from 'eslint/config';

export default defineConfig(
	globalIgnores([
		'node_modules',
		'dist',
		'coverage',
		'.obsidian-cache',
		'esbuild.config.mjs',
		'version-bump.mjs',
		'versions.json',
		'main.js',
		'package.json',
		'package-lock.json',
		'tsconfig.json',
		'test/tsconfig.json',
	]),
	{
		languageOptions: {
			globals: {
				...globals.browser,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: ['eslint.config.mts', 'manifest.json', 'vitest.config.ts', 'wdio.conf.mts'],
					// These run in Node.js. The tsconfig of src has no Node.js types (see tsconfig.json), the one of the tests has.
					defaultProject: 'test/tsconfig.json',
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json'],
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		rules: {
			'obsidianmd/ui/sentence-case': ['warn', { brands: [...DEFAULT_BRANDS, 'Cross-Vault Sync'] }],
		},
	},
	{
		// WebdriverIO declares its configuration and browser types in a global namespace
		files: ['wdio.conf.mts', 'test/e2e/**/*.ts'],
		languageOptions: {
			globals: { WebdriverIO: 'readonly' },
		},
	},
);
