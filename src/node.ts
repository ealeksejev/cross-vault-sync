import type * as Crypto from 'crypto';
import type * as Fs from 'fs';
import type * as Path from 'path';
import { Platform } from 'obsidian';
import type { FileIo, Hash } from './io';
import type { PathModule, PlatformName } from './paths';

export interface NodeServices {
	io: FileIo;
	hash: Hash;
	path: PathModule;
	platform: PlatformName;
}

// Node.js modules exist only in the desktop app, which the manifest requires (isDesktopOnly).
// require(), not import(): Obsidian cannot resolve a dynamic import of a Node.js module
// ("Failed to resolve module specifier 'fs'", found by the e2e tests).
export function loadNodeServices(): NodeServices {
	if (!Platform.isDesktop) {
		throw new Error('Cross-Vault Sync needs the Obsidian desktop app');
	}
	/* eslint-disable @typescript-eslint/no-require-imports -- import() of a Node.js module fails in Obsidian, see above */
	const fs = require('fs') as typeof Fs;
	const path = require('path') as typeof Path;
	const crypto = require('crypto') as typeof Crypto;
	/* eslint-enable @typescript-eslint/no-require-imports -- end of the Node.js modules */
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
