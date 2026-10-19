import * as nodePath from 'path';
import { describe, expect, it } from 'vitest';
import { EntryResolver, folderEntry, noteEntry, parseEntry } from '../../src/entries';
import { PathRules } from '../../src/paths';
import { VaultFolders } from '../../src/vault-folders';
import { memoryStorage } from './helpers/storage';

const win = nodePath.win32;

describe('sync_targets entries', () => {
	it('are a name and a path as "Copy path > From vault folder" gives it, a trailing slash makes a folder', () => {
		expect(parseEntry(' Vault A/Projects/Notes/Cross-Vault Sync/Café notes ')).toEqual({ name: 'Vault A', path: 'Projects/Notes/Cross-Vault Sync/Café notes', folder: false });
		expect(parseEntry('Vault B/Projects/Notes/')).toEqual({ name: 'Vault B', path: 'Projects/Notes', folder: true });
		expect(parseEntry('Vault B/')).toEqual({ name: 'Vault B', path: '', folder: true });
		expect(parseEntry('Vault B\\Notes\\topic')).toEqual({ name: 'Vault B', path: 'Notes/topic', folder: false });
	});

	it('refuse a missing name, a missing slash, and absolute paths and URLs', () => {
		for (const entry of ['', 'Vault A', '/Notes/topic', 'C:\\Vault\\topic.md', 'C:/Vault/topic.md', 'obsidian://open?vault=Vault A&file=topic', 42, null]) {
			expect(parseEntry(entry)).toBeNull();
		}
	});

	it('are written without .md, and a folder with a trailing slash', () => {
		expect(noteEntry('Vault A', 'Projects/v1.2.md')).toBe('Vault A/Projects/v1.2');
		expect(folderEntry('Vault B', 'Projects/Notes')).toBe('Vault B/Projects/Notes/');
		expect(folderEntry('Vault B', '')).toBe('Vault B/');
	});
});

describe('entry resolver', () => {
	const paths = new PathRules(win, 'win32');
	const OWN = 'C:\\Users\\alice\\Documents\\Obsidian\\Vault A';

	function resolver(ownFolder = OWN) {
		const folders = new VaultFolders(memoryStorage(), paths);
		return { folders, entries: new EntryResolver(paths, folders, { name: 'Vault A', folder: ownFolder }) };
	}

	it('finds this vault by its name, in any case, and adds .md to the file path only', () => {
		const { entries } = resolver();
		const fullPath = win.join(OWN, 'Projects', 'Drafts', 'v1.2.md');
		expect(entries.resolve('Vault A/Projects/Drafts/v1.2', 'x.md')).toEqual({ kind: 'path', fullPath });
		expect(entries.resolve('vault a/Projects/Drafts/v1.2.md', 'x.md')).toEqual({ kind: 'path', fullPath });
	});

	it('gives a copy in a folder the name of the note', () => {
		const { folders, entries } = resolver();
		folders.register('Vault B', 'D:\\Vaults\\Vault B');
		expect(entries.resolve('Vault B/Projects/Notes/', 'Café notes.md')).toEqual({ kind: 'path', fullPath: 'D:\\Vaults\\Vault B\\Projects\\Notes\\Café notes.md' });
		expect(entries.resolve('Vault B/', 'topic.md')).toEqual({ kind: 'path', fullPath: 'D:\\Vaults\\Vault B\\topic.md' });
	});

	it('finds other names in the table of this computer, a folder added by hand first', () => {
		const { folders, entries } = resolver();
		expect(entries.resolve('Vault B/Notes/topic', 'x.md')).toEqual({ kind: 'missing-vault', vault: 'Vault B' });
		folders.register('Vault B', 'D:\\Vaults\\Vault B');
		expect(entries.resolve('Vault B/Notes/topic', 'x.md')).toEqual({ kind: 'path', fullPath: 'D:\\Vaults\\Vault B\\Notes\\topic.md' });
		folders.register('Vault B', 'E:\\Old\\Vault B');
		expect(entries.resolve('Vault B/Notes/topic', 'x.md')).toEqual({ kind: 'ambiguous-vault', vault: 'Vault B' });
		folders.setManual('Vault B', 'D:\\Vaults\\Vault B');
		expect(entries.resolve('Vault B/Notes/topic', 'x.md')).toEqual({ kind: 'path', fullPath: 'D:\\Vaults\\Vault B\\Notes\\topic.md' });
		folders.setManual('Work', 'F:\\Work');
		expect(entries.resolve('Work/Inbox/topic', 'x.md')).toEqual({ kind: 'path', fullPath: 'F:\\Work\\Inbox\\topic.md' });
	});

	it('always finds this vault under its own name, whatever the table says', () => {
		const { folders, entries } = resolver();
		folders.setManual('Vault A', 'D:\\Other\\Vault A');
		expect(entries.resolve('Vault A/a', 'x.md')).toEqual({ kind: 'path', fullPath: win.join(OWN, 'a.md') });
	});

	it('keeps a vault at the root of a drive, and refuses paths that lead out of it', () => {
		const { folders, entries } = resolver();
		folders.register('Root', 'D:\\');
		expect(entries.resolve('Root/a', 'x.md')).toEqual({ kind: 'path', fullPath: 'D:\\a.md' });
		expect(entries.resolve('Vault A/../Vault B/secret', 'x.md')).toEqual({ kind: 'invalid' });
		expect(entries.resolve('not an entry', 'x.md')).toEqual({ kind: 'invalid' });
	});

	it('knows no folder of its own vault without a folder on disk', () => {
		const { entries } = resolver('');
		expect(entries.resolve('Vault A/a', 'x.md')).toEqual({ kind: 'missing-vault', vault: 'Vault A' });
	});
});
