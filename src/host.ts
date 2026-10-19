import type { App, TFile } from 'obsidian';
import type { EntryResolver } from './entries';
import type { FileIo, Hash } from './io';
import type { PathRules } from './paths';
import type { CrossVaultSyncSettings } from './settings';

// What the sync modules need from the plugin. CrossVaultSyncPlugin implements it. The sync state is not here:
// every copy carries its own in its frontmatter (see header.ts).
export interface SyncHost {
	readonly app: App;
	readonly settings: CrossVaultSyncSettings;
	readonly paths: PathRules;
	readonly entries: EntryResolver;
	readonly io: FileIo;
	readonly hash: Hash;
	isUnloaded(): boolean;
	vaultBasePath(): string;
	// Absolute path of a note in this vault, or '' when the vault has no folder on disk
	fullPath(file: TFile): string;
}
