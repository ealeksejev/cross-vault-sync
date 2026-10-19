import { describe, expect, it, vi } from 'vitest';
import { A_ENTRY, B_BASE, B_ENTRY, B_FULL, C_BASE, C_ENTRY, note, synced, twoVaults, useWorld } from './helpers/world';

describe('target folder watchers', () => {
	const ctx = useWorld();
	const io = () => ctx.world.io;

	it('watch one folder per target, filter by name and follow auto-sync', async () => {
		const { pA, fA } = await synced(ctx.world);
		pA.settings.autoSync = true;
		pA.watchers.update(fA, true);
		expect(io().openWatchers()).toHaveLength(1);
		io().put(`${B_BASE}\\Notes\\other.md`, 'x');
		expect(pA.engine.debounceTimers.has(fA.path)).toBe(false);
		io().put(B_FULL, io().content(B_FULL)!);
		expect(pA.engine.debounceTimers.has(fA.path)).toBe(true);
		pA.engine.unload();
		io().openWatchers()[0]!.listener('rename', null);
		expect(pA.engine.debounceTimers.has(fA.path)).toBe(true);
		pA.engine.unload();

		pA.settings.autoSync = false;
		io().put(B_FULL, io().content(B_FULL)!);
		expect(pA.engine.debounceTimers.has(fA.path)).toBe(false);
		pA.watchers.update(fA, false);
		expect(io().openWatchers()).toHaveLength(0);

		pA.settings.autoSync = true;
		pA.watchers.update(fA, false);
		const watcher = io().openWatchers()[0];
		pA.watchers.update(fA, false);
		expect(io().openWatchers()[0]).toBe(watcher);
		pA.watchers.update(fA, true);
		expect(watcher?.closed).toBe(true);
		expect(io().openWatchers()).toHaveLength(1);
		pA.onunload();
		expect(io().openWatchers()).toHaveLength(0);
	});

	it('a change seen after unload does nothing', async () => {
		const { pA, fA } = await synced(ctx.world);
		pA.settings.autoSync = true;
		pA.watchers.update(fA, true);
		const watcher = io().openWatchers()[0]!;
		pA.onunload();
		watcher.listener('change', 'topic.md');
		expect(pA.engine.debounceTimers.size).toBe(0);
	});

	it('watcher errors close the watcher, and failures to watch or to close are contained', async () => {
		// The folder outside the vaults has a name on this computer but does not exist
		ctx.world.table().setManual('Work', C_BASE);
		const { pA, fA } = await twoVaults(ctx.world, { list: [A_ENTRY, B_ENTRY, C_ENTRY] });
		pA.settings.autoSync = true;
		pA.watchers.update(fA, true);
		// A missing folder is expected, and only a debug message
		expect(ctx.logged(/Folder to watch does not exist/, 'debug')).toBe(true);
		expect(ctx.logged(/Folder to watch does not exist/)).toBe(false);
		const watcher = io().openWatchers()[0]!;
		watcher.emitError(new Error('EPERM'));
		expect(watcher.closed).toBe(true);
		expect(pA.watchers.watchers.size).toBe(0);
		expect(ctx.logged(/Stopped watching folder/)).toBe(true);

		pA.watchers.update(fA, true);
		const fresh = io().openWatchers()[0]!;
		watcher.throwOnClose = true;
		watcher.emitError(new Error('EPERM'));
		expect(pA.watchers.watchers.size).toBe(1);
		fresh.throwOnClose = true;
		pA.watchers.close();
		expect(pA.watchers.watchers.size).toBe(0);
	});

	it('a folder that exists but cannot be watched is an error', async () => {
		const { pA, fA } = await twoVaults(ctx.world);
		pA.settings.autoSync = true;
		vi.spyOn(io(), 'watch').mockImplementationOnce(() => {
			throw Object.assign(new Error('too many open files'), { code: 'EMFILE' });
		});
		pA.watchers.update(fA, true);
		expect(ctx.logged(/Could not watch folder/)).toBe(true);
		expect(pA.watchers.watchers.size).toBe(0);
	});

	it('targets in the same folder share one watcher', async () => {
		const SECOND = `${B_BASE}\\Notes\\second.md`;
		const { pA, fA } = await twoVaults(ctx.world, { list: [A_ENTRY, B_ENTRY, 'Vault B/Notes/second'] });
		pA.settings.autoSync = true;
		pA.watchers.update(fA, true);
		expect(io().openWatchers()).toHaveLength(1);
		io().put(SECOND, note('second'));
		expect(pA.engine.debounceTimers.has(fA.path)).toBe(true);
	});
});
