import * as nodePath from 'path';
import { describe, expect, it } from 'vitest';
import { PathRules } from '../../src/paths';
import { VAULT_FOLDERS_KEY, VaultFolders } from '../../src/vault-folders';
import { FakeIo } from './helpers/fake-io';
import { memoryStorage } from './helpers/storage';

const win = nodePath.win32;
const paths = new PathRules(win, 'win32');

describe('vault folders of this computer', () => {
	it('registers each folder once and finds it by name in any case', () => {
		const folders = new VaultFolders(memoryStorage(), paths);
		folders.register('Test', 'D:\\Vaults\\Test');
		folders.register('test', 'd:\\vaults\\TEST');
		expect(folders.list()).toEqual([{ name: 'Test', folder: 'D:\\Vaults\\Test', manual: false }]);
		expect(folders.lookup('TEST')).toEqual({ folder: 'D:\\Vaults\\Test' });
		expect(folders.lookup('Other')).toBeNull();
	});

	it('marks a name with two registered folders as ambiguous, and a folder added by hand wins', () => {
		const folders = new VaultFolders(memoryStorage(), paths);
		folders.register('Test', 'D:\\Vaults\\Test');
		folders.register('Test', 'E:\\Copy\\Test');
		expect(folders.lookup('Test')).toEqual({ ambiguous: true });
		folders.setManual('Test', 'E:\\Copy\\Test');
		folders.setManual('test', 'D:\\Vaults\\Test');
		expect(folders.lookup('Test')).toEqual({ folder: 'D:\\Vaults\\Test' });
		folders.setManual('Alpha', 'D:\\Alpha');
		expect(folders.list().map((entry) => [entry.name, entry.manual])).toEqual([
			['Alpha', true],
			['test', true],
			['Test', false],
			['Test', false],
		]);
	});

	it('removes the clicked entry only', () => {
		const folders = new VaultFolders(memoryStorage(), paths);
		folders.register('Test', 'D:\\Vaults\\Test');
		folders.register('Test', 'E:\\Copy\\Test');
		folders.setManual('Test', 'F:\\Test');
		folders.remove({ name: 'Test', folder: 'E:\\Copy\\Test', manual: false });
		expect(folders.list()).toEqual([
			{ name: 'Test', folder: 'F:\\Test', manual: true },
			{ name: 'Test', folder: 'D:\\Vaults\\Test', manual: false },
		]);
		folders.remove({ name: 'Test', folder: 'F:\\Test', manual: true });
		folders.remove({ name: 'Test', folder: 'D:\\Vaults\\Test', manual: false });
		folders.remove({ name: 'Gone', folder: 'D:\\Gone', manual: false });
		folders.remove({ name: 'Gone', folder: 'D:\\Gone', manual: true });
		expect(folders.list()).toEqual([]);
	});

	it('reads only valid entries from the stored table', () => {
		for (const stored of ['not json', '[1]', '5', JSON.stringify({ manual: [], auto: 'x' })]) {
			const storage = memoryStorage();
			storage.setItem(VAULT_FOLDERS_KEY, stored);
			expect(new VaultFolders(storage, paths).list()).toEqual([]);
		}
		const storage = memoryStorage();
		storage.setItem(VAULT_FOLDERS_KEY, JSON.stringify({ manual: { A: 'D:\\A', B: 5 }, auto: { C: ['D:\\C', 7], D: [], E: 'D:\\E' } }));
		expect(new VaultFolders(storage, paths).list()).toEqual([
			{ name: 'A', folder: 'D:\\A', manual: true },
			{ name: 'C', folder: 'D:\\C', manual: false },
		]);
	});

	it('forgets registered folders that are gone or are files, and keeps folders added by hand', async () => {
		const io = new FakeIo(win, true);
		io.addDir('D:\\Vaults\\Test');
		await io.writeFile('D:\\Vaults\\file', 'x', 'w');
		const folders = new VaultFolders(memoryStorage(), paths);
		folders.register('Test', 'D:\\Vaults\\Test');
		folders.register('Test', 'E:\\Moved\\Test');
		folders.register('File', 'D:\\Vaults\\file');
		folders.setManual('Hand', 'Z:\\Offline');
		await folders.prune(io);
		expect(folders.list().map((entry) => entry.folder)).toEqual(['Z:\\Offline', 'D:\\Vaults\\Test']);
		expect(folders.lookup('Test')).toEqual({ folder: 'D:\\Vaults\\Test' });
	});
});
