import type { TFile as TFileOriginal } from 'obsidian';
import type { App } from 'obsidian-test-mocks/obsidian';
import { describe, expect, it } from 'vitest';
import { errno } from './helpers/fake-io';
import { edit, read } from './helpers/vault';
import { A_BASE, B_BASE, autoSync, bodyOf, fileOf, keepHeader, note, settle, useWorld } from './helpers/world';

// Conflicts that nobody caused, found in real use. Automatic sync is on and Obsidian's file events start
// every sync, as in Obsidian: no test chooses which note syncs or when.
describe('no false conflicts', () => {
	const ctx = useWorld();
	const io = () => ctx.world.io;
	const backups = () => [...new Set(io().writeLog)].filter((p) => /\.sync-conflict-/.test(p) && io().exists(p));
	const nameOf = (base: string) => io().path.basename(base);

	// A person's edit in Obsidian: the editor keeps the frontmatter the plugin wrote
	async function change(app: App, file: TFileOriginal, next: string): Promise<void> {
		await edit(app, file, keepHeader(await read(app, file), next));
	}

	async function bodiesOf(app: App, paths: string[]): Promise<string[]> {
		return Promise.all(paths.map(async (rel) => bodyOf(await read(app, fileOf(app, rel)))));
	}

	// Vault A: a note and its copy in Archive that have been in sync, and an empty folder Company
	async function pairInOneVault() {
		const vault = nameOf(A_BASE);
		const pair = [`${vault}/topic`, `${vault}/Archive/topic`];
		const app = ctx.world.vault(A_BASE, { 'topic.md': note('v1', pair), 'Archive/topic.md': note('v1', pair) });
		await app.vault.createFolder('Company');
		const plugin = await ctx.world.plugin(app);
		await plugin.engine.syncFile(fileOf(app, 'topic.md'));
		return { vault, pair, app, plugin };
	}

	// Obsidian reports the plugin's write of the old copy either while the plugin is still replacing the folder
	// entry or after it. Both orders must end without a conflict.
	for (const events of ['during', 'after'] as const) {
		it(`a third copy added as a folder entry in the same vault, write reported ${events} the sync`, async () => {
			const { vault, pair, app, plugin } = await pairInOneVault();
			io().events = events;
			autoSync(plugin);
			await change(app, fileOf(app, 'topic.md'), note('v1', [...pair, `${vault}/Company/`]));
			await settle(plugin);

			const exact = [...pair, `${vault}/Company/topic`];
			expect(await bodiesOf(app, ['topic.md', 'Archive/topic.md', 'Company/topic.md'])).toEqual(Array(3).fill(note('v1', exact)));
			expect(backups()).toEqual([]);
			expect(ctx.count(/edited in more than one place/)).toBe(0);
		});

		it(`a third copy added as a folder entry, with the copies in two vaults, write reported ${events} the sync`, async () => {
			const [a, b] = [nameOf(A_BASE), nameOf(B_BASE)];
			const pair = [`${a}/topic`, `${b}/topic`];
			const appA = ctx.world.vault(A_BASE, { 'topic.md': note('v1', pair) });
			const appB = ctx.world.vault(B_BASE, { 'topic.md': note('v1', pair) });
			await appB.vault.createFolder('Archive');
			const pA = await ctx.world.plugin(appA);
			const pB = await ctx.world.plugin(appB);
			await pA.engine.syncFile(fileOf(appA, 'topic.md'));
			io().events = events;
			autoSync(pA, pB);
			await change(appA, fileOf(appA, 'topic.md'), note('v1', [...pair, `${b}/Archive/`]));
			await settle(pA, pB);

			const exact = [...pair, `${b}/Archive/topic`];
			expect([...(await bodiesOf(appA, ['topic.md'])), ...(await bodiesOf(appB, ['topic.md', 'Archive/topic.md']))]).toEqual(Array(3).fill(note('v1', exact)));
			expect(backups()).toEqual([]);
			expect(ctx.count(/edited in more than one place/)).toBe(0);
		});
	}

	it('an edit made right after a sync, before the copies it wrote have run their own sync', async () => {
		const vault = nameOf(A_BASE);
		const three = [`${vault}/topic`, `${vault}/Archive/topic`, `${vault}/Company/topic`];
		const app = ctx.world.vault(A_BASE, { 'topic.md': note('Hello', three), 'Archive/topic.md': note('Hello', three), 'Company/topic.md': note('Hello', three) });
		const plugin = await ctx.world.plugin(app);
		await plugin.engine.syncFile(fileOf(app, 'topic.md'));
		autoSync(plugin);

		await change(app, fileOf(app, 'topic.md'), note('Hello!', three));
		// The note's own sync has written both copies. Obsidian reported those writes, so their syncs are pending.
		for (let i = 0; i < 40 && !(await bodiesOf(app, ['Company/topic.md']))[0]!.includes('Hello!'); i++) await new Promise((r) => window.setTimeout(r, 25));
		expect(plugin.engine.debounceTimers.size).toBeGreaterThan(0);
		await change(app, fileOf(app, 'topic.md'), note('Hello!!', three));
		await settle(plugin);

		expect(await bodiesOf(app, ['topic.md', 'Archive/topic.md', 'Company/topic.md'])).toEqual(Array(3).fill(note('Hello!!', three)));
		expect(backups()).toEqual([]);
		expect(ctx.count(/edited in more than one place/)).toBe(0);
	});

	it('a copy in another vault that missed a sync takes the newer version when it syncs later', async () => {
		const [a, b] = [nameOf(A_BASE), nameOf(B_BASE)];
		const three = [`${a}/topic`, `${a}/Archive/topic`, `${b}/Company/topic`];
		const appA = ctx.world.vault(A_BASE, { 'topic.md': note('v1', three), 'Archive/topic.md': note('v1', three) });
		const appB = ctx.world.vault(B_BASE, { 'Company/topic.md': note('v1', three) });
		const pA = await ctx.world.plugin(appA);
		const pB = await ctx.world.plugin(appB);
		await pA.engine.syncFile(fileOf(appA, 'topic.md'));
		autoSync(pA, pB);
		// Vault A cannot write vault B's copy for a while, for example while OneDrive holds it
		const company = io().path.join(B_BASE, 'Company', 'topic.md');
		io().hooks.beforeWrite = (fullPath) => {
			if (io().key(fullPath) === io().key(company)) throw errno('EROFS', fullPath);
		};
		await change(appA, fileOf(appA, 'topic.md'), note('v2', three));
		await settle(pA, pB);
		expect(bodyOf(io().content(company))).toBe(note('v1', three));

		io().hooks = {};
		appB.workspace.trigger('file-open', fileOf(appB, 'Company/topic.md'));
		await settle(pA, pB);
		expect([...(await bodiesOf(appA, ['topic.md', 'Archive/topic.md'])), ...(await bodiesOf(appB, ['Company/topic.md']))]).toEqual(Array(3).fill(note('v2', three)));
		expect(backups()).toEqual([]);
		expect(ctx.count(/edited in more than one place/)).toBe(0);
	});

	// A folder entry gives the copy in that folder the note's name. Any other note in the folder that carries the
	// same list, such as a conflict backup or a duplicate, must not count the folder entry as its own.
	for (const other of ['topic.sync-conflict-0123abcd.md', 'topic 1.md']) {
		it(`opening ${other} in a folder that a folder entry names syncs nothing`, async () => {
			const vault = nameOf(A_BASE);
			const list = [`${vault}/topic`, `${vault}/Company/`];
			const app = ctx.world.vault(A_BASE, { 'topic.md': note('v1', list), 'Company/topic.md': note('v1', list), [`Company/${other}`]: note('old', list) });
			const plugin = await ctx.world.plugin(app);
			autoSync(plugin);
			const writes = io().writeLog.length;

			app.workspace.trigger('file-open', fileOf(app, `Company/${other}`));
			await settle(plugin);
			expect(io().writeLog.slice(writes)).toEqual([]);
			expect(await bodiesOf(app, ['topic.md', 'Company/topic.md', `Company/${other}`])).toEqual([note('v1', list), note('v1', list), note('old', list)]);
		});
	}

	it('edits in two copies are still a conflict, and the other version is kept', async () => {
		const [a, b] = [nameOf(A_BASE), nameOf(B_BASE)];
		const pair = [`${a}/topic`, `${b}/topic`];
		const appA = ctx.world.vault(A_BASE, { 'topic.md': note('v1', pair) });
		const appB = ctx.world.vault(B_BASE, { 'topic.md': note('v1', pair) });
		const pA = await ctx.world.plugin(appA);
		await ctx.world.plugin(appB);
		await pA.engine.syncFile(fileOf(appA, 'topic.md'));
		// Vault B is closed: its copy is edited on another computer and arrives later
		const bFull = io().path.join(B_BASE, 'topic.md');
		io().put(bFull, keepHeader(io().content(bFull), note('edited in B', pair)));
		autoSync(pA);
		await change(appA, fileOf(appA, 'topic.md'), note('edited in A', pair));
		await settle(pA);

		expect(bodyOf(io().content(bFull))).toBe(note('edited in A', pair));
		expect(backups().map((p) => bodyOf(io().content(p)))).toEqual([note('edited in B', pair)]);
		expect(ctx.count(/edited in more than one place/)).toBe(1);
	});
});
