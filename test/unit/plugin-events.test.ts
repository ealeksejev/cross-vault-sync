import type { Command, TFile as TFileOriginal } from 'obsidian';
import { TFile } from 'obsidian-test-mocks/obsidian';
import { describe, expect, it, vi } from 'vitest';
import type CrossVaultSyncPlugin from '../../src/main';
import { AddSyncTargetModal } from '../../src/ui/add-target-modal';
import { change, read } from './helpers/vault';
import { B_FULL, bodyOf, drain, editOnDisk, fileOf, note, synced, useWorld } from './helpers/world';

const commandsOf = (plugin: CrossVaultSyncPlugin) => (plugin as unknown as { commands__: Map<string, Command> }).commands__;
const command = (plugin: CrossVaultSyncPlugin, id: string): Command => {
	const found = Array.from(commandsOf(plugin).values()).find((c) => c.id.endsWith(id));
	if (!found) throw new Error(`no command ${id}`);
	return found;
};

describe('Obsidian events, status bar and commands', () => {
	const ctx = useWorld();
	const io = () => ctx.world.io;

	it('modify events schedule a sync for Markdown notes when auto-sync is on', async () => {
		const { appA, pA, fA } = await synced(ctx.world);
		pA.settings.autoSync = true;
		appA.vault.trigger('modify', fA);
		expect(pA.engine.debounceTimers.has(fA.path)).toBe(true);
		pA.engine.unload();
		appA.vault.trigger('modify', TFile.create__(appA.vault, 'pic.png'));
		appA.vault.trigger('modify', appA.vault.getRoot());
		pA.settings.autoSync = false;
		appA.vault.trigger('modify', fA);
		expect(pA.engine.debounceTimers.size).toBe(0);
	});

	it('rename events reach the own-path handler for Markdown notes only', async () => {
		const { appA, pA, fA } = await synced(ctx.world);
		const calls: string[] = [];
		vi.spyOn(pA.ownPath, 'handleRename').mockImplementation(async (_file, oldPath) => {
			calls.push(oldPath);
		});
		appA.vault.trigger('rename', TFile.create__(appA.vault, 'pic.png'), 'old.png');
		appA.vault.trigger('rename', appA.vault.getRoot(), 'old-folder');
		appA.vault.trigger('rename', fA, 'old.md');
		expect(calls).toEqual(['old.md']);
	});

	it('metadata changes on the active note refresh the status bar and watchers', async () => {
		const { appA, pA, fA } = await synced(ctx.world);
		pA.settings.autoSync = true;
		vi.spyOn(appA.workspace, 'getActiveFile').mockReturnValue(TFile.fromOriginalType2__(fA));
		const other = await appA.vault.create('Other.md', 'x');
		appA.metadataCache.trigger('changed', other);
		expect(pA.statusBarEl.textContent).toBe('');
		appA.metadataCache.trigger('changed', fA);
		expect(pA.statusBarEl.textContent).toBe('⇅ Sync (2)');
		expect(io().openWatchers()).toHaveLength(1);
	});

	it('file-open updates the status bar and watchers and checks for external changes', async () => {
		const { appA, pA, fA } = await synced(ctx.world);
		pA.settings.autoSync = true;
		editOnDisk(io(), B_FULL, note('B edit'));
		appA.workspace.trigger('file-open', fA);
		await drain(pA);
		expect(pA.statusBarEl.textContent).toBe('⇅ Sync (2)');
		expect(io().openWatchers()).toHaveLength(1);
		expect(bodyOf(await read(appA, fA))).toBe(note('B edit'));

		pA.settings.autoSync = false;
		editOnDisk(io(), B_FULL, note('B again'));
		appA.workspace.trigger('file-open', fA);
		await drain(pA);
		expect(bodyOf(await read(appA, fA))).toBe(note('B edit'));

		appA.workspace.trigger('file-open', null);
		expect(pA.statusBarEl.textContent).toBe('');
		expect(io().openWatchers()).toHaveLength(0);
		const plain = await appA.vault.create('Projects/plain.md', 'plain\n');
		appA.workspace.trigger('file-open', plain);
		expect(pA.statusBarEl.textContent).toBe('');
	});

	it('window focus checks the active Markdown note', async () => {
		const { appA, pA, fA } = await synced(ctx.world);
		pA.settings.autoSync = true;
		editOnDisk(io(), B_FULL, note('B edit'));
		const active = vi.spyOn(appA.workspace, 'getActiveFile');
		const focus = () => window.dispatchEvent(new Event('focus'));
		active.mockReturnValue(null);
		focus();
		active.mockReturnValue(TFile.create__(appA.vault, 'pic.png'));
		focus();
		pA.settings.autoSync = false;
		active.mockReturnValue(TFile.fromOriginalType2__(fA));
		focus();
		await drain(pA);
		expect(bodyOf(await read(appA, fA))).toBe(note('v1'));
		pA.settings.autoSync = true;
		focus();
		await drain(pA);
		expect(bodyOf(await read(appA, fA))).toBe(note('B edit'));
	});

	it('the status bar click syncs the active note or explains there is none', async () => {
		const { appA, pA, fA } = await synced(ctx.world);
		const active = vi.spyOn(appA.workspace, 'getActiveFile');
		expect(pA.statusBarEl.hasClass('mod-clickable')).toBe(true);
		active.mockReturnValue(null);
		pA.statusBarEl.click();
		expect(ctx.count(/No active Markdown note/)).toBe(1);
		active.mockReturnValue(TFile.fromOriginalType2__(fA));
		await change(appA, fA, note('A edit'));
		pA.statusBarEl.click();
		await drain(pA);
		expect(bodyOf(io().content(B_FULL))).toBe(note('A edit'));
		expect(ctx.count(/Synchronized 1 target/)).toBe(1);
	});

	it('commands are available only for Markdown notes and do their job', async () => {
		const { appA, pA, fA } = await synced(ctx.world);
		const active = vi.spyOn(appA.workspace, 'getActiveFile');
		const open = vi.spyOn(AddSyncTargetModal.prototype, 'open');
		for (const id of ['sync-active-note', 'add-sync-target']) {
			const check = command(pA, id).checkCallback!;
			active.mockReturnValue(null);
			expect(check(true)).toBe(false);
			active.mockReturnValue(TFile.create__(appA.vault, 'pic.png'));
			expect(check(true)).toBe(false);
			active.mockReturnValue(TFile.fromOriginalType2__(fA));
			expect(check(true)).toBe(true);
		}
		expect(open).not.toHaveBeenCalled();
		await change(appA, fA, note('A edit'));
		expect(command(pA, 'sync-active-note').checkCallback!(false)).toBe(true);
		await drain(pA);
		expect(bodyOf(io().content(B_FULL))).toBe(note('A edit'));
		command(pA, 'add-sync-target').checkCallback!(false);
		expect(open).toHaveBeenCalledTimes(1);
		await command(pA, 'sync-all-notes').callback!();
		await drain(pA);
		await new Promise((resolve) => window.setTimeout(resolve, 20));
		expect(ctx.count(/Checked 1 note/)).toBe(1);
	});

	it('refreshWatchers follows the active note', async () => {
		const { appA, pA, fA } = await synced(ctx.world);
		pA.settings.autoSync = true;
		const active = vi.spyOn(appA.workspace, 'getActiveFile');
		active.mockReturnValue(TFile.fromOriginalType2__(fA));
		pA.refreshWatchers();
		expect(io().openWatchers()).toHaveLength(1);
		active.mockReturnValue(null);
		pA.refreshWatchers();
		expect(io().openWatchers()).toHaveLength(0);
		active.mockReturnValue(TFile.fromOriginalType2__(fA));
		pA.refreshWatchers();
		active.mockReturnValue(TFile.create__(appA.vault, 'image.png'));
		pA.refreshWatchers();
		expect(io().openWatchers()).toHaveLength(0);
	});

	it('a note opened from another vault object is looked up by path', async () => {
		const { appA, pA } = await synced(ctx.world);
		const same: TFileOriginal = fileOf(appA, 'Projects/topic.md');
		expect(pA.engine.targetsOf(same).targets).toHaveLength(2);
	});
});
