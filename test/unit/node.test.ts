import * as fs from 'fs';
import { createRequire } from 'module';
import * as os from 'os';
import * as path from 'path';
import { Platform } from 'obsidian-test-mocks/obsidian';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as NodeModule from '../../src/node';

// The real module, not the test world's replacement from setup.ts
const { loadNodeServices } = await vi.importActual<typeof NodeModule>('../../src/node');

describe('Node services', () => {
	const dirs: string[] = [];
	beforeAll(() => {
		// Obsidian's plugin loader provides require(). Vitest runs the module as ESM, which has none.
		vi.stubGlobal('require', createRequire(import.meta.url));
	});
	afterEach(() => {
		Platform.isDesktop = true;
		Platform.isWin = false;
		Platform.isMacOS = false;
		for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
	});

	it('read, write, stat and watch real files, and hash with SHA-256', async () => {
		const services = loadNodeServices();
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cvs-'));
		dirs.push(dir);
		const file = path.join(dir, 'note.md');
		const seen: (string | null)[] = [];
		const watcher = services.io.watch(dir, (_event, filename) => seen.push(filename));
		await services.io.writeFile(file, 'hello', 'wx');
		await expect(services.io.writeFile(file, 'again', 'wx')).rejects.toMatchObject({ code: 'EEXIST' });
		await services.io.writeFile(file, 'hello world', 'w');
		expect(await services.io.readFile(file)).toBe('hello world');
		const stat = await services.io.stat(file);
		expect(stat.size).toBe(11);
		expect(stat.isDirectory()).toBe(false);
		// A write that keeps the modification time of the content it had
		await services.io.writeFile(file, 'hello again', 'w', 1_700_000_000_000);
		expect((await services.io.stat(file)).mtimeMs).toBe(1_700_000_000_000);
		await new Promise((resolve) => window.setTimeout(resolve, 100));
		watcher.close();
		expect(seen).toContain('note.md');
		expect(services.hash('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
		expect(services.path.join('a', 'b')).toBe(path.join('a', 'b'));
	});

	it('name the platform from Obsidian', () => {
		Platform.isWin = true;
		expect(loadNodeServices().platform).toBe('win32');
		Platform.isWin = false;
		Platform.isMacOS = true;
		expect(loadNodeServices().platform).toBe('darwin');
		Platform.isMacOS = false;
		expect(loadNodeServices().platform).toBe('linux');
	});

	it('are refused outside the desktop app', () => {
		Platform.isDesktop = false;
		expect(() => loadNodeServices()).toThrow(/desktop app/);
	});
});
