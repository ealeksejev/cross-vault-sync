import { FileSystemAdapter, Notice, Platform, Plugin, TFile } from 'obsidian';
import { EntryResolver } from './entries';
import type { SyncHost } from './host';
import type { FileIo, Hash } from './io';
import { loadNodeServices } from './node';
import { OwnPath } from './own-path';
import { PathRules } from './paths';
import { CrossVaultSyncSettingTab, DEFAULT_SETTINGS, type CrossVaultSyncSettings } from './settings';
import { SyncEngine } from './sync';
import { AddSyncTargetModal } from './ui/add-target-modal';
import { addCopyTargetItem } from './ui/copy-target';
import { VaultFolders } from './vault-folders';
import { TargetWatchers } from './watchers';

export default class CrossVaultSyncPlugin extends Plugin implements SyncHost {
	settings: CrossVaultSyncSettings = { ...DEFAULT_SETTINGS };
	paths!: PathRules;
	folders!: VaultFolders;
	entries!: EntryResolver;
	io!: FileIo;
	hash!: Hash;
	engine!: SyncEngine;
	watchers!: TargetWatchers;
	ownPath!: OwnPath;
	statusBarEl!: HTMLElement;
	private unloaded = false;
	// False when onload stopped early, so onunload has nothing to release
	private ready = false;

	async onload(): Promise<void> {
		if (!Platform.isDesktop) {
			new Notice('Cross-Vault Sync is desktop-only.');
			return;
		}
		const node = loadNodeServices();
		this.paths = new PathRules(node.path, node.platform);
		this.io = node.io;
		this.hash = node.hash;
		await this.loadSettings();

		const ownVault = { name: this.app.vault.getName(), folder: this.vaultBasePath() };
		this.folders = new VaultFolders(window.localStorage, this.paths);
		if (ownVault.folder) this.folders.register(ownVault.name, ownVault.folder);
		void this.folders.prune(this.io);
		this.entries = new EntryResolver(this.paths, this.folders, ownVault);

		this.engine = new SyncEngine(this);
		this.watchers = new TargetWatchers(this, this.engine);
		this.ownPath = new OwnPath(this, this.engine);

		this.statusBarEl = this.addStatusBarItem();
		this.statusBarEl.addClass('mod-clickable');
		this.registerDomEvent(this.statusBarEl, 'click', () => {
			const activeFile = this.app.workspace.getActiveFile();
			if (activeFile) void this.engine.syncFile(activeFile, true);
			else new Notice('No active Markdown note to sync.');
		});
		this.updateStatusBar(null);

		this.addSettingTab(new CrossVaultSyncSettingTab(this.app, this));
		this.registerCommands();
		this.registerEvents();
		this.ready = true;
	}

	onunload(): void {
		this.unloaded = true;
		if (!this.ready) return;
		this.engine.unload();
		this.watchers.close();
	}

	private registerCommands(): void {
		const activeNote = () => {
			const file = this.app.workspace.getActiveFile();
			return file && file.extension === 'md' ? file : null;
		};
		this.addCommand({
			id: 'sync-active-note',
			name: 'Sync active note now',
			checkCallback: (checking) => {
				const file = activeNote();
				if (!file) return false;
				if (!checking) void this.engine.syncFile(file, true);
				return true;
			},
		});
		this.addCommand({
			id: 'sync-all-notes',
			name: 'Sync all notes with sync_targets',
			callback: () => void this.engine.syncAll(true),
		});
		this.addCommand({
			id: 'add-sync-target',
			name: 'Add sync target to active note',
			checkCallback: (checking) => {
				const file = activeNote();
				if (!file) return false;
				if (!checking) new AddSyncTargetModal(this.app, this, file).open();
				return true;
			},
		});
	}

	private registerEvents(): void {
		const isNote = (file: unknown): file is TFile => file instanceof TFile && file.extension === 'md';

		this.registerEvent(this.app.vault.on('modify', (file) => {
			if (this.settings.autoSync && isNote(file)) this.engine.schedule(file);
		}));
		this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
			if (isNote(file)) void this.ownPath.handleRename(file, oldPath);
		}));
		// Pick up sync_targets edits on the active note (status bar count, watched targets, own path)
		this.registerEvent(this.app.metadataCache.on('changed', (file) => {
			if (file !== this.app.workspace.getActiveFile()) return;
			this.updateStatusBar(file);
			this.watchers.update(file, false);
			if (this.ownPath.remember(file)) void this.ownPath.addIfMissing(file);
		}));
		this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => addCopyTargetItem(menu, file, this.app.vault.getName())));
		this.registerEvent(this.app.workspace.on('file-open', (file) => {
			if (!isNote(file)) {
				this.updateStatusBar(null);
				this.watchers.close();
				return;
			}
			this.ownPath.remember(file);
			this.updateStatusBar(file);
			this.watchers.update(file, true);
			// Check for external updates on open
			if (this.settings.autoSync) void this.engine.syncFile(file, false);
		}));
		// Check for updates when the window gets focus
		this.registerDomEvent(window, 'focus', () => {
			const file = this.app.workspace.getActiveFile();
			if (this.settings.autoSync && isNote(file)) void this.engine.syncFile(file, false);
		});
	}

	isUnloaded(): boolean {
		return this.unloaded;
	}

	vaultBasePath(): string {
		const adapter = this.app.vault.adapter;
		return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : '';
	}

	fullPath(file: TFile): string {
		const basePath = this.vaultBasePath();
		return basePath ? this.paths.path.resolve(basePath, file.path) : '';
	}

	refreshWatchers(): void {
		const file = this.app.workspace.getActiveFile();
		if (file && file.extension === 'md') this.watchers.update(file, true);
		else this.watchers.close();
	}

	updateStatusBar(file: TFile | null): void {
		const count = file ? this.engine.targetsOf(file).targets.length : 0;
		this.statusBarEl.setText(count === 0 ? '' : `⇅ Sync (${count})`);
	}

	// The plugin's data holds its settings only: the sync state is in the notes. Other keys are dropped.
	async loadSettings(): Promise<void> {
		const data = ((await this.loadData()) ?? {}) as Record<string, unknown>;
		const settings: Record<string, unknown> = { ...DEFAULT_SETTINGS };
		for (const key of Object.keys(DEFAULT_SETTINGS)) {
			if (key in data) settings[key] = data[key];
		}
		this.settings = settings as unknown as CrossVaultSyncSettings;
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
