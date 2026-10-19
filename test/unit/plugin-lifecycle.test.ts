import { App, CapacitorAdapter, Platform } from 'obsidian-test-mocks/obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import CrossVaultSyncPlugin from '../../src/main';
import { DEFAULT_SETTINGS } from '../../src/settings';
import { change } from './helpers/vault';
import { A_REL, B_FULL, bodyOf, fileOf, note, sleep, synced, useWorld } from './helpers/world';

describe('plugin lifecycle and data', () => {
	const ctx = useWorld();
	const io = () => ctx.world.io;
	afterEach(() => {
		Platform.isDesktop = true;
	});

	it('off desktop the plugin only explains that it is desktop-only', async () => {
		Platform.isDesktop = false;
		const app = ctx.world.vault('C:\\Vault');
		const plugin = await ctx.world.plugin(app);
		expect(ctx.count(/desktop-only/)).toBe(1);
		expect(Object.hasOwn(plugin, 'engine')).toBe(false);
		plugin.onunload();
	});

	it('without a vault folder on disk nothing is synced or watched', async () => {
		const app = App.createConfigured__({ adapter: CapacitorAdapter.create__('mobile', {}), files: { [A_REL]: note('v1') } });
		const plugin = await ctx.world.plugin(app);
		const file = fileOf(app, A_REL);
		expect(plugin.vaultBasePath()).toBe('');
		expect(plugin.fullPath(file)).toBe('');
		await plugin.engine.syncFile(file, true);
		plugin.watchers.update(file, true);
		await plugin.ownPath.handleRename(file, 'old.md');
		await plugin.ownPath.addIfMissing(file);
		expect(io().writeLog).toEqual([]);
		expect(io().openWatchers()).toEqual([]);
	});

	it('nothing is synced or scheduled after unload', async () => {
		const { appA, pA, fA } = await synced(ctx.world);
		await change(appA, fA, note('A edit'));
		const before = io().writeLog.length;
		pA.onunload();
		await pA.engine.syncFile(fA);
		pA.engine.schedule(fA);
		expect(pA.engine.debounceTimers.size).toBe(0);
		expect(io().writeLog.length).toBe(before);
	});

	it('a manual sync reports what it did', async () => {
		const { appA, pA, fA } = await synced(ctx.world);
		await pA.engine.syncFile(fA, true);
		expect(ctx.count(/already in sync/)).toBe(1);
		await change(appA, fA, note('A edit'));
		await pA.engine.syncFile(fA, true);
		expect(ctx.count(/Synchronized 1 target/)).toBe(1);
	});

	it('the plugin data holds the settings only: other keys are dropped, and syncing never writes it', async () => {
		const app = ctx.world.vault('C:\\Vault');
		vi.spyOn(CrossVaultSyncPlugin.prototype, 'loadData').mockResolvedValueOnce({ autoSync: false, syncState: { 'c:\\vault\\a.md': {} }, other: 1 });
		const plugin = await ctx.world.plugin(app);
		expect(plugin.settings).toEqual({ ...DEFAULT_SETTINGS, autoSync: false, debounceMs: 200 });
		const saved = vi.spyOn(plugin, 'saveData').mockResolvedValue();
		await plugin.saveSettings();
		expect(saved).toHaveBeenCalledWith(plugin.settings);

		const { appA, pA, fA } = await synced(ctx.world);
		const syncSaved = vi.spyOn(pA, 'saveData');
		await change(appA, fA, note('A edit'));
		await pA.engine.syncFile(fA);
		pA.onunload();
		await sleep(0);
		expect(syncSaved).not.toHaveBeenCalled();
	});

	it('a first start without saved data uses the default settings', async () => {
		const app = ctx.world.vault('C:\\Vault');
		vi.spyOn(CrossVaultSyncPlugin.prototype, 'loadData').mockResolvedValueOnce(null);
		const plugin = await ctx.world.plugin(app);
		expect(plugin.settings).toEqual({ ...DEFAULT_SETTINGS, autoSync: false, debounceMs: 200 });
	});

	it('the debounced sync replaces a pending timer and fires once', async () => {
		const { appA, pA, fA } = await synced(ctx.world);
		await change(appA, fA, note('A edit'));
		pA.engine.schedule(fA);
		const first = pA.engine.debounceTimers.get(fA.path);
		pA.engine.schedule(fA);
		expect(pA.engine.debounceTimers.get(fA.path)).not.toBe(first);
		expect(pA.engine.debounceTimers.size).toBe(1);
		await sleep(300);
		await Promise.all(pA.engine.syncQueues.values());
		expect(bodyOf(io().content(B_FULL))).toBe(note('A edit'));
		expect(pA.engine.debounceTimers.size).toBe(0);
	});

	it('sync all notes checks every note with targets and stays quiet when automatic', async () => {
		const { appA, pA, fA } = await synced(ctx.world);
		await appA.vault.create('Projects/plain.md', 'plain\n');
		await appA.vault.create('Projects/topic.sync-conflict-1234abcd.md', note('stale'));
		await change(appA, fA, note('A edit'));
		await pA.engine.syncAll(true);
		expect(ctx.count(/Checked 2 note/)).toBe(1);
		expect(bodyOf(io().content(B_FULL))).toBe(note('A edit'));
		await pA.engine.syncAll(false);
		expect(ctx.count(/Checked/)).toBe(1);
	});
});
