import type { PathRules } from './paths';
import type { VaultFolders } from './vault-folders';

// A sync_targets entry: the name of a vault (or of a folder outside the vaults), a slash, and a path in it
// as "Copy path > From vault folder" gives it. A note path has no .md extension. A trailing slash makes the
// path a folder, and the copy in it has the note's own file name.
export interface Entry {
	name: string;
	path: string;
	folder: boolean;
}

// A name the entry starts with, whose folder on this computer is not known for sure
export interface VaultProblem {
	kind: 'missing-vault' | 'ambiguous-vault';
	vault: string;
}

// What a sync_targets entry points to on this computer
export type ResolvedEntry = { kind: 'path'; fullPath: string } | VaultProblem | { kind: 'invalid' };

export function parseEntry(entry: unknown): Entry | null {
	if (typeof entry !== 'string') return null;
	const text = entry.trim().replace(/\\/g, '/');
	// Absolute paths and URLs ("C:/...", "/home/...", "obsidian://...") are no entries
	if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return null;
	const slash = text.indexOf('/');
	if (slash <= 0) return null;
	const rest = text.slice(slash + 1);
	return { name: text.slice(0, slash).trim(), path: rest.replace(/\/+$/, ''), folder: rest === '' || rest.endsWith('/') };
}

export function noteEntry(name: string, notePath: string): string {
	return `${name}/${notePath.replace(/\.md$/, '')}`;
}

export function folderEntry(name: string, folderPath: string): string {
	return folderPath ? `${name}/${folderPath}/` : `${name}/`;
}

export function vaultProblemMessage(problem: VaultProblem): string {
	return problem.kind === 'missing-vault'
		? `Cross-Vault Sync: "${problem.vault}" has no folder on this computer. Open that vault here once with Cross-Vault Sync enabled, or add its folder in the settings.`
		: `Cross-Vault Sync: More than one folder on this computer belongs to a vault named "${problem.vault}". Add the right one in the settings.`;
}

// Turns entries into files on this computer. The folder of a name differs between computers and comes
// from this computer's table, except for this vault's own name.
export class EntryResolver {
	constructor(
		readonly paths: PathRules,
		private readonly folders: VaultFolders,
		private readonly ownVault: { name: string; folder: string }
	) {}

	// noteName is the file name of the note whose list this is, which a folder entry gives its copy
	resolve(entry: unknown, noteName: string): ResolvedEntry {
		const parsed = parseEntry(entry);
		return parsed ? this.resolveEntry(parsed, noteName) : { kind: 'invalid' };
	}

	resolveEntry(entry: Entry, noteName: string): ResolvedEntry {
		const folder = this.locate(entry.name);
		if (typeof folder !== 'string') return folder;
		// Copy path leaves out the .md extension of notes. Only the file path gets it, the entry stays as it is.
		const relative = entry.folder ? [entry.path, noteName].filter(Boolean).join('/') : entry.path.endsWith('.md') ? entry.path : `${entry.path}.md`;
		const fullPath = this.paths.path.join(folder, ...relative.split('/'));
		// ".." must not lead out of the vault
		const base = this.paths.key(folder);
		const prefix = base.endsWith(this.paths.path.sep) ? base : base + this.paths.path.sep;
		return this.paths.key(fullPath).startsWith(prefix) ? { kind: 'path', fullPath } : { kind: 'invalid' };
	}

	// The folder of a name on this computer. This vault's own name always means this vault, so its own entries
	// can never point elsewhere.
	locate(name: string): string | VaultProblem {
		if (this.ownVault.folder && this.paths.nameKey(name) === this.paths.nameKey(this.ownVault.name)) return this.ownVault.folder;
		const found = this.folders.lookup(name);
		if (!found) return { kind: 'missing-vault', vault: name };
		return 'folder' in found ? found.folder : { kind: 'ambiguous-vault', vault: name };
	}
}
