import * as nodePath from 'path';
import type { TFile as TFileOriginal } from 'obsidian';
import { TFile, type App } from 'obsidian-test-mocks/obsidian';
import { describe, expect, it, vi } from 'vitest';
import type CrossVaultSyncPlugin from '../../src/main';
import { readHeader } from '../../src/header';
import { edit, frontmatter, read, rename } from './helpers/vault';
import { A_BASE, A_ENTRY, A_FULL, A_REL, B_BASE, B_ENTRY, B_FULL, B_REL, C_BASE, C_ENTRY, bodyOf, fileOf, note, reindex, sleep, synced, useWorld } from './helpers/world';

const win = nodePath.win32;
const NEW_REL = 'Archive/topic.md';
const NEW_FULL = win.resolve(A_BASE, NEW_REL);
const NEW_ENTRY = 'Vault A/Archive/topic';

describe('own path: moves', () => {
	const ctx = useWorld();
	const io = () => ctx.world.io;

	it('moving a note rewrites its own entry and never recreates the old path', async () => {
		const { appA, appB, pA, pB, fA, fB } = await synced(ctx.world);
		await rename(appA, fA, NEW_REL);
		await sleep(20);
		expect(frontmatter(appA, fA)?.['sync_targets']).toEqual([NEW_ENTRY, B_ENTRY]);
		// The copy in vault B still lists the old path, which its sync_known names as a copy that existed
		await pB.engine.syncFile(fB);
		expect(io().exists(A_FULL)).toBe(false);
		await pA.engine.syncFile(fA);
		expect(io().exists(A_FULL)).toBe(false);
		expect(io().content(B_FULL)).toBe(await read(appA, fA));
		expect(readHeader(io().content(B_FULL)!)?.known).toEqual([NEW_ENTRY, B_ENTRY]);
		reindex(appB, fB);
		await pB.engine.syncFile(fB);
		expect(io().exists(A_FULL)).toBe(false);
		expect(io().exists(NEW_FULL)).toBe(true);
	});

	it('a scalar value becomes a list, and other entries are left alone', async () => {
		const appA = ctx.world.vault(A_BASE, { [A_REL]: `---\nsync_targets: ${A_ENTRY}\n---\nbody\n` });
		await appA.vault.createFolder('Archive');
		await ctx.world.plugin(appA);
		const fA = fileOf(appA, A_REL);
		await rename(appA, fA, NEW_REL);
		await sleep(20);
		expect(frontmatter(appA, fA)?.['sync_targets']).toEqual([NEW_ENTRY]);
		await edit(appA, fA, `---\nsync_targets:\n  - ${NEW_ENTRY}\n  - 42\n  - relative.md\n---\nbody\n`);
		await rename(appA, fA, A_REL);
		await sleep(20);
		expect(frontmatter(appA, fA)?.['sync_targets']).toEqual([A_ENTRY, 42, 'relative.md']);
	});

	it('a folder entry is never the note itself, so moving the note leaves it, and the copies keep their names', async () => {
		const appA = ctx.world.vault(A_BASE, { [A_REL]: note('body', ['Vault A/Projects/', B_ENTRY]) });
		await appA.vault.createFolder('Archive');
		ctx.world.vault(B_BASE, { [B_REL]: 'copy\n' });
		await ctx.world.plugin(appA);
		const fA = fileOf(appA, A_REL);
		await rename(appA, fA, NEW_REL);
		await sleep(20);
		expect(frontmatter(appA, fA)?.['sync_targets']).toEqual(['Vault A/Projects/', B_ENTRY]);
		expect(io().content(B_FULL)).toBe('copy\n');
	});

	it('renaming a copy writes nothing', async () => {
		const { appA } = await synced(ctx.world);
		const copy = await appA.vault.create('Projects/topic-copy.md', note('copy'));
		const before = await read(appA, copy.asOriginalType2__());
		await appA.vault.rename(copy, 'Archive/topic-copy.md');
		await sleep(20);
		expect(await read(appA, copy.asOriginalType2__())).toBe(before);
	});

	it('a failed frontmatter update after a move is reported', async () => {
		const { appA, fA } = await synced(ctx.world);
		vi.spyOn(appA.fileManager, 'processFrontMatter').mockRejectedValue(new Error('YAMLParseError'));
		await rename(appA, fA, NEW_REL);
		await sleep(20);
		expect(ctx.count(/Could not update sync_targets after moving "topic"/)).toBe(1);
	});
});

describe('own path: added when sync_targets is edited in the open note', () => {
	const ctx = useWorld();

	// Vault B is known on this computer but has no copy yet
	async function openNote(initial = 'body\n'): Promise<{ app: App; appB: App; plugin: CrossVaultSyncPlugin; file: TFileOriginal }> {
		const app = ctx.world.vault(A_BASE, { [A_REL]: initial });
		const appB = ctx.world.vault(B_BASE);
		const plugin = await ctx.world.plugin(app);
		const file = fileOf(app, A_REL);
		vi.spyOn(app.workspace, 'getActiveFile').mockReturnValue(TFile.fromOriginalType2__(file));
		app.workspace.trigger('file-open', file);
		return { app, appB, plugin, file };
	}

	// The user edits sync_targets, Obsidian saves and re-parses the note
	async function editList(app: App, file: TFileOriginal, list: string[]): Promise<void> {
		await edit(app, file, note('body', list));
		await sleep(20);
	}

	const targetsOf = (app: App, file: TFileOriginal) => frontmatter(app, file)?.['sync_targets'];

	it('listing only the other vault adds the own entry first, and the note then syncs', async () => {
		const { app, appB, plugin, file } = await openNote();
		await appB.vault.createFolder('Notes');
		await editList(app, file, [B_ENTRY]);
		expect(targetsOf(app, file)).toEqual([A_ENTRY, B_ENTRY]);
		const content = await read(app, file);
		await sleep(20);
		expect(await read(app, file)).toBe(content);
		await plugin.engine.syncFile(file);
		expect(bodyOf(ctx.world.io.content(B_FULL))).toBe(content);
	});

	it('entries that are no targets here stay where they are when the own entry is added', async () => {
		const { app, file } = await openNote();
		await editList(app, file, [B_ENTRY, '42', 'Other/topic']);
		expect(targetsOf(app, file)).toEqual([A_ENTRY, B_ENTRY, 42, 'Other/topic']);
	});

	it('a single scalar target becomes a list with the own entry first', async () => {
		const { app, file } = await openNote();
		await edit(app, file, `---\nsync_targets: ${B_ENTRY}\n---\nbody\n`);
		await sleep(20);
		expect(targetsOf(app, file)).toEqual([A_ENTRY, B_ENTRY]);
	});

	it('a target in the same vault that does not exist yet still gets the own entry', async () => {
		const { app, file } = await openNote();
		await editList(app, file, ['Vault A/Mirror/topic']);
		expect(targetsOf(app, file)).toEqual([A_ENTRY, 'Vault A/Mirror/topic']);
	});

	it('a copy is left alone: its list names another existing note in this vault', async () => {
		const { app, file } = await openNote();
		const copy = (await app.vault.create('Projects/topic-copy.md', 'copy\n')).asOriginalType2__();
		vi.spyOn(app.workspace, 'getActiveFile').mockReturnValue(TFile.fromOriginalType2__(copy));
		app.workspace.trigger('file-open', copy);
		await editList(app, copy, [A_ENTRY, B_ENTRY]);
		expect(targetsOf(app, copy)).toEqual([A_ENTRY, B_ENTRY]);
		expect(targetsOf(app, file)).toBeUndefined();
	});

	it('opening a note or editing its body does not add the own entry', async () => {
		const { app, file } = await openNote(note('body', [B_ENTRY]));
		await edit(app, file, note('body edited', [B_ENTRY]));
		await sleep(20);
		expect(targetsOf(app, file)).toEqual([B_ENTRY]);
	});

	it('a change before any file-open, or on a note that was not opened, does not count', async () => {
		const app = ctx.world.vault(A_BASE, { [A_REL]: 'body\n', 'Projects/other.md': 'other\n' });
		ctx.world.vault(B_BASE);
		await ctx.world.plugin(app);
		const file = fileOf(app, A_REL);
		const other = fileOf(app, 'Projects/other.md');
		const active = vi.spyOn(app.workspace, 'getActiveFile').mockReturnValue(TFile.fromOriginalType2__(file));
		await editList(app, file, [B_ENTRY]);
		expect(targetsOf(app, file)).toEqual([B_ENTRY]);
		active.mockReturnValue(TFile.fromOriginalType2__(other));
		await editList(app, other, [B_ENTRY]);
		expect(targetsOf(app, other)).toEqual([B_ENTRY]);
	});

	it('this vault name means this vault, even when the table names another folder for it', async () => {
		const { app, plugin, file } = await openNote();
		plugin.folders.setManual('Vault A', 'D:\\Elsewhere\\Vault A');
		await editList(app, file, [B_ENTRY]);
		expect(targetsOf(app, file)).toEqual([A_ENTRY, B_ENTRY]);
		const content = await read(app, file);
		await sleep(20);
		expect(await read(app, file)).toBe(content);
	});

	it('nothing is added when the own entry is listed, when only a folder entry names the note, or no entry is valid', async () => {
		const { app, file } = await openNote();
		await editList(app, file, [A_ENTRY, B_ENTRY]);
		expect(targetsOf(app, file)).toEqual([A_ENTRY, B_ENTRY]);
		await editList(app, file, ['Vault A/Projects/', B_ENTRY]);
		expect(targetsOf(app, file)).toEqual(['Vault A/Projects/', B_ENTRY]);
		await editList(app, file, ['relative.md']);
		expect(targetsOf(app, file)).toEqual(['relative.md']);
	});

	it('the list is checked again inside the frontmatter write', async () => {
		const { app, file } = await openNote();
		const processFrontMatter = app.fileManager.processFrontMatter.bind(app.fileManager);
		const spy = vi.spyOn(app.fileManager, 'processFrontMatter');
		spy.mockImplementationOnce(async (target, fn, options) => {
			await app.vault.adapter.write(A_REL, note('body', [A_ENTRY, B_ENTRY]));
			return processFrontMatter(target, fn, options);
		});
		await editList(app, file, [B_ENTRY]);
		expect(targetsOf(app, file)).toEqual([A_ENTRY, B_ENTRY]);
		ctx.world.folder('Work', C_BASE);
		spy.mockImplementationOnce(async (target, fn, options) => {
			await app.vault.adapter.write(A_REL, 'body\n');
			return processFrontMatter(target, fn, options);
		});
		await editList(app, file, [C_ENTRY]);
		expect(await read(app, file)).not.toMatch(/sync_targets/);
	});

	it('a failing frontmatter write is reported', async () => {
		const { app, file } = await openNote();
		vi.spyOn(app.fileManager, 'processFrontMatter').mockRejectedValue(new Error('bad yaml'));
		await editList(app, file, [B_ENTRY]);
		expect(ctx.count(/Could not add this note's own path to sync_targets/)).toBe(1);
		expect(ctx.logged(/Failed to add own path/)).toBe(true);
	});
});
