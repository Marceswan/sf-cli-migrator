# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
bun install          # Install dependencies
bun run build        # Compile TypeScript → lib/
bun run clean        # Remove compiled output
bun run test         # Run tests (mocha)
sf plugins link .    # Link plugin for local testing
sf filebuddy migrate   # Run the plugin (after linking)
```

## Architecture

This is a Salesforce CLI (`sf`) plugin built on oclif with `@salesforce/sf-plugins-core`. It migrates ContentDocument files between orgs. Supports both flag-driven execution and an interactive inquirer menu.

### Dual-Mode Design

- **Flag mode:** `sf filebuddy migrate --source-org X --target-org Y --object Account --match-field Name --dry-run` — all four required flags provided, executes immediately.
- **Interactive mode:** `sf filebuddy migrate` — missing flags trigger the inquirer-based menu loop with org selection, object/field autocomplete, and migration configuration.

### Module Responsibilities

- **src/commands/filebuddy/migrate.ts** — oclif command class. Parses flags, detects mode (flag vs interactive), wires up the `MigrationLogger`, delegates to either direct execution or the interactive menu.

- **src/lib/migration.ts** — The 8-step migration pipeline: query source records → find ContentDocumentLinks → get ContentVersion metadata → map records to target via match field → download binaries → upload as base64 ContentVersions → resolve new ContentDocumentIds → create ContentDocumentLinks. All display output goes through a `MigrationLogger` interface, keeping this module decoupled from oclif. Uses `Connection` from `@salesforce/core` (jsforce v3 under the hood).

- **src/lib/interactive.ts** — Inquirer-based interactive menu loop. Lists orgs via `AuthInfo.listAllAuthorizations()`, connects via `Org.create()`, provides object/field autocomplete, gathers migration config, calls `runMigration()`, and displays results.

- **src/lib/temp.ts** — Temp directory management using OS temp dir (`os.tmpdir()`). Timestamped subdirs for concurrent-run safety.

### Key Constraints

- Files >10 MB are skipped (REST API limit; `MAX_FILE_SIZE` in migration.ts)
- Only the latest ContentVersion is migrated per document (`IsLatest = true`)
- SOQL queries are chunked in batches of 200 (`BATCH_SIZE`) with automatic `queryMore` pagination
- Auth is handled entirely by sf CLI — no standalone OAuth, no token persistence
- Connection objects come from `@salesforce/core` `Org.getConnection()` (jsforce v3)
- Binary file download has a fallback chain: jsforce v3 `conn.request()` → native `fetch()` with bearer token

### Converted From

This plugin was converted from `sf-file-migrator`, a standalone Node.js CLI using jsforce v1 + inquirer. The original lives at `/Users/marc.swan/Documents/Code/sf-file-migrator`. See `CONVERSION_PLAN.md` for the full migration rationale.
