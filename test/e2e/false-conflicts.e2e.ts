import * as fs from 'fs';
import * as path from 'path';
import { browser, expect } from '@wdio/globals';
import { beforeEach, describe, it } from 'mocha';
import { obsidianPage } from 'wdio-obsidian-service';
import { bodyOf, listOf, note, readNote, setAutoSync, vaultName, vaultPath, waitForIdle } from './helpers';

// Conflicts that nobody caused, found in real use. Automatic sync is on and Obsidian's own events start every
// sync, as when a person uses the plugin.
describe('no false conflicts in Obsidian', function () {
	let vault: string;
	let name: string;
	const backups = () => (fs.readdirSync(vault, { recursive: true }) as string[]).filter((file) => file.includes('.sync-conflict-'));

	async function createNotes(files: Record<string, string>, folders: string[]): Promise<void> {
		await browser.executeObsidian(
			async ({ app }, notes, dirs) => {
				for (const dir of dirs) await app.vault.createFolder(dir);
				for (const [file, text] of Object.entries(notes)) await app.vault.create(file, text);
			},
			files,
			folders
		);
	}

	async function open(file: string): Promise<void> {
		await browser.executeObsidian(async ({ app, obsidian }, notePath) => {
			const note = app.vault.getAbstractFileByPath(notePath);
			if (note instanceof obsidian.TFile) await app.workspace.getLeaf().openFile(note, { state: { mode: 'source' } });
		}, file);
	}

	// Waits for the debounced syncs that the last writes started, and for the ones those started in turn
	async function settle(): Promise<void> {
		for (let i = 0; i < 3; i++) {
			await browser.pause(1500);
			await waitForIdle();
		}
	}

	beforeEach(async function () {
		await obsidianPage.resetVault();
		vault = await vaultPath();
		name = await vaultName();
		await setAutoSync(true);
	});

	it('a third copy added as a folder entry to a note with a copy in the same vault', async function () {
		const pair = [`${name}/topic`, `${name}/Archive/topic`];
		await createNotes({ 'topic.md': note('Hello', pair), 'Archive/topic.md': note('Hello', pair) }, ['Archive', 'Company']);
		await open('topic.md');
		await browser.executeObsidianCommand('cross-vault-sync:sync-active-note');
		await settle();

		// A person adds the folder, as Copy sync target on the folder gives it
		await browser.executeObsidian(async ({ app, obsidian }, entry) => {
			const file = app.vault.getAbstractFileByPath('topic.md');
			if (!(file instanceof obsidian.TFile)) return;
			await app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
				(frontmatter['sync_targets'] as string[]).push(entry);
			});
		}, `${name}/Company/`);
		await browser.waitUntil(() => fs.existsSync(path.join(vault, 'Company', 'topic.md')), { timeoutMsg: 'the third copy was not created' });
		await settle();

		const exact = [...pair, `${name}/Company/topic`];
		for (const file of ['topic.md', 'Archive/topic.md', 'Company/topic.md']) {
			expect(await listOf(file)).toEqual(exact);
			expect(bodyOf(await readNote(file))).toBe(note('Hello', exact));
		}
		expect(backups()).toEqual([]);
	});

	it('opening a conflict backup in a folder that a folder entry names syncs nothing', async function () {
		const list = [`${name}/topic`, `${name}/Company/`];
		const files = {
			'topic.md': note('Hello', list),
			'Company/topic.md': note('Hello', list),
			'Company/topic.sync-conflict-0123abcd.md': note('older', list),
		};
		await createNotes(files, ['Company']);
		await open('Company/topic.sync-conflict-0123abcd.md');
		await settle();
		for (const [file, text] of Object.entries(files)) expect(await readNote(file)).toBe(text);
		expect(backups()).toEqual(['Company/topic.sync-conflict-0123abcd.md'.split('/').join(path.sep)]);
	});

	// Properties showed the sync fields of the note as it was opened. Its next edit wrote them back, an older
	// version than the copies had, and every tag made a conflict backup (seen in Obsidian 1.14.5).
	it('tags added in Properties of the open note', async function () {
		const pair = [`${name}/Security/topic`, `${name}/Network/Security/topic`];
		await createNotes({ 'Security/topic.md': note('Hello', pair), 'Network/Security/topic.md': note('Hello', pair) }, ['Security', 'Network/Security']);
		await open('Network/Security/topic.md');
		await browser.executeObsidianCommand('cross-vault-sync:sync-active-note');
		await settle();

		// A person adds a tags property, then the tags, with the mouse and the keyboard
		await browser.$('.workspace-leaf.mod-active .metadata-add-button').click();
		await browser.keys('tags');
		await browser.keys('Enter');
		for (const tag of ['to-do/this-year', 'foobar']) {
			await browser.$('.workspace-leaf.mod-active .metadata-property[data-property-key="tags"] .multi-select-input').click();
			await browser.keys(tag);
			await browser.keys('Enter');
			await browser.keys('Escape');
			await settle();
		}

		for (const file of ['Security/topic.md', 'Network/Security/topic.md']) {
			const tags = await browser.executeObsidian(({ app, obsidian }, notePath) => {
				const copy = app.vault.getAbstractFileByPath(notePath);
				const frontmatter: Record<string, unknown> | undefined = copy instanceof obsidian.TFile ? app.metadataCache.getFileCache(copy)?.frontmatter : undefined;
				return frontmatter?.['tags'];
			}, file);
			expect(tags).toEqual(['to-do/this-year', 'foobar']);
		}
		expect(backups()).toEqual([]);
	});
});
