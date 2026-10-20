import { App, CapacitorAdapter, TextComponent } from 'obsidian-test-mocks/obsidian';
import { describe, expect, it, vi } from 'vitest';
import { waitForMetadata } from '../../src/targets';
import { AddSyncTargetModal, LAST_TARGET_KEY } from '../../src/ui/add-target-modal';
import { edit, frontmatter, read } from './helpers/vault';
import { A_BASE, A_ENTRY, A_REL, B_BASE, B_ENTRY, B_FULL, fileOf, sleep, useWorld } from './helpers/world';

describe('add sync target dialog', () => {
	const ctx = useWorld();

	async function setup(content: string) {
		const app = ctx.world.vault(A_BASE, { [A_REL]: content });
		const appB = ctx.world.vault(B_BASE, {});
		await appB.vault.createFolder('Notes');
		const plugin = await ctx.world.plugin(app);
		const file = fileOf(app, A_REL);
		return { app, plugin, file, modal: new AddSyncTargetModal(app.asOriginalType__(), plugin, file) };
	}

	it('checks the entry, adds a folder target, closes after the sync and remembers the folder', async () => {
		const { app, plugin, modal, file } = await setup('just text\n');
		const texts = vi.spyOn(TextComponent, 'create__');
		const close = vi.spyOn(modal, 'close');
		// The mock open() closes the dialog on the next tick, so render it directly
		modal.onOpen();
		const input = (texts.mock.results[0]!.value as TextComponent).inputEl;
		expect(modal.titleEl.textContent).toBe('Add sync target');
		expect(modal.contentEl.querySelector('h1, h2, h3')).toBeNull();
		expect(modal.contentEl.querySelector('p')?.textContent).toMatch(/"topic"/);
		expect(input.value).toBe('');
		expect(input.hasClass('cross-vault-sync-path-input')).toBe(true);
		expect(input.closest('.setting-item')?.hasClass('cross-vault-sync-path-setting')).toBe(true);
		expect(input.getAttribute('style')).toBeNull();
		const [cancel, add] = Array.from(modal.contentEl.querySelectorAll('button'));
		expect(add?.textContent).toBe('Add and sync');

		const typeAndAdd = async (value: string) => {
			input.value = value;
			input.dispatchEvent(new Event('input'));
			add!.click();
			await sleep(30);
		};
		await typeAndAdd('');
		await typeAndAdd('Vault B');
		expect(close).not.toHaveBeenCalled();
		expect(ctx.count(/Enter a vault name and a path/)).toBe(2);
		await typeAndAdd('Vault B/Notes/');
		expect(close).toHaveBeenCalledTimes(1);
		expect(modal.contentEl.children).toHaveLength(0);
		// The copy got the note's name, and the folder entry now names it exactly
		expect(frontmatter(app, file)?.['sync_targets']).toEqual([A_ENTRY, B_ENTRY]);
		await plugin.engine.syncFile(file);
		expect(ctx.world.io.content(B_FULL)).toBe(await read(app, file));
		expect(app.loadLocalStorage(LAST_TARGET_KEY)).toBe('Vault B/Notes/');

		modal.onOpen();
		expect((texts.mock.results.at(-1)!.value as TextComponent).inputEl.value).toBe('Vault B/Notes/');
		Array.from(modal.contentEl.querySelectorAll('button'))[0]!.click();
		expect(close).toHaveBeenCalledTimes(2);
		expect(cancel).toBeDefined();
	});

	it('merges with scalar and list values and drops duplicates and junk', async () => {
		const { app, modal, file } = await setup(`---\nsync_targets: ${B_ENTRY}\n---\nbody\n`);
		modal.target = 'vault b/notes/TOPIC';
		expect(await modal.addAndSync()).toBe(true);
		expect(frontmatter(app, file)?.['sync_targets']).toEqual([A_ENTRY, B_ENTRY]);
		expect(app.loadLocalStorage(LAST_TARGET_KEY)).toBe('vault b/notes/');
		await edit(app, file, `---\nsync_targets:\n  - 42\n  - ''\n  - ${A_ENTRY}\n  - relative.md\n  - relative.md\n---\nbody\n`);
		modal.target = 'Vault B/topic';
		expect(await modal.addAndSync()).toBe(true);
		expect(frontmatter(app, file)?.['sync_targets']).toEqual([A_ENTRY, 'relative.md', 'Vault B/topic']);
		expect(app.loadLocalStorage(LAST_TARGET_KEY)).toBe('Vault B/');
	});

	it('reports a name without a folder, an ambiguous name and a path out of the vault', async () => {
		const { plugin, modal } = await setup('body\n');
		modal.target = 'Other/Notes/';
		expect(await modal.addAndSync()).toBe(false);
		expect(ctx.count(/"Other" has no folder on this computer/)).toBe(1);
		plugin.folders.register('Vault B', 'D:\\Copy\\Vault B');
		modal.target = 'Vault B/Notes/';
		expect(await modal.addAndSync()).toBe(false);
		expect(ctx.count(/More than one folder on this computer belongs to a vault named "Vault B"/)).toBe(1);
		modal.target = 'Vault A/../Other/topic';
		expect(await modal.addAndSync()).toBe(false);
		expect(ctx.count(/must stay inside the vault/)).toBe(1);
	});

	it('reports a failed frontmatter update', async () => {
		const { app, modal } = await setup('body\n');
		vi.spyOn(app.fileManager, 'processFrontMatter').mockRejectedValueOnce(new Error('bad yaml'));
		modal.target = B_ENTRY;
		expect(await modal.addAndSync()).toBe(false);
		vi.spyOn(app.fileManager, 'processFrontMatter').mockRejectedValueOnce('not an error');
		expect(await modal.addAndSync()).toBe(false);
		expect(ctx.count(/Could not update frontmatter: bad yaml/)).toBe(1);
		expect(ctx.count(/Could not update frontmatter: not an error/)).toBe(1);
	});

	it('does nothing without a vault folder on disk', async () => {
		const app = App.createConfigured__({ adapter: CapacitorAdapter.create__('mobile', {}), files: { [A_REL]: 'body\n' } });
		// Added by hand, so it stays when the plugin forgets registered folders that are gone
		ctx.world.folder('Vault B', B_BASE);
		const plugin = await ctx.world.plugin(app);
		const modal = new AddSyncTargetModal(app.asOriginalType__(), plugin, fileOf(app, A_REL));
		modal.target = B_ENTRY;
		expect(await modal.addAndSync()).toBe(false);
		expect(ctx.notices).toEqual([]);
	});
});

describe('waitForMetadata', () => {
	const ctx = useWorld();

	it('resolves on a change of that note, or after the timeout, and removes its listener', async () => {
		const app = ctx.world.vault(A_BASE, { 'a.md': 'a', 'b.md': 'b' });
		const a = fileOf(app, 'a.md');
		const b = fileOf(app, 'b.md');
		const offref = vi.spyOn(app.metadataCache, 'offref');
		let done = false;
		const waiting = waitForMetadata(app.asOriginalType__(), a, 1000).then(() => {
			done = true;
		});
		app.metadataCache.trigger('changed', b);
		await sleep(10);
		expect(done).toBe(false);
		app.metadataCache.trigger('changed', a);
		await waiting;
		expect(offref).toHaveBeenCalledTimes(1);
		const started = Date.now();
		await waitForMetadata(app.asOriginalType__(), a, 30);
		expect(Date.now() - started).toBeGreaterThanOrEqual(25);
		expect(offref).toHaveBeenCalledTimes(2);
	});
});
