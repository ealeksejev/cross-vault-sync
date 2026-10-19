import { Notice } from 'obsidian';
import type { CopyFiles } from './copies';
import { errorCode } from './io';
import type { SyncHost } from './host';

// A backup's name ends in ".sync-conflict-" and eight hex digits. A backup carries the list of the note it
// came from and is never synced itself.
export function isConflictBackup(basename: string): boolean {
	return /\.sync-conflict-[0-9a-f]{8}$/.test(basename);
}

// Saves the losing version next to its copy. Named by content hash: racing instances in both vaults
// produce one backup, not two. Returns false when the backup could not be written.
export async function backupConflict(host: SyncHost, files: CopyFiles, filePath: string, content: string): Promise<boolean> {
	const { path } = host.paths;
	const ext = path.extname(filePath);
	const baseName = path.basename(filePath, ext);
	const conflictPath = path.join(path.dirname(filePath), `${baseName}.sync-conflict-${host.hash(content).slice(0, 8)}${ext}`);
	try {
		await files.create(conflictPath, content);
		new Notice(`Cross-Vault Sync: Conflict backup saved as ${path.basename(conflictPath)}`);
		return true;
	} catch (err) {
		if (errorCode(err) === 'EEXIST') return true;
		console.error('Cross-Vault Sync: Failed to save conflict backup', err);
		return false;
	}
}
