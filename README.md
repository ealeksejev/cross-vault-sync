# Cross-Vault Sync

An Obsidian plugin to keep individual notes synchronized across multiple vaults using the `sync_targets` frontmatter property.

## The Problem

When working with multiple separate Obsidian vaults (such as a work vault and a personal knowledge base), you often need the exact same note to exist in more than one vault, frequently organized under completely different folder hierarchies.

Filesystem-level links (symbolic links, NTFS junctions, hardlinks) fail in practice:
- Obsidian Sync does not support symbolic links or hardlinks, and links fail entirely on mobile platforms (Android, iOS)
- Cloud storage services (such as Microsoft OneDrive) do not follow or sync links pointing outside their own folder tree
- Atomic file saves used by modern text editors sever hardlinks on disk

As a result, notes diverge or cloud synchronization breaks.

## The Solution

Cross-Vault Sync maintains standalone, real `.md` files in each vault and automatically synchronizes their content bi-directionally in the background.

Both files remain identical because the `sync_targets` YAML property lists all file locations. It is enough to list the other locations. The plugin adds the note's own entry (see Behavior notes).

Each entry is a vault name, a slash, and the path in that vault as **Copy path → From vault folder** gives it, without the `.md` extension. An entry that ends with a slash is a folder: the copy in it gets the note's own name. **Copy sync target** in the file menu of a note or folder copies the whole entry, ready to paste:

```yaml
---
sync_targets:
  - Vault A/Projects/topic
  - Vault B/Notes/
---
```

After the first sync the plugin replaces a folder entry with the exact file, here `Vault B/Notes/topic`. From then on the copies can be renamed independently: each vault keeps only its own entry current.

## Sync state in the note

Every copy carries its own sync state in its frontmatter, like the header of a network packet. The plugin keeps no sync state anywhere else, so it works the same with the copies in one vault, in several vaults, or on several computers. Every sync that writes a copy writes three fields into it:

```yaml
sync_version: 3
sync_hash: "a41f…"
sync_known:
  - "Vault A/Projects/topic"
  - "Vault B/Notes/topic"
```

- `sync_version` is the number of the sync that wrote this content
- `sync_hash` is the SHA-256 hash of the note without these three fields
- `sync_known` lists the entries that had a copy at that sync

A copy whose content no longer matches its own `sync_hash` was edited after its last sync. A sync reads every copy and decides:

| Copies | Result |
| --- | --- |
| one edited copy, or several with the same content | it wins quietly |
| copies edited in different ways | a conflict: the newest wins, the others are kept as `<name>.sync-conflict-<hash>.md` |
| a copy edited from an older version than the newest sync | a conflict with that sync |
| no edited copy, different versions | the highest version wins: the others missed a sync |

The version alone is not enough: an edit changes the text, not the version. The hash alone is not enough either: a copy that missed a sync matches its own hash too. A write that changes only these fields keeps the file's modification time, so a conflict never takes the plugin's own write for a newer edit.

## Vaults on several computers

The same vault can be in a different folder on each computer, for example under another user name. The entries name the vault, not its folder, so the same list works on every computer. The plugin keeps one table of vault folders per computer, in the app's local storage, which Obsidian Sync does not copy:

- Every vault records its own folder when it opens with Cross-Vault Sync enabled. Once both vaults have been opened on a computer, each finds the other
- For a vault not opened on this computer yet, add its folder under **Vaults and folders on this computer** in the plugin settings. A folder added by hand wins over a recorded one
- A folder outside the vaults, for example in OneDrive, gets a name of your choice in the same table on each computer, and entries start with that name
- When two existing folders on one computer recorded the same vault name, the plugin syncs to neither and says so on a manual sync. Add the right folder by hand. Recorded folders that no longer exist are forgotten when a vault opens

## Features

- **Bi-directional synchronization**: Changes saved in Vault A propagate to Vault B, and vice versa, while at least one of the vaults is open
- **Obsidian Sync compatibility**: Notes in the open vault, the note itself and copies in the same vault, are written through Obsidian's Vault API. Copies in other vaults are plain file writes, which Obsidian Sync picks up when that vault is open (or on its next start)
- **External change detection**: Edits made while a vault is in the background or closed are detected and synced on focus or file open
- **Change detection in every copy**: Each copy knows from its own sync fields whether it changed since its last sync, whatever its modification time. Only when copies were edited in more than one place does the newest one win, and the other version is kept as a conflict backup
- **Convenient UI**: Status bar indicator, **Copy sync target** in the file menu, a dialog to link new targets that offers the last folder again, Command Palette commands, and a dedicated settings page

## Behavior notes

- A note syncs only if a file entry in `sync_targets` names the note itself. When you edit `sync_targets` in an open note, the plugin adds the note's own entry. It does not add it when the list names an existing note in the same vault: such a list belongs to a copy. Conflict backups, OneDrive or Obsidian Sync conflict copies and duplicated notes carry the original's list but not their own entry, so they are never synced. Moving or renaming a note in Obsidian updates its own entry automatically, and the copies keep their names
- A folder entry names the copy that has the note's name in that folder, never the note itself. Any other note of that name in the folder, such as a conflict backup, stays a copy
- Conflict backups (`*.sync-conflict-<hash>.md`) are never synced, also when you open them
- An entry without its trailing slash that names an existing folder, such as `Vault B/Notes`, creates no note: the plugin reports the missing slash instead
- Absolute paths and URLs are no entries: they are ignored and reported on a manual sync
- Deletions are not propagated. A copy listed in `sync_known` that is missing was deleted on purpose and is not recreated automatically. Run **Sync active note now** to recreate it
- Missing folders are never created. A target whose folder does not exist on this computer is skipped
- Do not use a plugin that rewrites the note after every change (for example an "update modified date" plugin) in both vaults. The two copies then keep overwriting each other, and every round creates a conflict backup
- With OneDrive Files On-Demand, mark the synced folder **Always keep on this device**, otherwise every check downloads the file
- Install the same plugin version in every vault

## Files outside the vault

The plugin reads and writes the files listed in `sync_targets`, also outside the vault, and writes conflict backups next to them. While a note is open, it watches the folders of that note's targets for changes. It needs this to keep the copies in other vaults identical. It does not use the network. Its own data in the vault holds the settings only.

## Installation

The plugin needs the Obsidian desktop app, version 1.13.4 or newer.

1. Build the plugin (see Development), or take `main.js`, `manifest.json` and `styles.css` from a GitHub release
2. Copy these three files into `<vault>/.obsidian/plugins/cross-vault-sync/`
3. Open Obsidian Settings, navigate to **Community plugins**, and enable **Cross-Vault Sync**
4. Repeat the installation in the other vault(s)

## Development

The project follows the [official sample plugin](https://github.com/obsidianmd/obsidian-sample-plugin): TypeScript in `src/` (`main.ts` holds only the plugin lifecycle), bundled by esbuild into `main.js`. It needs Node.js 22 or 24.

```bash
npm ci
npm run build      # type check and bundle into main.js
npm run lint       # ESLint with eslint-plugin-obsidianmd
npm run test:unit  # type check the tests, run Vitest, fail below 100% coverage
npm run test:e2e   # build, then run the end-to-end tests in real Obsidian
```

- **Unit tests** (`test/unit`) use Vitest with `obsidian-test-mocks` for the Obsidian API and an in-memory file system shared by the test vaults. A write from outside Obsidian into a vault fires Obsidian's `modify` or `create` event, as Obsidian's own file watcher does, and `test/unit/false-conflicts.test.ts` lets those events start every sync
- **End-to-end tests** (`test/e2e`) use `wdio-obsidian-service`. They download Obsidian into `.obsidian-cache` and run on the plugin's `minAppVersion` and on the latest version. On Linux, Obsidian needs a display (WSLg on WSL 2, Xvfb in CI) and the libraries its `.deb` package depends on: `libgtk-3-0`, `libnotify4`, `libnss3`, `libxss1`, `libxtst6`, `xdg-utils`, `libatspi2.0-0`, `libuuid1` and `libsecret-1-0`. It also needs ALSA (`libasound2t64` on Ubuntu 24.04), which the package does not list
- **CI** (`.github/workflows`) lints every commit, runs both test suites and creates a draft release with build provenance for every tag

`npm version patch|minor|major` updates `manifest.json` and `versions.json`.

## License

MIT License, see `LICENSE` (partially inspired by the `local-folder-sync` project by Jens Eldering).
