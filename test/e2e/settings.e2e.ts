import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { browser, expect } from '@wdio/globals';
import { afterEach, beforeEach, describe, it } from 'mocha';
import { addFolder, createAndOpen, inSettings, note, openPluginSettings, row, setAutoSync, vaultName, type AppWithPlugins, type AppWithSettings } from './helpers';

const NAMES = ['Automatic sync', 'Sync debounce (ms)', 'Frontmatter property', 'Show notifications', 'Create conflict backup'];

async function pluginState() {
	return browser.executeObsidian(async ({ app }) => {
		const plugin = (app as unknown as AppWithPlugins).plugins.plugins['cross-vault-sync']!;
		return { settings: { ...plugin.settings }, watched: plugin.watchers.watchers.size, data: await plugin.loadData() };
	});
}

describe('Cross-Vault Sync settings tab in Obsidian', function () {
	let other: string;

	// No obsidianPage.resetVault(): it deletes the vault's .obsidian/plugins folder, and saveData() then writes nothing.
	// Each spec file starts with a fresh copy of the vault.
	beforeEach(async function () {
		other = fs.mkdtempSync(path.join(os.tmpdir(), 'cvs-other-'));
		await addFolder('Other', other);
		await setAutoSync(true);
	});

	afterEach(async function () {
		await browser.executeObsidian(async ({ app }) => {
			(app as unknown as AppWithSettings).setting.close();
			const plugin = (app as unknown as AppWithPlugins).plugins.plugins['cross-vault-sync']!;
			Object.assign(plugin.settings, { autoSync: true, debounceMs: 1000, frontmatterKey: 'sync_targets' });
			await plugin.saveSettings();
		});
		fs.rmSync(other, { recursive: true, force: true });
	});

	it('shows the settings and saves them, and only them, in the plugin data', async function () {
		const target = path.join(other, 'Note.md');
		await createAndOpen('Note.md', note('body', [`${await vaultName()}/Note`, 'Other/Note']));
		await browser.executeObsidianCommand('cross-vault-sync:sync-active-note');
		await browser.waitUntil(() => fs.existsSync(target));
		const before = await pluginState();
		expect(before.watched).toBe(1);

		await openPluginSettings();
		// The general settings come first, without a heading. The vault folder list follows in a group of its own.
		const names = await browser.executeObsidian(({ app }) => {
			const groups = (app as unknown as AppWithSettings).setting.activeTab.containerEl.querySelectorAll('.setting-group');
			return Array.from(groups).map((group) => Array.from(group.querySelectorAll('.setting-item-heading, .setting-item-name')).map((el) => el.textContent)[0]);
		});
		expect(names).toEqual([NAMES[0], 'Vaults and folders on this computer']);
		const general = await browser.executeObsidian(({ app }) => {
			const group = (app as unknown as AppWithSettings).setting.activeTab.containerEl.querySelector('.setting-group');
			return Array.from(group?.querySelectorAll('.setting-item-name') ?? []).map((el) => el.textContent);
		});
		expect(general).toEqual(NAMES);

		await inSettings(() => row('Automatic sync').$('.checkbox-container').click());
		await browser.waitUntil(async () => !(await pluginState()).settings.autoSync, { timeoutMsg: 'toggle not saved' });

		const enter = (name: string, value: string, key: string) =>
			inSettings(async () => {
				await row(name).$('input').setValue(value);
				await browser.keys(key);
			});
		for (const rejected of ['', '150']) {
			await enter('Sync debounce (ms)', rejected, 'Enter');
			await inSettings(() =>
				browser.waitUntil(async () => (await row('Sync debounce (ms)').getText()).includes('Value must be at least 200'), { timeoutMsg: `no inline error for "${rejected}"` })
			);
			expect((await pluginState()).settings.debounceMs).toBe(1000);
		}
		await enter('Sync debounce (ms)', '750', 'Enter');
		await browser.waitUntil(async () => (await pluginState()).settings.debounceMs === 750, { timeoutMsg: 'debounce not saved' });

		await enter('Frontmatter property', '   ', 'Tab');
		await inSettings(() =>
			browser.waitUntil(async () => (await row('Frontmatter property').getText()).includes('Enter a property name.'), { timeoutMsg: 'no inline error' })
		);
		expect((await pluginState()).settings.frontmatterKey).toBe('sync_targets');
		await enter('Frontmatter property', ' targets ', 'Tab');
		await browser.waitUntil(async () => (await pluginState()).settings.frontmatterKey === 'targets', { timeoutMsg: 'property not saved' });

		const after = await pluginState();
		expect(after.data).toEqual(after.settings);
		expect(after.watched).toBe(0);
	});

	it('finds every setting with the settings search', async function () {
		await browser.executeObsidian(({ app }) => (app as unknown as AppWithSettings).setting.open());
		for (const name of NAMES) {
			await inSettings(() => browser.$('.mod-settings .search-input-container input').setValue(name));
			await browser.waitUntil(
				() => browser.executeObsidian(({ app }, wanted) => (app as unknown as AppWithSettings).setting.searchResultsEl.textContent?.includes(wanted) ?? false, name),
				{ timeoutMsg: `"${name}" not found` }
			);
		}
	});
});
