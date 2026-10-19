import { App, Modal, Notice, Setting, type TFile } from 'obsidian';
import { folderEntry, noteEntry, parseEntry, vaultProblemMessage } from '../entries';
import type CrossVaultSyncPlugin from '../main';
import { asList, waitForMetadata } from '../targets';

// The folder of the last target added in this vault, as a folder entry. The next note usually goes there too.
export const LAST_TARGET_KEY = 'cross-vault-sync:last-target-folder';

export class AddSyncTargetModal extends Modal {
	target = '';

	constructor(app: App, private readonly plugin: CrossVaultSyncPlugin, private readonly activeFile: TFile) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		const last: unknown = this.app.loadLocalStorage(LAST_TARGET_KEY);
		this.target = typeof last === 'string' ? last : '';

		this.titleEl.setText('Add sync target');
		contentEl.createEl('p', { text: `Link "${this.activeFile.basename}" to a note or folder in another vault.` });

		new Setting(contentEl)
			.setName('Target')
			.setDesc('A vault name and a path, such as vault/folder/note, or vault/folder/ for a copy with the same name. Copy sync target in the menu of a note or folder copies it.')
			.addText((text) => {
				text.setPlaceholder('Vault/folder/')
					.setValue(this.target)
					.onChange((value) => {
						this.target = value;
					});
				// Width comes from styles.css
				text.inputEl.addClass('cross-vault-sync-path-input');
			});

		new Setting(contentEl)
			.addButton((button) => {
				button.setButtonText('Cancel').onClick(() => this.close());
			})
			.addButton((button) => {
				button.setButtonText('Add and sync')
					.setCta()
					.onClick(async () => {
						if (await this.addAndSync()) this.close();
					});
			});
	}

	onClose(): void {
		this.contentEl.empty();
	}

	async addAndSync(): Promise<boolean> {
		const { plugin } = this;
		const entry = parseEntry(this.target);
		if (!entry) {
			new Notice('Enter a vault name and a path, such as vault/folder/note, or vault/folder/ for a folder.');
			return false;
		}
		const resolved = plugin.entries.resolveEntry(entry, this.activeFile.name);
		if (resolved.kind !== 'path') {
			new Notice(resolved.kind === 'invalid' ? 'The path must stay inside the vault or folder.' : vaultProblemMessage(resolved));
			return false;
		}
		if (!plugin.fullPath(this.activeFile)) return false;
		const targetEntry = entry.folder ? folderEntry(entry.name, entry.path) : noteEntry(entry.name, entry.path);
		const ownEntry = plugin.ownPath.entryFor(this.activeFile);
		const frontmatterKey = plugin.settings.frontmatterKey;
		// Entries that name the same file count once
		const keyOf = (raw: string) => {
			const file = plugin.entries.resolve(raw, this.activeFile.name);
			return file.kind === 'path' ? plugin.paths.key(file.fullPath) : raw;
		};

		// Subscribe before writing so the metadata update cannot slip past
		const metadataReady = waitForMetadata(this.app, this.activeFile);
		try {
			// processFrontMatter parses and re-serializes the YAML, so existing scalar, flow or block values are handled
			await this.app.fileManager.processFrontMatter(this.activeFile, (frontmatter: Record<string, unknown>) => {
				const merged: string[] = [];
				const seen = new Set<string>();
				for (const raw of [ownEntry, ...asList(frontmatter[frontmatterKey]), targetEntry]) {
					if (typeof raw !== 'string' || !raw.trim()) continue;
					const key = keyOf(raw.trim());
					if (seen.has(key)) continue;
					seen.add(key);
					merged.push(raw.trim());
				}
				frontmatter[frontmatterKey] = merged;
			});
		} catch (err) {
			new Notice(`Cross-Vault Sync: Could not update frontmatter: ${err instanceof Error ? err.message : String(err)}`);
			return false;
		}
		const folder = entry.folder ? entry.path : entry.path.slice(0, Math.max(0, entry.path.lastIndexOf('/')));
		this.app.saveLocalStorage(LAST_TARGET_KEY, folderEntry(entry.name, folder));

		// The sync reads targets from the metadata cache, which updates asynchronously after the write
		await metadataReady;
		new Notice('Sync target added. Syncing note...');
		await plugin.engine.syncFile(this.activeFile, true);
		return true;
	}
}
