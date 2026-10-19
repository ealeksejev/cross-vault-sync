import * as nodePath from 'path';
import { describe, expect, it } from 'vitest';
import { decide, type Candidate } from '../../src/decide';
import type { SyncHeader } from '../../src/header';
import { errorCode, errorMessage } from '../../src/io';
import { PathRules } from '../../src/paths';
import { asList } from '../../src/targets';

// A copy whose body is the given text. Its sync fields say which body and version its last sync wrote.
const candidate = (key: string, body: string, mtime: number, header: SyncHeader | null): Candidate => ({
	isLocal: key === 'local',
	key,
	fullPath: key,
	content: body,
	hash: body,
	bodyHash: body,
	header,
	mtime,
});
const synced = (version: number, body: string): SyncHeader => ({ version, hash: body, known: [] });

describe('decide', () => {
	const local = candidate('local', 'v1', 1, synced(1, 'v1'));

	it('keeps the local note when every copy matches it', () => {
		expect(decide([local, candidate('b', 'v1', 5, synced(1, 'v1'))])).toEqual({ winner: local, losers: [], version: 1 });
		expect(decide([local])).toEqual({ winner: local, losers: [], version: 1 });
	});

	it('picks the one edited copy regardless of its modification time, with a new version', () => {
		const b = candidate('b', 'edit', 0, synced(1, 'v1'));
		expect(decide([local, b])).toEqual({ winner: b, losers: [], version: 2 });
	});

	it('ranks copies edited in different ways by modification time, newest first', () => {
		const mine = candidate('local', 'mine', 3, synced(1, 'v1'));
		const b = candidate('b', 'theirs', 9, synced(1, 'v1'));
		const c = candidate('c', 'theirs', 2, synced(1, 'v1'));
		const d = candidate('d', 'theirs', 4, synced(1, 'v1'));
		expect(decide([mine, c, b, d])).toEqual({ winner: b, losers: [mine], version: 2 });
	});

	it('counts copies without sync fields as edited: the same content agrees, other content conflicts', () => {
		const mine = candidate('local', 'mine', 1, null);
		expect(decide([mine, candidate('b', 'mine', 9, null)])).toEqual({ winner: mine, losers: [], version: 1 });
		const theirs = candidate('b', 'theirs', 9, null);
		expect(decide([mine, theirs])).toEqual({ winner: theirs, losers: [mine], version: 1 });
	});

	it('an edit of an older version conflicts with the newer sync, which keeps its version when it wins', () => {
		const current = candidate('local', 'v2', 5, synced(2, 'v2'));
		const older = candidate('b', 'b edit', 3, synced(1, 'v1'));
		expect(decide([current, older])).toEqual({ winner: current, losers: [older], version: 2 });
		const newer = candidate('b', 'b edit', 9, synced(1, 'v1'));
		expect(decide([current, newer])).toEqual({ winner: newer, losers: [current], version: 3 });
	});

	it('a copy without sync fields among synced copies is an edit of an older version', () => {
		const current = candidate('local', 'v3', 1, synced(3, 'v3'));
		const empty = candidate('b', '', 5, null);
		expect(decide([current, empty])).toEqual({ winner: empty, losers: [current], version: 4 });
	});

	it('unchanged copies of different versions: the highest version wins, whatever its time', () => {
		const behind = candidate('local', 'v1', 9, synced(1, 'v1'));
		const ahead = candidate('b', 'v2', 1, synced(2, 'v2'));
		expect(decide([behind, ahead])).toEqual({ winner: ahead, losers: [], version: 2 });
	});

	it('the note keeps its own copy of a content that a copy also has, and the newest time ranks it', () => {
		const b = candidate('b', 'same', 9, synced(1, 'v1'));
		const mine = candidate('local', 'same', 1, synced(1, 'v1'));
		const c = candidate('c', 'other', 5, synced(1, 'v1'));
		expect(decide([b, c, mine])).toEqual({ winner: mine, losers: [c], version: 2 });
	});
});

describe('path rules', () => {
	const win = new PathRules(nodePath.win32, 'win32');
	const mac = new PathRules(nodePath.posix, 'darwin');
	const linux = new PathRules(nodePath.posix, 'linux');

	it('Windows: absolute means a drive or UNC path, and paths compare without case', () => {
		expect(win.isAbsolutePath('C:\\Vault')).toBe(true);
		expect(win.isAbsolutePath('c:/vault')).toBe(true);
		expect(win.isAbsolutePath('\\\\server\\share')).toBe(true);
		expect(win.isAbsolutePath('\\folder')).toBe(false);
		expect(win.isAbsolutePath('/mnt/c/vault')).toBe(false);
		expect(win.key('C:\\A\\B.md')).toBe(win.key('c:\\a\\b.md'));
		expect(win.nameKey('Note.md')).toBe('note.md');
	});

	it('macOS ignores case, Linux does not, and both need absolute paths', () => {
		expect(mac.key('/A/B.md')).toBe(mac.key('/a/b.md'));
		expect(linux.key('/A/B.md')).not.toBe(linux.key('/a/b.md'));
		expect(linux.nameKey('Note.md')).toBe('Note.md');
		expect(linux.isAbsolutePath('/home/u/vault')).toBe(true);
		expect(linux.isAbsolutePath('home/u')).toBe(false);
	});
});

describe('small helpers', () => {
	it('asList turns YAML values into lists', () => {
		expect(asList(null)).toEqual([]);
		expect(asList(undefined)).toEqual([]);
		expect(asList('a')).toEqual(['a']);
		expect(asList(['a', 'b'])).toEqual(['a', 'b']);
	});

	it('errorCode and errorMessage read Node errors and anything else', () => {
		const err: NodeJS.ErrnoException = new Error('busy');
		err.code = 'EBUSY';
		expect(errorCode(err)).toBe('EBUSY');
		expect(errorCode('EBUSY')).toBeUndefined();
		expect(errorMessage(err)).toBe('busy');
		expect(errorMessage(42)).toBe('42');
	});
});
