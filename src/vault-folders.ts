import { statOrNull, type FileIo } from './io';
import type { PathRules } from './paths';

// The browser's localStorage is shared by every vault window on this computer: app.saveLocalStorage
// prefixes its keys with the vault ID for that reason (checked by the e2e tests). This key has no
// prefix, so it holds one table for the whole computer.
export const VAULT_FOLDERS_KEY = 'cross-vault-sync:vault-folders';

export interface VaultFolder {
	name: string;
	folder: string;
	// Added in the settings instead of registered by the vault itself
	manual: boolean;
}

export type FolderLookup = { folder: string } | { ambiguous: true } | null;

interface Table {
	manual: Record<string, string>;
	// A name can belong to more than one folder: two vaults with the same name, or a moved vault
	auto: Record<string, string[]>;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

// Where each vault, and each named folder outside the vaults, is on this computer. A vault registers its own
// folder when it loads the plugin. Folders added in the settings cover vaults not opened here yet and
// folders outside the vaults, and win over registered ones.
export class VaultFolders {
	constructor(private readonly storage: Pick<Storage, 'getItem' | 'setItem'>, private readonly paths: PathRules) {}

	register(name: string, folder: string): void {
		const table = this.read();
		const stored = this.storedName(table.auto, name) ?? name;
		const folders = table.auto[stored] ?? [];
		if (folders.some((f) => this.paths.key(f) === this.paths.key(folder))) return;
		table.auto[stored] = [...folders, folder];
		this.write(table);
	}

	setManual(name: string, folder: string): void {
		const table = this.read();
		const stored = this.storedName(table.manual, name);
		if (stored !== undefined) delete table.manual[stored];
		table.manual[name] = folder;
		this.write(table);
	}

	remove(entry: VaultFolder): void {
		const table = this.read();
		if (entry.manual) {
			const stored = this.storedName(table.manual, entry.name);
			if (stored !== undefined) delete table.manual[stored];
		} else {
			const stored = this.storedName(table.auto, entry.name);
			if (stored !== undefined) {
				const rest = table.auto[stored]!.filter((f) => this.paths.key(f) !== this.paths.key(entry.folder));
				if (rest.length > 0) table.auto[stored] = rest;
				else delete table.auto[stored];
			}
		}
		this.write(table);
	}

	// Manual entries first, each part sorted by name
	list(): VaultFolder[] {
		const table = this.read();
		const byName = (a: VaultFolder, b: VaultFolder) => a.name.localeCompare(b.name);
		return [
			...Object.entries(table.manual).map(([name, folder]) => ({ name, folder, manual: true })).sort(byName),
			...Object.entries(table.auto).flatMap(([name, folders]) => folders.map((folder) => ({ name, folder, manual: false }))).sort(byName),
		];
	}

	// A name registered by two existing folders is ambiguous: either could be the wrong vault
	lookup(name: string): FolderLookup {
		const table = this.read();
		const manual = this.storedName(table.manual, name);
		if (manual !== undefined) return { folder: table.manual[manual]! };
		const auto = this.storedName(table.auto, name);
		if (auto === undefined) return null;
		const folders = table.auto[auto]!;
		return folders.length === 1 ? { folder: folders[0]! } : { ambiguous: true };
	}

	// Forgets registered folders that are gone, so a moved vault is no longer ambiguous
	async prune(io: FileIo): Promise<void> {
		for (const entry of this.list()) {
			if (entry.manual) continue;
			const stat = await statOrNull(io, entry.folder);
			if (!stat || !stat.isDirectory()) this.remove(entry);
		}
	}

	private storedName(record: Record<string, unknown>, name: string): string | undefined {
		return Object.keys(record).find((stored) => this.paths.nameKey(stored) === this.paths.nameKey(name));
	}

	private read(): Table {
		const table: Table = { manual: {}, auto: {} };
		let parsed: unknown;
		try {
			parsed = JSON.parse(this.storage.getItem(VAULT_FOLDERS_KEY) ?? '{}');
		} catch {
			return table;
		}
		if (!isRecord(parsed)) return table;
		if (isRecord(parsed.manual)) {
			for (const [name, folder] of Object.entries(parsed.manual)) if (typeof folder === 'string') table.manual[name] = folder;
		}
		if (isRecord(parsed.auto)) {
			for (const [name, folders] of Object.entries(parsed.auto)) {
				const valid = Array.isArray(folders) ? folders.filter((f): f is string => typeof f === 'string') : [];
				if (valid.length > 0) table.auto[name] = valid;
			}
		}
		return table;
	}

	private write(table: Table): void {
		this.storage.setItem(VAULT_FOLDERS_KEY, JSON.stringify(table));
	}
}
