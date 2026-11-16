import * as nodePath from 'path';
import type { TFile as TFileOriginal } from 'obsidian';
import { App, CapacitorAdapter, TFile } from 'obsidian-test-mocks/obsidian';
import { describe, expect, it, vi } from 'vitest';
import type CrossVaultSyncPlugin from '../../src/main';
import { MANIFEST_BASENAME } from '../../src/folder-sync';
import { errno } from './helpers/fake-io';
import { edit, frontmatter, openInEditor, read, rename } from './helpers/vault';
import { A_BASE, B_BASE, C_BASE, bodyOf, fileOf, note, settle, sleep, useWorld } from './helpers/world';

const win = nodePath.win32;
const M_NAME = MANIFEST_BASENAME;
const M_REL = `Projects/${M_NAME}.md`;
const A_M = `Vault A/Projects/${M_NAME}`;
const B_ALPHA = win.resolve(B_BASE, 'Notes/alpha.md');
const B_M = win.resolve(B_BASE, `Notes/${M_NAME}.md`);

// Background work (the load catch-up, a create sync) runs outside the sync queues: wait for its effect
async function until(check: () => boolean, timeout = 5000): Promise<void> {
	const start = Date.now();
	for (;;) {
		if (check()) return;
		if (Date.now() - start > timeout) throw new Error('timed out waiting');
		await sleep(20);
	}
}

async function untilList(app: App, file: TFileOriginal, list: unknown[]): Promise<void> {
	await until(() => JSON.stringify(frontmatter(app, file)?.['sync_targets']) === JSON.stringify(list));
}

// Vault A with a manifest folder (Projects) and vault B with the target folder. pA's load catch-up has run.
async function folderWorld(ctx: ReturnType<typeof useWorld>): Promise<{ appA: App; appB: App; pA: CrossVaultSyncPlugin }> {
	const appA = ctx.world.vault(A_BASE, {
		[M_REL]: note('manifest', [A_M, 'Vault B/Notes/']),
		'Projects/alpha.md': 'alpha\n',
		'Projects/deep/beta.md': 'beta\n',
		'Projects/cn.md': note('cn', ['Vault A/Projects/cn', 'Vault B/Notes/']),
		'Other/plain.md': 'plain\n',
	});
	const appB = ctx.world.vault(B_BASE, {});
	await appB.vault.createFolder('Notes');
	await appB.vault.createFolder('Notes/deep');
	const pA = await ctx.world.plugin(appA);
	await ctx.world.plugin(appB);
	await until(() => frontmatter(appA, fileOf(appA, 'Projects/alpha.md'))?.['sync_targets'] !== undefined);
	return { appA, appB, pA };
}

describe('folder sync: a manifest note mirrors its folder', () => {
	const ctx = useWorld();
	const io = () => ctx.world.io;

	it('on load, every note of the folder gets its own entry and the mirror entry, recursively', async () => {
		const { appA } = await folderWorld(ctx);
		expect(frontmatter(appA, fileOf(appA, 'Projects/alpha.md'))?.['sync_targets']).toEqual(['Vault A/Projects/alpha', 'Vault B/Notes/alpha']);
		expect(frontmatter(appA, fileOf(appA, 'Projects/deep/beta.md'))?.['sync_targets']).toEqual(['Vault A/Projects/deep/beta', 'Vault B/Notes/deep/beta']);
		// The user's folder entry stays, and the manifest itself is not rewritten
		expect(frontmatter(appA, fileOf(appA, 'Projects/cn.md'))?.['sync_targets']).toEqual(['Vault A/Projects/cn', 'Vault B/Notes/']);
		expect(frontmatter(appA, fileOf(appA, M_REL))?.['sync_targets']).toEqual([A_M, 'Vault B/Notes/']);
		// A note outside the folder is left alone
		expect(frontmatter(appA, fileOf(appA, 'Other/plain.md'))?.['sync_targets']).toBeUndefined();
	});

	it('syncing a note of the folder creates the mirror copy, subfolder included', async () => {
		const { appA, pA } = await folderWorld(ctx);
		const alpha = fileOf(appA, 'Projects/alpha.md');
		await pA.engine.syncFile(alpha);
		expect(bodyOf(io().content(B_ALPHA))).toBe(note('alpha', ['Vault A/Projects/alpha', 'Vault B/Notes/alpha']));
		await pA.engine.syncFile(fileOf(appA, 'Projects/deep/beta.md'));
		expect(io().exists(win.resolve(B_BASE, 'Notes/deep/beta.md'))).toBe(true);
	});

	it('the manifest keeps its folder entry, a plain note still gets pinned', async () => {
		const { appA, pA } = await folderWorld(ctx);
		const m = fileOf(appA, M_REL);
		await pA.engine.syncFile(m);
		expect(frontmatter(appA, m)?.['sync_targets']).toEqual([A_M, 'Vault B/Notes/']);
		expect(io().exists(B_M)).toBe(true);
		// A plain note with a folder entry gets it pinned to the copy
		const cn = fileOf(appA, 'Projects/cn.md');
		await pA.engine.syncFile(cn);
		expect(frontmatter(appA, cn)?.['sync_targets']).toEqual(['Vault A/Projects/cn', 'Vault B/Notes/cn']);
	});

	it('a note created in the folder gets the entries and syncs at once', async () => {
		const { appA } = await folderWorld(ctx);
		await appA.vault.create('Projects/gamma.md', 'gamma\n');
		const bGamma = win.resolve(B_BASE, 'Notes/gamma.md');
		await until(() => io().exists(bGamma));
		const gamma = fileOf(appA, 'Projects/gamma.md');
		expect(frontmatter(appA, gamma)?.['sync_targets']).toEqual(['Vault A/Projects/gamma', 'Vault B/Notes/gamma']);
		expect(bodyOf(io().content(bGamma))).toBe(note('gamma', ['Vault A/Projects/gamma', 'Vault B/Notes/gamma']));
	});

	it('a note created outside the folder, and a non-Markdown file, are left alone', async () => {
		const { appA } = await folderWorld(ctx);
		await appA.vault.create('Other/gamma.md', 'gamma\n');
		await sleep(30);
		expect(frontmatter(appA, fileOf(appA, 'Other/gamma.md'))?.['sync_targets']).toBeUndefined();
		await appA.vault.create('Projects/pic.png', 'x');
		await sleep(30);
		expect(io().exists(win.resolve(B_BASE, 'Notes/pic.png'))).toBe(false);
	});

	it('a conflict backup in the folder is left alone', async () => {
		const { appA } = await folderWorld(ctx);
		await appA.vault.create('Projects/alpha.sync-conflict-1234abcd.md', 'backup\n');
		await sleep(30);
		expect(frontmatter(appA, fileOf(appA, 'Projects/alpha.sync-conflict-1234abcd.md'))?.['sync_targets']).toBeUndefined();
	});

	it('a new manifest note starts mirroring its folder', async () => {
		const { appA } = await folderWorld(ctx);
		await appA.vault.createFolder('Docs');
		await appA.vault.create('Docs/doc1.md', 'doc1\n');
		await appA.vault.create(`Docs/${M_NAME}.md`, note('manifest2', [`Vault A/Docs/${M_NAME}`, 'Vault B/Notes/']));
		await until(() => frontmatter(appA, fileOf(appA, 'Docs/doc1.md'))?.['sync_targets'] !== undefined);
		expect(frontmatter(appA, fileOf(appA, 'Docs/doc1.md'))?.['sync_targets']).toEqual(['Vault A/Docs/doc1', 'Vault B/Notes/doc1']);
	});

	it('a note renamed to the manifest name becomes the manifest of its folder', async () => {
		const { appA } = await folderWorld(ctx);
		await appA.vault.createFolder('Docs');
		await appA.vault.create('Docs/doc1.md', 'doc1\n');
		const draft = await appA.vault.create('Docs/draft.md', note('manifest2', ['Vault B/Notes/']));
		await appA.vault.rename(draft, `Docs/${M_NAME}.md`);
		await until(() => frontmatter(appA, fileOf(appA, 'Docs/doc1.md'))?.['sync_targets'] !== undefined);
		expect(frontmatter(appA, fileOf(appA, 'Docs/doc1.md'))?.['sync_targets']).toEqual(['Vault A/Docs/doc1', 'Vault B/Notes/doc1']);
	});
});

describe('folder sync: moves', () => {
	const ctx = useWorld();
	const io = () => ctx.world.io;

	async function world() {
		const appA = ctx.world.vault(A_BASE, {
			[M_REL]: note('manifest', [A_M, 'Vault B/Notes/']),
			'Projects/alpha.md': 'alpha\n',
		});
		const appB = ctx.world.vault(B_BASE, {});
		await appB.vault.createFolder('Notes');
		const pA = await ctx.world.plugin(appA);
		await ctx.world.plugin(appB);
		await until(() => frontmatter(appA, fileOf(appA, 'Projects/alpha.md'))?.['sync_targets'] !== undefined);
		return { appA, appB, pA };
	}

	it('a note moved inside the folder keeps its mirror entry pointing at the new place', async () => {
		const { appA, appB } = await world();
		await appA.vault.createFolder('Projects/sub');
		await appB.vault.createFolder('Notes/sub');
		const alpha = fileOf(appA, 'Projects/alpha.md');
		await rename(appA, alpha, 'Projects/sub/renamed.md');
		await until(() => Boolean((frontmatter(appA, alpha)?.['sync_targets'] as string[] | undefined)?.includes('Vault B/Notes/sub/renamed')));
		expect(frontmatter(appA, alpha)?.['sync_targets']).toEqual(['Vault A/Projects/sub/renamed', 'Vault B/Notes/sub/renamed']);
		await until(() => io().exists(win.resolve(B_BASE, 'Notes/sub/renamed.md')));
	});

	it('a note moved out of the folder loses its mirror entries', async () => {
		const { appA } = await world();
		await appA.vault.createFolder('Outbox');
		const alpha = fileOf(appA, 'Projects/alpha.md');
		await rename(appA, alpha, 'Outbox/alpha.md');
		await until(() => (frontmatter(appA, alpha)?.['sync_targets'] as string[] | undefined)?.[0] === 'Vault A/Outbox/alpha');
		expect(frontmatter(appA, alpha)?.['sync_targets']).toEqual(['Vault A/Outbox/alpha']);
	});

	it('a manifest moved under its own name leaves the old folder and the note alone', async () => {
		const { appA } = await world();
		await appA.vault.createFolder('Archive');
		const m = fileOf(appA, M_REL);
		const before = io().writeLog.length;
		await rename(appA, m, `Archive/${M_NAME}.md`);
		await sleep(50);
		// Only the own entry moved, with the own-path handler
		expect(frontmatter(appA, m)?.['sync_targets']).toEqual([`Vault A/Archive/${M_NAME}`, 'Vault B/Notes/']);
		expect(frontmatter(appA, fileOf(appA, 'Projects/alpha.md'))?.['sync_targets']).toEqual(['Vault A/Projects/alpha', 'Vault B/Notes/alpha']);
		expect(io().writeLog.length).toBe(before + 1);
	});
});

describe('folder sync: manifest edits', () => {
	const ctx = useWorld();
	const io = () => ctx.world.io;

	it('a target added to the manifest extends every note of the folder, active or not', async () => {
		const { appA } = await folderWorld(ctx);
		ctx.world.folder('Work', C_BASE);
		vi.spyOn(appA.workspace, 'getActiveFile').mockReturnValue(null);
		const alpha = fileOf(appA, 'Projects/alpha.md');
		await edit(appA, fileOf(appA, M_REL), note('manifest', [A_M, 'Vault B/Notes/', 'Work/Extra/']));
		await untilList(appA, alpha, ['Vault A/Projects/alpha', 'Vault B/Notes/alpha', 'Work/Extra/alpha']);
	});

	it('a re-index without a list edit does not re-apply the folder', async () => {
		const { appA, pA } = await folderWorld(ctx);
		const spy = vi.spyOn(pA.folderSync, 'applyFolder');
		const calls = spy.mock.calls.length;
		await edit(appA, fileOf(appA, M_REL), note('manifest body edit', [A_M, 'Vault B/Notes/']));
		await sleep(50);
		expect(spy.mock.calls.length).toBe(calls);
	});

	it('a target removed from the manifest leaves the notes entries, which stay syncable', async () => {
		const { appA } = await folderWorld(ctx);
		const alpha = fileOf(appA, 'Projects/alpha.md');
		const before = io().writeLog.length;
		await edit(appA, fileOf(appA, M_REL), note('manifest', [A_M]));
		await sleep(50);
		expect(frontmatter(appA, alpha)?.['sync_targets']).toEqual(['Vault A/Projects/alpha', 'Vault B/Notes/alpha']);
		expect(io().writeLog.length).toBe(before + 1);
	});

	it('a self-mirror in the same vault adds no duplicate entry', async () => {
		const { appA } = await folderWorld(ctx);
		const alpha = fileOf(appA, 'Projects/alpha.md');
		await edit(appA, fileOf(appA, M_REL), note('manifest', [A_M, 'Vault A/Projects/', 'Vault B/Notes/']));
		await untilList(appA, alpha, ['Vault A/Projects/alpha', 'Vault B/Notes/alpha']);
	});

	it('a target at the vault root mirrors to the vault root, the old target entry stays', async () => {
		const { appA } = await folderWorld(ctx);
		const alpha = fileOf(appA, 'Projects/alpha.md');
		await edit(appA, fileOf(appA, M_REL), note('manifest', [A_M, 'Vault B/']));
		// The entry for the old target, written earlier, stays: entries are only added, never removed
		await untilList(appA, alpha, ['Vault A/Projects/alpha', 'Vault B/Notes/alpha', 'Vault B/alpha']);
	});

	it('a target in an unknown vault gives no entry, and a synced entry for it stays', async () => {
		const { appA, pA } = await folderWorld(ctx);
		const m = fileOf(appA, M_REL);
		const alpha = fileOf(appA, 'Projects/alpha.md');
		// A list the note got from a computer where Vault C was known
		await edit(appA, alpha, note('alpha\n', ['Vault A/Projects/alpha', 'Vault B/Notes/alpha', 'Vault C/Notes/alpha']));
		await edit(appA, m, note('manifest', [A_M, 'Vault B/Notes/', 'Vault C/Notes/']));
		await untilList(appA, alpha, ['Vault A/Projects/alpha', 'Vault B/Notes/alpha', 'Vault C/Notes/alpha']);
		await pA.engine.syncFile(m, true);
		expect(ctx.count(/"Vault C" has no folder on this computer/)).toBe(1);
	});
});

describe('folder sync: guards', () => {
	const ctx = useWorld();
	const io = () => ctx.world.io;

	it('a copy that names an existing note of this vault is left alone', async () => {
		const { appA } = await folderWorld(ctx);
		await appA.vault.create('Projects/alpha-copy.md', note('copy', ['Vault A/Projects/alpha']));
		await sleep(30);
		expect(frontmatter(appA, fileOf(appA, 'Projects/alpha-copy.md'))?.['sync_targets']).toEqual(['Vault A/Projects/alpha']);
	});

	it('a list without its own entry but only targets outside the vault gets the entries', async () => {
		const { appA } = await folderWorld(ctx);
		await appA.vault.create('Projects/alpha-copy.md', note('copy', ['Vault B/Notes/alpha-copy']));
		await until(() => (frontmatter(appA, fileOf(appA, 'Projects/alpha-copy.md'))?.['sync_targets'] as string[] | undefined)?.length === 2);
		expect(frontmatter(appA, fileOf(appA, 'Projects/alpha-copy.md'))?.['sync_targets']).toEqual(['Vault A/Projects/alpha-copy', 'Vault B/Notes/alpha-copy']);
	});

	it('a list naming a missing note of this vault still gets the entries', async () => {
		const { appA, pA } = await folderWorld(ctx);
		await appA.vault.create('Projects/gone-copy.md', note('gone', ['Vault A/Projects/gone']));
		// The entry for the missing note is kept: entries are never removed except the mirror's own old place
		await until(() => (frontmatter(appA, fileOf(appA, 'Projects/gone-copy.md'))?.['sync_targets'] as string[] | undefined)?.length === 3);
		expect(frontmatter(appA, fileOf(appA, 'Projects/gone-copy.md'))?.['sync_targets']).toEqual(['Vault A/Projects/gone-copy', 'Vault A/Projects/gone', 'Vault B/Notes/gone-copy']);
		// The sync of the copy it created settles before the test ends
		await settle(pA);
	});

	it('a note the user is still typing in is not rewritten', async () => {
		const { appA, pA } = await folderWorld(ctx);
		const alpha = fileOf(appA, 'Projects/alpha.md');
		// Drop the mirror entry, so the apply wants to write
		await edit(appA, alpha, note('alpha\n', ['Vault A/Projects/alpha']));
		const opened = await openInEditor(appA, alpha);
		opened.view.editor.setValue('typing in the editor\n');
		expect(await pA.folderSync.applyToNote(alpha)).toBe(false);
		expect(await read(appA, alpha)).toBe(note('alpha\n', ['Vault A/Projects/alpha']));
	});

	it('a failing frontmatter write is logged', async () => {
		const { appA, pA } = await folderWorld(ctx);
		const alpha = fileOf(appA, 'Projects/alpha.md');
		await edit(appA, alpha, note('alpha\n', ['Vault A/Projects/alpha']));
		vi.spyOn(appA.fileManager, 'processFrontMatter').mockRejectedValueOnce(new Error('bad yaml'));
		expect(await pA.folderSync.applyToNote(alpha)).toBe(false);
		expect(ctx.logged(/Failed to add the folder entries to a note/)).toBe(true);
	});

	it('junk entries in the note list are left where they are', async () => {
		const { appA, pA } = await folderWorld(ctx);
		const alpha = fileOf(appA, 'Projects/alpha.md');
		await edit(appA, alpha, `---\nsync_targets:\n  - 42\n  - ''\n  - relative.md\n  - Vault A/../evil\n  - Vault B/Notes/alpha\n---\nalpha\n`);
		expect(await pA.folderSync.applyToNote(alpha)).toBe(true);
		expect(frontmatter(appA, alpha)?.['sync_targets']).toEqual(['Vault A/Projects/alpha', 42, '', 'relative.md', 'Vault A/../evil', 'Vault B/Notes/alpha']);
	});

	it('a manifest that names an existing note of its own name elsewhere is a copy and manages nothing', async () => {
		const { appA } = await folderWorld(ctx);
		const m = fileOf(appA, M_REL);
		await appA.vault.createFolder('Archive');
		await appA.vault.create(`Archive/${M_NAME}.md`, 'other\n');
		// Drop the mirror entry, so an apply would write it back
		const alpha = fileOf(appA, 'Projects/alpha.md');
		await edit(appA, alpha, note('alpha\n', ['Vault A/Projects/alpha']));
		await edit(appA, m, note('manifest', [`Vault A/Archive/${M_NAME}`, 'Vault B/Notes/']));
		await sleep(50);
		// The applyFolder and the create of a new note both leave the notes alone
		expect(frontmatter(appA, alpha)?.['sync_targets']).toEqual(['Vault A/Projects/alpha']);
		await appA.vault.create('Projects/omega.md', 'omega\n');
		await sleep(30);
		expect(frontmatter(appA, fileOf(appA, 'Projects/omega.md'))?.['sync_targets']).toBeUndefined();
	});

	it('a manifest that names a missing note of its own name still manages its folder', async () => {
		const { appA } = await folderWorld(ctx);
		await edit(appA, fileOf(appA, M_REL), note('manifest', [`Vault A/Archive/${M_NAME}`, 'Vault B/Notes/']));
		await appA.vault.create('Projects/gamma.md', 'gamma\n');
		await until(() => frontmatter(appA, fileOf(appA, 'Projects/gamma.md'))?.['sync_targets'] !== undefined);
		expect(frontmatter(appA, fileOf(appA, 'Projects/gamma.md'))?.['sync_targets']).toEqual(['Vault A/Projects/gamma', 'Vault B/Notes/gamma']);
	});

	it('a manifest that lists junk and other notes still manages its folder', async () => {
		const { appA } = await folderWorld(ctx);
		await edit(appA, fileOf(appA, M_REL), note('manifest', [A_M, 'relative.md', 'Vault A/Other/plain', `Vault C/${M_NAME}`, 'Vault B/Notes/']));
		await appA.vault.create('Projects/gamma.md', 'gamma\n');
		await until(() => frontmatter(appA, fileOf(appA, 'Projects/gamma.md'))?.['sync_targets'] !== undefined);
		expect(frontmatter(appA, fileOf(appA, 'Projects/gamma.md'))?.['sync_targets']).toEqual(['Vault A/Projects/gamma', 'Vault B/Notes/gamma']);
	});

	it('the manifest itself, and a note outside every folder, are not rewritten', async () => {
		const { appA, pA } = await folderWorld(ctx);
		const m = fileOf(appA, M_REL);
		expect(await pA.folderSync.applyToNote(m)).toBe(false);
		const plain = fileOf(appA, 'Other/plain.md');
		expect(await pA.folderSync.applyToNote(plain)).toBe(false);
		expect(await pA.folderSync.applyToNote(plain, plain.path)).toBe(false);
	});

	it('nothing is applied after unload', async () => {
		const { appA, pA } = await folderWorld(ctx);
		pA.onunload();
		const before = io().writeLog.length;
		const alpha = fileOf(appA, 'Projects/alpha.md');
		await pA.folderSync.initialApply();
		await pA.folderSync.onCreate(alpha);
		await pA.folderSync.onRename(alpha, 'Projects/old.md');
		appA.metadataCache.trigger('changed', fileOf(appA, M_REL));
		await sleep(30);
		expect(io().writeLog.length).toBe(before);
	});

	it('without a vault folder on disk nothing is applied', async () => {
		const app = App.createConfigured__({
			adapter: CapacitorAdapter.create__('mobile', {}),
			files: { [M_REL]: note('manifest', [A_M, 'Vault B/Notes/']), 'Projects/alpha.md': 'alpha\n' },
		});
		const plugin = await ctx.world.plugin(app);
		expect(await plugin.folderSync.applyToNote(fileOf(app, 'Projects/alpha.md'))).toBe(false);
		expect(io().writeLog).toEqual([]);
	});
});

describe('folder sync: the target folder is a source too', () => {
	const ctx = useWorld();
	const io = () => ctx.world.io;

	it('a file of the target folder without a note of the folder becomes a note on load', async () => {
		const appA = ctx.world.vault(A_BASE, {
			[M_REL]: note('manifest', [A_M, 'Vault B/Notes/']),
			'Projects/alpha.md': 'alpha\n',
		});
		const appB = ctx.world.vault(B_BASE, {});
		await appB.vault.createFolder('Notes');
		io().addDir(win.resolve(B_BASE, 'Notes/newskill'));
		io().put(win.resolve(B_BASE, 'Notes/newskill/SKILL.md'), 'skill\n');
		await ctx.world.plugin(appA);
		await ctx.world.plugin(appB);
		await until(() => appA.vault.getAbstractFileByPath('Projects/newskill/SKILL.md') !== null);
		const skill = fileOf(appA, 'Projects/newskill/SKILL.md');
		expect(frontmatter(appA, skill)?.['sync_targets']).toEqual(['Vault A/Projects/newskill/SKILL', 'Vault B/Notes/newskill/SKILL']);
		// The pair is synced: the copy carries the header and the entries, the file's text is untouched
		await until(() => (io().content(win.resolve(B_BASE, 'Notes/newskill/SKILL.md')) ?? '').includes('sync_version'));
		expect(bodyOf(io().content(win.resolve(B_BASE, 'Notes/newskill/SKILL.md')))).toBe(note('skill', ['Vault A/Projects/newskill/SKILL', 'Vault B/Notes/newskill/SKILL']));
		// Adopting the file is not a conflict nobody caused: no backup, no notice
		expect(io().writeLog.filter((p) => /sync-conflict/.test(p))).toEqual([]);
		expect(ctx.count(/edited in more than one place/)).toBe(0);
	});

	it('a file another program makes in the target folder becomes a note of the folder', async () => {
		const { appA, pA } = await folderWorld(ctx);
		await pA.folderSync.reconcileTargets();
		io().put(win.resolve(B_BASE, 'Notes/late.md'), 'late\n');
		await until(() => appA.vault.getAbstractFileByPath('Projects/late.md') !== null);
		expect(frontmatter(appA, fileOf(appA, 'Projects/late.md'))?.['sync_targets']).toEqual(['Vault A/Projects/late', 'Vault B/Notes/late']);
	});

	it('a folder another program makes in the target folder is discovered with its files', async () => {
		const { appA } = await folderWorld(ctx);
		io().addDir(win.resolve(B_BASE, 'Notes/newskill2'));
		io().put(win.resolve(B_BASE, 'Notes/newskill2/SKILL.md'), 'skill two\n');
		await until(() => appA.vault.getAbstractFileByPath('Projects/newskill2/SKILL.md') !== null);
		expect(frontmatter(appA, fileOf(appA, 'Projects/newskill2/SKILL.md'))?.['sync_targets']).toEqual(['Vault A/Projects/newskill2/SKILL', 'Vault B/Notes/newskill2/SKILL']);
	});

	it('non-Markdown files and conflict backups of the target folder are not pulled', async () => {
		const { appA } = await folderWorld(ctx);
		io().put(win.resolve(B_BASE, 'Notes/pic.png'), 'x');
		io().put(win.resolve(B_BASE, 'Notes/alpha.sync-conflict-1234abcd.md'), 'backup\n');
		io().put(win.resolve(B_BASE, 'Notes/omega.md'), 'omega\n');
		await until(() => appA.vault.getAbstractFileByPath('Projects/omega.md') !== null);
		expect(appA.vault.getAbstractFileByPath('Projects/pic.png')).toBeNull();
		expect(appA.vault.getAbstractFileByPath('Projects/alpha.sync-conflict-1234abcd.md')).toBeNull();
	});

	it('a target folder outside the vaults is pulled and watched too', async () => {
		const { appA } = await folderWorld(ctx);
		ctx.world.folder('Work', C_BASE);
		io().addDir(win.resolve(C_BASE, 'newskill'));
		io().put(win.resolve(C_BASE, 'newskill/SKILL.md'), 'work skill\n');
		await edit(appA, fileOf(appA, M_REL), note('manifest', [A_M, 'Vault B/Notes/', 'Work/']));
		await until(() => appA.vault.getAbstractFileByPath('Projects/newskill/SKILL.md') !== null);
		const skill = fileOf(appA, 'Projects/newskill/SKILL.md');
		expect(frontmatter(appA, skill)?.['sync_targets']).toEqual(['Vault A/Projects/newskill/SKILL', 'Vault B/Notes/newskill/SKILL', 'Work/newskill/SKILL']);
		expect(bodyOf(io().content(win.resolve(C_BASE, 'newskill/SKILL.md')))).toBe('work skill\n');
	});

	it('the target folders are watched, unwatched when the target is removed, and closed on unload', async () => {
		const { appA, pA } = await folderWorld(ctx);
		await pA.folderSync.reconcileTargets();
		const notes = win.resolve(B_BASE, 'Notes');
		expect(io().openWatchers().some((w) => w.dir === notes)).toBe(true);
		await edit(appA, fileOf(appA, M_REL), note('manifest', [A_M]));
		await until(() => !io().openWatchers().some((w) => w.dir === notes));
		pA.onunload();
		expect(io().openWatchers()).toEqual([]);
	});

	it('a target folder that is missing on this computer is neither pulled nor watched', async () => {
		const appA = ctx.world.vault(A_BASE, { [M_REL]: note('manifest', [A_M, 'Ghost/']) });
		ctx.world.table().setManual('Ghost', 'C:\\Users\\U\\Ghost');
		const pA = await ctx.world.plugin(appA);
		await pA.folderSync.reconcileTargets();
		expect(ctx.logged(/Target folder to watch does not exist/, 'debug')).toBe(true);
		expect(io().openWatchers()).toEqual([]);
	});

	it('a watch that fails for another reason is logged', async () => {
		const { pA } = await folderWorld(ctx);
		vi.spyOn(io(), 'watch').mockImplementationOnce(() => {
			throw new Error('denied');
		});
		await pA.folderSync.reconcileTargets();
		expect(ctx.logged(/Could not watch target folder/)).toBe(true);
	});

	it('a watcher that errors is closed and removed', async () => {
		const { pA } = await folderWorld(ctx);
		await pA.folderSync.reconcileTargets();
		const watchers = io().openWatchers();
		expect(watchers.length).toBeGreaterThan(0);
		watchers[0]!.emitError(new Error('drive gone'));
		expect(ctx.logged(/Stopped watching target folder/)).toBe(true);
		expect(io().openWatchers()).not.toContain(watchers[0]);
		expect(io().openWatchers()).toHaveLength(watchers.length - 1);
	});

	it('an error of a watcher that was already replaced changes nothing', async () => {
		const { appA, pA } = await folderWorld(ctx);
		await pA.folderSync.reconcileTargets();
		const notes = win.resolve(B_BASE, 'Notes');
		const old = io().openWatchers().find((w) => w.dir === notes)!;
		await edit(appA, fileOf(appA, M_REL), note('manifest', [A_M]));
		await until(() => !io().openWatchers().some((w) => w.dir === notes));
		old.emitError(new Error('late'));
		expect(io().openWatchers().some((w) => w.dir === notes)).toBe(false);
	});

	it('a file that vanishes between the listing and the read is skipped', async () => {
		const { appA, pA } = await folderWorld(ctx);
		const gone = win.resolve(B_BASE, 'Notes/gone.md');
		io().put(gone, 'gone\n');
		io().hooks.readFile = (fullPath) => {
			if (fullPath === gone) throw errno('ENOENT', fullPath);
		};
		await pA.folderSync.reconcileTargets();
		expect(appA.vault.getAbstractFileByPath('Projects/gone.md')).toBeNull();
	});

	it('a note that cannot be created is logged', async () => {
		const { appA, pA } = await folderWorld(ctx);
		io().put(win.resolve(B_BASE, 'Notes/broken.md'), 'broken\n');
		vi.spyOn(appA.vault, 'create').mockRejectedValueOnce(new Error('disk full'));
		await pA.folderSync.reconcileTargets();
		expect(ctx.logged(/Failed to pull a note from a target folder/)).toBe(true);
	});

	it('a target file whose note already exists is not pulled again', async () => {
		const { appA, pA } = await folderWorld(ctx);
		io().put(win.resolve(B_BASE, 'Notes/late.md'), 'late\n');
		await until(() => appA.vault.getAbstractFileByPath('Projects/late.md') !== null);
		const create = vi.spyOn(appA.vault, 'create');
		await pA.folderSync.reconcileTargets();
		expect(create).not.toHaveBeenCalled();
	});

	it('a file in a target subfolder whose vault folders do not exist gets them created', async () => {
		const { appA } = await folderWorld(ctx);
		io().addDir(win.resolve(B_BASE, 'Notes/a/b'));
		io().put(win.resolve(B_BASE, 'Notes/a/b/deep.md'), 'deep\n');
		await until(() => appA.vault.getAbstractFileByPath('Projects/a/b/deep.md') !== null);
		expect(frontmatter(appA, fileOf(appA, 'Projects/a/b/deep.md'))?.['sync_targets']).toEqual(['Vault A/Projects/a/b/deep', 'Vault B/Notes/a/b/deep']);
	});

	it('a target file that vanishes between the listing and the stat is skipped', async () => {
		const { appA, pA } = await folderWorld(ctx);
		ctx.world.folder('Work', C_BASE);
		await edit(appA, fileOf(appA, M_REL), note('manifest', [A_M, 'Vault B/Notes/', 'Work/']));
		const gone = win.resolve(C_BASE, 'gone.md');
		io().put(gone, 'gone\n');
		io().hooks.stat = (fullPath) => {
			if (fullPath === gone) io().remove(gone);
		};
		await pA.folderSync.reconcileTargets();
		io().hooks = {};
		expect(appA.vault.getAbstractFileByPath('Projects/gone.md')).toBeNull();
	});

	it('a file of the target root becomes a note of the vault root', async () => {
		const appA = ctx.world.vault(A_BASE, { [`${M_NAME}.md`]: note('manifest', [`Vault A/${M_NAME}`, 'Vault B/']) });
		const appB = ctx.world.vault(B_BASE, {});
		io().put(win.resolve(B_BASE, 'root.md'), 'root\n');
		await ctx.world.plugin(appA);
		await ctx.world.plugin(appB);
		await until(() => appA.vault.getAbstractFileByPath('root.md') !== null);
		expect(frontmatter(appA, fileOf(appA, 'root.md'))?.['sync_targets']).toEqual(['Vault A/root', 'Vault B/root']);
	});

	it('a folder entry of a vault not on this computer is neither pulled nor watched', async () => {
		const appA = ctx.world.vault(A_BASE, {
			[M_REL]: note('manifest', [A_M, 'Ghost/', 'not an entry']),
			'Projects/alpha.md': 'alpha\n',
		});
		const pA = await ctx.world.plugin(appA);
		await pA.folderSync.reconcileTargets();
		expect(io().openWatchers()).toEqual([]);
		// The folder is not managed: the notes keep exactly the list they had
		expect(frontmatter(appA, fileOf(appA, 'Projects/alpha.md'))).toBeUndefined();
	});

	it('a manifest copy in the other vault pulls nothing and watches nothing', async () => {
		const appA = ctx.world.vault(A_BASE, {
			[M_REL]: note('manifest', [A_M, 'Vault B/Notes/']),
			'Projects/alpha.md': 'alpha\n',
		});
		const appB = ctx.world.vault(B_BASE, {});
		await appB.vault.createFolder('Notes');
		const pA = await ctx.world.plugin(appA);
		const pB = await ctx.world.plugin(appB);
		pA.folderSync.close();
		await pA.engine.syncFile(fileOf(appA, M_REL));
		await pB.folderSync.reconcileTargets();
		const notes = win.resolve(B_BASE, 'Notes');
		expect(io().openWatchers().some((w) => w.dir === notes)).toBe(false);
		expect(appB.vault.getMarkdownFiles().map((f) => f.path)).toEqual([`Notes/${M_NAME}.md`]);
	});

	it('a listing that fails skips the rest of the target tree', async () => {
		const appA = ctx.world.vault(A_BASE, { [M_REL]: note('manifest', [A_M, 'Vault B/Notes/']) });
		const appB = ctx.world.vault(B_BASE, {});
		await appB.vault.createFolder('Notes');
		const pA = await ctx.world.plugin(appA);
		await ctx.world.plugin(appB);
		await pA.folderSync.reconcileTargets();
		const sub = win.resolve(B_BASE, 'Notes/sub');
		await appB.vault.createFolder('Notes/sub');
		const realReaddir = io().readdir.bind(io());
		vi.spyOn(io(), 'readdir').mockImplementation((dir) => {
			if (dir === sub) return Promise.reject(new Error('denied'));
			return realReaddir(dir);
		});
		await pA.folderSync.reconcileTargets();
		// The watcher of the unreadable folder is open, but its tree was not walked
		expect(io().openWatchers().some((w) => w.dir === sub)).toBe(true);
	});
});

describe('folder sync: event wiring', () => {
	const ctx = useWorld();

	it('create, rename and metadata changes reach the folder handlers for Markdown notes only', async () => {
		const appA = ctx.world.vault(A_BASE, { [M_REL]: note('manifest', [A_M, 'Vault B/Notes/']) });
		const plugin = await ctx.world.plugin(appA);
		const calls: string[] = [];
		vi.spyOn(appA.workspace, 'getActiveFile').mockReturnValue(null);
		vi.spyOn(plugin.ownPath, 'handleRename').mockImplementation(async () => undefined);
		vi.spyOn(plugin.folderSync, 'onCreate').mockImplementation(async () => { calls.push('create'); });
		vi.spyOn(plugin.folderSync, 'onRename').mockImplementation(async () => { calls.push('rename'); });
		vi.spyOn(plugin.folderSync, 'onManifestChanged').mockImplementation(async () => { calls.push('changed'); });

		appA.vault.trigger('create', TFile.create__(appA.vault, 'Projects/pic.png'));
		appA.vault.trigger('create', TFile.create__(appA.vault, 'Projects/new.md'));
		appA.vault.trigger('rename', TFile.create__(appA.vault, 'pic.png'), 'old.png');
		appA.vault.trigger('rename', TFile.create__(appA.vault, 'Projects/new.md'), 'old.md');
		appA.metadataCache.trigger('changed', TFile.create__(appA.vault, 'pic.png'));
		appA.metadataCache.trigger('changed', fileOf(appA, M_REL));
		// The rename handler runs its own entry first, so its push lands on a microtask after the synchronous ones
		await sleep(20);
		expect(calls).toEqual(['create', 'changed', 'rename']);
	});
});
