import * as nodePath from 'path';
import { describe, expect, it, vi } from 'vitest';
import { errno } from './helpers/fake-io';
import { edit, openInEditor, read } from './helpers/vault';
import { A_BASE, A_ENTRY, A_FULL, A_REL, B_FULL, bodyOf, editOnDisk, fileOf, note, synced, useWorld } from './helpers/world';

const win = nodePath.win32;

describe('writing into the note open in the active editor', () => {
	const ctx = useWorld();
	const io = () => ctx.world.io;

	it('goes through the editor and replaces only the changed parts: the sync fields, and the text separately', async () => {
		const { appA, pA, fA } = await synced(ctx.world);
		const { view, save } = await openInEditor(appA, fA);
		const before = view.editor.getValue();
		const process = vi.spyOn(appA.vault, 'process');
		const replace = vi.spyOn(view.editor, 'replaceRange');
		editOnDisk(io(), B_FULL, note('v1 plus an added line'));
		await pA.engine.syncFile(fA);
		expect(bodyOf(await read(appA, fA))).toBe(note('v1 plus an added line'));
		expect(save).toHaveBeenCalledTimes(1);
		expect(process).not.toHaveBeenCalled();
		// The text: an insertion after "v1", which keeps everything before it in place
		const at = view.editor.offsetToPos(before.lastIndexOf('v1') + 2);
		expect(replace).toHaveBeenCalledWith(' plus an added line', at, at);
		// The sync fields: a change that ends inside the frontmatter
		expect(replace).toHaveBeenCalledTimes(2);
		const [, , to] = replace.mock.calls[1]!;
		expect(to!.line).toBeLessThan(at.line);
	});

	it('replaces only the changed parts also when the other copy has \\r\\n line breaks', async () => {
		const { appA, pA, fA } = await synced(ctx.world);
		const { view } = await openInEditor(appA, fA);
		const before = view.editor.getValue();
		const replace = vi.spyOn(view.editor, 'replaceRange');
		// An editor on Windows saved the other copy with \r\n line breaks. Obsidian's editor uses \n.
		editOnDisk(io(), B_FULL, note('v1 plus an added line').replace(/\n/g, '\r\n'));
		await pA.engine.syncFile(fA);
		const at = view.editor.offsetToPos(before.lastIndexOf('v1') + 2);
		expect(replace).toHaveBeenCalledWith(' plus an added line', at, at);
		expect(replace).toHaveBeenCalledTimes(2);
		expect(view.editor.getValue()).not.toContain('\r');
		expect(bodyOf(await read(appA, fA))).toBe(note('v1 plus an added line'));
	});

	it('replaces text appended or removed at the end as the difference only', async () => {
		const { appA, pA, fA } = await synced(ctx.world);
		const { view } = await openInEditor(appA, fA);
		const replace = vi.spyOn(view.editor, 'replaceRange');
		const end = view.editor.getValue().length;
		editOnDisk(io(), B_FULL, `${note('v1')}tail`);
		await pA.engine.syncFile(fA);
		expect(replace).toHaveBeenCalledWith('tail', view.editor.offsetToPos(end), view.editor.offsetToPos(end));
		const tailEnd = view.editor.getValue().length;
		const tailStart = view.editor.offsetToPos(tailEnd - 4);
		const tailEndPos = view.editor.offsetToPos(tailEnd);
		replace.mockClear();
		editOnDisk(io(), B_FULL, note('v1'));
		await pA.engine.syncFile(fA);
		expect(replace).toHaveBeenCalledWith('', tailStart, tailEndPos);
		expect(bodyOf(await read(appA, fA))).toBe(note('v1'));
	});

	it('uses vault.process in reading mode and for another note in the active editor', async () => {
		const { appA, pA, fA } = await synced(ctx.world);
		const { view, save } = await openInEditor(appA, fA, 'preview');
		const process = vi.spyOn(appA.vault, 'process');
		editOnDisk(io(), B_FULL, note('B edit'));
		await pA.engine.syncFile(fA);
		expect(process).toHaveBeenCalledTimes(1);
		expect(save).not.toHaveBeenCalled();
		// Obsidian reloads an open view after its file changed. The mock view does not.
		view.editor.setValue(await read(appA, fA));
		const other = await appA.vault.create('Other.md', 'other');
		await openInEditor(appA, other.asOriginalType2__());
		editOnDisk(io(), B_FULL, note('B again'));
		await pA.engine.syncFile(fA);
		expect(process).toHaveBeenCalledTimes(2);
		expect(bodyOf(await read(appA, fA))).toBe(note('B again'));
	});

	it('backs off when the note changed on disk or in the editor since it was read', async () => {
		const { appA, pA, fA } = await synced(ctx.world);
		const syncedNote = await read(appA, fA);
		const { view, save } = await openInEditor(appA, fA);
		editOnDisk(io(), B_FULL, note('B edit'));
		const vaultRead = appA.vault.read.bind(appA.vault);
		const reads = vi.spyOn(appA.vault, 'read');
		reads.mockImplementationOnce(vaultRead).mockImplementationOnce(async (file) => {
			await edit(appA, fA, note('saved meanwhile'));
			return vaultRead(file);
		});
		await pA.engine.syncFile(fA);
		expect(save).not.toHaveBeenCalled();
		expect(await read(appA, fA)).toBe(note('saved meanwhile'));
		expect(pA.engine.debounceTimers.has(fA.path)).toBe(true);
		pA.engine.unload();

		// The note as it was synced, and an editor that matches it
		await edit(appA, fA, syncedNote);
		view.editor.setValue(syncedNote);
		reads.mockImplementationOnce(vaultRead).mockImplementationOnce(async (file) => {
			view.editor.setValue('typed meanwhile');
			return vaultRead(file);
		});
		await pA.engine.syncFile(fA);
		expect(save).not.toHaveBeenCalled();
		expect(view.editor.getValue()).toBe('typed meanwhile');
		expect(pA.engine.debounceTimers.has(fA.path)).toBe(true);
	});

	it('a copy in this vault open in the editor is written through it, also when it had no frontmatter', async () => {
		const L = [A_ENTRY, 'Vault A/Archive/topic'];
		const appA = ctx.world.vault(A_BASE, { [A_REL]: note('v1', L) });
		await appA.vault.createFolder('Archive');
		const archivePath = win.join(A_BASE, 'Archive', 'topic.md');
		// An older draft that was made by hand before the copy was listed
		io().put(archivePath, 'draft\n', 1);
		await new Promise((resolve) => window.setTimeout(resolve, 0));
		const pA = await ctx.world.plugin(appA);
		const archive = fileOf(appA, 'Archive/topic.md');
		const { save } = await openInEditor(appA, archive);
		await pA.engine.syncFile(fileOf(appA, A_REL));
		expect(save).toHaveBeenCalledTimes(1);
		expect(bodyOf(await read(appA, archive))).toBe(note('v1', L));
		expect([...new Set(io().writeLog)].filter((p) => /sync-conflict/.test(p)).map((p) => io().content(p))).toEqual(['draft\n']);
	});

	it('reports a failing editor save', async () => {
		const { appA, pA, fA } = await synced(ctx.world);
		const { save } = await openInEditor(appA, fA);
		save.mockRejectedValueOnce(errno('EPERM', A_FULL));
		editOnDisk(io(), B_FULL, note('B edit'));
		await pA.engine.syncFile(fA);
		expect(ctx.count(/EPERM/)).toBe(1);
	});
});
