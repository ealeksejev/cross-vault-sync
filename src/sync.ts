import { Notice, type TFile } from 'obsidian';
import { backupConflict, isConflictBackup } from './conflict';
import { CopyFiles } from './copies';
import { decide, type Candidate } from './decide';
import { noteEntry, parseEntry, vaultProblemMessage } from './entries';
import { ErrorReporter, LoopGuard } from './guards';
import { readHeader, withoutHeader, writeHeader } from './header';
import type { SyncHost } from './host';
import { errorCode, statOrNull, type ExistingCopy, type MissingCopy } from './io';
import { hasUnsavedChanges, writeLocal } from './local-write';
import { MIN_DEBOUNCE_MS } from './settings';
import { asList, readTargets, type ListedEntry } from './targets';

type Existing = ExistingCopy & { key: string; candidate: Candidate };
type Missing = MissingCopy & { key: string };

export class SyncEngine {
	readonly debounceTimers = new Map<string, number>();
	readonly syncQueues = new Map<string, Promise<void>>();
	readonly loopGuard = new LoopGuard();
	readonly errors: ErrorReporter;
	readonly files: CopyFiles;

	constructor(private readonly host: SyncHost) {
		this.errors = new ErrorReporter(host);
		this.files = new CopyFiles(host);
	}

	unload(): void {
		for (const timer of this.debounceTimers.values()) window.clearTimeout(timer);
		this.debounceTimers.clear();
	}

	schedule(file: TFile): void {
		if (this.host.isUnloaded()) return;
		const filePath = file.path;
		const pending = this.debounceTimers.get(filePath);
		if (pending !== undefined) window.clearTimeout(pending);
		const timer = window.setTimeout(() => {
			this.debounceTimers.delete(filePath);
			void this.syncFile(file, false);
		}, Math.max(MIN_DEBOUNCE_MS, this.host.settings.debounceMs));
		this.debounceTimers.set(filePath, timer);
	}

	// Serializes syncs per note: focus, file-open, watcher and modify events can all fire within milliseconds
	syncFile(file: TFile, manual = false): Promise<void> {
		const key = file.path;
		const previous = this.syncQueues.get(key);
		// Assigned before the async body first resumes, which is when it compares against it
		let run!: Promise<void>;
		run = (async () => {
			// A queued run never rejects, so waiting for it cannot throw
			await previous;
			try {
				await this.syncNow(file, manual);
			} catch (err) {
				console.error('Cross-Vault Sync: Sync failed', err);
			} finally {
				if (this.syncQueues.get(key) === run) this.syncQueues.delete(key);
			}
		})();
		this.syncQueues.set(key, run);
		return run;
	}

	async syncAll(manual = false): Promise<void> {
		let totalCount = 0;
		for (const file of this.host.app.vault.getMarkdownFiles()) {
			if (this.targetsOf(file).targets.length > 0) {
				await this.syncFile(file, false);
				totalCount++;
			}
		}
		if (manual) new Notice(`Cross-Vault Sync: Checked ${totalCount} note(s) with sync_targets.`);
	}

	targetsOf(file: TFile, oldPath?: string) {
		return readTargets(this.host.app, file, this.host.settings.frontmatterKey, this.host.entries, oldPath);
	}

	private candidate(isLocal: boolean, key: string, fullPath: string, content: string, mtime: number): Candidate {
		const { hash } = this.host;
		return { isLocal, key, fullPath, content, hash: hash(content), bodyHash: hash(withoutHeader(content)), header: readHeader(content), mtime };
	}

	private async syncNow(file: TFile, manual: boolean): Promise<void> {
		const { host } = this;
		if (host.isUnloaded()) return;
		// The note may have been deleted while this sync was queued or debounced
		if (host.app.vault.getAbstractFileByPath(file.path) !== file) return;
		if (!manual && this.loopGuard.isPaused(file.path)) return;
		if (isConflictBackup(file.basename)) {
			if (manual) new Notice('Cross-Vault Sync: This note is a conflict backup. Backups are never synced.');
			return;
		}

		const localFullPath = host.fullPath(file);
		if (!localFullPath) return;
		const localKey = host.paths.key(localFullPath);
		const frontmatterKey = host.settings.frontmatterKey;

		const { targets, ignored, problems, folderTargets, fileTargets, listed } = this.targetsOf(file);
		if (manual && ignored > 0) {
			new Notice(`Cross-Vault Sync: Ignored ${ignored} ${frontmatterKey} entr${ignored === 1 ? 'y' : 'ies'}. Write entries like Vault/folder/note, or Vault/folder/ for a folder.`);
		}
		if (manual) for (const problem of problems) new Notice(vaultProblemMessage(problem));
		if (targets.length === 0) {
			if (manual && ignored === 0 && problems.length === 0) new Notice(`No ${frontmatterKey} configured in note frontmatter.`);
			return;
		}
		// Conflict backups, OneDrive/Obsidian Sync conflict copies, duplicated or moved notes all carry the
		// original's list. Syncing them would push stale content over the real copies, so a file entry must name
		// the note itself. A folder entry names whatever note of this name is in that folder.
		if (!fileTargets.has(localKey)) {
			if (manual) new Notice(`Cross-Vault Sync: This note's own path is not listed in ${frontmatterKey}, so it is treated as a copy and not synced.`);
			return;
		}

		let local: Candidate;
		try {
			const content = await host.app.vault.read(file);
			const stat = await statOrNull(host.io, localFullPath);
			local = this.candidate(true, localKey, localFullPath, content, stat ? stat.mtimeMs : file.stat.mtime);
		} catch (err) {
			console.error('Cross-Vault Sync: Failed to read local file', err);
			return;
		}

		// Read every copy before deciding anything, so one winner is chosen for the whole group
		const existing: Existing[] = [];
		const missing: Missing[] = [];
		let complete = true;
		for (const target of targets) {
			const key = host.paths.key(target);
			if (key === localKey) continue;
			try {
				const copy = await this.files.read(target);
				if (copy.exists) existing.push({ ...copy, key, candidate: this.candidate(false, key, copy.fullPath, copy.content, copy.mtime) });
				else missing.push({ ...copy, key });
			} catch (err) {
				complete = false;
				// Being written: decide again once the write is done
				if (errorCode(err) === 'ECHANGED') this.schedule(file);
				else this.errors.report(target, err, manual);
			}
		}

		const candidates: [Candidate, ...Candidate[]] = [local, ...existing.map((c) => c.candidate)];
		const { winner, losers, version } = decide(candidates);

		// A missing copy that sync_known lists had been created and was deleted on purpose. Only a manual sync
		// creates it again.
		const known = this.knownBefore(candidates, file.name);
		const deleted = manual ? [] : missing.filter((c) => known.keys.has(c.key));
		const toCreate: Missing[] = [];
		for (const copy of missing) {
			if (!deleted.includes(copy) && (await this.creatable(copy, folderTargets, manual))) toCreate.push(copy);
		}

		// A new copy goes into sync_known once it exists. It is created with the entries that had a copy before,
		// so a create that fails never makes its entry look like a copy that was deleted.
		const kept = new Set([localKey, ...existing.map((c) => c.key), ...deleted.map((c) => c.key)]);
		const withKnown = (present: Set<string>) => writeHeader(winner.content, { version, hash: winner.bodyHash, known: this.knownAfter(listed, present, known.entries) });
		const planned = withKnown(new Set([...kept, ...toCreate.map((c) => c.key)]));
		const localChanges = planned !== local.content;

		// Never sync a note the user is still typing in, in either direction: a copy's version is not pulled into
		// it, and its own version is not pushed without the sync fields it must get with it. The save that
		// follows triggers a new sync.
		if (localChanges && hasUnsavedChanges(host, file, local.content)) return;

		if ((localChanges || toCreate.length > 0 || existing.some((c) => c.content !== planned)) && !manual) {
			if (this.loopGuard.record(file.path, file.name, winner.isLocal ? 'push' : 'pull')) return;
		}

		if (losers.length > 0) {
			if (host.settings.createConflictBackup) {
				for (const loser of losers) {
					if (!(await backupConflict(host, this.files, loser.fullPath, loser.content))) {
						new Notice('Cross-Vault Sync: Could not save a conflict backup, so nothing was overwritten.');
						return;
					}
				}
			}
			if (manual || host.settings.showNotices) {
				new Notice(`Cross-Vault Sync: "${file.basename}" was edited in more than one place. Kept the newest version.`);
			}
		}

		let syncedCount = 0;
		const createdKeys: string[] = [];

		for (const copy of toCreate) {
			try {
				await this.files.create(copy.fullPath, withKnown(kept));
				createdKeys.push(copy.key);
				syncedCount++;
				if (host.settings.showNotices) new Notice(`Cross-Vault Sync: Created target file ${host.paths.path.basename(copy.fullPath)}`);
			} catch (err) {
				complete = false;
				// Appeared in the meantime: decide again instead of overwriting it
				if (errorCode(err) === 'EEXIST') this.schedule(file);
				else this.errors.report(copy.fullPath, err, manual);
			}
		}

		// A write that changes only the sync fields keeps the file's modification time, which stays the time of
		// its last edit: a conflict must not take the plugin's own write for a newer edit.
		const content = withKnown(new Set([...kept, ...createdKeys]));
		if (content !== local.content) {
			let written: boolean;
			try {
				written = await writeLocal(host, file, local.hash, content, winner.bodyHash === local.bodyHash ? local.mtime : undefined);
			} catch (err) {
				this.errors.report(localFullPath, err, manual);
				return;
			}
			if (!written) {
				// The note changed since it was read: back off and decide again
				this.schedule(file);
				return;
			}
			if (winner.bodyHash !== local.bodyHash) syncedCount++;
		}

		for (const copy of existing) {
			if (copy.content === content) continue;
			try {
				if (!(await this.files.replace(copy, content, copy.candidate.bodyHash === winner.bodyHash ? copy.mtime : undefined))) {
					// Edited while this sync was running: decide again instead of overwriting it
					complete = false;
					this.schedule(file);
					continue;
				}
				syncedCount++;
			} catch (err) {
				complete = false;
				this.errors.report(copy.fullPath, err, manual);
			}
		}

		if (complete) {
			const written = new Set([localKey, ...existing.map((c) => c.key), ...createdKeys]);
			if ([...folderTargets].some((key) => written.has(key))) await this.pinFolderEntries(file, written);
		}

		if (manual) {
			if (syncedCount > 0) new Notice(`Cross-Vault Sync: Synchronized ${syncedCount} target(s).`);
			else if (complete) new Notice('Cross-Vault Sync: Note is already in sync.');
		}
	}

	// sync_known of the copies of the newest version: the entries as written, and the files they name here
	private knownBefore(candidates: Candidate[], noteName: string): { entries: Set<string>; keys: Set<string> } {
		const latest = Math.max(...candidates.map((c) => c.header?.version ?? 0));
		const entries = new Set<string>();
		const keys = new Set<string>();
		for (const { header } of candidates) {
			if (!header || header.version !== latest) continue;
			for (const entry of header.known) {
				entries.add(entry);
				const resolved = this.host.entries.resolve(entry, noteName);
				if (resolved.kind === 'path') keys.add(this.host.paths.key(resolved.fullPath));
			}
		}
		return { entries, keys };
	}

	// sync_known after this sync, in list order: the entries whose copy exists or was deleted on purpose. An
	// entry whose vault has no folder on this computer keeps its place when sync_known had it. Otherwise
	// computers with different vault folders would rewrite each other's copies.
	private knownAfter(listed: ListedEntry[], present: Set<string>, before: Set<string>): string[] {
		const known: string[] = [];
		const keys = new Set<string>();
		for (const { file, key } of listed) {
			if (known.includes(file) || (key !== null && keys.has(key))) continue;
			if (key === null ? !before.has(file) : !present.has(key)) continue;
			known.push(file);
			if (key !== null) keys.add(key);
		}
		return known;
	}

	// A copy is created only in a folder that exists. "Vault/Folder" without the trailing slash names the note
	// "Folder.md". Next to an existing folder of that name it is a missing slash, and creating the note would not
	// put the copy where it was meant.
	private async creatable(copy: Missing, folderTargets: Set<string>, manual: boolean): Promise<boolean> {
		const { host } = this;
		const dir = host.paths.path.dirname(copy.fullPath);
		const dirStat = await statOrNull(host.io, dir);
		if (!dirStat || !dirStat.isDirectory()) {
			// Never mkdir -p: the folder may belong to a vault or OneDrive account that is absent on this machine
			if (manual) new Notice(`Cross-Vault Sync: Folder does not exist: ${dir}`);
			else console.warn('Cross-Vault Sync: Target folder does not exist', dir);
			return false;
		}
		const asFolder = copy.fullPath.replace(/\.md$/, '');
		if (!folderTargets.has(copy.key) && (await statOrNull(host.io, asFolder))?.isDirectory()) {
			const message = `Cross-Vault Sync: ${asFolder} is a folder. End its ${host.settings.frontmatterKey} entry with / to sync into it.`;
			if (manual) new Notice(message);
			else console.warn(message);
			return false;
		}
		return true;
	}

	// A folder entry only says where the copy goes the first time. Once the copy exists, the entry names the
	// exact file, so the copies can be renamed independently later. The change reaches the copies with the
	// sync that the edit starts.
	private async pinFolderEntries(file: TFile, present: Set<string>): Promise<void> {
		const { host } = this;
		const frontmatterKey = host.settings.frontmatterKey;
		try {
			await host.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
				frontmatter[frontmatterKey] = asList(frontmatter[frontmatterKey]).map((raw) => {
					const entry = parseEntry(raw);
					if (!entry?.folder) return raw;
					const resolved = host.entries.resolveEntry(entry, file.name);
					if (resolved.kind !== 'path' || !present.has(host.paths.key(resolved.fullPath))) return raw;
					return noteEntry(entry.name, [entry.path, file.name].filter(Boolean).join('/'));
				});
			});
		} catch (err) {
			console.error('Cross-Vault Sync: Failed to replace folder entries with file entries', err);
		}
	}
}
