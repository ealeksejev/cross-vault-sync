import { TFile, normalizePath } from 'obsidian';
import type { SyncHost } from './host';
import { readCopy, statOrNull, unchangedSince, writeWithRetry, type ExistingCopy, type MissingCopy } from './io';
import { writeLocal } from './local-write';

// Reads and writes copies and backups. A file in this vault goes through Obsidian's Vault API, as Obsidian's
// plugin guidelines ask: Obsidian runs its file operations one after another, so a read never sees a write
// half done, Obsidian learns of a change at once, and a copy open in the editor is changed through it. Files
// in other vaults and in folders outside the vaults are read and written with Node.js.
export class CopyFiles {
	constructor(private readonly host: SyncHost) {}

	// The path of a file in this vault, relative to the vault folder, or null for a file elsewhere. normalizePath
	// gives it the form of Obsidian's own paths, since the path comes from an entry the user wrote.
	vaultPath(fullPath: string): string | null {
		const { paths } = this.host;
		const base = this.host.vaultBasePath();
		if (!base) return null;
		const baseKey = paths.key(base);
		const prefix = baseKey.endsWith(paths.path.sep) ? baseKey : baseKey + paths.path.sep;
		if (!paths.key(fullPath).startsWith(prefix)) return null;
		return normalizePath(paths.path.relative(base, fullPath));
	}

	// The note in this vault at that path, when Obsidian knows it
	private vaultFile(fullPath: string): TFile | null {
		const rel = this.vaultPath(fullPath);
		const file = rel === null ? null : this.host.app.vault.getAbstractFileByPath(rel);
		return file instanceof TFile ? file : null;
	}

	async read(fullPath: string): Promise<ExistingCopy | MissingCopy> {
		const file = this.vaultFile(fullPath);
		if (!file) return readCopy(this.host.io, this.host.hash, fullPath);
		const content = await this.host.app.vault.read(file);
		const stat = await statOrNull(this.host.io, fullPath);
		return { exists: true, fullPath, content, hash: this.host.hash(content), mtime: stat ? stat.mtimeMs : file.stat.mtime, size: stat ? stat.size : file.stat.size };
	}

	// Creates the file. Fails with the code EEXIST when something is at that path already.
	async create(fullPath: string, content: string): Promise<void> {
		const rel = this.vaultPath(fullPath);
		if (rel === null) return writeWithRetry(this.host.io, fullPath, content, 'wx');
		try {
			await this.host.app.vault.create(rel, content);
		} catch (err) {
			// Obsidian's message when the path is taken (checked in Obsidian 1.13.4 and 1.14.4)
			if (err instanceof Error && err.message === 'File already exists.') throw Object.assign(err, { code: 'EEXIST' });
			throw err;
		}
	}

	// Replaces a copy with what a sync decided. Returns false when the copy changed after it was read: then it
	// must not be overwritten, and the sync has to decide again. mtime, when given, stays its modification time.
	async replace(copy: ExistingCopy, content: string, mtime?: number): Promise<boolean> {
		const file = this.vaultFile(copy.fullPath);
		if (file) return writeLocal(this.host, file, copy.hash, content, mtime);
		if (!(await unchangedSince(this.host.io, copy))) return false;
		await writeWithRetry(this.host.io, copy.fullPath, content, 'w', mtime);
		return true;
	}
}
