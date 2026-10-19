import * as path from 'path';
import process, { env } from 'process';
import { parseObsidianVersions } from 'wdio-obsidian-service';

// wdio-obsidian-service downloads Obsidian versions into this folder
const cacheDir = path.resolve('.obsidian-cache');

// "earliest" is the plugin's minAppVersion. Override with OBSIDIAN_VERSIONS, e.g. "latest/latest".
const versions = await parseObsidianVersions(env.OBSIDIAN_VERSIONS ?? 'earliest/earliest latest/latest', { cacheDir });
if (env.CI) {
	// The resolved versions are the GitHub Actions cache key (see .github/workflows/test.yml)
	process.stdout.write(`obsidian-cache-key: ${JSON.stringify(versions)}\n`);
}

export const config: WebdriverIO.Config = {
	runner: 'local',
	framework: 'mocha',
	specs: ['./test/e2e/**/*.e2e.ts'],
	maxInstances: Number(env.WDIO_MAX_INSTANCES ?? 2),
	// The plugin is desktop-only, so no mobile emulation
	capabilities: versions.map<WebdriverIO.Capabilities>(([appVersion, installerVersion]) => ({
		browserName: 'obsidian',
		'wdio:obsidianOptions': {
			appVersion,
			installerVersion,
			plugins: ['.'],
			vault: 'test/vaults/simple',
		},
	})),
	services: ['obsidian'],
	reporters: ['obsidian'],
	mochaOpts: {
		ui: 'bdd',
		timeout: 60 * 1000,
	},
	waitforInterval: 250,
	waitforTimeout: 10 * 1000,
	logLevel: 'warn',
	cacheDir,
	injectGlobals: false,
};
