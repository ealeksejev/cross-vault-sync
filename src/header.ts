// The sync state of a note lives in the note itself, like the header of a network packet. Every sync that
// writes a note writes three fields into its frontmatter:
//   sync_version  the number of the sync that wrote this content
//   sync_hash     the SHA-256 hash of the note without these three fields
//   sync_known    the entries that had a copy at that sync
// A copy whose content no longer matches its own sync_hash was edited after that sync.

export const VERSION_KEY = 'sync_version';
export const HASH_KEY = 'sync_hash';
export const KNOWN_KEY = 'sync_known';

export interface SyncHeader {
	version: number;
	hash: string;
	known: string[];
}

const OWN_FIELD = /^(sync_version|sync_hash|sync_known)\s*:/;
const SHA256 = /^[0-9a-f]{64}$/;

// The lines of a note and the frontmatter between its two "---" lines, or null without frontmatter.
// Line breaks are compared as \n: the editor uses \n even where the file on disk has \r\n.
function split(content: string): { lines: string[]; end: number | null } {
	const lines = content.replace(/\r\n/g, '\n').split('\n');
	if (lines[0]!.trimEnd() !== '---') return { lines, end: null };
	const end = lines.findIndex((line, i) => i > 0 && line.trimEnd() === '---');
	return { lines, end: end === -1 ? null : end };
}

// A field's lines: its key line and, for a block list, the indented or "- " lines after it
function fieldEnd(lines: string[], start: number, end: number): number {
	let i = start + 1;
	while (i < end && /^(\s|-\s|-$)/.test(lines[i]!)) i++;
	return i;
}

// The note with the three fields removed, with \n line breaks. sync_hash is the hash of this.
export function withoutHeader(content: string): string {
	const { lines, end } = split(content);
	if (end === null) return lines.join('\n');
	const kept = [lines[0]!];
	let i = 1;
	while (i < end) {
		if (OWN_FIELD.test(lines[i]!)) {
			i = fieldEnd(lines, i, end);
			continue;
		}
		kept.push(lines[i]!);
		i++;
	}
	return [...kept, ...lines.slice(end)].join('\n');
}

// A YAML scalar as written by this plugin ("..." or plain) or by Obsidian ('...' or plain)
function scalar(raw: string): string {
	const text = raw.trim();
	if (text.startsWith('"')) {
		try {
			return String(JSON.parse(text));
		} catch {
			return text.slice(1, -1);
		}
	}
	if (text.startsWith("'")) return text.slice(1, -1).replace(/''/g, "'");
	return text;
}

function listOf(lines: string[], start: number, end: number): string[] {
	const inline = lines[start]!.slice(lines[start]!.indexOf(':') + 1).trim();
	if (inline.startsWith('[')) {
		return inline.slice(1, inline.lastIndexOf(']')).split(',').map(scalar).filter(Boolean);
	}
	if (inline) return [scalar(inline)];
	return lines
		.slice(start + 1, fieldEnd(lines, start, end))
		.map((line) => line.trim())
		.filter((line) => line.startsWith('-'))
		.map((line) => scalar(line.slice(1)))
		.filter(Boolean);
}

// The three fields, or null when the note has no valid version and hash
export function readHeader(content: string): SyncHeader | null {
	const { lines, end } = split(content);
	if (end === null) return null;
	let version: number | null = null;
	let hash: string | null = null;
	let known: string[] = [];
	for (let i = 1; i < end; i++) {
		const line = lines[i]!;
		const value = line.slice(line.indexOf(':') + 1);
		if (line.startsWith(`${VERSION_KEY}:`)) version = Number(scalar(value));
		else if (line.startsWith(`${HASH_KEY}:`)) hash = scalar(value);
		else if (line.startsWith(`${KNOWN_KEY}:`)) known = listOf(lines, i, end);
	}
	if (version === null || !Number.isInteger(version) || version < 1 || hash === null || !SHA256.test(hash)) return null;
	return { version, hash, known };
}

// The note with these three fields, written at the end of its frontmatter. The hash is quoted: unquoted,
// Obsidian's processFrontMatter reads a hash like "1234e5678" as a number and writes it back as ".inf".
export function writeHeader(content: string, header: SyncHeader): string {
	const eol = content.includes('\r\n') ? '\r\n' : '\n';
	const fields = [
		`${VERSION_KEY}: ${header.version}`,
		`${HASH_KEY}: ${JSON.stringify(header.hash)}`,
		`${KNOWN_KEY}:`,
		...header.known.map((entry) => `  - ${JSON.stringify(entry)}`),
	];
	const { lines, end } = split(withoutHeader(content));
	const result = end === null ? ['---', ...fields, '---', ...lines] : [...lines.slice(0, end), ...fields, ...lines.slice(end)];
	return result.join(eol);
}
