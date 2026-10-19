import * as nodePath from 'path';
import { describe, expect, it } from 'vitest';
import { read } from './helpers/vault';
import { bodyOf, fileOf, note, useWorld } from './helpers/world';

const win = nodePath.win32;
const REL = 'Projects/Notes/topic.md';
const ENTRIES = ['Vault A/Projects/Notes/topic', 'Vault B/Projects/Notes/topic'];
// The same two vaults on two computers: another user name, and vault B in another place
const COMPUTERS = {
	first: { a: 'C:\\Users\\alice\\Documents\\Obsidian\\Vault A', b: 'C:\\Users\\alice\\Documents\\Obsidian\\Vault B' },
	second: { a: 'C:\\Users\\bob\\Documents\\Obsidian\\Vault A', b: 'D:\\Vaults\\Vault B' },
};

describe('one sync_targets list on two computers', () => {
	// Each test is one computer: its own disk and its own vault folder table
	const ctx = useWorld();

	async function open(computer: { a: string; b: string }, { list = ENTRIES, openB = true } = {}) {
		const appA = ctx.world.vault(computer.a, { [REL]: note('v1', list) });
		const appB = ctx.world.vault(computer.b, {}, { registered: openB });
		await appB.vault.createFolder('Projects');
		await appB.vault.createFolder('Projects/Notes');
		const plugin = await ctx.world.plugin(appA);
		if (openB) await ctx.world.plugin(appB);
		return { appA, plugin, file: fileOf(appA, REL), copy: win.join(computer.b, ...REL.split('/')) };
	}

	it.each(Object.entries(COMPUTERS))('the %s computer finds both vaults from the same entries', async (_name, computer) => {
		const { appA, plugin, file, copy } = await open(computer);
		await plugin.engine.syncFile(file);
		expect(bodyOf(ctx.world.io.content(copy))).toBe(bodyOf(await read(appA, file)));
	});

	it('absolute paths are no entries, and the other entries still sync', async () => {
		const { first, second } = COMPUTERS;
		const list = [win.join(first.a, REL), win.join(first.b, REL), ...ENTRIES];
		const { appA, plugin, file, copy } = await open(second, { list });
		await plugin.engine.syncFile(file, true);
		expect(bodyOf(ctx.world.io.content(copy))).toBe(bodyOf(await read(appA, file)));
		expect(ctx.count(/Ignored 2 sync_targets entries/)).toBe(1);
		expect(ctx.world.io.writeLog.filter((p) => p.startsWith('C:\\Users\\alice'))).toEqual([]);
	});

	it('a vault not opened on this computer is reported once, and syncs once its folder is added by hand', async () => {
		const list = [...ENTRIES, 'Vault B/Other/note', 'Work/Projects/Notes/topic'];
		const { appA, plugin, file, copy } = await open(COMPUTERS.second, { list, openB: false });
		await plugin.engine.syncFile(file, true);
		expect(ctx.count(/"Vault B" has no folder on this computer/)).toBe(1);
		expect(ctx.count(/"Work" has no folder on this computer/)).toBe(1);
		expect(ctx.world.io.exists(copy)).toBe(false);
		plugin.folders.setManual('Vault B', COMPUTERS.second.b);
		await plugin.engine.syncFile(file, true);
		expect(bodyOf(ctx.world.io.content(copy))).toBe(bodyOf(await read(appA, file)));
	});
});
