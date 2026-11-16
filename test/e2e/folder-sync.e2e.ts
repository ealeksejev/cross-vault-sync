import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { browser, expect } from '@wdio/globals';
import { afterEach, beforeEach, describe, it } from 'mocha';
import { obsidianPage } from 'wdio-obsidian-service';
import { addFolder, bodyOf, listOf, note, readFileOrEmpty, setAutoSync, vaultName, vaultPath } from './helpers';

// A note with this name in a folder is the manifest that mirrors the folder tree into the folders of its list
const MANIFEST = 'Projects/SYNC';

// The plugin manager as the tests reach it
type PluginManager = { plugins: { disablePlugin(id: string): Promise<void>; enablePlugin(id: string): Promise<void> } };

// Runs in real Obsidian. The "other vault" is a temporary folder next to the sandboxed test vault, named
// "Other" in this computer's table.
describe('folder sync in Obsidian', function () {
	let vault: string;
	let own: (notePath: string) => string;
	let other: string;

	// The launcher installs the plugin linked from the repo root (plugins: ['.'] in wdio.conf.mts).
	// resetVault drops the sandbox's whole config dir (a stale-file loop bug in the service),
	// so the plugin files need restoring or a disabled plugin could not be re-enabled: Obsidian
	// re-reads main.js from disk when loading it
	const reinstallPlugin = async (configDir: string): Promise<void> => {
		const dest = path.join(vault, configDir, 'plugins', 'cross-vault-sync');
		fs.mkdirSync(dest, { recursive: true });
		for (const file of ['manifest.json', 'main.js', 'styles.css']) {
			fs.copyFileSync(path.join(process.cwd(), file), path.join(dest, file));
		}
	};

	beforeEach(async function () {
		await obsidianPage.resetVault();
		vault = await vaultPath();
		await reinstallPlugin(await obsidianPage.getConfigDir());
		const name = await vaultName();
		own = (notePath) => `${name}/${notePath}`;
		other = fs.mkdtempSync(path.join(os.tmpdir(), 'cvs-other-'));
		fs.mkdirSync(path.join(other, 'Notes'));
		await addFolder('Other', other);
		await setAutoSync(true);
	});

	afterEach(function () {
		fs.rmSync(other, { recursive: true, force: true });
	});

	// A note of the folder, a note in a subfolder, and the manifest of the folder
	async function manifestFolder(): Promise<void> {
		await browser.executeObsidian(async ({ app }, manifestPath, manifest) => {
			await app.vault.createFolder('Projects');
			await app.vault.createFolder('Projects/deep');
			await app.vault.create('Projects/alpha.md', 'alpha\n');
			await app.vault.create('Projects/deep/beta.md', 'beta\n');
			await app.vault.create(`${manifestPath}.md`, manifest);
		}, MANIFEST, note('manifest', [own(MANIFEST), 'Other/Notes/']));
	}

	async function openNote(notePath: string): Promise<void> {
		await browser.executeObsidian(async ({ app, obsidian }, p) => {
			const file = app.vault.getAbstractFileByPath(p);
			if (file instanceof obsidian.TFile) await app.workspace.getLeaf().openFile(file, { state: { mode: 'source' } });
		}, notePath);
	}

	it('a new manifest mirrors its folder into the target folder, recursively', async function () {
		await manifestFolder();
		await browser.waitUntil(
			async () => JSON.stringify(await listOf('Projects/alpha.md')) === JSON.stringify([own('Projects/alpha'), 'Other/Notes/alpha']),
			{ timeoutMsg: 'the entries were not written to the note of the folder' }
		);
		await browser.waitUntil(
			async () => JSON.stringify(await listOf('Projects/deep/beta.md')) === JSON.stringify([own('Projects/deep/beta'), 'Other/Notes/deep/beta']),
			{ timeoutMsg: 'the entries were not written to the note of a subfolder' }
		);
		await browser.executeObsidian(async ({ app }) => {
			await app.vault.create('Projects/gamma.md', 'gamma\n');
		});
		const copy = path.join(other, 'Notes', 'gamma.md');
		await browser.waitUntil(() => fs.existsSync(copy), { timeoutMsg: 'the mirror copy was not created' });
		expect(bodyOf(readFileOrEmpty(copy))).toBe(note('gamma', [own('Projects/gamma'), 'Other/Notes/gamma']));
	});

	it('a sync pins the plain note folder entry but keeps the manifest folder entry', async function () {
		await browser.executeObsidian(async ({ app }, cn, manifestPath, manifest) => {
			await app.vault.createFolder('Projects');
			await app.vault.create('Projects/cn.md', cn);
			await app.vault.create(`${manifestPath}.md`, manifest);
		}, note('cn', [own('Projects/cn'), 'Other/Notes/']), MANIFEST, note('manifest', [own(MANIFEST), 'Other/Notes/']));
		await openNote('Projects/cn.md');
		await browser.executeObsidianCommand('cross-vault-sync:sync-active-note');
		const cnCopy = path.join(other, 'Notes', 'cn.md');
		await browser.waitUntil(() => fs.existsSync(cnCopy), { timeoutMsg: 'the plain note copy was not created' });
		await browser.waitUntil(
			async () => JSON.stringify(await listOf('Projects/cn.md')) === JSON.stringify([own('Projects/cn'), 'Other/Notes/cn']),
			{ timeoutMsg: 'the plain note folder entry was not pinned to the copy' }
		);
		await openNote(`${MANIFEST}.md`);
		await browser.executeObsidianCommand('cross-vault-sync:sync-active-note');
		const mCopy = path.join(other, 'Notes', 'SYNC.md');
		await browser.waitUntil(() => fs.existsSync(mCopy), { timeoutMsg: 'the manifest copy was not created' });
		// The sync write and the metadata cache re-parse race: wait for the cache to settle.
		// While the list is unexpected, the disk content is recorded in the failure message.
		const anomalies: string[] = [];
		await browser.waitUntil(
			async () => {
				const list = JSON.stringify(await listOf(`${MANIFEST}.md`));
				if (list !== JSON.stringify([own(MANIFEST), 'Other/Notes/'])) {
					const disk = fs.readFileSync(path.join(vault, `${MANIFEST}.md`), 'utf8');
					const record = `list=${list} disk:\n${disk}\n---`;
					if (!anomalies.includes(record)) anomalies.push(record);
				}
				return list === JSON.stringify([own(MANIFEST), 'Other/Notes/']);
			},
			{ timeoutMsg: `the manifest list was not kept. ${anomalies.length} anomaly record(s):\n${anomalies.join('\n')}` }
		);
	});

	it('moving a note inside the folder re-aims its mirror entry and creates the copy at the new place', async function () {
		await manifestFolder();
		await browser.waitUntil(
			async () => JSON.stringify(await listOf('Projects/alpha.md')) === JSON.stringify([own('Projects/alpha'), 'Other/Notes/alpha']),
			{ timeoutMsg: 'the entries were not written to the note of the folder' }
		);
		fs.mkdirSync(path.join(other, 'Notes', 'sub'));
		await browser.executeObsidian(async ({ app, obsidian }) => {
			const file = app.vault.getAbstractFileByPath('Projects/alpha.md');
			await app.vault.createFolder('Projects/sub');
			if (file instanceof obsidian.TFile) await app.fileManager.renameFile(file, 'Projects/sub/renamed.md');
		});
		await browser.waitUntil(
			async () =>
				JSON.stringify(await listOf('Projects/sub/renamed.md')) === JSON.stringify([own('Projects/sub/renamed'), 'Other/Notes/sub/renamed']),
			{ timeoutMsg: 'the mirror entry was not re-aimed at the new place' }
		);
		const copy = path.join(other, 'Notes', 'sub', 'renamed.md');
		await browser.waitUntil(() => fs.existsSync(copy), { timeoutMsg: 'the copy was not created at the new place' });
	});

	it('a folder another program makes in the target folder is discovered as a note of the folder', async function () {
		await manifestFolder();
		await browser.waitUntil(
			async () => JSON.stringify(await listOf('Projects/alpha.md')) === JSON.stringify([own('Projects/alpha'), 'Other/Notes/alpha']),
			{ timeoutMsg: 'the entries were not written to the note of the folder' }
		);
		// Another program adds a folder and a file to the target folder
		fs.mkdirSync(path.join(other, 'Notes', 'newskill'));
		fs.writeFileSync(path.join(other, 'Notes', 'newskill', 'SKILL.md'), 'skill\n');
		await browser.waitUntil(
			async () => JSON.stringify(await listOf('Projects/newskill/SKILL.md')) === JSON.stringify([own('Projects/newskill/SKILL'), 'Other/Notes/newskill/SKILL']),
			{ timeout: 15000, timeoutMsg: 'the file of the target folder was not pulled into the folder' }
		);
		// The pulled file becomes a synced pair: the file in the target gets the sync fields
		const copy = path.join(other, 'Notes', 'newskill', 'SKILL.md');
		await browser.waitUntil(
			() => fs.readFileSync(copy, 'utf8').includes('sync_version'),
			{ timeout: 15000, timeoutMsg: 'the pulled file was not synced back to the target folder' }
		);
	});

	it('a note renamed to the manifest name starts mirroring its folder', async function () {
		await browser.executeObsidian(async ({ app, obsidian }, draft, manifestName) => {
			await app.vault.createFolder('Docs');
			await app.vault.create('Docs/doc1.md', 'doc1\n');
			await app.vault.create('Docs/draft.md', draft);
			const file = app.vault.getAbstractFileByPath('Docs/draft.md');
			if (file instanceof obsidian.TFile) await app.fileManager.renameFile(file, `Docs/${manifestName}.md`);
		}, note('draft', ['Other/Notes/']), path.basename(MANIFEST));
		await browser.waitUntil(
			async () => JSON.stringify(await listOf('Docs/doc1.md')) === JSON.stringify([own('Docs/doc1'), 'Other/Notes/doc1']),
			{ timeoutMsg: 'the renamed note did not start mirroring its folder' }
		);
	});

	it('on plugin load, a note whose mirror entry was removed gets it back', async function () {
		await manifestFolder();
		await browser.waitUntil(
			async () => JSON.stringify(await listOf('Projects/alpha.md')) === JSON.stringify([own('Projects/alpha'), 'Other/Notes/alpha']),
			{ timeoutMsg: 'the entries were not written to the note of the folder' }
		);
		// An edit made by another program drops the mirror entry
		fs.writeFileSync(path.join(vault, 'Projects/alpha.md'), note('alpha', [own('Projects/alpha')]));
		await browser.waitUntil(
			async () => JSON.stringify(await listOf('Projects/alpha.md')) === JSON.stringify([own('Projects/alpha')]),
			{ timeoutMsg: 'the dropped entry came back before the reload' }
		);
		// Disabling and re-enabling the plugin re-runs its load, as opening the vault would
		await browser.executeObsidian(async ({ app }) => {
			const manager = (app as unknown as PluginManager).plugins;
			await manager.disablePlugin('cross-vault-sync');
			await manager.enablePlugin('cross-vault-sync');
		});
		await browser.waitUntil(
			async () => JSON.stringify(await listOf('Projects/alpha.md')) === JSON.stringify([own('Projects/alpha'), 'Other/Notes/alpha']),
			{ timeoutMsg: 'the load catch-up did not re-add the mirror entry' }
		);
	});
});
