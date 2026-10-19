import { App, Modal, Notice, Setting } from 'obsidian';
import { statOrNull } from '../io';
import type CrossVaultSyncPlugin from '../main';

// Adds a folder of this computer under a name: a vault not opened here yet, a vault with an ambiguous name,
// or a folder outside the vaults
export class AddVaultFolderModal extends Modal {
	vaultName = '';
	folder = '';

	constructor(app: App, private readonly plugin: CrossVaultSyncPlugin, private readonly onAdded: () => void) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		this.titleEl.setText('Add folder');

		new Setting(contentEl)
			.setName('Name')
			.setDesc('The name at the start of sync_targets entries: a vault name, or a name for a folder outside the vaults.')
			.addText((text) => {
				text.setValue(this.vaultName).onChange((value) => {
					this.vaultName = value;
				});
			});
		new Setting(contentEl)
			.setName('Folder')
			.setDesc('The absolute path of the folder on this computer.')
			.addText((text) => {
				text.setPlaceholder('Absolute folder path')
					.setValue(this.folder)
					.onChange((value) => {
						this.folder = value;
					});
				text.inputEl.addClass('cross-vault-sync-path-input');
			});

		new Setting(contentEl)
			.addButton((button) => {
				button.setButtonText('Cancel').onClick(() => this.close());
			})
			.addButton((button) => {
				button.setButtonText('Add')
					.setCta()
					.onClick(async () => {
						if (await this.add()) this.close();
					});
			});
	}

	onClose(): void {
		this.contentEl.empty();
	}

	async add(): Promise<boolean> {
		const { plugin } = this;
		const name = this.vaultName.trim();
		// Explorer's "Copy as path" wraps the path in double quotes
		const folder = this.folder.trim().replace(/^"(.*)"$/, '$1').trim();
		if (!name) {
			new Notice('Enter a name.');
			return false;
		}
		if (!plugin.paths.isAbsolutePath(folder)) {
			new Notice('Enter the absolute path of the folder.');
			return false;
		}
		const stat = await statOrNull(plugin.io, folder);
		if (!stat?.isDirectory()) {
			new Notice(`Folder not found: ${folder}`);
			return false;
		}
		plugin.folders.setManual(name, plugin.paths.path.resolve(folder));
		this.onAdded();
		return true;
	}
}
