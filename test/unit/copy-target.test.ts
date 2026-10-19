import { Menu, TFolder } from 'obsidian-test-mocks/obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { addCopyTargetItem, targetEntryOf } from '../../src/ui/copy-target';
import { A_BASE, fileOf, sleep, useWorld } from './helpers/world';

const NOTE = 'Projects/Notes/Café notes.md';

describe('copy sync target', () => {
	const ctx = useWorld();

	function vault() {
		const app = ctx.world.vault(A_BASE, { [NOTE]: 'x', 'Projects/picture.png': 'p' });
		const folder = app.vault.getAbstractFileByPath('Projects/Notes');
		if (!(folder instanceof TFolder)) throw new Error('no folder');
		return { app, note: fileOf(app, NOTE), folder: folder.asOriginalType2__(), root: TFolder.fromOriginalType2__(app.vault.getRoot().asOriginalType2__()).asOriginalType2__(), png: fileOf(app, 'Projects/picture.png') };
	}

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('names a note without .md and a folder with a trailing slash, as sync_targets entries', () => {
		const { note, folder, root, png } = vault();
		expect(targetEntryOf(note, 'Vault A')).toBe('Vault A/Projects/Notes/Café notes');
		expect(targetEntryOf(folder, 'Vault A')).toBe('Vault A/Projects/Notes/');
		expect(targetEntryOf(root, 'Vault A')).toBe('Vault A/');
		expect(targetEntryOf(png, 'Vault A')).toBeNull();
	});

	it('copies the entry from the file menu and says so, or reports a failed copy', async () => {
		const { note, png } = vault();
		const writeText = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('denied')).mockRejectedValueOnce('no access');
		vi.stubGlobal('navigator', { clipboard: { writeText } });
		const menu = Menu.create2__();
		addCopyTargetItem(menu.asOriginalType2__(), png, 'Vault A');
		addCopyTargetItem(menu.asOriginalType2__(), note, 'Vault A');
		const [item] = menu.menuItems__;
		expect(menu.menuItems__).toHaveLength(1);
		expect(item?.title__).toBe('Copy sync target');
		for (let i = 0; i < 3; i++) item?.onClick__?.(new MouseEvent('click'));
		await sleep(10);
		expect(writeText).toHaveBeenCalledWith('Vault A/Projects/Notes/Café notes');
		expect(ctx.count(/^Copied Vault A\/Projects\/Notes\/Café notes$/)).toBe(1);
		expect(ctx.count(/Could not copy .*: denied/)).toBe(1);
		expect(ctx.count(/Could not copy .*: no access/)).toBe(1);
	});

	it('is in the file menu of every note and folder once the plugin is loaded', async () => {
		const { app, note } = vault();
		await ctx.world.plugin(app);
		const menu = Menu.create2__();
		app.workspace.trigger('file-menu', menu.asOriginalType2__(), note, 'file-explorer-context-menu');
		expect(menu.menuItems__.map((item) => item.title__)).toEqual(['Copy sync target']);
	});
});
