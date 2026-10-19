import { App, PluginSettingTab, type SettingDefinitionItem } from 'obsidian';
import type CrossVaultSyncPlugin from './main';
import { AddVaultFolderModal } from './ui/add-vault-folder-modal';

export interface CrossVaultSyncSettings {
	autoSync: boolean;
	debounceMs: number;
	frontmatterKey: string;
	showNotices: boolean;
	createConflictBackup: boolean;
}

type SettingKey = keyof CrossVaultSyncSettings;

export const MIN_DEBOUNCE_MS = 200;

export const DEFAULT_SETTINGS: CrossVaultSyncSettings = {
	autoSync: true,
	debounceMs: 1000,
	frontmatterKey: 'sync_targets',
	showNotices: true,
	createConflictBackup: true,
};

export class CrossVaultSyncSettingTab extends PluginSettingTab {
	constructor(app: App, private readonly plugin: CrossVaultSyncPlugin) {
		super(app, plugin);
	}

	getSettingDefinitions(): SettingDefinitionItem<SettingKey>[] {
		// The rows as rendered, so a delete removes the row the user clicked
		const vaultFolders = this.plugin.folders.list();
		return [
			{
				name: 'Automatic sync',
				desc: 'Automatically synchronize notes when modified.',
				control: { type: 'toggle', key: 'autoSync' },
			},
			{
				name: 'Sync debounce (ms)',
				desc: 'Wait time in milliseconds after editing before synchronizing.',
				control: {
					type: 'number',
					key: 'debounceMs',
					min: MIN_DEBOUNCE_MS,
					step: 1,
					// min alone lets an emptied field through as 0 (seen in Obsidian 1.13.4 and 1.14.4)
					validate: (value) => (value >= MIN_DEBOUNCE_MS ? undefined : `Value must be at least ${MIN_DEBOUNCE_MS}.`),
				},
			},
			{
				name: 'Frontmatter property',
				desc: 'The YAML frontmatter key that lists the copies of a note.',
				control: {
					type: 'text',
					key: 'frontmatterKey',
					validate: (value) => (value.trim() ? undefined : 'Enter a property name.'),
				},
			},
			{
				name: 'Show notifications',
				desc: 'Show notification notices when files are created or updated.',
				control: { type: 'toggle', key: 'showNotices' },
			},
			{
				name: 'Create conflict backup',
				desc: 'When a note was edited in more than one place, save the version that loses as <name>.sync-conflict-<hash>.md next to it.',
				control: { type: 'toggle', key: 'createConflictBackup' },
			},
			{
				type: 'list',
				heading: 'Vaults and folders on this computer',
				emptyState: 'None yet. A vault is added when it is opened on this computer with Cross-Vault Sync enabled.',
				addItem: {
					name: 'Add folder',
					action: () => new AddVaultFolderModal(this.app, this.plugin, () => this.update()).open(),
				},
				onDelete: (index) => {
					const entry = vaultFolders[index];
					if (entry) this.plugin.folders.remove(entry);
					this.update();
				},
				items: vaultFolders.map((entry) => ({
					name: entry.name,
					desc: `${entry.folder} (${entry.manual ? 'added by hand' : 'found automatically'})`,
					searchable: false,
				})),
			},
		];
	}

	getControlValue(key: string): unknown {
		return (this.plugin.settings as unknown as Record<string, unknown>)[key];
	}

	// Replaces the default write: a changed autoSync or frontmatter key changes which target folders are watched
	async setControlValue(key: string, value: unknown): Promise<void> {
		(this.plugin.settings as unknown as Record<string, unknown>)[key] = typeof value === 'string' ? value.trim() : value;
		await this.plugin.saveSettings();
		if (key === 'autoSync' || key === 'frontmatterKey') this.plugin.refreshWatchers();
	}
}
