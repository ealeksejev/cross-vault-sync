import type { App, TFile } from 'obsidian';
import { noteEntry, parseEntry, type EntryResolver, type VaultProblem } from './entries';

export interface TargetList {
	targets: string[];
	ignored: number;
	problems: VaultProblem[];
	// Keys of the targets that a folder entry names
	folderTargets: Set<string>;
	// Keys of the targets that a file entry names. Only these can be the note's own entry: a folder entry
	// gives the copy in that folder this note's name, so it would name any other note of that name there.
	fileTargets: Set<string>;
	// The usable entries in list order, each naming the file itself as sync_known stores it. key is null for
	// an entry whose vault has no known folder on this computer.
	listed: ListedEntry[];
}

export interface ListedEntry {
	file: string;
	key: string | null;
}

// The sync_targets value as parsed by Obsidian, or null. While the vault 'rename' listeners run, Obsidian
// still keeps a moved note's metadata under its old path, so rename handlers pass that path as well.
export function rawTargets(app: App, file: TFile, key: string, oldPath?: string): unknown {
	const cache = app.metadataCache.getFileCache(file) ?? (oldPath === undefined ? null : app.metadataCache.getCache(oldPath));
	const frontmatter = cache?.frontmatter;
	const raw: unknown = frontmatter ? frontmatter[key] : null;
	return raw ?? null;
}

// A YAML value as a list: a scalar becomes one entry, a missing value none
export function asList(raw: unknown): unknown[] {
	if (raw === null || raw === undefined) return [];
	return Array.isArray(raw) ? (raw as unknown[]) : [raw];
}

// De-duplicated files on this computer, how many entries were not usable, and the vaults without a known folder
export function readTargets(app: App, file: TFile, key: string, entries: EntryResolver, oldPath?: string): TargetList {
	const targets: string[] = [];
	const problems: VaultProblem[] = [];
	const folderTargets = new Set<string>();
	const fileTargets = new Set<string>();
	const listed: ListedEntry[] = [];
	const seen = new Set<string>();
	let ignored = 0;
	for (const raw of asList(rawTargets(app, file, key, oldPath))) {
		const entry = parseEntry(raw);
		const resolved = entry ? entries.resolveEntry(entry, file.name) : ({ kind: 'invalid' } as const);
		if (!entry || resolved.kind === 'invalid') {
			ignored++;
			continue;
		}
		// A folder entry names the copy that has this note's name in that folder
		const asFile = noteEntry(entry.name, entry.folder ? [entry.path, file.name].filter(Boolean).join('/') : entry.path);
		if (resolved.kind !== 'path') {
			if (!problems.some((p) => p.kind === resolved.kind && p.vault === resolved.vault)) problems.push(resolved);
			listed.push({ file: asFile, key: null });
			continue;
		}
		const entryKey = entries.paths.key(resolved.fullPath);
		(entry.folder ? folderTargets : fileTargets).add(entryKey);
		listed.push({ file: asFile, key: entryKey });
		if (seen.has(entryKey)) continue;
		seen.add(entryKey);
		targets.push(resolved.fullPath);
	}
	return { targets, ignored, problems, folderTargets, fileTargets, listed };
}

// Resolves once the metadata cache has re-parsed the note, or after the timeout
export function waitForMetadata(app: App, file: TFile, timeoutMs = 2000): Promise<void> {
	return new Promise((resolve) => {
		// Whichever comes first removes the other, so finish runs once
		const finish = () => {
			window.clearTimeout(timer);
			app.metadataCache.offref(ref);
			resolve();
		};
		const ref = app.metadataCache.on('changed', (changed) => {
			if (changed === file) finish();
		});
		const timer = window.setTimeout(finish, timeoutMs);
	});
}
