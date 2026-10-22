import { MarkdownView, type TFile } from 'obsidian';
import type { SyncHost } from './host';

// The editor uses \n line breaks even when the file on disk uses \r\n
export function sameText(a: string, b: string): boolean {
	return a.replace(/\r\n/g, '\n') === b.replace(/\r\n/g, '\n');
}

interface Change {
	from: number;
	to: number;
	text: string;
}

// The one range of current that differs from next, between their common start and common end. offset moves it
// to where current starts in the whole text.
function changedRange(current: string, next: string, offset: number): Change {
	let start = 0;
	while (start < current.length && start < next.length && current[start] === next[start]) start++;
	let end = 0;
	while (end < current.length - start && end < next.length - start && current[current.length - 1 - end] === next[next.length - 1 - end]) end++;
	return { from: offset + start, to: offset + current.length - end, text: next.slice(start, next.length - end) };
}

// Where the frontmatter ends, after its closing "---" line, or 0 without one
function frontmatterLength(text: string): number {
	return /^---\r?\n(?:.*\r?\n)*?---(?:\r?\n|$)/.exec(text)?.[0].length ?? 0;
}

// The changes that turn current into next. The frontmatter, where a sync rewrites its own fields, and the
// note below it change separately: a cursor in text that is the same in both stays where it is.
function changes(current: string, next: string): Change[] {
	const [a, b] = [frontmatterLength(current), frontmatterLength(next)];
	const parts = a > 0 && b > 0 ? [changedRange(current.slice(0, a), next.slice(0, b), 0), changedRange(current.slice(a), next.slice(b), a)] : [changedRange(current, next, 0)];
	return parts.filter((change) => change.from !== change.to || change.text !== '');
}

export function hasUnsavedChanges(host: SyncHost, file: TFile, diskContent: string): boolean {
	return host.app.workspace.getLeavesOfType('markdown').some((leaf) =>
		leaf.view instanceof MarkdownView &&
		leaf.view.file === file &&
		!sameText(leaf.view.editor.getValue(), diskContent)
	);
}

// Writes the winning content into a note of this vault and returns false if the note changed since it
// was read. Both paths go through Obsidian, so Obsidian Sync sees the change. A note open in the active
// editor is changed through the editor, which keeps the cursor, selection and folds. mtime, when given, stays
// the note's modification time; the editor's save sets its own.
export async function writeLocal(host: SyncHost, file: TFile, expectedHash: string, content: string, mtime?: number): Promise<boolean> {
	const view = host.app.workspace.getActiveViewOfType(MarkdownView);
	if (view && view.file === file && view.getMode() === 'source') {
		const editor = view.editor;
		const disk = await host.app.vault.read(file);
		const current = editor.getValue();
		// Changed on disk, or typed into the editor, since it was read
		if (host.hash(disk) !== expectedHash || !sameText(current, disk)) return false;
		// Replace only the parts that differ, the last first so the offsets of the earlier one stay valid. The
		// editor's text has \n line breaks, so content with \r\n would differ at every line break.
		for (const change of changes(current, content.replace(/\r\n/g, '\n')).reverse()) {
			editor.replaceRange(change.text, editor.offsetToPos(change.from), editor.offsetToPos(change.to));
		}
		await view.save();
		return true;
	}
	// vault.process re-reads the note atomically
	let raced = false;
	await host.app.vault.process(
		file,
		(data) => {
			if (host.hash(data) !== expectedHash) {
				raced = true;
				return data;
			}
			return content;
		},
		mtime === undefined ? undefined : { mtime }
	);
	return !raced;
}
