import type { TFile } from 'obsidian';
import { isConflictBackup } from './conflict';
import { noteEntry, parseEntry, type Entry } from './entries';
import type { SyncHost } from './host';
import { errorCode, statOrNull, type FileWatcher } from './io';
import { hasUnsavedChanges } from './local-write';
import type { PathRules } from './paths';
import type { SyncEngine } from './sync';
import { asList, rawTargets, waitForMetadata } from './targets';

// A note with this name in a folder is the manifest of that folder: the folder entries in its
// sync_targets mirror the whole folder tree, note by note, to those folders. The mirror entries are
// written into the frontmatter of every note of the folder, as with individually synced notes, so every
// note carries its own sync state and no state lives outside the notes.
export const MANIFEST_BASENAME = 'SYNC';

export function isManifestBasename(basename: string, paths: PathRules): boolean {
	return paths.nameKey(basename) === paths.nameKey(MANIFEST_BASENAME);
}

// The entry that mirrors a note's place relative to the manifest's folder into one of the target folders
export function derivedEntry(entry: Pick<Entry, 'name' | 'path'>, relative: string): string {
	return noteEntry(entry.name, entry.path ? `${entry.path}/${relative}` : relative);
}

// Folds the manifests' entries into the sync_targets of the notes of their folders
export class FolderSync {
	// The value of the manifest's sync_targets the last apply used, per manifest path, so a re-index without
	// an edit does not re-apply the folder
	private readonly applied = new Map<string, string>();
	// The target folders of every manifest are watched, so a file another program makes there becomes a note
	private readonly targetWatchers = new Map<string, FileWatcher>();
	// The debounced run of reconcileTargets
	private pullTimer: number | null = null;

	constructor(private readonly host: SyncHost, private readonly engine: SyncEngine) {}

	close(): void {
		for (const watcher of this.targetWatchers.values()) {
			try {
				watcher.close();
			} catch {
				// already closed
			}
		}
		this.targetWatchers.clear();
		if (this.pullTimer !== null) {
			window.clearTimeout(this.pullTimer);
			this.pullTimer = null;
		}
	}

	isManifest(file: TFile): boolean {
		return isManifestBasename(file.basename, this.host.paths);
	}

	manifests(): TFile[] {
		return this.host.app.vault.getMarkdownFiles().filter((file) => this.isManifest(file));
	}

	// The manifest's path without its file name; '' for a manifest in the vault root
	private prefixOf(manifest: TFile): string {
		return manifest.path.slice(0, manifest.path.length - manifest.name.length);
	}

	// The manifests whose folder contains the path
	manifestsOf(path: string): TFile[] {
		const out: TFile[] = [];
		for (const manifest of this.manifests()) {
			if (path === manifest.path) continue;
			const prefix = this.prefixOf(manifest);
			if (path.startsWith(prefix)) out.push(manifest);
		}
		return out;
	}

	// The manifest's folder entries that resolve on this computer, with the folder each names. The others are
	// reported by the manifest's own sync
	targetsOf(manifest: TFile): { entry: Entry; dir: string }[] {
		const out: { entry: Entry; dir: string }[] = [];
		for (const raw of asList(rawTargets(this.host.app, manifest, this.host.settings.frontmatterKey))) {
			const entry = parseEntry(raw);
			if (!entry?.folder) continue;
			// A folder entry names the copy that has the manifest's name in the target folder; the folder is
			// the copy's parent
			const resolved = this.host.entries.resolveEntry(entry, manifest.name);
			if (resolved.kind !== 'path') continue;
			out.push({ entry, dir: this.host.paths.path.dirname(resolved.fullPath) });
		}
		return out;
	}

	// Catch-up when the vault opens: the notes carry the entries, so a complete folder reads and writes nothing
	async initialApply(): Promise<void> {
		if (this.host.isUnloaded()) return;
		for (const manifest of this.manifests()) await this.applyFolder(manifest);
		// The target trees are pulled and watched too, for a folder whose notes are already complete
		this.scheduleReconcile();
	}

	// A note appeared: a new manifest starts syncing its folder, a new note gets the entries
	async onCreate(file: TFile): Promise<void> {
		if (this.host.isUnloaded()) return;
		if (this.isManifest(file)) {
			await this.applyFolder(file);
			return;
		}
		if (await this.applyToNote(file)) await this.syncAfterApply(file);
	}

	// A note moved in or out of a manifest's folder, or became the manifest of its folder
	async onRename(file: TFile, oldPath: string): Promise<void> {
		if (this.host.isUnloaded()) return;
		const oldName = this.host.paths.path.basename(oldPath, '.md');
		if (this.isManifest(file) && !isManifestBasename(oldName, this.host.paths)) {
			await this.applyFolder(file);
			return;
		}
		if (await this.applyToNote(file, oldPath)) await this.syncAfterApply(file);
	}

	// The manifest's list changed: the entries of the whole folder are re-checked
	async onManifestChanged(manifest: TFile): Promise<void> {
		if (this.host.isUnloaded()) return;
		const value = this.listOf(manifest);
		if (value === this.applied.get(manifest.path)) return;
		await this.applyFolder(manifest);
	}

	// Every note under the manifest's folder gets the manifest's entries. A written note syncs with the
	// modify event its write fires, or with a manual sync
	async applyFolder(manifest: TFile): Promise<void> {
		const prefix = this.prefixOf(manifest);
		this.applied.set(manifest.path, this.listOf(manifest));
		// The target tree of the folder is pulled and watched, in both directions
		this.scheduleReconcile();
		// No folder target resolves on this computer, so nothing is mirrored: the notes are not managed
		if (this.targetsOf(manifest).length === 0) return;
		if (await this.isCopyOfAnotherManifest(manifest)) return;
		for (const file of this.host.app.vault.getMarkdownFiles()) {
			if (file.path === manifest.path || !file.path.startsWith(prefix)) continue;
			await this.applyToNote(file);
		}
	}

	// The write of the entries fires modify before the metadata cache has re-parsed the note, whose sync
	// would still see the old list. Wait for the re-parse, then sync the note itself
	private async syncAfterApply(file: TFile): Promise<void> {
		await waitForMetadata(this.host.app, file);
		await this.engine.syncFile(file);
	}

	// The target tree or the manifest changed: pull the trees and refresh the watchers. Debounced, because
	// one change by another program lands as several file events
	private scheduleReconcile(): void {
		if (this.pullTimer !== null) window.clearTimeout(this.pullTimer);
		this.pullTimer = window.setTimeout(() => {
			this.pullTimer = null;
			void this.reconcileTargets();
		}, this.host.settings.debounceMs);
	}

	// The mirror runs both ways: every file of the target folders that has no note in the manifest's folder
	// becomes one, and the folders stay watched for the next change
	async reconcileTargets(): Promise<void> {
		for (const manifest of this.manifests()) {
			if (await this.isCopyOfAnotherManifest(manifest)) continue;
			for (const { dir } of this.targetsOf(manifest)) await this.pullDir(dir, '', this.prefixOf(manifest));
		}
		await this.updateTargetWatchers();
	}

	// The files under dir that map to a missing note under prefix: a note is created with the file's
	// content, and its create event gives it the entries and syncs it
	private async pullDir(dir: string, rel: string, prefix: string): Promise<void> {
		let names: string[];
		try {
			names = await this.host.io.readdir(dir);
		} catch {
			return; // the target folder is missing on this computer
		}
		for (const name of names) {
			const full = this.host.paths.path.join(dir, name);
			const stat = await statOrNull(this.host.io, full);
			if (!stat) continue;
			const childRel = rel === '' ? name : `${rel}/${name}`;
			if (stat.isDirectory()) {
				await this.pullDir(full, childRel, prefix);
				continue;
			}
			if (!/\.md$/i.test(name) || isConflictBackup(name.replace(/\.md$/i, ''))) continue;
			const vaultPath = prefix + childRel;
			if (this.host.app.vault.getAbstractFileByPath(vaultPath) !== null) continue;
			await this.pullFile(full, vaultPath);
		}
	}

	private async pullFile(full: string, vaultPath: string): Promise<void> {
		let content: string;
		try {
			content = await this.host.io.readFile(full);
		} catch {
			return; // the file vanished between the listing and the read
		}
		try {
			await this.createInVault(vaultPath, content);
		} catch (err) {
			console.error('Cross-Vault Sync: Failed to pull a note from a target folder', err);
		}
	}

	// Obsidian creates a note only in an existing folder
	private async createInVault(vaultPath: string, content: string): Promise<void> {
		const missing: string[] = [];
		let parent = vaultPath.lastIndexOf('/') > 0 ? vaultPath.slice(0, vaultPath.lastIndexOf('/')) : '';
		while (parent !== '') {
			if (this.host.app.vault.getAbstractFileByPath(parent) === null) missing.push(parent);
			parent = parent.lastIndexOf('/') > 0 ? parent.slice(0, parent.lastIndexOf('/')) : '';
		}
		for (const folder of missing.reverse()) await this.host.app.vault.createFolder(folder);
		await this.host.app.vault.create(vaultPath, content);
	}

	// One watcher per directory of the target folders: any change there pulls the tree again
	private async updateTargetWatchers(): Promise<void> {
		const wanted = new Set<string>();
		for (const manifest of this.manifests()) {
			if (await this.isCopyOfAnotherManifest(manifest)) continue;
			for (const { dir } of this.targetsOf(manifest)) await this.watchTree(dir, wanted);
		}
		for (const [dirKey, watcher] of [...this.targetWatchers]) {
			if (wanted.has(dirKey)) continue;
			try {
				watcher.close();
			} catch {
				// already closed
			}
			this.targetWatchers.delete(dirKey);
		}
	}

	private async watchTree(dir: string, wanted: Set<string>): Promise<void> {
		const queue: string[] = [dir];
		while (queue.length > 0) {
			const current = queue.pop()!;
			const dirKey = this.host.paths.key(current);
			wanted.add(dirKey);
			if (!this.targetWatchers.has(dirKey)) {
				try {
					const watcher = this.host.io.watch(current, () => this.scheduleReconcile());
					// Without a listener, an 'error' (folder deleted, drive gone) is thrown as an uncaught exception
					watcher.on('error', (err) => {
						console.error('Cross-Vault Sync: Stopped watching target folder', current, err);
						try {
							watcher.close();
						} catch {
							// already closed
						}
						if (this.targetWatchers.get(dirKey) === watcher) this.targetWatchers.delete(dirKey);
					});
					this.targetWatchers.set(dirKey, watcher);
				} catch (err) {
					// A target folder absent on this computer may appear later: the next reconcile watches it then
					if (errorCode(err) === 'ENOENT') console.debug('Cross-Vault Sync: Target folder to watch does not exist', current);
					else console.error('Cross-Vault Sync: Could not watch target folder', current, err);
					continue;
				}
			}
			let names: string[];
			try {
				names = await this.host.io.readdir(current);
			} catch {
				continue;
			}
			for (const name of names) {
				const sub = this.host.paths.path.join(current, name);
				const stat = await statOrNull(this.host.io, sub);
				if (stat?.isDirectory()) queue.push(sub);
			}
		}
	}

	// The manifest's sync_targets value, as stored in the applied table
	private listOf(manifest: TFile): string {
		return JSON.stringify(rawTargets(this.host.app, manifest, this.host.settings.frontmatterKey));
	}

	// A manifest whose list names an existing note of the same name elsewhere is the copy of another
	// manifest's mirror: the copy carries the original's list. It never manages the notes of its folder,
	// as a copy of any note is never synced
	private async isCopyOfAnotherManifest(manifest: TFile): Promise<boolean> {
		const { host } = this;
		const localKey = host.paths.key(host.fullPath(manifest));
		for (const raw of asList(rawTargets(host.app, manifest, host.settings.frontmatterKey))) {
			const entry = parseEntry(raw);
			if (entry === null || entry.folder) continue;
			const resolved = host.entries.resolveEntry(entry, manifest.name);
			if (resolved.kind !== 'path') continue;
			if (host.paths.key(resolved.fullPath) === localKey) continue;
			if (host.paths.nameKey(host.paths.path.basename(resolved.fullPath, '.md')) !== host.paths.nameKey(manifest.basename)) continue;
			if (await statOrNull(host.io, resolved.fullPath)) return true;
		}
		return false;
	}

	// The note's own entry and the manifests' mirror entries in the note's sync_targets. oldPath is the
	// note's path before a move, whose mirror entries are replaced. Returns whether the list changed.
	async applyToNote(note: TFile, oldPath: string | null = null): Promise<boolean> {
		const { host } = this;
		if (isConflictBackup(note.basename)) return false;
		const localFullPath = host.fullPath(note);
		if (!localFullPath) return false;
		const manifests = new Map<string, TFile>();
		for (const path of [note.path, ...(oldPath !== null && oldPath !== note.path ? [oldPath] : [])]) {
			for (const manifest of this.manifestsOf(path)) {
				// The copy of another manifest's mirror manages no notes, so it gives no entries
				if (manifests.has(manifest.path) || (await this.isCopyOfAnotherManifest(manifest))) continue;
				manifests.set(manifest.path, manifest);
			}
		}
		if (manifests.size === 0) return false;
		if (await this.isCopyOfAnother(note)) return false;

		const frontmatterKey = host.settings.frontmatterKey;
		const own = noteEntry(host.app.vault.getName(), note.path);
		const derived = new Map<string, string>();
		const stale = new Set<string>();
		for (const manifest of manifests.values()) {
			const prefix = this.prefixOf(manifest);
			const relative = note.path.startsWith(prefix)
				? note.path.slice(prefix.length).replace(/\.md$/, '')
				: null;
			const oldRelative = oldPath !== null && oldPath.startsWith(prefix)
				? oldPath.slice(prefix.length).replace(/\.md$/, '')
				: null;
			for (const { entry } of this.targetsOf(manifest)) {
				if (relative !== null) {
					const mirror = derivedEntry(entry, relative);
					derived.set(this.keyOf(mirror, note.name), mirror);
				}
				if (oldRelative !== null) stale.add(this.keyOf(derivedEntry(entry, oldRelative), note.name));
			}
		}

		const current = asList(rawTargets(host.app, note, frontmatterKey));
		if (JSON.stringify(this.merge(own, derived, stale, current, note.name)) === JSON.stringify(current)) return false;

		// A write is expected: never rewrite a note the user is still typing in
		const content = await host.app.vault.read(note);
		if (hasUnsavedChanges(host, note, content)) return false;
		try {
			await host.app.fileManager.processFrontMatter(note, (frontmatter: Record<string, unknown>) => {
				// The list may have changed while this ran
				frontmatter[frontmatterKey] = this.merge(own, derived, stale, asList(frontmatter[frontmatterKey]), note.name);
			});
		} catch (err) {
			console.error('Cross-Vault Sync: Failed to add the folder entries to a note', err);
			return false;
		}
		return true;
	}

	// A list that names an existing note in this vault belongs to a copy (conflict backup, OneDrive copy,
	// duplicate) and is left alone, as the own-path handler leaves it
	private async isCopyOfAnother(note: TFile): Promise<boolean> {
		const { host } = this;
		const localKey = host.paths.key(host.fullPath(note));
		const { targets, fileTargets } = this.engine.targetsOf(note);
		if (fileTargets.has(localKey)) return false;
		const vaultPrefix = host.paths.key(host.vaultBasePath()) + host.paths.path.sep;
		for (const target of targets) {
			if (host.paths.key(target).startsWith(vaultPrefix) && (await statOrNull(host.io, target))) return true;
		}
		return false;
	}

	// own first, then the note's entries, then the mirror entries. Entries that name the same file count
	// once; the mirror entries of a note's old place are removed
	private merge(own: string, derived: Map<string, string>, stale: Set<string>, current: unknown[], noteName: string): unknown[] {
		const merged: unknown[] = [];
		const seen = new Set<string>();
		const add = (raw: unknown): void => {
			merged.push(raw);
			if (typeof raw === 'string' && raw.trim() !== '') seen.add(this.keyOf(raw, noteName));
		};
		add(own);
		for (const raw of current) {
			if (typeof raw === 'string' && raw.trim() !== '') {
				const key = this.keyOf(raw, noteName);
				if (stale.has(key) || seen.has(key)) continue;
			}
			add(raw);
		}
		for (const raw of derived.values()) {
			if (!seen.has(this.keyOf(raw, noteName))) add(raw);
		}
		return merged;
	}

	// The file an entry names, comparable across computers; an entry no vault here names is kept under its text
	private keyOf(entry: string, noteName: string): string {
		const parsed = parseEntry(entry);
		const resolved = parsed ? this.host.entries.resolveEntry(parsed, noteName) : null;
		return resolved?.kind === 'path' ? this.host.paths.key(resolved.fullPath) : entry;
	}
}
