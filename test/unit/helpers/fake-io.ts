import type { PlatformPath } from 'path';
import type { FileIo, FileStat, FileWatcher } from '../../../src/io';

// The synchronous part of obsidian-test-mocks' in-memory adapter that a mounted vault needs
export interface MountedAdapter {
	statSync__(normalizedPath: string): { type: 'file' | 'folder'; mtime: number; size: number } | null;
	readSync__(normalizedPath: string): string;
	writeSync__(normalizedPath: string, data: string, options?: { mtime?: number }): void;
}

export interface FakeWatcher extends FileWatcher {
	dir: string;
	closed: boolean;
	throwOnClose: boolean;
	listener: (eventType: string, filename: string | null) => void;
	emitError(err: Error): void;
}

// Hooks run inside the fake calls, so a test can inject an error or a concurrent change at that moment
export interface FakeIoHooks {
	stat?: (fullPath: string) => void;
	readFile?: (fullPath: string) => void;
	afterRead?: (fullPath: string) => void;
	beforeWrite?: (fullPath: string, flag: 'w' | 'wx') => void;
}

export function errno(code: string, fullPath: string): NodeJS.ErrnoException {
	const err: NodeJS.ErrnoException = new Error(`${code}: ${fullPath}`);
	err.code = code;
	return err;
}

interface Entry {
	mtimeMs: number;
	content: string;
}

// One disk for every vault of a test. Paths inside a mounted vault are stored in that vault's mock adapter,
// so Obsidian's view of the vault and the plugin's direct file access see the same files.
export class FakeIo implements FileIo {
	readonly writeLog: string[] = [];
	readonly watchers: FakeWatcher[] = [];
	hooks: FakeIoHooks = {};
	// When Obsidian reports a write into a vault: 'during' the rest of the plugin's sync, which is the order
	// that made a copy sync before the note that wrote it, or 'after' the sync has finished
	events: 'during' | 'after' = 'during';
	// Ahead of Date.now(), so every write made by a test or the plugin is newer than the vaults' initial files
	clock = Date.now() + 1_000_000;
	private readonly files = new Map<string, Entry>();
	private readonly dirs = new Set<string>();
	private readonly mounts: { key: string; base: string; adapter: MountedAdapter; onChange?: (rel: string) => void }[] = [];

	constructor(readonly path: PlatformPath, private readonly caseInsensitive: boolean) {}

	tick(): number {
		this.clock += 1000;
		return this.clock;
	}

	key(p: string): string {
		const resolved = this.path.resolve(p);
		return this.caseInsensitive ? resolved.toLowerCase() : resolved;
	}

	// Stores the vault's files in its adapter. Every write through the adapter, by Obsidian's Vault API or by
	// put(), gets this disk's clock and goes into the write log. onChange runs after a write from outside
	// Obsidian into the vault, as Obsidian's own file watcher reports it.
	mount(basePath: string, adapter: MountedAdapter, onChange?: (rel: string) => void): void {
		const writeSync = adapter.writeSync__.bind(adapter);
		adapter.writeSync__ = (normalizedPath, data, options) => {
			writeSync(normalizedPath, data, { ...options, mtime: options?.mtime ?? this.tick() });
			this.writeLog.push(this.path.resolve(basePath, ...normalizedPath.split('/')));
		};
		this.mounts.push({ key: this.key(basePath), base: this.path.resolve(basePath), adapter, onChange });
		this.addDir(this.path.dirname(basePath));
	}

	private mounted(fullPath: string): { adapter: MountedAdapter; rel: string; onChange?: (rel: string) => void } | null {
		const key = this.key(fullPath);
		for (const mount of this.mounts) {
			if (key === mount.key) return { adapter: mount.adapter, rel: '', onChange: mount.onChange };
			if (key.startsWith(mount.key + this.path.sep)) {
				const rel = this.path.relative(mount.base, this.path.resolve(fullPath)).split(this.path.sep).join('/');
				return { adapter: mount.adapter, rel, onChange: mount.onChange };
			}
		}
		return null;
	}

	addDir(dir: string): void {
		let current = this.path.resolve(dir);
		for (;;) {
			this.dirs.add(this.key(current));
			const parent = this.path.dirname(current);
			if (parent === current) return;
			current = parent;
		}
	}

	private isDir(fullPath: string): boolean {
		const mount = this.mounted(fullPath);
		if (mount) return mount.rel === '' || mount.adapter.statSync__(mount.rel)?.type === 'folder';
		return this.dirs.has(this.key(fullPath));
	}

	private entry(fullPath: string): Entry | null {
		const mount = this.mounted(fullPath);
		if (!mount) return this.files.get(this.key(fullPath)) ?? null;
		const stat = mount.adapter.statSync__(mount.rel);
		return stat?.type === 'file' ? { mtimeMs: stat.mtime, content: mount.adapter.readSync__(mount.rel) } : null;
	}

	// Writes a file directly, as another program would. Watchers of its folder see the change.
	put(fullPath: string, content: string, mtimeMs?: number): void {
		const resolved = this.path.resolve(fullPath);
		if (!this.isDir(this.path.dirname(resolved))) throw errno('ENOENT', resolved);
		const mtime = mtimeMs ?? this.tick();
		const mount = this.mounted(resolved);
		if (mount) {
			// The adapter's write logs it
			mount.adapter.writeSync__(mount.rel, content, { mtime });
			const { onChange, rel } = mount;
			if (onChange && this.events === 'during') queueMicrotask(() => onChange(rel));
			else if (onChange) window.setTimeout(() => onChange(rel), 0);
		} else {
			this.files.set(this.key(resolved), { mtimeMs: mtime, content });
			this.writeLog.push(resolved);
		}
		for (const watcher of this.watchers) {
			if (!watcher.closed && this.key(watcher.dir) === this.key(this.path.dirname(resolved))) {
				watcher.listener('change', this.path.basename(resolved));
			}
		}
	}

	content(fullPath: string): string | undefined {
		return this.entry(fullPath)?.content;
	}

	exists(fullPath: string): boolean {
		return this.entry(fullPath) !== null;
	}

	// External files only: delete vault files through the vault
	remove(fullPath: string): void {
		this.files.delete(this.key(fullPath));
	}

	mtime(fullPath: string): number {
		const entry = this.entry(fullPath);
		if (!entry) throw errno('ENOENT', fullPath);
		return entry.mtimeMs;
	}

	private ancestorIsFile(fullPath: string): boolean {
		let current = this.path.dirname(this.path.resolve(fullPath));
		for (;;) {
			if (this.entry(current)) return true;
			const parent = this.path.dirname(current);
			if (parent === current) return false;
			current = parent;
		}
	}

	async stat(fullPath: string): Promise<FileStat> {
		this.hooks.stat?.(this.path.resolve(fullPath));
		const entry = this.entry(fullPath);
		if (entry) return { mtimeMs: entry.mtimeMs, size: entry.content.length, isDirectory: () => false };
		if (this.isDir(fullPath)) return { mtimeMs: 0, size: 0, isDirectory: () => true };
		throw errno(this.ancestorIsFile(fullPath) ? 'ENOTDIR' : 'ENOENT', fullPath);
	}

	async readFile(fullPath: string): Promise<string> {
		this.hooks.readFile?.(this.path.resolve(fullPath));
		const entry = this.entry(fullPath);
		if (!entry) throw errno('ENOENT', fullPath);
		this.hooks.afterRead?.(this.path.resolve(fullPath));
		return entry.content;
	}

	async writeFile(fullPath: string, content: string, flag: 'w' | 'wx', mtimeMs?: number): Promise<void> {
		this.hooks.beforeWrite?.(this.path.resolve(fullPath), flag);
		if (flag === 'wx' && this.exists(fullPath)) throw errno('EEXIST', fullPath);
		this.put(fullPath, content, mtimeMs);
	}

	watch(dir: string, listener: (eventType: string, filename: string | null) => void): FakeWatcher {
		if (!this.isDir(dir)) throw errno('ENOENT', dir);
		const errorListeners: ((err: Error) => void)[] = [];
		const watcher: FakeWatcher = {
			dir,
			listener,
			closed: false,
			throwOnClose: false,
			close() {
				this.closed = true;
				if (this.throwOnClose) throw new Error('close failed');
			},
			on(_event, handler) {
				errorListeners.push(handler);
				return this;
			},
			emitError(err) {
				for (const handler of errorListeners) handler(err);
			},
		};
		this.watchers.push(watcher);
		return watcher;
	}

	openWatchers(): FakeWatcher[] {
		return this.watchers.filter((w) => !w.closed);
	}
}
