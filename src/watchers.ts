import type { TFile } from 'obsidian';
import type { SyncHost } from './host';
import type { FileWatcher } from './io';
import type { SyncEngine } from './sync';

// Watches the folders of the active note's targets and schedules a sync when a target changes
export class TargetWatchers {
	readonly watchers = new Map<string, FileWatcher>();
	private signature: string | null = null;

	constructor(private readonly host: SyncHost, private readonly engine: SyncEngine) {}

	close(): void {
		for (const watcher of this.watchers.values()) {
			try {
				watcher.close();
			} catch {
				// already closed
			}
		}
		this.watchers.clear();
		this.signature = null;
	}

	update(file: TFile, force: boolean): void {
		const { host } = this;
		const localFullPath = host.fullPath(file);
		const localKey = localFullPath ? host.paths.key(localFullPath) : '';
		const external = host.settings.autoSync && localKey
			? this.engine.targetsOf(file).targets.filter((t) => host.paths.key(t) !== localKey)
			: [];

		const signature = `${file.path}\n${external.map((t) => host.paths.key(t)).join('\n')}`;
		if (!force && signature === this.signature) return;
		this.close();
		this.signature = signature;

		// Watch each target's folder and filter by name. A watch on the file itself silently dies on
		// macOS/Linux when an editor saves atomically (write temp file, rename over the original).
		const byDir = new Map<string, { dir: string; names: Set<string> }>();
		for (const target of external) {
			const dir = host.paths.path.dirname(target);
			const dirKey = host.paths.key(dir);
			const entry = byDir.get(dirKey) ?? { dir, names: new Set<string>() };
			entry.names.add(host.paths.nameKey(host.paths.path.basename(target)));
			byDir.set(dirKey, entry);
		}

		for (const [dirKey, { dir, names }] of byDir) {
			try {
				const watcher = host.io.watch(dir, (_eventType, filename) => {
					if (host.isUnloaded() || !host.settings.autoSync) return;
					if (filename && !names.has(host.paths.nameKey(filename))) return;
					this.engine.schedule(file);
				});
				// Without a listener, an 'error' (folder deleted, drive gone) is thrown as an uncaught exception
				watcher.on('error', (err) => {
					console.warn('Cross-Vault Sync: Stopped watching folder', dir, err);
					try {
						watcher.close();
					} catch {
						// already closed
					}
					if (this.watchers.get(dirKey) === watcher) this.watchers.delete(dirKey);
				});
				this.watchers.set(dirKey, watcher);
			} catch (err) {
				console.warn('Cross-Vault Sync: Could not watch folder', dir, err);
			}
		}
	}
}
