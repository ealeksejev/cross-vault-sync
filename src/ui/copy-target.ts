import { Notice, TFile, TFolder, type Menu, type TAbstractFile } from 'obsidian';
import { folderEntry, noteEntry } from '../entries';

// The entry that names a note or folder of this vault, ready to paste into another note's sync_targets.
// A folder entry gives the copy the note's own name.
export function targetEntryOf(file: TAbstractFile, vaultName: string): string | null {
	if (file instanceof TFolder) return folderEntry(vaultName, file.isRoot() ? '' : file.path);
	return file instanceof TFile && file.extension === 'md' ? noteEntry(vaultName, file.path) : null;
}

// "Copy sync target" in the file menu of notes and folders
export function addCopyTargetItem(menu: Menu, file: TAbstractFile, vaultName: string): void {
	const entry = targetEntryOf(file, vaultName);
	if (!entry) return;
	menu.addItem((item) => {
		item.setTitle('Copy sync target')
			.setIcon('copy')
			.onClick(async () => {
				try {
					await navigator.clipboard.writeText(entry);
					new Notice(`Copied ${entry}`);
				} catch (err) {
					new Notice(`Cross-Vault Sync: Could not copy ${entry}: ${err instanceof Error ? err.message : String(err)}`);
				}
			});
	});
}
