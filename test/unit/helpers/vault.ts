import type { MarkdownView as MarkdownViewOriginal, TFile as TFileOriginal } from 'obsidian';
import { MarkdownView, TFile, type App } from 'obsidian-test-mocks/obsidian';
import { vi, type MockInstance } from 'vitest';
import { keepHeader } from './world';

// Writes a note through the vault, as Obsidian does after it sees the file change on disk
export async function edit(app: App, file: TFileOriginal, content: string, mtime?: number): Promise<void> {
	await app.vault.modify(TFile.fromOriginalType2__(file), content, mtime === undefined ? undefined : { mtime });
}

export async function read(app: App, file: TFileOriginal): Promise<string> {
	return app.vault.read(TFile.fromOriginalType2__(file));
}

// A person's edit in Obsidian: the new text, with the sync fields the note had, as the editor keeps them
export async function change(app: App, file: TFileOriginal, next: string, mtime?: number): Promise<void> {
	await edit(app, file, keepHeader(await read(app, file), next), mtime);
}

export function frontmatter(app: App, file: TFileOriginal): Record<string, unknown> | undefined {
	return app.metadataCache.getFileCache(TFile.fromOriginalType2__(file))?.frontmatter;
}

export async function rename(app: App, file: TFileOriginal, newPath: string): Promise<void> {
	await app.vault.rename(TFile.fromOriginalType2__(file), newPath);
}

export async function trash(app: App, file: TFileOriginal): Promise<void> {
	await app.fileManager.trashFile(TFile.fromOriginalType2__(file));
}

export interface OpenNote {
	view: MarkdownViewOriginal;
	save: MockInstance<() => Promise<void>>;
}

// Opens the note in the active editor. The mock editor starts empty and its save() writes nothing,
// so both are made to behave like Obsidian's.
export async function openInEditor(app: App, file: TFileOriginal, mode: 'source' | 'preview' = 'source'): Promise<OpenNote> {
	const leaf = app.workspace.getLeaf(true);
	await leaf.openFile(TFile.fromOriginalType2__(file));
	const view = leaf.view;
	if (!(view instanceof MarkdownView)) throw new Error('not a markdown view');
	view.editor.setValue(await read(app, file));
	vi.spyOn(view, 'getMode').mockReturnValue(mode);
	const save = vi.spyOn(view, 'save').mockImplementation(async () => {
		await edit(app, file, view.editor.getValue());
	});
	app.workspace.setActiveLeaf(leaf);
	return { view: view.asOriginalType7__(), save };
}
