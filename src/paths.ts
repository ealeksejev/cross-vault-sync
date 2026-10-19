import type * as NodePath from 'path';

export type PathModule = Pick<typeof NodePath, 'resolve' | 'relative' | 'dirname' | 'basename' | 'extname' | 'join' | 'isAbsolute' | 'sep'>;

export type PlatformName = 'win32' | 'darwin' | 'linux';

// Path rules of the platform Obsidian runs on. Tests pass path.win32 or path.posix to check both.
export class PathRules {
	private readonly caseInsensitive: boolean;

	constructor(readonly path: PathModule, private readonly platform: PlatformName) {
		this.caseInsensitive = platform === 'win32' || platform === 'darwin';
	}

	// Comparable form of a path: resolved, and lowercased where the file system ignores case
	key(p: string): string {
		const resolved = this.path.resolve(p);
		return this.caseInsensitive ? resolved.toLowerCase() : resolved;
	}

	nameKey(name: string): string {
		return this.caseInsensitive ? name.toLowerCase() : name;
	}

	// Relative paths would resolve against Obsidian's working directory, and on Windows "/mnt/c/..." (WSL)
	// or "\foo" would resolve against the current drive
	isAbsolutePath(p: string): boolean {
		if (this.platform === 'win32') {
			return /^[a-zA-Z]:[\\/]/.test(p) || /^\\\\[^\\]+\\[^\\]+/.test(p);
		}
		return this.path.isAbsolute(p);
	}
}
