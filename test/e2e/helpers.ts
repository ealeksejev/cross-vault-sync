import * as fs from 'fs';
import { browser } from '@wdio/globals';
import { readHeader, withoutHeader, writeHeader } from '../../src/header';

// The plugin as the e2e tests see it inside Obsidian. Functions passed to executeObsidian run in Obsidian
// and cannot use anything from this file, so they reach the plugin through this type.
export interface PluginHandle {
	settings: { autoSync: boolean; debounceMs: number; frontmatterKey: string };
	engine: { debounceTimers: Map<string, number>; syncQueues: Map<string, Promise<void>> };
	watchers: { watchers: Map<string, unknown> };
	ownPath: { entryFor(file: unknown): string };
	folders: { setManual(name: string, folder: string): void };
	loadData(): Promise<unknown>;
	saveSettings(): Promise<void>;
}

export type AppWithPlugins = { plugins: { plugins: Record<string, PluginHandle> } };

export const note = (body: string, list: string[]) => `---\nsync_targets:\n${list.map((p) => `  - ${p}`).join('\n')}\n---\n${body}\n`;

// A note as the user sees it: without the sync fields the plugin writes into its frontmatter
export const bodyOf = (content: string): string => withoutHeader(content);

// An edit by another program: new text, with the sync fields the file had, as an editor keeps them
export function editFile(file: string, next: string): void {
	const header = readHeader(fs.readFileSync(file, 'utf8'));
	fs.writeFileSync(file, header ? writeHeader(next, header) : next);
}

export async function vaultName(): Promise<string> {
	return browser.executeObsidian(({ app }) => app.vault.getName());
}

// A folder outside the vault under a name in this computer's table, as if added in the settings
export async function addFolder(name: string, folder: string): Promise<void> {
	await browser.executeObsidian(({ app }, folderName, folderPath) => {
		(app as unknown as AppWithPlugins).plugins.plugins['cross-vault-sync']!.folders.setManual(folderName, folderPath);
	}, name, folder);
}

export async function vaultPath(): Promise<string> {
	return browser.executeObsidian(({ app, obsidian }) => {
		const adapter = app.vault.adapter;
		return adapter instanceof obsidian.FileSystemAdapter ? adapter.getBasePath() : '';
	});
}

// Creates the note and opens it in a source-mode editor
export async function createAndOpen(name: string, content: string): Promise<void> {
	await browser.executeObsidian(async ({ app }, notePath, noteContent) => {
		const file = await app.vault.create(notePath, noteContent);
		const leaf = app.workspace.getLeaf();
		await leaf.openFile(file, { state: { mode: 'source' } });
	}, name, content);
}

export async function readNote(name: string): Promise<string> {
	return browser.executeObsidian(async ({ app, obsidian }, notePath) => {
		const file = app.vault.getAbstractFileByPath(notePath);
		return file instanceof obsidian.TFile ? app.vault.read(file) : '';
	}, name);
}

export async function listOf(name: string): Promise<unknown> {
	return browser.executeObsidian(({ app, obsidian }, notePath) => {
		const file = app.vault.getAbstractFileByPath(notePath);
		const frontmatter: Record<string, unknown> | undefined = file instanceof obsidian.TFile ? app.metadataCache.getFileCache(file)?.frontmatter : undefined;
		return frontmatter?.['sync_targets'];
	}, name);
}

export async function setAutoSync(enabled: boolean): Promise<void> {
	await browser.executeObsidian(({ app }, value) => {
		(app as unknown as AppWithPlugins).plugins.plugins['cross-vault-sync']!.settings.autoSync = value;
	}, enabled);
}

// Waits until no sync is scheduled or running
export async function waitForIdle(): Promise<void> {
	await browser.waitUntil(
		() =>
			browser.executeObsidian(({ app }) => {
				const { engine } = (app as unknown as AppWithPlugins).plugins.plugins['cross-vault-sync']!;
				return engine.debounceTimers.size === 0 && engine.syncQueues.size === 0;
			}),
		{ timeoutMsg: 'syncs still pending' }
	);
}

export const readFileOrEmpty = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');

// The settings window is not part of Obsidian's public API
export type AppWithSettings = {
	setting: { open(): void; close(): void; openTabById(id: string): void; activeTab: { containerEl: HTMLElement }; searchResultsEl: HTMLElement };
};

export async function openPluginSettings(): Promise<void> {
	await browser.executeObsidian(({ app }) => {
		const { setting } = app as unknown as AppWithSettings;
		setting.open();
		setting.openTabById('cross-vault-sync');
	});
}

// Obsidian 1.13 and later open the settings in a window of their own. UI steps run there, the plugin is read in the main window.
export async function inSettings(steps: () => Promise<unknown>): Promise<void> {
	const main = await browser.getWindowHandle();
	await browser.waitUntil(async () => (await browser.getWindowHandles()).length > 1, { timeoutMsg: 'no settings window' });
	await browser.switchWindow(/^Settings/);
	try {
		await steps();
	} finally {
		await browser.switchToWindow(main);
	}
}

// A row of the open settings tab, found by its name
export const row = (name: string) =>
	browser.$(`//div[contains(@class,"vertical-tab-content")]//div[contains(@class,"setting-item ") or @class="setting-item"][.//div[@class="setting-item-name" and text()="${name}"]]`);
