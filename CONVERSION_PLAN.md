# SF File Migrator → SF CLI Plugin Conversion Plan

This document is a Claude Code execution plan. It contains all context and instructions needed to convert the standalone `sf-file-migrator` Node.js CLI into a proper Salesforce CLI (`sf`) plugin at `/Users/marc.swan/Documents/Code/sf-cli-migrator`.

## Source Reference

The original codebase lives at `/Users/marc.swan/Documents/Code/sf-file-migrator`. Read all four source files before starting:

- `src/index.js` — 468 lines. Interactive menu loop (inquirer), connection state, object/field autocomplete, migration config gathering, results display.
- `src/auth.js` — 249 lines. SF CLI token reading via shell commands, standalone OAuth fallback with local HTTP server on port 3141.
- `src/migration.js` — 369 lines. The 8-step migration pipeline: query source records, find ContentDocumentLinks, get ContentVersion metadata, map records to target via match field, download binaries, upload as base64 ContentVersions, resolve new ContentDocumentIds, create ContentDocumentLinks. Helpers: `queryAll`, `queryAllChunked`, `downloadContentVersion`, `escSoql`, `formatBytes`.
- `src/config.js` — 89 lines. Token persistence (`.tokens/` dir, JSON per org) and temp directory management (`temp/`).

---

## Target Architecture

### Plugin Identity

- **Plugin name:** `sf-cli-migrator`
- **Command:** `sf fileorg migrate`
- **Topic:** `fileorg`
- **Language:** TypeScript (ESM)
- **Framework:** oclif via `@salesforce/sf-plugins-core`

### Dual-Mode Design: Flags + Interactive Menu

The plugin supports two invocation modes:

**1. Flag mode** (all required flags provided — executes immediately):
```bash
sf fileorg migrate \
  --source-org mySource \
  --target-org myTarget \
  --object Account \
  --match-field External_Id__c \
  --where "CreatedDate >= 2024-01-01" \
  --dry-run
```

**2. Interactive mode** (missing flags trigger the inquirer menu):
```bash
sf fileorg migrate
# launches interactive menu identical to the original tool
```

Detection logic in the command's `run()` method: check if `source-org`, `target-org`, `object`, and `match-field` flags are all provided. If yes, execute directly. If any are missing, launch the interactive menu, passing in whichever flags were provided so those prompts can be skipped.

### Target File Structure

```
sf-cli-migrator/
├── src/
│   ├── commands/
│   │   └── fileorg/
│   │       └── migrate.ts        # Command class (flags + interactive menu)
│   ├── lib/
│   │   ├── migration.ts          # 8-step pipeline (ported from migration.js)
│   │   ├── interactive.ts        # Menu loop + inquirer prompts (ported from index.js)
│   │   └── temp.ts               # Temp directory management (ported from config.js)
│   └── index.ts                  # Plugin exports
├── messages/
│   └── fileorg.migrate.md        # Command help text and flag descriptions
├── test/
│   └── commands/
│       └── fileorg/
│           └── migrate.test.ts
├── package.json
├── tsconfig.json
├── CLAUDE.md
└── README.md
```

---

## Phase 1: Scaffold the Plugin

### Step 1A: Initialize the project

Do NOT use `sf dev generate plugin` — it generates boilerplate we don't need and uses yarn. Instead, manually scaffold a minimal plugin.

Create `package.json`:
```json
{
  "name": "sf-cli-migrator",
  "version": "1.0.0",
  "description": "Salesforce CLI plugin to migrate ContentDocument files between orgs",
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/index.d.ts",
  "license": "MIT",
  "scripts": {
    "build": "tsc -b",
    "clean": "rm -rf lib",
    "test": "mocha test/**/*.test.ts --timeout 10000"
  },
  "dependencies": {
    "@oclif/core": "^4",
    "@salesforce/core": "^8",
    "@salesforce/sf-plugins-core": "^12",
    "fs-extra": "^11.2.0",
    "inquirer": "^9.2.12",
    "inquirer-autocomplete-prompt": "^3.0.1"
  },
  "devDependencies": {
    "@types/fs-extra": "^11",
    "@types/inquirer": "^9",
    "@types/mocha": "^10",
    "@types/node": "^20",
    "chai": "^4",
    "mocha": "^10",
    "sinon": "^17",
    "typescript": "^5"
  },
  "oclif": {
    "bin": "sf",
    "commands": "./lib/commands",
    "topicSeparator": " ",
    "flexibleTaxonomy": true,
    "topics": {
      "fileorg": {
        "description": "Commands for migrating files between Salesforce orgs"
      }
    }
  },
  "files": [
    "lib",
    "messages",
    "oclif.manifest.json"
  ]
}
```

Create `tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "lib": ["ES2022"],
    "outDir": "lib",
    "rootDir": "src",
    "strict": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "lib", "test"]
}
```

Create `.gitignore`:
```
node_modules/
lib/
temp/
*.tsbuildinfo
oclif.manifest.json
```

Run `npm install`.

### Step 1B: Create message file

Create `messages/fileorg.migrate.md` with markdown sections for: `summary`, `description`, `examples`, and each flag's summary (`flags.source-org.summary`, `flags.target-org.summary`, `flags.object.summary`, `flags.match-field.summary`, `flags.where.summary`, `flags.dry-run.summary`). See the oclif Messages pattern — each `# heading` becomes a message key.

---

## Phase 2: Port the Migration Pipeline (`src/lib/migration.ts`)

This is the highest-value, most reusable module. Port `sf-file-migrator/src/migration.js` to `sf-cli-migrator/src/lib/migration.ts`.

### Critical: jsforce v1 to v3 API Changes

The original uses `jsforce@^1.11.1`. The sf CLI plugin uses `@jsforce/jsforce-node@^3` (bundled via `@salesforce/core`). The `Connection` object from `org.getConnection()` extends jsforce v3's Connection.

**What stays the same:**
- `conn.query(soql)` — same signature, returns `QueryResult<T>`
- `conn.queryMore(nextRecordsUrl)` — same signature
- `conn.describe(objectName)` — same
- `conn.describeGlobal()` — same
- `conn.sobject('ContentVersion').create({...})` — same
- `conn.sobject('ContentDocumentLink').create([...])` — same

**What changes:**

1. **Import path:** No `import jsforce from 'jsforce'`. Instead use `Connection` from `@salesforce/core`. The Connection from `@salesforce/core` extends jsforce v3 — all `.query()`, `.sobject()`, etc. methods are available on it.

2. **Binary file download** — this is the HIGHEST RISK change. The original uses a callback-based `conn.request({ url, encoding: null }, callback)`. In jsforce v3 / `@salesforce/core`, use the promise-based form. If that doesn't work for binary data, fall back to a raw HTTPS request using `conn.instanceUrl` and `conn.accessToken` to fetch `/services/data/v{version}/sobjects/ContentVersion/{id}/VersionData`. A third fallback is using native `fetch()` with the Authorization Bearer header. **Test the binary download early. This is the most likely point of failure.**

3. **API version:** The original pins `version: '59.0'`. With `@salesforce/core`, the version comes from the org's config or the `--api-version` flag. Do NOT hardcode it.

4. **Output display:** Replace `chalk` and `ora` with a `MigrationLogger` interface so migration.ts stays decoupled from oclif:

```typescript
export interface MigrationLogger {
  log: (msg: string) => void;
  warn: (msg: string) => void;
  startSpinner: (msg: string) => void;
  updateSpinner: (msg: string) => void;
  stopSpinner: (msg: string) => void;
  stopSpinnerFail: (msg: string) => void;
}
```

### Porting Instructions

1. Copy `migration.js` as the starting point.
2. Add TypeScript types for all parameters and return values.
3. Replace `chalk` and `ora` calls with the `MigrationLogger` interface.
4. Replace the callback-based `downloadContentVersion` with an async/promise version.
5. Keep `queryAll`, `queryAllChunked`, `escSoql`, `formatBytes` as private helper functions.
6. Keep constants: `BATCH_SIZE = 200`, `MAX_FILE_SIZE = 10 * 1024 * 1024`.
7. Export `runMigration` and the types (`MigrationOptions`, `MigrationResults`, `MigrationLogger`).

### Type Definitions

```typescript
import { Connection } from '@salesforce/core';

export interface MigrationOptions {
  sourceConn: Connection;
  targetConn: Connection;
  objectApiName: string;
  matchField: string;
  whereClause?: string;
  dryRun?: boolean;
  logger: MigrationLogger;
}

export interface MigrationResults {
  filesFound: number;
  filesUploaded: number;
  filesFailed: number;
  filesSkipped: number;
  linksCreated: number;
  errors: Array<{ file?: string; stage: string; error: string }>;
}
```

---

## Phase 3: Port Temp Directory Management (`src/lib/temp.ts`)

Port only the temp directory functions from `sf-file-migrator/src/config.js`. **Delete all token management code** — oclif handles auth.

Change the temp directory location from project-relative (`PROJECT_ROOT/temp`) to OS temp dir (`os.tmpdir()`). Use timestamped subdirectories so concurrent runs don't collide.

Update `cleanupTempDir` to accept the path as an argument (since each run creates a unique timestamped dir).

Update `migration.ts` to pass the temp dir path to `cleanupTempDir` accordingly.

---

## Phase 4: Port the Interactive Menu (`src/lib/interactive.ts`)

Port the inquirer-based interactive menu from `sf-file-migrator/src/index.js`. This module handles the menu loop, org selection, object/field autocomplete, and migration configuration.

### What Changes

1. **Org connection:** Replace `connectOrg()` (which shells out to `sf org display` and creates raw jsforce connections) with org resolution via `@salesforce/core`:
   - Use `AuthInfo.listAllAuthorizations()` to list available orgs (replaces `listSfCliOrgs()` which used shell commands)
   - Use `Org.create({ aliasOrUsername })` then `org.getConnection()` to connect (replaces `connectFromSfCli()` which used shell commands + raw jsforce constructor)

2. **Remove standalone OAuth entirely.** No more `authenticateStandalone`, `getAuthCodeViaBrowser`, HTTP server on port 3141, `.env` loading, or token persistence. The plugin requires `sf` CLI auth. If a user's session is expired, tell them to run `sf org login web`.

3. **Remove session restoration** (`restoreSessions`). The sf CLI manages sessions.

4. **Keep the menu loop structure.** The `mainMenu()` recursive function, `showBanner()`, `connectionStatus()`, `startMigration()`, object/field autocomplete — all stay. Just swap the connection plumbing underneath.

5. **Keep inquirer + inquirer-autocomplete-prompt.** These work fine inside oclif commands.

6. **chalk is OK to keep** for the interactive menu display. The interactive module is inherently a terminal UI, so direct chalk usage is fine here (unlike migration.ts which should stay decoupled via the logger interface).

### Exported Interface

```typescript
import { Connection } from '@salesforce/core';

export interface InteractiveResult {
  sourceConn: Connection;
  targetConn: Connection;
  objectApiName: string;
  matchField: string;
  whereClause?: string;
  dryRun: boolean;
}

/**
 * Launch the interactive menu. Loops until the user runs a migration or exits.
 * Any pre-filled flags from the command line skip the corresponding prompts.
 */
export async function runInteractive(
  prefilledFlags: Partial<InteractiveResult>,
  logger: MigrationLogger
): Promise<void>;
```

### Menu Flow in Interactive Mode

```
  ╔══════════════════════════════════════╗
  ║   SF File Migrator (sf plugin)      ║
  ║   ContentDocument Migration Tool    ║
  ╚══════════════════════════════════════╝

  Source: ○ Not connected
  Target: ○ Not connected

? What would you like to do?
  Connect Source Org (migrate FROM)
  Connect Target Org (migrate TO)
  ──────────────
  Start Migration
  ──────────────
  Disconnect Source
  Disconnect Target
  Exit
```

When "Connect Source Org" is selected, list orgs from `AuthInfo.listAllAuthorizations()`:
```
? Source (FROM) — Select an org:
  my-sandbox — user@example.com (my-domain--sandbox.sandbox.my.salesforce.com)
  my-prod — user@example.com (my-domain.my.salesforce.com)
```

No manual OAuth fallback. If no orgs are found, display:
```
No authenticated orgs found. Run `sf org login web --alias myorg` first.
```

---

## Phase 5: Wire Up the Command (`src/commands/fileorg/migrate.ts`)

This is the oclif command class that ties everything together.

### Key Design Decisions

- All four "required" flags (`source-org`, `target-org`, `object`, `match-field`) are set to `required: false` in the flag definition. This allows interactive mode when they're omitted. When all four ARE provided, skip the menu and execute directly.

- `Flags.requiredOrg()` is used for `source-org` and `target-org` with `required: false`. When provided, oclif auto-resolves the alias/username to an `Org` object. When omitted, the flag value is `undefined` and interactive mode handles it.

- The command creates a `MigrationLogger` implementation that maps to oclif's `action` spinner and `this.log()` / `this.warn()` methods.

- In flag mode, the command calls `runMigration()` directly and displays results.

- In interactive mode, the command calls `runInteractive()` which handles the full menu loop (including calling `runMigration` internally when the user selects "Start Migration").

### Results Display

Port the results display block from the original `index.js` (lines 370-390) into a `displayResults()` method on the command class. It shows: files found, uploaded, skipped, failed, links created, elapsed time, and up to 10 errors.

---

## Phase 6: Create Plugin Entry Point

Create `src/index.ts` that re-exports the command class. This is required by the oclif plugin loader.

---

## Phase 7: Build, Link, and Test

```bash
cd /Users/marc.swan/Documents/Code/sf-cli-migrator

# Build TypeScript
npm run build

# Link for local testing
sf plugins link .

# Test interactive mode
sf fileorg migrate

# Test flag mode (dry run)
sf fileorg migrate \
  --source-org <your-source-alias> \
  --target-org <your-target-alias> \
  --object Account \
  --match-field Name \
  --dry-run

# Unlink when done
sf plugins unlink sf-cli-migrator
```

### Testing Priority

1. **Binary file download** — Test downloading a single file first. This is the most likely point of failure due to the jsforce v1-to-v3 change.
2. **Org resolution** — Verify `AuthInfo.listAllAuthorizations()` returns the same orgs as `sf org list`.
3. **Interactive menu** — Verify the full connect → configure → dry-run flow works.
4. **Flag mode** — Verify direct execution with all flags works.
5. **Large dataset** — Test with >2000 records to verify pagination still works.

---

## What NOT to Port

These items from the original codebase are **completely replaced by oclif** and should NOT appear in the plugin:

| Original | Reason to Drop |
|---|---|
| `src/auth.js` (entire file) | `Org.create()` + `org.getConnection()` replaces all auth |
| Shell calls to `sf org display` | oclif resolves orgs natively via `AuthInfo` |
| Shell calls to `sf org list` | Use `AuthInfo.listAllAuthorizations()` instead |
| Standalone OAuth (HTTP server, port 3141) | Plugin requires sf CLI auth |
| Token persistence (`.tokens/` dir) | sf CLI manages tokens |
| `dotenv` / `.env` loading | No Connected App credentials needed |
| `open` package (browser launch) | No OAuth browser flow |
| `process.exit()` calls | Let oclif handle process lifecycle |

---

## Summary of Module Mapping

| Original File | Lines | Plugin Destination | Reuse % | Key Changes |
|---|---|---|---|---|
| `src/index.js` | 468 | `src/commands/fileorg/migrate.ts` + `src/lib/interactive.ts` | ~70% | Swap auth plumbing, keep menu + prompts |
| `src/auth.js` | 249 | **Deleted** | 0% | Entirely replaced by `@salesforce/core` |
| `src/migration.js` | 369 | `src/lib/migration.ts` | ~85% | TypeScript types, jsforce v3 download API, logger interface |
| `src/config.js` | 89 | `src/lib/temp.ts` | ~35% | Keep temp dir logic only, OS temp path, drop tokens |

---

## CLAUDE.md for the New Project

After the plugin is working, create a `CLAUDE.md` at the project root documenting: commands (`npm run build`, `npm test`, `sf plugins link .`, `sf fileorg migrate`), the module responsibilities (command class, migration pipeline, interactive menu, temp management), key constraints (10MB file limit, batch size 200, IsLatest only, jsforce v3 via @salesforce/core), and the dual-mode design (flag mode vs interactive mode).
