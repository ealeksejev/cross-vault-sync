// The functions of Node's path module that the plugin uses. They are declared here: the community directory
// reviews the source without Node.js types, which would leave every call untyped.
export interface PathModule {
	readonly sep: string;
	resolve(...paths: string[]): string;
	relative(from: string, to: string): string;
	dirname(path: string): string;
	basename(path: string, suffix?: string): string;
	extname(path: string): string;
	join(...paths: string[]): string;
	isAbsolute(path: string): boolean;
}

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
