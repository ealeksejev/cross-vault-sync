import * as nodePath from 'path';
import { describe, expect, it, vi } from 'vitest';
import { readHeader, withoutHeader } from '../../src/header';
import { errno } from './helpers/fake-io';
import { change, edit, frontmatter, read, trash } from './helpers/vault';
import {
	A_BASE,
	A_ENTRY,
	A_FULL,
	A_REL,
	B_BASE,
	B_ENTRY,
	B_FULL,
	C_BASE,
	C_ENTRY,
	C_FULL,
	bodyOf,
	editOnDisk,
	fileOf,
	note,
	sha256,
	synced,
	twoVaults,
	useWorld,
} from './helpers/world';

const win = nodePath.win32;
const backups = (paths: string[]) => paths.filter((p) => /\.sync-conflict-/.test(p));

describe('sync decisions', () => {
	const ctx = useWorld();
	const io = () => ctx.world.io;
	const writtenBackups = () => [...new Set(backups(io().writeLog))].filter((p) => io().exists(p));

	it('creates a missing target when its folder exists', async () => {
		const { pA, fA } = await twoVaults(ctx.world, { withB: false });
		await pA.engine.syncFile(fA);
		expect(bodyOf(io().content(B_FULL))).toBe(note('v1'));
		expect(ctx.count(/Created target file topic\.md/)).toBe(1);
	});

	it('the create notice follows the notification setting', async () => {
		const { pA, fA } = await twoVaults(ctx.world, { withB: false });
		pA.settings.showNotices = false;
		await pA.engine.syncFile(fA);
		expect(io().exists(B_FULL)).toBe(true);
		expect(ctx.count(/Created/)).toBe(0);
	});

	it('every copy gets the same sync fields: version 1, the hash of the note without them, and the known entries', async () => {
		const { appA, pA, fA } = await twoVaults(ctx.world);
		await pA.engine.syncFile(fA);
		const content = await read(appA, fA);
		expect(io().content(B_FULL)).toBe(content);
		expect(readHeader(content)).toEqual({ version: 1, hash: sha256(note('v1')), known: [A_ENTRY, B_ENTRY] });
		expect(withoutHeader(content)).toBe(note('v1'));
	});

	it('copies that already match write nothing, from either vault', async () => {
		const { pA, pB, fA, fB } = await synced(ctx.world);
		const before = [io().mtime(A_FULL), io().mtime(B_FULL), io().writeLog.length];
		for (let i = 0; i < 3; i++) {
			await pB.engine.syncFile(fB);
			await pA.engine.syncFile(fA);
		}
		expect([io().mtime(A_FULL), io().mtime(B_FULL), io().writeLog.length]).toEqual(before);
	});

	it('an edit is pushed to the other vault with the next version', async () => {
		const { appA, appB, pA, pB, fA, fB } = await synced(ctx.world);
		await change(appA, fA, note('v2'));
		await pA.engine.syncFile(fA);
		expect(bodyOf(io().content(B_FULL))).toBe(note('v2'));
		expect(readHeader(io().content(B_FULL)!)?.version).toBe(2);
		await change(appB, fB, note('v3'));
		await pB.engine.syncFile(fB);
		expect(readHeader(await read(appA, fA))).toEqual({ version: 3, hash: sha256(note('v3')), known: [A_ENTRY, B_ENTRY] });
	});

	it('an older-mtime edit delivered by Obsidian Sync still wins', async () => {
		const { appA, pA, fA } = await synced(ctx.world);
		await change(appA, fA, note('mobile'), io().mtime(B_FULL) - 600_000);
		await pA.engine.syncFile(fA);
		expect(bodyOf(io().content(B_FULL))).toBe(note('mobile'));
		expect(writtenBackups()).toEqual([]);
	});

	it('an older-mtime edit delivered by OneDrive is pulled', async () => {
		const { appA, pA, fA } = await synced(ctx.world);
		editOnDisk(io(), B_FULL, note('onedrive'), io().mtime(A_FULL) - 600_000);
		await pA.engine.syncFile(fA, true);
		expect(bodyOf(await read(appA, fA))).toBe(note('onedrive'));
		expect(writtenBackups()).toEqual([]);
		expect(ctx.count(/Synchronized 2 target\(s\)/)).toBe(1);
	});

	it('a real conflict keeps the newest edit and backs up the other next to its copy', async () => {
		const { appA, pA, pB, fA, fB } = await synced(ctx.world);
		await change(appA, fA, note('edit A'));
		editOnDisk(io(), B_FULL, note('edit B'));
		await pA.engine.syncFile(fA);
		expect(bodyOf(await read(appA, fA))).toBe(note('edit B'));
		expect(bodyOf(io().content(B_FULL))).toBe(note('edit B'));
		const [backup, ...more] = writtenBackups();
		expect(more).toEqual([]);
		expect(bodyOf(io().content(backup!))).toBe(note('edit A'));
		expect(win.dirname(backup!)).toBe(win.dirname(A_FULL));
		expect(ctx.count(/edited in more than one place/)).toBe(1);
		await pB.engine.syncFile(fB);
		expect(writtenBackups()).toHaveLength(1);
	});

	it('a conflict with backups and notices off still keeps the newest edit', async () => {
		const { appA, pA, fA } = await synced(ctx.world);
		pA.settings.createConflictBackup = false;
		pA.settings.showNotices = false;
		await change(appA, fA, note('edit A'));
		editOnDisk(io(), B_FULL, note('edit B'));
		await pA.engine.syncFile(fA);
		expect(bodyOf(await read(appA, fA))).toBe(note('edit B'));
		expect(writtenBackups()).toEqual([]);
		expect(ctx.count(/more than one place/)).toBe(0);
	});

	it('a failed conflict backup in this vault cancels the overwrite', async () => {
		const { appA, pA, fA } = await synced(ctx.world);
		await change(appA, fA, note('edit A'));
		editOnDisk(io(), B_FULL, note('edit B'));
		vi.spyOn(appA.vault, 'create').mockRejectedValueOnce(new Error('disk full'));
		await pA.engine.syncFile(fA);
		expect(bodyOf(await read(appA, fA))).toBe(note('edit A'));
		expect(bodyOf(io().content(B_FULL))).toBe(note('edit B'));
		expect(ctx.count(/nothing was overwritten/)).toBe(1);
		expect(ctx.logged(/Failed to save conflict backup/)).toBe(true);
	});

	it('a failed conflict backup in another vault cancels the overwrite', async () => {
		const { appA, pA, fA } = await synced(ctx.world);
		editOnDisk(io(), B_FULL, note('edit B'));
		await change(appA, fA, note('edit A'));
		io().hooks.beforeWrite = (p) => {
			if (/sync-conflict/.test(p)) throw errno('EROFS', p);
		};
		await pA.engine.syncFile(fA);
		expect(bodyOf(await read(appA, fA))).toBe(note('edit A'));
		expect(bodyOf(io().content(B_FULL))).toBe(note('edit B'));
		expect(ctx.count(/nothing was overwritten/)).toBe(1);
	});

	it('an existing backup with the same content counts as saved', async () => {
		const { appA, pA, fA } = await synced(ctx.world);
		await change(appA, fA, note('edit A'));
		editOnDisk(io(), B_FULL, note('edit B'));
		const loser = await read(appA, fA);
		const backup = win.join(win.dirname(A_FULL), `topic.sync-conflict-${sha256(loser).slice(0, 8)}.md`);
		io().put(backup, loser);
		pA.settings.showNotices = false;
		await pA.engine.syncFile(fA, true);
		expect(bodyOf(await read(appA, fA))).toBe(note('edit B'));
		expect(writtenBackups()).toEqual([backup]);
		expect(io().content(backup)).toBe(loser);
		expect(ctx.count(/more than one place/)).toBe(1);
	});

	it('conflict backups, OneDrive copies and duplicates carry the list but are never synced', async () => {
		const { appA, pA } = await synced(ctx.world);
		const copies = ['Projects/topic.sync-conflict-1234abcd.md', 'Projects/topic-DESKTOP-PC.md', 'Projects/topic 1.md'];
		for (const rel of copies) await appA.vault.create(rel, note('stale'));
		const before = [io().content(A_FULL), io().content(B_FULL), io().writeLog.length];
		for (const rel of copies) {
			await pA.engine.syncFile(fileOf(appA, rel));
			await pA.engine.syncFile(fileOf(appA, rel), true);
		}
		expect([io().content(A_FULL), io().content(B_FULL), io().writeLog.length]).toEqual(before);
		expect(ctx.count(/treated as a copy/)).toBe(2);
		expect(ctx.count(/This note is a conflict backup\. Backups are never synced\./)).toBe(1);
	});

	it('a copy that shows up later with different content is a conflict, not a silent overwrite', async () => {
		const L = [A_ENTRY, B_ENTRY, C_ENTRY];
		ctx.world.table().setManual('Work', C_BASE);
		const { appA, pA, fA } = await twoVaults(ctx.world, { list: L });
		await pA.engine.syncFile(fA);
		io().addDir(win.dirname(C_FULL));
		io().put(C_FULL, note('old C', L), 1);
		await pA.engine.syncFile(fA);
		expect(bodyOf(await read(appA, fA))).toBe(note('v1', L));
		expect(bodyOf(io().content(C_FULL))).toBe(note('v1', L));
		expect(writtenBackups().map((p) => io().content(p))).toContain(note('old C', L));
	});

	it('with three copies one winner is copied everywhere', async () => {
		const L = [A_ENTRY, B_ENTRY, C_ENTRY];
		ctx.world.folder('Work', C_BASE);
		io().addDir(win.dirname(C_FULL));
		const { appA, pA, fA } = await twoVaults(ctx.world, { list: L });
		io().put(C_FULL, note('v1', L));
		await pA.engine.syncFile(fA);
		editOnDisk(io(), B_FULL, note('B edit', L));
		await pA.engine.syncFile(fA);
		expect(bodyOf(await read(appA, fA))).toBe(note('B edit', L));
		expect(bodyOf(io().content(C_FULL))).toBe(note('B edit', L));
		// two copies carrying the same new content, in both mtime orders
		editOnDisk(io(), B_FULL, note('same', L));
		editOnDisk(io(), C_FULL, note('same', L));
		await pA.engine.syncFile(fA);
		expect(bodyOf(await read(appA, fA))).toBe(note('same', L));
		editOnDisk(io(), C_FULL, note('again', L));
		editOnDisk(io(), B_FULL, note('again', L));
		await pA.engine.syncFile(fA);
		expect(bodyOf(await read(appA, fA))).toBe(note('again', L));
		expect(writtenBackups()).toEqual([]);
	});

	it('a copy deleted after syncing is only recreated by a manual sync, as sync_known tells', async () => {
		const { appA, appB, pA, fA, fB } = await synced(ctx.world);
		await trash(appB, fB);
		const writes = io().writeLog.length;
		await pA.engine.syncFile(fA);
		expect(io().exists(B_FULL)).toBe(false);
		expect(io().writeLog.length).toBe(writes);
		await pA.engine.syncFile(fA, true);
		expect(bodyOf(io().content(B_FULL))).toBe(bodyOf(await read(appA, fA)));
		expect(readHeader(await read(appA, fA))?.known).toEqual([A_ENTRY, B_ENTRY]);
	});

	it('a new copy is known once it exists: a failed create is tried again by the next sync', async () => {
		const { appA, pA, fA } = await twoVaults(ctx.world, { withB: false });
		io().hooks.beforeWrite = (p) => {
			if (p === B_FULL) throw errno('EROFS', p);
		};
		await pA.engine.syncFile(fA);
		expect(readHeader(await read(appA, fA))?.known).toEqual([A_ENTRY]);
		io().hooks = {};
		await pA.engine.syncFile(fA);
		expect(readHeader(io().content(B_FULL)!)?.known).toEqual([A_ENTRY]);
		expect(readHeader(await read(appA, fA))?.known).toEqual([A_ENTRY, B_ENTRY]);
		await pA.engine.syncFile(fA);
		expect(io().content(B_FULL)).toBe(await read(appA, fA));
	});

	it('targets whose folder is missing or is a file are skipped, and folders are never created', async () => {
		const INNER = `${B_FULL}\\inner.md`;
		const L = [A_ENTRY, B_ENTRY, C_ENTRY, 'Vault B/Notes/topic.md/inner'];
		ctx.world.table().setManual('Work', C_BASE);
		const { appA, pA, fA } = await twoVaults(ctx.world, { list: L });
		await pA.engine.syncFile(fA);
		expect(io().exists(C_FULL) || io().exists(INNER)).toBe(false);
		await expect(io().stat(C_BASE)).rejects.toMatchObject({ code: 'ENOENT' });
		expect(readHeader(io().content(B_FULL)!)?.known).toEqual([A_ENTRY, B_ENTRY]);
		expect(ctx.count(/Folder does not exist/)).toBe(0);
		await pA.engine.syncFile(fA, true);
		expect(ctx.count(/Folder does not exist/)).toBe(2);
		io().addDir(win.dirname(C_FULL));
		await pA.engine.syncFile(fA);
		expect(bodyOf(io().content(C_FULL))).toBe(note('v1', L));
		expect(readHeader(await read(appA, fA))?.known).toEqual([A_ENTRY, B_ENTRY, C_ENTRY]);
	});

	it('a write that changes only the sync fields keeps the modification time of the content', async () => {
		const L = [A_ENTRY, B_ENTRY, C_ENTRY];
		ctx.world.table().setManual('Work', C_BASE);
		const { pA, fA } = await synced(ctx.world, { list: L });
		const times = [io().mtime(A_FULL), io().mtime(B_FULL)];
		// The third copy's folder appears: the copy is created, and the other two only learn of it
		io().addDir(win.dirname(C_FULL));
		await pA.engine.syncFile(fA);
		expect(readHeader(io().content(B_FULL)!)?.known).toEqual(L);
		expect([io().mtime(A_FULL), io().mtime(B_FULL)]).toEqual(times);
	});

	it('sync_known keeps an entry whose vault has no folder here when it had one elsewhere', async () => {
		const L = [A_ENTRY, B_ENTRY, 'Other/Notes/topic', 'Unknown/topic'];
		const { appA, pA, fA } = await synced(ctx.world, { list: L });
		expect(readHeader(await read(appA, fA))?.known).toEqual([A_ENTRY, B_ENTRY]);
		// Another computer, where Other has a folder, wrote the copies
		const elsewhere = (await read(appA, fA)).replace(`  - "${B_ENTRY}"\n`, `  - "${B_ENTRY}"\n  - "Other/Notes/topic"\n`);
		io().put(A_FULL, elsewhere);
		io().put(B_FULL, elsewhere);
		await pA.engine.syncFile(fA);
		expect(readHeader(io().content(B_FULL)!)?.known).toEqual([A_ENTRY, B_ENTRY, 'Other/Notes/topic']);
	});

	it('sync_known names each file once, and only files that have a copy', async () => {
		const L = [A_ENTRY, A_ENTRY, A_ENTRY.toUpperCase(), B_ENTRY, 'Vault B/Missing/topic'];
		const { appA, pA, fA } = await twoVaults(ctx.world, { list: L });
		await pA.engine.syncFile(fA);
		expect(readHeader(await read(appA, fA))?.known).toEqual([A_ENTRY, B_ENTRY]);
	});

	it('a note without sync fields among synced copies counts as an edit of an older version', async () => {
		const { appA, pA, fA } = await synced(ctx.world);
		const synced1 = io().content(B_FULL)!;
		// A copy restored from before the plugin wrote sync fields
		await edit(appA, fA, note('restored'));
		await pA.engine.syncFile(fA);
		expect(bodyOf(io().content(B_FULL))).toBe(note('restored'));
		expect(writtenBackups().map((p) => io().content(p))).toEqual([synced1]);
	});

	it('copies in this vault are written through the Vault API, copies elsewhere with Node.js', async () => {
		const L = [A_ENTRY, 'Vault A/Archive/topic', B_ENTRY];
		const { appA, pA, fA } = await twoVaults(ctx.world, { list: L });
		const archive = win.join(A_BASE, 'Archive', 'topic.md');
		const create = vi.spyOn(appA.vault, 'create');
		const process = vi.spyOn(appA.vault, 'process');
		const nodeWrites: string[] = [];
		io().hooks.beforeWrite = (p) => nodeWrites.push(p);
		await pA.engine.syncFile(fA);
		expect(create).toHaveBeenCalledWith('Archive/topic.md', expect.any(String));
		expect(nodeWrites).toEqual([B_FULL]);

		await change(appA, fA, note('v2', L));
		nodeWrites.length = 0;
		process.mockClear();
		await pA.engine.syncFile(fA);
		expect(process.mock.calls.map(([file]) => file.path).sort()).toEqual(['Archive/topic.md', A_REL]);
		expect(nodeWrites).toEqual([B_FULL]);
		expect(bodyOf(io().content(archive))).toBe(note('v2', L));
	});

	it("a copy in this vault is read through the Vault API, with Obsidian's time when the disk gives none", async () => {
		const L = [A_ENTRY, 'Vault A/Archive/topic', B_ENTRY];
		const { appA, pA, fA } = await synced(ctx.world, { list: L });
		const archive = win.join(A_BASE, 'Archive', 'topic.md');
		await change(appA, fA, note('v2', L));
		const vaultRead = vi.spyOn(appA.vault, 'read');
		io().hooks.stat = (p) => {
			if (io().key(p) === io().key(archive)) throw errno('EBUSY', p);
		};
		await pA.engine.syncFile(fA);
		expect(vaultRead.mock.calls.map(([file]) => file.path)).toContain('Archive/topic.md');
		expect(bodyOf(io().content(archive))).toBe(note('v2', L));
	});

	it('a file in this vault that Obsidian has not seen yet is written with Node.js', async () => {
		const L = [A_ENTRY, 'Vault A/Archive/topic', B_ENTRY];
		const { appA, pA, fA } = await synced(ctx.world, { list: L });
		const archive = win.join(A_BASE, 'Archive', 'topic.md');
		await change(appA, fA, note('v2', L));
		// The copy is deleted and written again by another program. Obsidian reports it only after the sync has read it.
		io().events = 'after';
		await trash(appA, fileOf(appA, 'Archive/topic.md'));
		io().put(archive, io().content(B_FULL)!);
		await pA.engine.syncFile(fA);
		expect(bodyOf(io().content(archive))).toBe(note('v2', L));
	});

	it('a failing create in this vault is reported, and a create that finds the file decides again', async () => {
		const L = [A_ENTRY, 'Vault A/Archive/topic'];
		const appA = ctx.world.vault(A_BASE, { [A_REL]: note('v1', L) });
		await appA.vault.createFolder('Archive');
		const pA = await ctx.world.plugin(appA);
		const fA = fileOf(appA, A_REL);
		vi.spyOn(appA.vault, 'create').mockRejectedValueOnce(new Error('disk full'));
		await pA.engine.syncFile(fA, true);
		expect(ctx.count(/Cross-Vault Sync error: disk full/)).toBe(1);
		vi.spyOn(appA.vault, 'create').mockRejectedValueOnce(new Error('File already exists.'));
		await pA.engine.syncFile(fA);
		expect(pA.engine.debounceTimers.has(A_REL)).toBe(true);
	});

	it('entries without a name, wikilinks, WSL paths, absolute paths, URLs, empty and non-string entries are ignored', async () => {
		const app = ctx.world.vault(A_BASE, {
			'Projects/mal.md':
				"---\nsync_targets:\n  - relative.md\n  - [[Some Note]]\n  - /mnt/c/Users/U/x.md\n  - C:\\Users\\U\\x.md\n  - obsidian://open?vault=Vault A&file=x\n  - 42\n  - ''\n---\nbody\n",
		});
		const pA = await ctx.world.plugin(app);
		const file = fileOf(app, 'Projects/mal.md');
		const before = io().writeLog.length;
		await pA.engine.syncFile(file);
		expect(ctx.notices).toEqual([]);
		await pA.engine.syncFile(file, true);
		expect(io().writeLog.length).toBe(before);
		expect(ctx.count(/Ignored 7 sync_targets entries\. Write entries like Vault\/folder\/note/)).toBe(1);
		expect(ctx.count(/No sync_targets configured/)).toBe(0);
	});

	it('duplicates are merged and one ignored entry is reported in singular', async () => {
		const { pA, fA } = await twoVaults(ctx.world, { list: [A_ENTRY, B_ENTRY, A_ENTRY.toUpperCase(), 'relative.md'] });
		await pA.engine.syncFile(fA, true);
		expect(ctx.count(/Ignored 1 sync_targets entry\./)).toBe(1);
		expect(pA.engine.targetsOf(fA).targets).toHaveLength(2);
	});

	it('a single scalar value is accepted, and writing only the sync fields counts as already in sync', async () => {
		const app = ctx.world.vault(A_BASE, { [A_REL]: `---\nsync_targets: ${A_ENTRY}\n---\nbody\n` });
		const pA = await ctx.world.plugin(app);
		const file = fileOf(app, A_REL);
		expect(pA.engine.targetsOf(file).targets).toHaveLength(1);
		await pA.engine.syncFile(file, true);
		expect(ctx.count(/already in sync/)).toBe(1);
		expect(readHeader(await read(app, file))?.version).toBe(1);
	});

	it('a folder entry gives the copy the note name, then names the copy exactly', async () => {
		const { appA, pA, fA } = await twoVaults(ctx.world, { list: [A_ENTRY, 'Vault B/Notes/'], withB: false });
		await pA.engine.syncFile(fA);
		expect(io().exists(B_FULL)).toBe(true);
		expect(frontmatter(appA, fA)?.['sync_targets']).toEqual([A_ENTRY, B_ENTRY]);
		await pA.engine.syncFile(fA);
		expect(io().content(B_FULL)).toBe(await read(appA, fA));
		// From now on the copy has a name of its own: renaming the note leaves it alone
		expect(bodyOf(await read(appA, fA))).toBe(note('v1', [A_ENTRY, B_ENTRY]));
	});

	it('a folder entry naming an existing copy is replaced with the exact name too', async () => {
		const { appA, pA, fA } = await twoVaults(ctx.world, { list: [A_ENTRY, 'Vault B/Notes/', 'Other/Notes/'] });
		await pA.engine.syncFile(fA);
		expect(frontmatter(appA, fA)?.['sync_targets']).toEqual([A_ENTRY, B_ENTRY, 'Other/Notes/']);
	});

	it('a folder entry never counts as the note itself, so a list without its own file entry is a copy', async () => {
		const { appA, pA, fA } = await twoVaults(ctx.world, { list: ['Vault A/Projects/', B_ENTRY] });
		const writes = io().writeLog.length;
		await pA.engine.syncFile(fA);
		await pA.engine.syncFile(fA, true);
		expect(io().writeLog.length).toBe(writes);
		expect(frontmatter(appA, fA)?.['sync_targets']).toEqual(['Vault A/Projects/', B_ENTRY]);
		expect(ctx.count(/treated as a copy/)).toBe(1);
	});

	it('a folder entry stays while its copy cannot be created', async () => {
		const appA = ctx.world.vault(A_BASE, { [A_REL]: note('v1', [A_ENTRY, 'Vault B/Missing/']) });
		ctx.world.vault(B_BASE);
		const pA = await ctx.world.plugin(appA);
		const fA = fileOf(appA, A_REL);
		await pA.engine.syncFile(fA);
		expect(frontmatter(appA, fA)?.['sync_targets']).toEqual([A_ENTRY, 'Vault B/Missing/']);
	});

	it('a failed replacement of a folder entry is logged, and the copy is still made', async () => {
		const { appA, pA, fA } = await twoVaults(ctx.world, { list: [A_ENTRY, 'Vault B/Notes/'], withB: false });
		vi.spyOn(appA.fileManager, 'processFrontMatter').mockRejectedValueOnce(new Error('bad yaml'));
		await pA.engine.syncFile(fA);
		expect(ctx.logged(/Failed to replace folder entries/)).toBe(true);
		expect(io().exists(B_FULL)).toBe(true);
	});

	it('an entry without its trailing slash next to an existing folder creates no note', async () => {
		const { pA, fA } = await twoVaults(ctx.world, { list: [A_ENTRY, 'Vault B/Notes'], withB: false });
		await pA.engine.syncFile(fA);
		expect(ctx.logged(/Notes is a folder\. End its sync_targets entry with \/ to sync into it\./)).toBe(true);
		await pA.engine.syncFile(fA, true);
		expect(ctx.count(/Notes is a folder/)).toBe(1);
		expect(io().exists(win.join(B_BASE, 'Notes.md'))).toBe(false);
	});

	it('notes without sync_targets: manual sync explains, automatic stays quiet', async () => {
		const app = ctx.world.vault(A_BASE, { [A_REL]: 'plain\n' });
		const pA = await ctx.world.plugin(app);
		const file = fileOf(app, A_REL);
		await pA.engine.syncFile(file);
		expect(ctx.notices).toEqual([]);
		await pA.engine.syncFile(file, true);
		expect(ctx.count(/No sync_targets configured/)).toBe(1);
	});

	it('a note Obsidian has not parsed yet counts as having no sync_targets', async () => {
		const app = ctx.world.vault(A_BASE, { [A_REL]: note('v1') });
		const pA = await ctx.world.plugin(app);
		app.metadataCache.cache__.delete(A_REL);
		const file = fileOf(app, A_REL);
		expect(pA.engine.targetsOf(file)).toEqual({ targets: [], ignored: 0, problems: [], folderTargets: new Set(), fileTargets: new Set(), listed: [] });
		await pA.engine.syncFile(file, true);
		expect(ctx.count(/No sync_targets configured/)).toBe(1);
		expect(io().exists(B_FULL)).toBe(false);
	});
});
