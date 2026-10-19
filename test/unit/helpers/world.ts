import { createHash } from 'crypto';
import * as nodePath from 'path';
import type { App as AppOriginal, TFile as TFileOriginal } from 'obsidian';
import { App, FileSystemAdapter, Notice, TFile } from 'obsidian-test-mocks/obsidian';
import { afterEach, beforeEach, expect, vi } from 'vitest';
import { readHeader, withoutHeader, writeHeader } from '../../../src/header';
import CrossVaultSyncPlugin from '../../../src/main';
import { PathRules, type PlatformName } from '../../../src/paths';
import { VaultFolders } from '../../../src/vault-folders';
import { FakeIo } from './fake-io';
import { services } from './services';

const win = nodePath.win32;
export const A_BASE = 'C:\\Users\\U\\Documents\\Vault A';
export const B_BASE = 'C:\\Users\\U\\OneDrive\\Vault B';
// A plain folder outside the vaults, named "Work" in the computer's table where a test needs it
export const C_BASE = 'C:\\Users\\U\\Work\\Folder C';
export const A_REL = 'Projects/topic.md';
export const B_REL = 'Notes/topic.md';
export const A_FULL = win.resolve(A_BASE, A_REL);
export const B_FULL = win.resolve(B_BASE, B_REL);
export const C_FULL = win.resolve(C_BASE, 'Inbox/topic.md');
// The same notes as sync_targets entries: the vault or folder name, then the path without .md
export const A_ENTRY = 'Vault A/Projects/topic';
export const B_ENTRY = 'Vault B/Notes/topic';
export const C_ENTRY = 'Work/Inbox/topic';

export const note = (body: string, list: string[] = [A_ENTRY, B_ENTRY]): string =>
	`---\nsync_targets:\n${list.map((p) => `  - ${p}`).join('\n')}\n---\n${body}\n`;

// A note as the user sees it: without the sync fields the plugin writes into its frontmatter
export const bodyOf = (content: string | undefined): string => withoutHeader(content ?? '');

// A person's edit: the new text, with the sync fields that the note had before, as an editor keeps them
export const keepHeader = (previous: string | undefined, next: string): string => {
	const header = readHeader(previous ?? '');
	return header ? writeHeader(next, header) : next;
};

// An edit made by another program, or one that OneDrive or Obsidian Sync brings from another computer: the
// file on disk gets new text and keeps the sync fields it had
export function editOnDisk(io: FakeIo, fullPath: string, next: string, mtimeMs?: number): void {
	io.put(fullPath, keepHeader(io.content(fullPath), next), mtimeMs);
}

export const sha256 = (content: string): string => createHash('sha256').update(content, 'utf8').digest('hex');

const MANIFEST = {
	id: 'cross-vault-sync',
	name: 'Cross-Vault Sync',
	version: '0.1.0',
	minAppVersion: '1.13.4',
	author: 'Community',
	description: 'Test manifest',
	isDesktopOnly: true,
};

export function fileOf(app: App, rel: string): TFileOriginal {
	const file = app.vault.getAbstractFileByPath(rel);
	if (!(file instanceof TFile)) throw new Error(`no file ${rel}`);
	return file.asOriginalType2__();
}

export async function drain(plugin: CrossVaultSyncPlugin): Promise<void> {
	while (plugin.engine.syncQueues.size) await Promise.all(Array.from(plugin.engine.syncQueues.values()));
}

export function clearTimers(plugin: CrossVaultSyncPlugin): void {
	plugin.engine.unload();
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, ms));

// Automatic sync as a person uses the plugin: Obsidian's events start every sync
export function autoSync(...plugins: CrossVaultSyncPlugin[]): void {
	for (const plugin of plugins) {
		plugin.settings.autoSync = true;
		plugin.settings.showNotices = true;
	}
}

// Waits until no sync is scheduled or running in any of the vaults, for two checks in a row
export async function settle(...plugins: CrossVaultSyncPlugin[]): Promise<void> {
	for (let quiet = 0, round = 0; quiet < 2; round++) {
		if (round === 40) throw new Error('syncs did not settle');
		await sleep(250);
		for (const plugin of plugins) await drain(plugin);
		const busy = plugins.some((p) => p.engine.debounceTimers.size > 0 || p.engine.syncQueues.size > 0);
		quiet = busy ? 0 : quiet + 1;
	}
}

// Vaults with mocked Obsidian, one fake disk shared by all of them, and the plugins loaded into them
export class World {
	readonly io: FakeIo;
	readonly plugins: CrossVaultSyncPlugin[] = [];

	constructor(readonly platform: PlatformName = 'win32') {
		this.io = new FakeIo(platform === 'win32' ? nodePath.win32 : nodePath.posix, platform === 'win32');
	}

	// registered: the vault was opened on this computer before, so the table knows its folder
	vault(basePath: string, files: Record<string, string> = {}, { registered = true }: { registered?: boolean } = {}): App {
		const adapter = FileSystemAdapter.create__(basePath);
		const app = App.createConfigured__({ adapter, files });
		// Obsidian names a vault after its folder. The mock returns ''.
		vi.spyOn(app.vault, 'getName').mockReturnValue(this.io.path.basename(basePath));
		// Obsidian watches its vault folder: a file written by another program fires 'modify', or 'create'
		// for a new one (checked by the e2e tests in Obsidian 1.13.4 and 1.14.4)
		this.io.mount(basePath, adapter, (rel) => {
			const file = app.vault.getAbstractFileByPath(rel);
			if (file instanceof TFile) {
				app.vault.refreshStat__(file);
				app.vault.trigger('modify', file);
			} else app.vault.reconcile__();
		});
		if (registered) this.table().register(this.io.path.basename(basePath), basePath);
		// The mock metadata cache indexes created and modified notes only. Obsidian also carries a note's
		// metadata over when it is renamed, but only after the vault 'rename' listeners have run
		// (checked by the e2e tests in Obsidian 1.4.5 and 1.14.4).
		app.vault.on('rename', (...data: unknown[]) => {
			const [file, oldPath] = data as [TFile, string];
			queueMicrotask(() => {
				const cache = app.metadataCache.cache__.get(oldPath);
				if (!cache) return;
				app.metadataCache.cache__.delete(oldPath);
				app.metadataCache.setCache__(file.path, cache);
			});
		});
		return app;
	}

	// A folder outside the vaults, added under a name in this computer's settings
	folder(name: string, basePath: string): void {
		this.io.addDir(basePath);
		this.table().setManual(name, basePath);
	}

	// The vault folder table of this computer, which every vault window shares
	table(): VaultFolders {
		return new VaultFolders(window.localStorage, new PathRules(this.io.path, this.platform));
	}

	// autoSync is off: the tests start syncs themselves, except the ones about Obsidian's events
	async plugin(app: App | AppOriginal): Promise<CrossVaultSyncPlugin> {
		services.current = { io: this.io, hash: sha256, path: this.io.path, platform: this.platform };
		const original = app instanceof App ? app.asOriginalType__() : app;
		const plugin = new CrossVaultSyncPlugin(original, MANIFEST);
		this.plugins.push(plugin);
		await plugin.onload();
		plugin.settings.debounceMs = 200;
		plugin.settings.autoSync = false;
		return plugin;
	}

	async teardown(): Promise<void> {
		for (const plugin of this.plugins) {
			// Mocked plugins throw on reading a property that was never assigned
			if (Object.hasOwn(plugin, 'engine')) await drain(plugin);
			plugin.onunload();
		}
		services.current = null;
	}
}

const CONSOLE_LEVELS = ['error', 'warn', 'info', 'log', 'debug'] as const;
type ConsoleLevel = (typeof CONSOLE_LEVELS)[number];

export interface TestContext {
	world: World;
	notices: string[];
	logs: { level: ConsoleLevel; args: unknown[] }[];
	count(re: RegExp): number;
	logged(re: RegExp, level?: 'error' | 'debug'): boolean;
}

// A fresh world per test, with notices and console messages collected instead of printed. Obsidian's plugin
// guidelines allow only errors in the developer console as it is by default, so any other message that the
// default console shows fails the test. Debug messages are hidden by default.
export function useWorld(platform: PlatformName = 'win32'): TestContext {
	const ctx: TestContext = {
		world: new World(platform),
		notices: [],
		logs: [],
		count: (re) => ctx.notices.filter((n) => re.test(n)).length,
		logged: (re, level = 'error') => ctx.logs.some((entry) => entry.level === level && entry.args.some((part) => re.test(String(part)))),
	};
	beforeEach(() => {
		// The vault folder table of the computer the test runs on
		window.localStorage.clear();
		ctx.world = new World(platform);
		ctx.notices = [];
		ctx.logs = [];
		vi.spyOn(Notice.prototype, 'constructor__').mockImplementation((message) => {
			ctx.notices.push(typeof message === 'string' ? message : (message.textContent ?? ''));
		});
		for (const level of CONSOLE_LEVELS) {
			vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
				ctx.logs.push({ level, args });
			});
		}
	});
	afterEach(async () => {
		await ctx.world.teardown();
		vi.restoreAllMocks();
		const shown = ctx.logs.filter((entry) => entry.level !== 'error' && entry.level !== 'debug');
		expect(shown, 'console messages shown by default that are not errors').toEqual([]);
	});
	return ctx;
}

export interface TwoVaults {
	appA: App;
	appB: App;
	pA: CrossVaultSyncPlugin;
	pB: CrossVaultSyncPlugin;
	fA: TFileOriginal;
	fB: TFileOriginal;
}

// Vault A and vault B with the note in both, or only in A
export async function twoVaults(world: World, { list, body = 'v1', withB = true }: { list?: string[]; body?: string; withB?: boolean } = {}): Promise<TwoVaults> {
	const appA = world.vault(A_BASE, { [A_REL]: note(body, list) });
	await appA.vault.createFolder('Archive');
	const appB = world.vault(B_BASE, withB ? { [B_REL]: note(body, list) } : {});
	if (!withB) await appB.vault.createFolder('Notes');
	const pA = await world.plugin(appA);
	const pB = await world.plugin(appB);
	return { appA, appB, pA, pB, fA: fileOf(appA, A_REL), fB: withB ? fileOf(appB, B_REL) : (null as unknown as TFileOriginal) };
}

// Same, after both plugins recorded the synced base
export async function synced(world: World, opts?: { list?: string[]; body?: string }): Promise<TwoVaults> {
	const vaults = await twoVaults(world, opts);
	await vaults.pA.engine.syncFile(vaults.fA);
	await vaults.pB.engine.syncFile(vaults.fB);
	return vaults;
}

// Obsidian re-reads a note it sees change on disk. The mocks need to be told.
export function reindex(app: App, file: TFileOriginal): void {
	app.vault.trigger('modify', file);
}
