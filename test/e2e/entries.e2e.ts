import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { browser, expect } from '@wdio/globals';
import { after, before, describe, it } from 'mocha';
import { createAndOpen, inSettings, listOf, note, openPluginSettings, readFileOrEmpty, readNote, row, vaultName, type AppWithPlugins, type AppWithSettings } from './helpers';

// The menu's items and their callbacks are not public API
type MenuInternals = { items: { titleEl?: HTMLElement; callback?: () => unknown }[] };

// What a file menu item writes to the clipboard. Obsidian's Copy path and the plugin both use navigator.clipboard.writeText,
// which is replaced with a recorder here: the system clipboard can return an older value (seen on 1.14.4 under WSLg).
async function copiedBy(notePath: string, title: string): Promise<string> {
	return browser.executeObsidian(async ({ app, obsidian }, filePath, itemTitle) => {
		const file = app.vault.getAbstractFileByPath(filePath);
		const menu = new obsidian.Menu();
		app.workspace.trigger('file-menu', menu, file, 'file-explorer-context-menu');
		const item = (menu as unknown as MenuInternals).items.find((i) => i.titleEl?.textContent === itemTitle);
		if (!item) return `no "${itemTitle}" item`;
		const written: string[] = [];
		navigator.clipboard.writeText = (text: string) => {
			written.push(text);
			return Promise.resolve();
		};
		try {
			await item.callback?.();
		} finally {
			Reflect.deleteProperty(navigator.clipboard, 'writeText');
		}
		return written.join(' | ') || '(nothing copied)';
	}, notePath, title);
}

describe('sync_targets entries in Obsidian', function () {
	// The other vault: a temporary folder that Obsidian never opened
	let other: string;

	before(function () {
		other = fs.mkdtempSync(path.join(os.tmpdir(), 'cvs-other-'));
		fs.mkdirSync(path.join(other, 'Notes'));
	});

	after(function () {
		fs.rmSync(other, { recursive: true, force: true });
	});

	it('Copy sync target gives the vault name and the path that Copy path gives, also for the own entry', async function () {
		const name = await vaultName();
		const result = await browser.executeObsidian(async ({ app, obsidian }) => {
			await app.vault.createFolder('Projects Two');
			const file = await app.vault.create('Projects Two/Note v1.2 + x & y.md', 'body\n');
			const plugin = (app as unknown as AppWithPlugins).plugins.plugins['cross-vault-sync']!;
			const adapter = app.vault.adapter as InstanceType<typeof obsidian.FileSystemAdapter>;
			const table = JSON.parse(window.localStorage.getItem('cross-vault-sync:vault-folders') ?? '{}') as { auto?: Record<string, string[]> };
			return { own: plugin.ownPath.entryFor(file), registered: table.auto?.[app.vault.getName()], base: adapter.getBasePath() };
		});
		const notePath = await copiedBy('Projects Two/Note v1.2 + x & y.md', 'from vault folder');
		const folderPath = await copiedBy('Projects Two', 'from vault folder');
		expect(notePath).toBe('Projects Two/Note v1.2 + x & y');
		expect(await copiedBy('Projects Two/Note v1.2 + x & y.md', 'Copy sync target')).toBe(`${name}/${notePath}`);
		expect(await copiedBy('Projects Two', 'Copy sync target')).toBe(`${name}/${folderPath}/`);
		expect(result.own).toBe(`${name}/${notePath}`);
		expect(result.registered).toEqual([result.base]);
	});

	it('a folder target in a folder added in the settings gets a copy with the note name, then names it exactly', async function () {
		const name = await vaultName();
		const target = path.join(other, 'Notes', 'Note.md');
		await createAndOpen('Note.md', note('body', [`${name}/Note`, 'Other/Notes/']));
		await browser.executeObsidianCommand('cross-vault-sync:sync-active-note');
		await browser.pause(500);
		expect(fs.existsSync(target)).toBe(false);

		await openPluginSettings();
		await inSettings(async () => {
			await browser.$('[aria-label="Add folder"]').click();
			// The settings window is a modal too, so the dialog is found by its title
			const dialog = '//div[contains(@class,"modal")][.//div[@class="modal-title" and text()="Add folder"]]';
			const inputs = browser.$$(`${dialog}//input[@type="text"]`);
			await inputs[0]!.setValue('Other');
			await inputs[1]!.setValue(other);
			await browser.$(`${dialog}//button[contains(@class,"mod-cta")]`).click();
			await row('Other').waitForExist({ timeoutMsg: 'the added folder is not listed' });
		});
		await browser.executeObsidian(({ app }) => (app as unknown as AppWithSettings).setting.close());

		await browser.executeObsidianCommand('cross-vault-sync:sync-active-note');
		await browser.waitUntil(() => fs.existsSync(target), { timeoutMsg: 'the other vault did not get the note' });
		await browser.waitUntil(async () => JSON.stringify(await listOf('Note.md')) === JSON.stringify([`${name}/Note`, 'Other/Notes/Note']), {
			timeoutMsg: 'the folder entry was not replaced with the exact file',
		});
		await browser.waitUntil(async () => readFileOrEmpty(target) === (await readNote('Note.md')), { timeoutMsg: 'the exact entry did not reach the copy' });
	});

	it('the add sync target dialog adds the entry, syncs, and offers the same folder next time', async function () {
		const name = await vaultName();
		await createAndOpen('Second.md', 'second\n');
		await browser.executeObsidianCommand('cross-vault-sync:add-sync-target');
		const dialog = '//div[contains(@class,"modal")][.//div[@class="modal-title" and text()="Add sync target"]]';
		const input = browser.$(`${dialog}//input[@type="text"]`);
		await input.setValue('Other/Notes/');
		await browser.$(`${dialog}//button[contains(@class,"mod-cta")]`).click();
		await browser.waitUntil(() => fs.existsSync(path.join(other, 'Notes', 'Second.md')), { timeoutMsg: 'the dialog did not sync' });
		await browser.waitUntil(async () => JSON.stringify(await listOf('Second.md')) === JSON.stringify([`${name}/Second`, 'Other/Notes/Second']), {
			timeoutMsg: 'entries not written',
		});

		await createAndOpen('Third.md', 'third\n');
		await browser.executeObsidianCommand('cross-vault-sync:add-sync-target');
		await browser.$(`${dialog}//input[@type="text"]`).waitForExist();
		expect(await browser.$(`${dialog}//input[@type="text"]`).getValue()).toBe('Other/Notes/');
		await browser.keys('Escape');
	});

	it('the path field of both dialogs takes the whole width of its row', async function () {
		// The previous test closes its dialog with Escape
		await browser.$(dialogTitled('Add sync target')).waitForExist({ reverse: true });
		await createAndOpen('Width.md', 'width\n');
		await browser.executeObsidianCommand('cross-vault-sync:add-sync-target');
		await browser.$(`${dialogTitled('Add sync target')}//input[@type="text"]`).waitForExist();
		const target = await pathFieldWidth('Add sync target');
		// Closed and gone before the settings open: a late Escape would close the settings instead
		await browser.$(`${dialogTitled('Add sync target')}//button[text()="Cancel"]`).click();
		await browser.$(dialogTitled('Add sync target')).waitForExist({ reverse: true });

		await openPluginSettings();
		let folder = { field: 0, row: 0 };
		await inSettings(async () => {
			await browser.$('[aria-label="Add folder"]').click();
			await browser.$(`${dialogTitled('Add folder')}//input[@type="text"]`).waitForExist();
			folder = await pathFieldWidth('Add folder');
			await browser.$(`${dialogTitled('Add folder')}//button[text()="Cancel"]`).click();
			await browser.$(dialogTitled('Add folder')).waitForExist({ reverse: true });
		});
		await browser.executeObsidian(({ app }) => (app as unknown as AppWithSettings).setting.close());

		expect(target.row).toBeGreaterThan(0);
		expect(Math.abs(target.field - target.row)).toBeLessThanOrEqual(1);
		expect(folder.row).toBeGreaterThan(0);
		expect(Math.abs(folder.field - folder.row)).toBeLessThanOrEqual(1);
	});
});

// The settings window is a modal too, so a dialog is found by its title
function dialogTitled(title: string): string {
	return `//div[contains(@class,"modal")][.//div[@class="modal-title" and text()="${title}"]]`;
}

// The width of a dialog's path field and of the content of its setting row, in CSS pixels
async function pathFieldWidth(title: string): Promise<{ field: number; row: number }> {
	return browser.execute((dialogTitle) => {
		const heading = Array.from(document.querySelectorAll('.modal .modal-title')).find((el) => el.textContent === dialogTitle);
		const input = heading?.closest('.modal')?.querySelector<HTMLInputElement>('input.cross-vault-sync-path-input');
		const row = input?.closest<HTMLElement>('.setting-item');
		if (!input || !row) return { field: -1, row: -1 };
		const style = getComputedStyle(row);
		return {
			field: input.getBoundingClientRect().width,
			row: row.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
		};
	}, title);
}
