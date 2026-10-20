import { TextComponent } from 'obsidian-test-mocks/obsidian';
import { describe, expect, it, vi } from 'vitest';
import { AddVaultFolderModal } from '../../src/ui/add-vault-folder-modal';
import { A_BASE, B_BASE, sleep, useWorld } from './helpers/world';

describe('add vault folder dialog', () => {
	const ctx = useWorld();

	it('checks the name and the folder, saves the folder as added by hand and closes', async () => {
		const app = ctx.world.vault(A_BASE, {});
		// Vault B exists on this computer but was never opened with the plugin
		ctx.world.vault(B_BASE, {}, { registered: false });
		const plugin = await ctx.world.plugin(app);
		const added = vi.fn();
		const modal = new AddVaultFolderModal(app.asOriginalType__(), plugin, added);
		const texts = vi.spyOn(TextComponent, 'create__');
		const close = vi.spyOn(modal, 'close');
		// The mock open() closes the dialog on the next tick, so render it directly
		modal.onOpen();
		const [name, folder] = texts.mock.results.map((result) => (result.value as TextComponent).inputEl);
		expect(modal.titleEl.textContent).toBe('Add folder');
		expect(folder!.hasClass('cross-vault-sync-path-input')).toBe(true);
		expect(folder!.closest('.setting-item')?.hasClass('cross-vault-sync-path-setting')).toBe(true);
		expect(name!.closest('.setting-item')?.hasClass('cross-vault-sync-path-setting')).toBe(false);
		const [cancel, add] = Array.from(modal.contentEl.querySelectorAll('button'));
		expect(add?.textContent).toBe('Add');

		const type = (input: HTMLInputElement, value: string) => {
			input.value = value;
			input.dispatchEvent(new Event('input'));
		};
		const submit = async () => {
			add!.click();
			await sleep(20);
		};
		await submit();
		expect(ctx.count(/Enter a name/)).toBe(1);
		type(name!, ' Vault B ');
		type(folder!, 'relative\\Vault B');
		await submit();
		expect(ctx.count(/absolute path of the folder/)).toBe(1);
		type(folder!, 'D:\\Missing');
		await submit();
		expect(ctx.count(/Folder not found: D:\\Missing/)).toBe(1);
		expect(close).not.toHaveBeenCalled();
		type(folder!, `"${B_BASE}"`);
		await submit();
		expect(plugin.folders.lookup('Vault B')).toEqual({ folder: B_BASE });
		expect(plugin.folders.list().find((entry) => entry.name === 'Vault B')?.manual).toBe(true);
		expect(added).toHaveBeenCalledTimes(1);
		expect(close).toHaveBeenCalledTimes(1);
		expect(modal.contentEl.children).toHaveLength(0);

		modal.onOpen();
		Array.from(modal.contentEl.querySelectorAll('button'))[0]!.click();
		expect(close).toHaveBeenCalledTimes(2);
		expect(cancel).toBeDefined();
	});
});
