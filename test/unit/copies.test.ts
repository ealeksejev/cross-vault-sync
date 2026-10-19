import * as nodePath from 'path';
import { describe, expect, it } from 'vitest';
import { CopyFiles } from '../../src/copies';
import type { SyncHost } from '../../src/host';
import { PathRules } from '../../src/paths';

// Only the parts of the host that vaultPath uses
const writerIn = (base: string, platform: 'win32' | 'linux') =>
	new CopyFiles({ vaultBasePath: () => base, paths: new PathRules(platform === 'win32' ? nodePath.win32 : nodePath.posix, platform) } as unknown as SyncHost);

describe('which copies are in this vault', () => {
	it('a file in the vault folder, at any depth, by its path in the vault', () => {
		const writer = writerIn('C:\\Vaults\\Vault A', 'win32');
		expect(writer.vaultPath('c:\\vaults\\vault a\\Projects\\topic.md')).toBe('Projects/topic.md');
		expect(writer.vaultPath('C:\\Vaults\\Vault A2\\topic.md')).toBeNull();
		expect(writer.vaultPath('D:\\topic.md')).toBeNull();
	});

	it('a vault at the root of a drive or file system', () => {
		expect(writerIn('C:\\', 'win32').vaultPath('C:\\Notes\\topic.md')).toBe('Notes/topic.md');
		expect(writerIn('/', 'linux').vaultPath('/home/u/topic.md')).toBe('home/u/topic.md');
	});

	it('no file, when the vault has no folder on disk', () => {
		expect(writerIn('', 'linux').vaultPath('/home/u/topic.md')).toBeNull();
	});
});
