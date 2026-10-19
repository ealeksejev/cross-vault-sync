import { Notice, type TFile } from 'obsidian';
import { isConflictBackup } from './conflict';
import { noteEntry, parseEntry, type Entry } from './entries';
import type { SyncHost } from './host';
import { statOrNull } from './io';
import type { SyncEngine } from './sync';
import { asList, rawTargets } from './targets';

// Keeps the note's own entry in sync_targets: adds it when the user lists only other locations,
// and points it at the new location after a move. The copies keep their own names.
export class OwnPath {
	private lastTargets: { path: string; value: string } | null = null;

	constructor(private readonly host: SyncHost, private readonly engine: SyncEngine) {}

	// Remembers the active note's sync_targets value. Returns true when the value changed since the
	// previous call for the same note, i.e. the list was edited while the note was open.
	remember(file: TFile): boolean {
		const value = JSON.stringify(rawTargets(this.host.app, file, this.host.settings.frontmatterKey));
		const changed = this.lastTargets !== null && this.lastTargets.path === file.path && this.lastTargets.value !== value;
		this.lastTargets = { path: file.path, value };
		return changed;
	}

	// Adds the note's own entry when sync_targets names only other locations. A list that names an existing
	// note in this vault belongs to a copy (conflict backup, OneDrive copy, duplicate) and is left alone. That
	// includes this note named by a folder entry, which names whatever note of this name is in that folder.
	async addIfMissing(file: TFile): Promise<void> {
		const { host } = this;
		const localFullPath = host.fullPath(file);
		if (!localFullPath || isConflictBackup(file.basename)) return;
		const localKey = host.paths.key(localFullPath);
		const { targets, fileTargets } = this.engine.targetsOf(file);
		if (targets.length === 0 || fileTargets.has(localKey)) return;

		const vaultPrefix = host.paths.key(host.vaultBasePath()) + host.paths.path.sep;
		for (const target of targets) {
			if (host.paths.key(target).startsWith(vaultPrefix) && (await statOrNull(host.io, target))) return;
		}

		const frontmatterKey = host.settings.frontmatterKey;
		const ownEntry = this.entryFor(file);
		try {
			await host.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
				// The list may have changed while the targets were checked
				const entries = asList(frontmatter[frontmatterKey]);
				if (entries.length === 0) return;
				if (entries.some((entry) => this.ownKeyOf(parseEntry(entry)) === localKey)) return;
				frontmatter[frontmatterKey] = [ownEntry, ...entries];
			});
		} catch (err) {
			console.error('Cross-Vault Sync: Failed to add own path to sync_targets', err);
			new Notice(`Cross-Vault Sync: Could not add this note's own path to ${frontmatterKey}.`);
		}
	}

	// The entry that named the note's old location names the new one
	async handleRename(file: TFile, oldPath: string): Promise<void> {
		const { host } = this;
		const basePath = host.vaultBasePath();
		if (!basePath) return;
		const oldKey = host.paths.key(host.paths.path.resolve(basePath, oldPath));
		const frontmatterKey = host.settings.frontmatterKey;
		const namedOld = (entry: Entry | null) => this.ownKeyOf(entry) === oldKey;
		// A copy (conflict backup, duplicate) does not list itself, and its rename changes nothing
		if (!asList(rawTargets(host.app, file, frontmatterKey, oldPath)).some((raw) => namedOld(parseEntry(raw)))) return;

		try {
			await host.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
				frontmatter[frontmatterKey] = asList(frontmatter[frontmatterKey]).map((raw) => {
					const entry = parseEntry(raw);
					return entry && namedOld(entry) ? noteEntry(entry.name, file.path) : raw;
				});
			});
		} catch (err) {
			console.error('Cross-Vault Sync: Failed to update sync_targets after rename', err);
			new Notice(`Cross-Vault Sync: Could not update ${frontmatterKey} after moving "${file.basename}". Update its own entry manually.`);
		}
	}

	// The note's own entry: its vault name and path, as "Copy path > From vault folder" gives the path
	entryFor(file: TFile): string {
		return noteEntry(this.host.app.vault.getName(), file.path);
	}

	// The file that a file entry names. A folder entry gives a copy this note's name and never names the note
	// itself: in that folder it would name any note of that name, such as a conflict backup or a duplicate.
	private ownKeyOf(entry: Entry | null): string | null {
		const resolved = entry && !entry.folder ? this.host.entries.resolveEntry(entry, '') : null;
		return resolved?.kind === 'path' ? this.host.paths.key(resolved.fullPath) : null;
	}
}
