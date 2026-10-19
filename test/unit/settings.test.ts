import type { SettingDefinitionList } from 'obsidian';
import { TFile } from 'obsidian-test-mocks/obsidian';
import { describe, expect, it, vi } from 'vitest';
import type CrossVaultSyncPlugin from '../../src/main';
import { DEFAULT_SETTINGS, type CrossVaultSyncSettingTab } from '../../src/settings';
import { AddVaultFolderModal } from '../../src/ui/add-vault-folder-modal';
import { A_BASE, B_BASE, synced, useWorld } from './helpers/world';

const tabOf = (plugin: CrossVaultSyncPlugin) => (plugin as unknown as { settingTabs__: CrossVaultSyncSettingTab[] }).settingTabs__[0]!;

// The general settings as rows of name and control, before the vault folder list. The mock cannot render
// control rows, the e2e tests do.
function rowsOf(tab: CrossVaultSyncSettingTab) {
	const items = tab.getSettingDefinitions();
	return items.slice(0, -1).map((item) => {
		if (!('control' in item) || !item.control) throw new Error('every general setting is a control row');
		return { name: item.name, control: item.control };
	});
}

function vaultListOf(tab: CrossVaultSyncSettingTab): SettingDefinitionList {
	const list = tab.getSettingDefinitions().at(-1);
	if (!list || !('type' in list) || list.type !== 'list') throw new Error('the last item is the vault folder list');
	return list as SettingDefinitionList;
}

describe('settings tab', () => {
	const ctx = useWorld();

	it('lists one control per setting in sentence case, without a heading', async () => {
		const { pA } = await synced(ctx.world);
		const rows = rowsOf(tabOf(pA));
		expect(rows.map((row) => row.name)).toEqual(['Automatic sync', 'Sync debounce (ms)', 'Frontmatter property', 'Show notifications', 'Create conflict backup']);
		expect(rows.map((row) => row.control.key).sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort());
	});

	it('lists the vault folders of this computer, adds one by hand and deletes the clicked row', async () => {
		const { pA } = await synced(ctx.world);
		const tab = tabOf(pA);
		pA.folders.setManual('Other', 'D:\\Other');
		const list = vaultListOf(tab);
		expect(list.heading).toBe('Vaults and folders on this computer');
		expect(list.emptyState).toMatch(/opened on this computer/);
		expect(list.items?.map((item) => [item.name, item.desc])).toEqual([
			['Other', 'D:\\Other (added by hand)'],
			['Vault A', `${A_BASE} (found automatically)`],
			['Vault B', `${B_BASE} (found automatically)`],
		]);

		const update = vi.spyOn(tab, 'update');
		const open = vi.spyOn(AddVaultFolderModal.prototype, 'open').mockReturnValue(undefined);
		list.addItem?.action(createDiv());
		const modal = open.mock.contexts[0] as AddVaultFolderModal | undefined;
		if (!modal) throw new Error('the add button opens the dialog');
		modal.vaultName = 'Third';
		modal.folder = A_BASE;
		expect(await modal.add()).toBe(true);
		expect(update).toHaveBeenCalledTimes(1);

		list.onDelete?.(0);
		list.onDelete?.(9);
		expect(update).toHaveBeenCalledTimes(3);
		expect(pA.folders.list().map((entry) => entry.name)).toEqual(['Third', 'Vault A', 'Vault B']);
	});

	it('rejects a debounce below 200 ms and an empty property name', async () => {
		const { pA } = await synced(ctx.world);
		const rows = rowsOf(tabOf(pA));
		const debounce = rows[1]!.control;
		if (debounce.type !== 'number' || !debounce.validate) throw new Error('the debounce is a validated number control');
		expect(debounce.min).toBe(200);
		expect(debounce.validate(0)).toBe('Value must be at least 200.');
		expect(debounce.validate(NaN)).toBe('Value must be at least 200.');
		expect(debounce.validate(200)).toBeUndefined();
		const property = rows[2]!.control;
		if (property.type !== 'text' || !property.validate) throw new Error('the property is a validated text control');
		expect(property.validate('   ')).toBe('Enter a property name.');
		expect(property.validate('targets')).toBeUndefined();
	});

	it('reads the current values', async () => {
		const { pA } = await synced(ctx.world);
		pA.settings.debounceMs = 750;
		const tab = tabOf(pA);
		expect(tab.getControlValue('debounceMs')).toBe(750);
		expect(tab.getControlValue('frontmatterKey')).toBe('sync_targets');
	});

	it('saves the settings only, trims the property name and refreshes the watchers', async () => {
		const { appA, pA, fA } = await synced(ctx.world);
		vi.spyOn(appA.workspace, 'getActiveFile').mockReturnValue(TFile.fromOriginalType2__(fA));
		const refresh = vi.spyOn(pA, 'refreshWatchers');
		const tab = tabOf(pA);

		await tab.setControlValue('autoSync', true);
		expect(ctx.world.io.openWatchers()).toHaveLength(1);
		await tab.setControlValue('autoSync', false);
		expect(ctx.world.io.openWatchers()).toHaveLength(0);
		await tab.setControlValue('frontmatterKey', ' targets ');
		expect(pA.settings.frontmatterKey).toBe('targets');
		expect(refresh).toHaveBeenCalledTimes(3);

		await tab.setControlValue('debounceMs', 750);
		await tab.setControlValue('showNotices', false);
		await tab.setControlValue('createConflictBackup', false);
		expect(refresh).toHaveBeenCalledTimes(3);
		expect(await pA.loadData()).toEqual({
			autoSync: false,
			debounceMs: 750,
			frontmatterKey: 'targets',
			showNotices: false,
			createConflictBackup: false,
		});
	});
});
