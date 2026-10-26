import { Platform } from 'obsidian';
import type { FileIo, FileStat, FileWatcher, Hash } from './io';
import type { PathModule, PlatformName } from './paths';

export interface NodeServices {
	io: FileIo;
	hash: Hash;
	path: PathModule;
	platform: PlatformName;
}

// The parts of Node's fs and crypto modules that the plugin uses, declared here for the same reason as PathModule
interface NodeFs {
	promises: {
		stat(path: string): Promise<FileStat>;
		readFile(path: string, encoding: 'utf8'): Promise<string>;
		writeFile(path: string, data: string, options: { encoding: 'utf8'; flag: 'w' | 'wx' }): Promise<void>;
		utimes(path: string, atime: Date, mtime: Date): Promise<void>;
	};
	watch(dir: string, listener: (eventType: string, filename: string | null) => void): FileWatcher;
}

interface NodeCrypto {
	createHash(algorithm: 'sha256'): { update(data: string, encoding: 'utf8'): { digest(encoding: 'hex'): string } };
}

// Obsidian's plugin loader gives every plugin Node's require()
declare const require: (id: 'fs' | 'path' | 'crypto') => unknown;

// Node.js modules exist only in the desktop app, which the manifest requires (isDesktopOnly).
// require(), not import(): Obsidian cannot resolve a dynamic import of a Node.js module
// ("Failed to resolve module specifier 'fs'", found by the e2e tests).
export function loadNodeServices(): NodeServices {
	if (!Platform.isDesktop) {
		throw new Error('Cross-Vault Sync needs the Obsidian desktop app');
	}
	const fs = require('fs') as NodeFs;
	const path = require('path') as PathModule;
	const crypto = require('crypto') as NodeCrypto;
	return {
		io: {
			stat: (fullPath) => fs.promises.stat(fullPath),
			readFile: (fullPath) => fs.promises.readFile(fullPath, 'utf8'),
			writeFile: async (fullPath, content, flag, mtimeMs) => {
				await fs.promises.writeFile(fullPath, content, { encoding: 'utf8', flag });
				if (mtimeMs !== undefined) await fs.promises.utimes(fullPath, new Date(), new Date(mtimeMs));
			},
			watch: (dir, listener) => fs.watch(dir, (eventType, filename) => listener(eventType, filename)),
		},
		hash: (content) => crypto.createHash('sha256').update(content, 'utf8').digest('hex'),
		path,
		platform: Platform.isWin ? 'win32' : Platform.isMacOS ? 'darwin' : 'linux',
	};
}
