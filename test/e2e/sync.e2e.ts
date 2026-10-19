import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { browser, expect } from '@wdio/globals';
import { afterEach, beforeEach, describe, it } from 'mocha';
import { obsidianPage } from 'wdio-obsidian-service';
import { addFolder, bodyOf, createAndOpen, editFile, listOf, note, readFileOrEmpty, readNote, setAutoSync, vaultName, vaultPath, waitForIdle } from './helpers';

// Runs in real Obsidian. The "other vault" is a temporary folder next to the sandboxed test vault, named
// "Other" in this computer's table.
describe('Cross-Vault Sync in Obsidian', function () {
	let vault: string;
	let own: (notePath: string) => string;
	let other: string;

	beforeEach(async function () {
		await obsidianPage.resetVault();
		vault = await vaultPath();
		const name = await vaultName();
		own = (notePath) => `${name}/${notePath}`;
		other = fs.mkdtempSync(path.join(os.tmpdir(), 'cvs-other-'));
		await addFolder('Other', other);
		await setAutoSync(true);
	});

	afterEach(function () {
		fs.rmSync(other, { recursive: true, force: true });
	});

	it('loads and registers its commands', async function () {
		const commands = await browser.executeObsidian(({ app }) =>
			Object.keys((app as unknown as { commands: { commands: Record<string, unknown> } }).commands.commands).filter((id) => id.startsWith('cross-vault-sync:')).sort()
		);
		expect(commands).toEqual(['cross-vault-sync:add-sync-target', 'cross-vault-sync:sync-active-note', 'cross-vault-sync:sync-all-notes']);
	});

	it('creates the target file with the sync command', async function () {
		const target = path.join(other, 'Note.md');
		const content = note('first', [own('Note'), 'Other/Note']);
		await createAndOpen('Note.md', content);
		await browser.executeObsidianCommand('cross-vault-sync:sync-active-note');
		await browser.waitUntil(() => bodyOf(readFileOrEmpty(target)) === content, { timeoutMsg: 'target not created' });
	});

	it('pushes an edit made in Obsidian', async function () {
		const target = path.join(other, 'Note.md');
		const list = [own('Note'), 'Other/Note'];
		await createAndOpen('Note.md', note('first', list));
		await browser.executeObsidianCommand('cross-vault-sync:sync-active-note');
		await browser.waitUntil(() => fs.existsSync(target));
		// A person's edit changes the text and keeps the sync fields in the frontmatter
		await browser.executeObsidian(async ({ app, obsidian }) => {
			const file = app.vault.getAbstractFileByPath('Note.md');
			if (file instanceof obsidian.TFile) await app.vault.process(file, (data) => data.replace('first', 'edited in Obsidian'));
		});
		await browser.waitUntil(() => bodyOf(readFileOrEmpty(target)) === note('edited in Obsidian', list), { timeoutMsg: 'edit not pushed' });
	});

	it('pulls an edit made in the other copy into the open editor and keeps the cursor', async function () {
		const target = path.join(other, 'Note.md');
		const list = [own('Note'), 'Other/Note'];
		await createAndOpen('Note.md', note('line one\nline two', list));
		await browser.executeObsidianCommand('cross-vault-sync:sync-active-note');
		await browser.waitUntil(() => fs.existsSync(target));
		await browser.waitUntil(async () => (await readNote('Note.md')).includes('sync_hash'), { timeoutMsg: 'sync fields not written' });
		// In the text: Obsidian itself moves a cursor out of the frontmatter
		const placed = await browser.executeObsidian(({ app, obsidian }) => {
			const editor = app.workspace.getActiveViewOfType(obsidian.MarkdownView)?.editor;
			const line = editor?.getValue().split('\n').indexOf('line two') ?? -1;
			editor?.setCursor({ line, ch: 4 });
			return editor?.getCursor();
		});
		expect(placed?.line).toBeGreaterThan(0);
		const external = note('line one\nline two\nline three from the other vault', list);
		editFile(target, external);
		await browser.waitUntil(async () => bodyOf(await readNote('Note.md')) === external, { timeoutMsg: 'edit not pulled' });
		const state = await browser.executeObsidian(({ app, obsidian }) => {
			const editor = app.workspace.getActiveViewOfType(obsidian.MarkdownView)?.editor;
			return { cursor: editor?.getCursor(), text: editor?.getValue() };
		});
		expect(bodyOf(state.text ?? '')).toBe(external);
		expect(state.cursor).toEqual(placed);
	});

	it('adds the own entry when sync_targets is edited in the open note', async function () {
		await createAndOpen('Own.md', 'body\n');
		await browser.executeObsidian(async ({ app, obsidian }) => {
			const file = app.vault.getAbstractFileByPath('Own.md');
			if (!(file instanceof obsidian.TFile)) return;
			await app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
				frontmatter['sync_targets'] = ['Other/Own'];
			});
		});
		await browser.waitUntil(async () => JSON.stringify(await listOf('Own.md')) === JSON.stringify([own('Own'), 'Other/Own']), {
			timeoutMsg: 'own entry not added',
		});
	});

	it('moving the note updates its own entry and does not recreate the old file', async function () {
		const target = path.join(other, 'Note.md');
		await createAndOpen('Note.md', note('move me', [own('Note'), 'Other/Note']));
		await browser.executeObsidianCommand('cross-vault-sync:sync-active-note');
		await browser.waitUntil(() => fs.existsSync(target));
		await browser.executeObsidian(async ({ app, obsidian }) => {
			await app.vault.createFolder('Archive');
			const file = app.vault.getAbstractFileByPath('Note.md');
			if (file instanceof obsidian.TFile) await app.fileManager.renameFile(file, 'Archive/Note.md');
		});
		await browser.waitUntil(async () => JSON.stringify(await listOf('Archive/Note.md')) === JSON.stringify([own('Archive/Note'), 'Other/Note']), {
			timeoutMsg: 'own entry not updated',
		});
		await browser.waitUntil(() => readFileOrEmpty(target).includes(own('Archive/Note')), { timeoutMsg: 'new list not pushed' });
		await browser.executeObsidianCommand('cross-vault-sync:sync-all-notes');
		await browser.pause(1500);
		expect(fs.existsSync(path.join(vault, 'Note.md'))).toBe(false);
	});

	it('keeps the newest edit of a conflict and saves the other next to its copy', async function () {
		const target = path.join(other, 'Note.md');
		const list = [own('Note'), 'Other/Note'];
		await createAndOpen('Note.md', note('base', list));
		await browser.executeObsidianCommand('cross-vault-sync:sync-active-note');
		await browser.waitUntil(() => fs.existsSync(target));
		// The sync's own write to the target fires the folder watcher. Its debounced sync must not push the local edit below.
		await setAutoSync(false);
		await waitForIdle();
		await browser.executeObsidian(async ({ app, obsidian }) => {
			const file = app.vault.getAbstractFileByPath('Note.md');
			if (file instanceof obsidian.TFile) await app.vault.process(file, (data) => data.replace('base', 'edited here'));
		});
		const here = await readNote('Note.md');
		await browser.pause(1100);
		editFile(target, note('edited there', list));
		await browser.executeObsidianCommand('cross-vault-sync:sync-active-note');
		await browser.waitUntil(async () => bodyOf(await readNote('Note.md')) === note('edited there', list), { timeoutMsg: 'newest edit not kept' });
		const backups = fs.readdirSync(vault).filter((name) => name.startsWith('Note.sync-conflict-'));
		expect(backups).toHaveLength(1);
		expect(fs.readFileSync(path.join(vault, backups[0]!), 'utf8')).toBe(here);
	});
});
