import * as nodePath from 'path';
import { describe, expect, it, vi } from 'vitest';
import { readHeader } from '../../src/header';
import type { SyncEngine } from '../../src/sync';
import { change, edit, openInEditor, read, trash } from './helpers/vault';
import { A_ENTRY, B_ENTRY, B_FULL, C_BASE, C_ENTRY, C_FULL, bodyOf, drain, editOnDisk, note, sleep, synced, twoVaults, useWorld } from './helpers/world';

const win = nodePath.win32;
type SyncNow = (file: unknown, manual: boolean) => Promise<void>;
const syncNowOf = (engine: SyncEngine) => engine as unknown as { syncNow: SyncNow };

describe('sync safety under concurrent edits', () => {
	const ctx = useWorld();
	const io = () => ctx.world.io;
	const backupsWith = (body: string) => [...new Set(io().writeLog)].filter((p) => /sync-conflict/.test(p) && io().exists(p) && bodyOf(io().content(p)) === body);

	it('a pull waits while the editor has unsaved changes', async () => {
		const { appA, pA, fA } = await synced(ctx.world);
		editOnDisk(io(), B_FULL, note('B edit'));
		const other = await appA.vault.create('Other.md', 'other');
		const { view: otherView } = await openInEditor(appA, other.asOriginalType2__());
		otherView.editor.setValue('unsaved in another note');
		const { view } = await openInEditor(appA, fA);
		const leaves = appA.workspace.getLeavesOfType('markdown');
		// A tab whose view has not loaded yet (deferred view) is not a MarkdownView
		vi.spyOn(appA.workspace, 'getLeavesOfType').mockReturnValue([{ view: {} } as never, ...leaves]);
		view.editor.setValue('typing');
		await pA.engine.syncFile(fA);
		expect(bodyOf(await read(appA, fA))).toBe(note('v1'));
		view.editor.setValue((await read(appA, fA)).replace(/\n/g, '\r\n'));
		await pA.engine.syncFile(fA);
		expect(bodyOf(await read(appA, fA))).toBe(note('B edit'));
	});

	it('a push waits while the editor has unsaved changes, and typing on until the save is no conflict', async () => {
		const { appA, pA, fA } = await synced(ctx.world);
		const before = io().content(B_FULL);
		await change(appA, fA, note('A edit'));
		const { view } = await openInEditor(appA, fA);
		view.editor.setValue(`${await read(appA, fA)}typing`);
		await pA.engine.syncFile(fA);
		expect(io().content(B_FULL)).toBe(before);

		// The user types on, and Obsidian saves
		await change(appA, fA, note('A edit, then more'));
		view.editor.setValue(await read(appA, fA));
		await pA.engine.syncFile(fA);
		expect(bodyOf(io().content(B_FULL))).toBe(note('A edit, then more'));
		expect(io().content(B_FULL)).toBe(await read(appA, fA));
		expect(readHeader(await read(appA, fA))?.version).toBe(2);
		expect(ctx.count(/more than one place/)).toBe(0);
	});

	it('a copy edited while it is read is left alone and read again later, without an error', async () => {
		const { appA, pA, fA } = await synced(ctx.world);
		await change(appA, fA, note('A edit'));
		io().hooks.afterRead = (p) => {
			if (io().key(p) === io().key(B_FULL)) {
				io().hooks.afterRead = undefined;
				editOnDisk(io(), B_FULL, note('B concurrent'));
			}
		};
		await pA.engine.syncFile(fA);
		expect(bodyOf(io().content(B_FULL))).toBe(note('B concurrent'));
		expect(pA.engine.debounceTimers.has(fA.path)).toBe(true);
		expect(ctx.count(/error/)).toBe(0);
		await sleep(350);
		await drain(pA);
		// Both copies changed since the version they share: a real conflict, and the other edit is kept
		expect(bodyOf(await read(appA, fA))).toBe(note('B concurrent'));
		expect(backupsWith(note('A edit'))).toHaveLength(1);
	});

	it('the local note changing during a pull is not overwritten', async () => {
		const { appA, pA, fA } = await synced(ctx.world);
		editOnDisk(io(), B_FULL, note('B edit'));
		const process = appA.vault.process.bind(appA.vault);
		vi.spyOn(appA.vault, 'process').mockImplementationOnce(async (file, fn, options) => {
			await edit(appA, fA, note('typed meanwhile'));
			return process(file, fn, options);
		});
		await pA.engine.syncFile(fA);
		expect(await read(appA, fA)).toBe(note('typed meanwhile'));
		expect(pA.engine.debounceTimers.has(fA.path)).toBe(true);
	});

	it('a copy deleted between read and write is not recreated in the same pass', async () => {
		const L = [A_ENTRY, B_ENTRY, C_ENTRY];
		ctx.world.folder('Work', C_BASE);
		io().addDir(win.dirname(C_FULL));
		const { appA, pA, fA } = await twoVaults(ctx.world, { list: L });
		io().put(C_FULL, note('v1', L));
		await pA.engine.syncFile(fA);
		await change(appA, fA, note('A edit', L));
		io().hooks.afterRead = (p) => {
			if (io().key(p) === io().key(C_FULL)) {
				io().hooks.afterRead = undefined;
				io().remove(C_FULL);
			}
		};
		await pA.engine.syncFile(fA);
		expect(io().exists(C_FULL)).toBe(false);
		expect(pA.engine.debounceTimers.has(fA.path)).toBe(true);
	});

	it('a target that appears just before it is created is not overwritten, and is not known yet', async () => {
		const { appA, pA, fA } = await twoVaults(ctx.world, { withB: false });
		io().hooks.beforeWrite = (p, flag) => {
			if (io().key(p) === io().key(B_FULL) && flag === 'wx') {
				io().hooks.beforeWrite = undefined;
				io().put(B_FULL, note('made elsewhere'));
			}
		};
		await pA.engine.syncFile(fA);
		expect(io().content(B_FULL)).toBe(note('made elsewhere'));
		expect(pA.engine.debounceTimers.has(fA.path)).toBe(true);
		expect(readHeader(await read(appA, fA))?.known).toEqual([A_ENTRY]);
	});

	it('both vaults resolving the same conflict at once converge with one backup', async () => {
		const { appA, pA, pB, fA, fB } = await synced(ctx.world);
		await change(appA, fA, note('race A'));
		editOnDisk(io(), B_FULL, note('race B'));
		await Promise.all([pA.engine.syncFile(fA), pB.engine.syncFile(fB)]);
		await sleep(350);
		await drain(pA);
		await drain(pB);
		expect(bodyOf(await read(appA, fA))).toBe(note('race B'));
		expect(io().content(B_FULL)).toBe(await read(appA, fA));
		expect(backupsWith(note('race A'))).toHaveLength(1);
	});

	it('overlapping syncs of one note run one after another', async () => {
		const { appA, pA, fA } = await synced(ctx.world);
		await change(appA, fA, note('A edit'));
		const order: string[] = [];
		const engine = syncNowOf(pA.engine);
		const original = engine.syncNow.bind(pA.engine);
		vi.spyOn(engine, 'syncNow').mockImplementation(async (file, manual) => {
			order.push('start');
			await original(file, manual);
			order.push('end');
		});
		await Promise.all([pA.engine.syncFile(fA), pA.engine.syncFile(fA), pA.engine.syncFile(fA)]);
		expect(order.join(',')).toBe('start,end,start,end,start,end');
		expect(pA.engine.syncQueues.size).toBe(0);
		expect(bodyOf(io().content(B_FULL))).toBe(note('A edit'));
	});

	it('an unexpected error inside a sync is contained', async () => {
		const { pA, fA } = await synced(ctx.world);
		vi.spyOn(syncNowOf(pA.engine), 'syncNow').mockRejectedValue(new Error('boom'));
		await pA.engine.syncFile(fA);
		expect(ctx.logged(/Sync failed/)).toBe(true);
	});

	it('a note rewritten on both sides over and over is paused, and manual sync still works', async () => {
		const { appA, pA, fA } = await synced(ctx.world);
		for (let i = 0; i < 4; i++) {
			editOnDisk(io(), B_FULL, note(`b${i}`));
			await pA.engine.syncFile(fA);
			await change(appA, fA, note(`a${i}`));
			await pA.engine.syncFile(fA);
		}
		expect(ctx.count(/paused for 5 minutes/)).toBe(1);
		await change(appA, fA, note('after pause'));
		await pA.engine.syncFile(fA);
		expect(bodyOf(io().content(B_FULL))).not.toBe(note('after pause'));
		await pA.engine.syncFile(fA, true);
		expect(bodyOf(io().content(B_FULL))).toBe(note('after pause'));
	});

	it('a deleted note is not synced after its queued sync starts', async () => {
		const { appA, pA, fA } = await synced(ctx.world);
		await trash(appA, fA);
		const before = io().writeLog.length;
		await pA.engine.syncFile(fA, true);
		expect(io().writeLog.length).toBe(before);
	});
});
