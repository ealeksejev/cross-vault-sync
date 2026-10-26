// File access outside the vault. Production uses Node's fs (see node.ts), tests use an in-memory fake.

export interface FileStat {
	mtimeMs: number;
	size: number;
	isDirectory(): boolean;
}

export interface FileWatcher {
	close(): void;
	on(event: 'error', listener: (err: Error) => void): unknown;
}

export interface FileIo {
	stat(fullPath: string): Promise<FileStat>;
	readFile(fullPath: string): Promise<string>;
	// 'wx' fails with EEXIST instead of overwriting. mtimeMs, when given, becomes the modification time.
	writeFile(fullPath: string, content: string, flag: 'w' | 'wx', mtimeMs?: number): Promise<void>;
	watch(dir: string, listener: (eventType: string, filename: string | null) => void): FileWatcher;
}

export type Hash = (content: string) => string;

export interface ExistingCopy {
	exists: true;
	fullPath: string;
	content: string;
	hash: string;
	mtime: number;
	size: number;
}

export interface MissingCopy {
	exists: false;
	fullPath: string;
}

// Transient lock errors from OneDrive, antivirus scanners or another editor holding the file open
const RETRYABLE_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'EAGAIN']);
const WRITE_RETRIES = 5;

export function errorCode(err: unknown): string | undefined {
	return err instanceof Error ? (err as Error & { code?: string }).code : undefined;
}

export function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export async function statOrNull(io: FileIo, fullPath: string): Promise<FileStat | null> {
	try {
		return await io.stat(fullPath);
	} catch {
		return null;
	}
}

export async function readCopy(io: FileIo, hash: Hash, fullPath: string): Promise<ExistingCopy | MissingCopy> {
	let stat: FileStat;
	try {
		stat = await io.stat(fullPath);
	} catch (err) {
		const code = errorCode(err);
		if (code === 'ENOENT' || code === 'ENOTDIR') return { exists: false, fullPath };
		throw err;
	}
	// Async read: on an OneDrive online-only file this triggers a download, which must not freeze the UI
	const content = await io.readFile(fullPath);
	// A program that writes a file empties it first. A file that changed while it was read may have been read
	// half written, so it is not used: the code ECHANGED asks the caller to read it again later.
	const after = await statOrNull(io, fullPath);
	if (!after || after.mtimeMs !== stat.mtimeMs || after.size !== stat.size) {
		throw Object.assign(new Error(`${fullPath} changed while it was read`), { code: 'ECHANGED' });
	}
	return { exists: true, fullPath, content, hash: hash(content), mtime: stat.mtimeMs, size: stat.size };
}

export async function unchangedSince(io: FileIo, copy: ExistingCopy): Promise<boolean> {
	const stat = await statOrNull(io, copy.fullPath);
	return stat !== null && stat.mtimeMs === copy.mtime && stat.size === copy.size;
}

// stopped tells when to give up waiting, such as when the plugin was turned off: the last error is thrown then
export async function writeWithRetry(io: FileIo, fullPath: string, content: string, flag: 'w' | 'wx', mtimeMs: number | undefined, stopped: () => boolean, attempt = 0): Promise<void> {
	try {
		await io.writeFile(fullPath, content, flag, mtimeMs);
	} catch (err) {
		const code = errorCode(err);
		if (code === undefined || !RETRYABLE_CODES.has(code) || attempt >= WRITE_RETRIES) throw err;
		await sleep(100 * 2 ** attempt);
		if (stopped()) throw err;
		await writeWithRetry(io, fullPath, content, flag, mtimeMs, stopped, attempt + 1);
	}
}
