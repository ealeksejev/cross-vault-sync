import { Notice } from 'obsidian';
import { errorCode, errorMessage } from './io';
import type { SyncHost } from './host';

// Loop breaker: a note whose sync direction flips this often is being rewritten on both sides by something else
const LOOP_WINDOW_MS = 60 * 1000;
const LOOP_MAX_REVERSALS = 6;
const LOOP_PAUSE_MS = 5 * 60 * 1000;
const ERROR_NOTICE_INTERVAL_MS = 60 * 1000;

export type Direction = 'pull' | 'push';

export class LoopGuard {
	readonly directionLog = new Map<string, { last: Direction | null; reversals: number[] }>();
	readonly pausedUntil = new Map<string, number>();

	isPaused(filePath: string): boolean {
		return (this.pausedUntil.get(filePath) ?? 0) > Date.now();
	}

	// Returns true when the note was paused because another process keeps rewriting it on both sides
	record(filePath: string, fileName: string, direction: Direction): boolean {
		const now = Date.now();
		const entry = this.directionLog.get(filePath) ?? { last: null, reversals: [] };
		if (entry.last && entry.last !== direction) entry.reversals.push(now);
		entry.last = direction;
		entry.reversals = entry.reversals.filter((t) => now - t < LOOP_WINDOW_MS);
		this.directionLog.set(filePath, entry);

		if (entry.reversals.length < LOOP_MAX_REVERSALS) return false;
		entry.reversals = [];
		this.pausedUntil.set(filePath, now + LOOP_PAUSE_MS);
		new Notice(`Cross-Vault Sync: "${fileName}" keeps changing on both sides, so auto-sync is paused for 5 minutes. Another plugin may be rewriting it on every change.`);
		return true;
	}
}

// Error notices: a manual sync always shows them, automatic syncs at most once a minute per target and error
export class ErrorReporter {
	readonly lastNotice = new Map<string, number>();

	constructor(private readonly host: SyncHost) {}

	report(target: string, err: unknown, manual: boolean): void {
		console.error(`Cross-Vault Sync: Error syncing with ${target}`, err);
		if (!manual && !this.host.settings.showNotices) return;
		const now = Date.now();
		const key = `${target}|${errorCode(err) ?? ''}`;
		if (!manual && now - (this.lastNotice.get(key) ?? 0) < ERROR_NOTICE_INTERVAL_MS) return;
		this.lastNotice.set(key, now);
		new Notice(`Cross-Vault Sync error: ${errorMessage(err)}`);
	}
}
