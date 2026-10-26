import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

// Vitest runs in the project folder
const manifest = JSON.parse(readFileSync('manifest.json', 'utf8')) as { description: string };

describe('manifest.json', () => {
	// The community directory's review rejects it: the directory implies Obsidian
	it('has a description without the word Obsidian', () => {
		expect(manifest.description).not.toMatch(/obsidian/i);
	});
});
