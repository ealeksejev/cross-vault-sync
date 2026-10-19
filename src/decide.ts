// Which copy of a note wins. Pure function, no I/O.
import type { SyncHeader } from './header';

// One copy of a note as a sync reads it
export interface Candidate {
	isLocal: boolean;
	key: string;
	fullPath: string;
	content: string;
	// Hash of the whole file, to tell before a write whether it changed since it was read
	hash: string;
	// Hash of the note without its sync fields, which sync_hash records
	bodyHash: string;
	header: SyncHeader | null;
	mtime: number;
}

export interface Decision {
	winner: Candidate;
	losers: Candidate[];
	// The sync_version the copies get: the winner's own when it is unchanged, otherwise a new one
	version: number;
}

// The copies that have one content: the one that stands for them, their newest time, and whether one of them
// is unchanged since the sync that wrote it
interface ContentGroup {
	copy: Candidate;
	mtime: number;
	unchanged: boolean;
}

// A copy was edited after the sync that wrote it when it no longer matches its own sync_hash. A copy without
// sync fields counts as edited too.
export function edited(candidate: Candidate): boolean {
	return candidate.header === null || candidate.header.hash !== candidate.bodyHash;
}

// Every copy tells by itself whether it changed since its last sync, so no copy needs another's state:
// - one edited copy, or several with the same content, wins quietly
// - copies edited in different ways are a conflict
// - an edit of an older version than the newest sync is a conflict with that sync
// - unchanged copies of different versions: the highest version wins, the others missed a sync
// Modification times only decide between conflicting versions: Obsidian Sync and OneDrive can stamp a
// downloaded edit with its original, older time.
export function decide(candidates: [Candidate, ...Candidate[]]): Decision {
	const latest = Math.max(0, ...candidates.map((c) => c.header?.version ?? 0));
	const changes = candidates.filter(edited);
	const current = candidates.filter((c) => c.header !== null && c.header.hash === c.bodyHash && c.header.version === latest);
	const stale = changes.some((c) => (c.header?.version ?? 0) < latest);
	const contenders = changes.length === 0 ? current : stale ? [...changes, ...current] : changes;

	// The competing versions by content, ranked by their newest copy. The note keeps its own copy of a content
	// that a copy also has, and a content that some copy has unchanged keeps its version.
	const groups = new Map<string, ContentGroup>();
	for (const candidate of contenders) {
		const group = groups.get(candidate.bodyHash);
		if (!group) {
			groups.set(candidate.bodyHash, { copy: candidate, mtime: candidate.mtime, unchanged: !edited(candidate) });
			continue;
		}
		if (candidate.isLocal || (!group.copy.isLocal && candidate.mtime > group.copy.mtime)) group.copy = candidate;
		group.mtime = Math.max(group.mtime, candidate.mtime);
		group.unchanged ||= !edited(candidate);
	}
	// Never empty: without edits, the copies of the latest version are unchanged
	const [first, ...rest] = Array.from(groups.values()).sort((a, b) => b.mtime - a.mtime) as [ContentGroup, ...ContentGroup[]];
	return { winner: first.copy, losers: rest.map((group) => group.copy), version: first.unchanged ? latest : latest + 1 };
}
