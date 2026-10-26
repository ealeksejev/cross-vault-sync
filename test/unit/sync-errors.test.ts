import * as nodePath from 'path';
import { describe, expect, it, vi } from 'vitest';
import { readHeader } from '../../src/header';
import { errno } from './helpers/fake-io';
import { change, read } from './helpers/vault';
import { A_BASE, A_ENTRY, A_FULL, B_ENTRY, B_FULL, C_BASE, C_ENTRY, C_FULL, bodyOf, editOnDisk, note, synced, twoVaults, useWorld } from './helpers/world';

const win = nodePath.win32;

describe('sync I/O errors', () => {
	const ctx = useWorld();
	const io = () => ctx.world.io;
	const isB = (p: string) => io().key(p) === io().key(B_FULL);

	it('a transient EBUSY on the target is retried', async () => {
		const { appA, pA, fA } = await synced(ctx.world);
		await change(appA, fA, note('A edit'));
		let busy = 2;
		io().hooks.beforeWrite = (p) => {
			if (isB(p) && busy-- > 0) throw errno('EBUSY', p);
		};
		await pA.engine.syncFile(fA);
		expect(bodyOf(io().content(B_FULL))).toBe(note('A edit'));
	});

	it('an EBUSY that never clears gives up after backing off', async () => {
		const { appA, pA, fA } = await synced(ctx.world);
		await change(appA, fA, note('A edit'));
		io().hooks.beforeWrite = (p) => {
			if (isB(p)) throw errno('EBUSY', p);
		};
		// performance.now(), not Date.now(): the wall clock can jump back while the test waits, as WSL 2 resyncs it
		const started = performance.now();
		await pA.engine.syncFile(fA);
		// 100 + 200 + 400 + 800 + 1600 ms
		expect(performance.now() - started).toBeGreaterThanOrEqual(3000);
		expect(ctx.count(/EBUSY/)).toBe(1);
		expect(bodyOf(io().content(B_FULL))).toBe(note('v1'));
	});

	it('a write waiting to retry when the plugin is turned off is not retried, and is not reported', async () => {
		const { appA, pA, fA } = await synced(ctx.world);
		await change(appA, fA, note('A edit'));
		let attempts = 0;
		io().hooks.beforeWrite = (p) => {
			if (!isB(p)) return;
			attempts++;
			// Obsidian turns the plugin off while the write waits for its first retry
			pA.onunload();
			throw errno('EBUSY', p);
		};
		await pA.engine.syncFile(fA);
		expect(attempts).toBe(1);
		expect(bodyOf(io().content(B_FULL))).toBe(note('v1'));
		expect(ctx.count(/EBUSY/)).toBe(0);
		expect(ctx.logged(/Error syncing/)).toBe(false);
	});

	it('a permanent write error leaves the copy one version behind, and the next sync brings it up to date', async () => {
		const { appA, pA, fA } = await synced(ctx.world);
		await change(appA, fA, note('A edit'));
		io().hooks.beforeWrite = (p) => {
			if (isB(p)) throw errno('ENOSPC', p);
		};
		await pA.engine.syncFile(fA);
		expect(bodyOf(io().content(B_FULL))).toBe(note('v1'));
		expect([readHeader(await read(appA, fA))?.version, readHeader(io().content(B_FULL)!)?.version]).toEqual([2, 1]);
		expect(ctx.count(/ENOSPC/)).toBe(1);
		io().hooks.beforeWrite = undefined;
		await pA.engine.syncFile(fA);
		expect(io().content(B_FULL)).toBe(await read(appA, fA));
		expect(ctx.count(/more than one place/)).toBe(0);
	});

	it('a failing create is reported', async () => {
		const { pA, fA } = await twoVaults(ctx.world, { withB: false });
		io().hooks.beforeWrite = (p) => {
			if (isB(p)) throw errno('EACCES', p);
		};
		await pA.engine.syncFile(fA);
		expect(io().exists(B_FULL)).toBe(false);
		expect(ctx.count(/EACCES/)).toBe(1);
	});

	it('a failing write of the note itself is reported, and no copy is written', async () => {
		const { appA, pA, fA } = await synced(ctx.world);
		editOnDisk(io(), B_FULL, note('B edit'));
		const copy = io().content(B_FULL);
		vi.spyOn(appA.vault, 'process').mockRejectedValueOnce(errno('EPERM', A_FULL));
		await pA.engine.syncFile(fA);
		expect(bodyOf(await read(appA, fA))).toBe(note('v1'));
		expect(io().content(B_FULL)).toBe(copy);
		expect(ctx.count(/EPERM/)).toBe(1);
	});

	it('a failing write of a copy in this vault is reported, and the other copies are still written', async () => {
		const L = [A_ENTRY, 'Vault A/Archive/topic', B_ENTRY];
		const { appA, pA, fA } = await synced(ctx.world, { list: L });
		await change(appA, fA, note('A edit', L));
		const process = appA.vault.process.bind(appA.vault);
		vi.spyOn(appA.vault, 'process').mockImplementation(async (file, fn, options) => {
			if (file.path === 'Archive/topic.md') throw errno('EPERM', file.path);
			return process(file, fn, options);
		});
		await pA.engine.syncFile(fA);
		expect(ctx.count(/EPERM/)).toBe(1);
		expect(bodyOf(io().content(win.join(A_BASE, 'Archive', 'topic.md')))).toBe(note('v1', L));
		expect(bodyOf(io().content(B_FULL))).toBe(note('A edit', L));
	});

	it('an unreadable copy is reported, the others still sync, and it catches up later', async () => {
		const L = [A_ENTRY, B_ENTRY, C_ENTRY];
		ctx.world.folder('Work', C_BASE);
		io().addDir(win.dirname(C_FULL));
		const { appA, pA, fA } = await twoVaults(ctx.world, { list: L });
		io().put(C_FULL, note('v1', L));
		await pA.engine.syncFile(fA);
		await change(appA, fA, note('A edit', L));
		io().hooks.readFile = (p) => {
			if (io().key(p) === io().key(C_FULL)) throw errno('EACCES', p);
		};
		await pA.engine.syncFile(fA);
		expect(bodyOf(io().content(B_FULL))).toBe(note('A edit', L));
		expect(bodyOf(io().content(C_FULL))).toBe(note('v1', L));
		io().hooks.readFile = undefined;
		await pA.engine.syncFile(fA);
		expect(bodyOf(io().content(C_FULL))).toBe(note('A edit', L));
		expect(ctx.count(/more than one place/)).toBe(0);
	});

	it('a stat error other than "missing" counts as unreadable, and a manual sync does not claim success', async () => {
		const { pA, fA } = await synced(ctx.world);
		io().hooks.stat = (p) => {
			if (isB(p)) throw errno('EACCES', p);
		};
		await pA.engine.syncFile(fA, true);
		expect(ctx.count(/EACCES/)).toBe(1);
		expect(ctx.count(/already in sync|Synchronized/)).toBe(0);
	});

	it('an unreadable local note is skipped', async () => {
		const { appA, pA, fA } = await synced(ctx.world);
		await change(appA, fA, note('A edit'));
		vi.spyOn(appA.vault, 'read').mockRejectedValueOnce(new Error('locked'));
		await pA.engine.syncFile(fA);
		expect(bodyOf(io().content(B_FULL))).toBe(note('v1'));
		expect(ctx.logged(/Failed to read local file/)).toBe(true);
	});

	it("Obsidian's cached mtime is used when the local stat fails", async () => {
		const { appA, pA, fA } = await synced(ctx.world);
		editOnDisk(io(), B_FULL, note('B edit'));
		// Newer on disk, but older in Obsidian's cache
		await change(appA, fA, note('A edit'));
		fA.stat.mtime = 42;
		io().hooks.stat = (p) => {
			if (io().key(p) === io().key(A_FULL)) throw errno('EBUSY', p);
		};
		await pA.engine.syncFile(fA);
		expect(bodyOf(await read(appA, fA))).toBe(note('B edit'));
	});

	it('error notices: manual always, automatic once a minute, none when notices are off', async () => {
		const { pA, fA } = await synced(ctx.world);
		io().hooks.readFile = (p) => {
			if (isB(p)) throw errno('EACCES', p);
		};
		await pA.engine.syncFile(fA);
		await pA.engine.syncFile(fA);
		expect(ctx.count(/EACCES/)).toBe(1);
		await pA.engine.syncFile(fA, true);
		expect(ctx.count(/EACCES/)).toBe(2);
		pA.settings.showNotices = false;
		pA.engine.errors.lastNotice.clear();
		await pA.engine.syncFile(fA);
		expect(ctx.count(/EACCES/)).toBe(2);
	});

	it('an error that is not an Error object is reported by its text', async () => {
		const { pA, fA } = await synced(ctx.world);
		io().hooks.readFile = (p) => {
			// eslint-disable-next-line @typescript-eslint/only-throw-error -- what a buggy dependency might throw
			if (isB(p)) throw 'disk on fire';
		};
		await pA.engine.syncFile(fA, true);
		expect(ctx.count(/Cross-Vault Sync error: disk on fire/)).toBe(1);
	});
});
