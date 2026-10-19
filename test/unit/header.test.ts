import { describe, expect, it } from 'vitest';
import { readHeader, withoutHeader, writeHeader, type SyncHeader } from '../../src/header';

const HASH = 'a41f'.repeat(16);
const header: SyncHeader = { version: 3, hash: HASH, known: ['Vault A/Projects/topic', 'Vault B/Notes: "topic"'] };
const plain = '---\ntags: x\nsync_targets:\n  - Vault A/Projects/topic\n---\nbody\n';

describe('sync fields in the frontmatter', () => {
	it('are written at the end of the frontmatter, the hash and entries quoted, and read back', () => {
		const written = writeHeader(plain, header);
		expect(written).toBe(
			`---\ntags: x\nsync_targets:\n  - Vault A/Projects/topic\nsync_version: 3\nsync_hash: "${HASH}"\nsync_known:\n  - "Vault A/Projects/topic"\n  - "Vault B/Notes: \\"topic\\""\n---\nbody\n`
		);
		expect(readHeader(written)).toEqual(header);
		expect(withoutHeader(written)).toBe(plain);
	});

	it('replace the earlier fields, wherever they are, and keep the line breaks of the note', () => {
		const earlier = `---\r\nsync_version: 1\r\ntags: x\r\nsync_known: []\r\nsync_hash: ${'0'.repeat(64)}\r\n---\r\nbody\r\n`;
		const written = writeHeader(earlier, { version: 2, hash: HASH, known: [] });
		expect(written).toBe(`---\r\ntags: x\r\nsync_version: 2\r\nsync_hash: "${HASH}"\r\nsync_known:\r\n---\r\nbody\r\n`);
		expect(withoutHeader(written)).toBe('---\ntags: x\n---\nbody\n');
	});

	it('get a frontmatter of their own in a note without one', () => {
		const written = writeHeader('just text\n', { version: 1, hash: HASH, known: ['A/b'] });
		expect(written).toBe(`---\nsync_version: 1\nsync_hash: "${HASH}"\nsync_known:\n  - "A/b"\n---\njust text\n`);
		expect(readHeader(written)).toEqual({ version: 1, hash: HASH, known: ['A/b'] });
	});

	it('are read in the forms Obsidian writes when it rewrites the frontmatter', () => {
		const rewritten = (known: string) => `---\nsync_version: 7\nsync_hash: '${HASH}'\nsync_known: ${known}\nnext: 1\n---\n`;
		expect(readHeader(rewritten("['It''s', \"b\", c]"))?.known).toEqual(["It's", 'b', 'c']);
		expect(readHeader(rewritten('single'))?.known).toEqual(['single']);
		expect(readHeader(rewritten('\n  - one\n  -\n- two'))?.known).toEqual(['one', 'two']);
		expect(readHeader(`---\nsync_version: 7\nsync_hash: ${HASH}\n---\n`)).toEqual({ version: 7, hash: HASH, known: [] });
		// A double-quoted value that is no JSON string, such as a YAML escape JSON lacks
		expect(readHeader(`---\nsync_version: "7"\nsync_hash: "${HASH}"\nsync_known:\n  - "a\\x41"\n---\n`)?.known).toEqual(['a\\x41']);
	});

	it('are missing without both a valid version and a SHA-256 hash, or without a closed frontmatter', () => {
		for (const fields of [
			`sync_hash: "${HASH}"`,
			`sync_version: 1`,
			`sync_version: 0\nsync_hash: "${HASH}"`,
			`sync_version: 1.5\nsync_hash: "${HASH}"`,
			`sync_version: x\nsync_hash: "${HASH}"`,
			`sync_version: 1\nsync_hash: ".inf"`,
			`sync_version: 1\nsync_hash: "${HASH.toUpperCase()}"`,
		]) {
			expect(readHeader(`---\n${fields}\n---\nbody\n`)).toBeNull();
		}
		expect(readHeader('body\n')).toBeNull();
		expect(readHeader(`---\nsync_version: 1\nsync_hash: "${HASH}"\nbody\n`)).toBeNull();
		expect(withoutHeader(`---\nsync_version: 1\nbody`)).toBe('---\nsync_version: 1\nbody');
	});
});
