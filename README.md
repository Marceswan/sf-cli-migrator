# SF CLI Migrator

A Salesforce CLI (`sf`) plugin that migrates ContentDocument files — and their record associations — between orgs. Sandbox to production, production to sandbox, or org-to-org.

Built on [oclif](https://oclif.io/) and [`@salesforce/sf-plugins-core`](https://github.com/salesforcecli/sf-plugins-core).

## How It Works

1. **Connect two orgs** — uses your existing `sf` CLI authenticated sessions (zero additional setup)
2. **Pick an object** (Account, Case, Opportunity, Custom_Object__c, etc.)
3. **Choose a match field** to map records between orgs (External ID, Name, CaseNumber, etc.)
4. The plugin automatically:
   - Queries all ContentDocumentLinks for your records in the source org
   - Downloads the file binaries
   - Uploads them as new ContentVersions in the target org
   - Creates ContentDocumentLinks to associate files with the correct target records

## Prerequisites

- **Node.js 18+**
- **Salesforce CLI (`sf`)** — [Install guide](https://developer.salesforce.com/tools/salesforcecli)
- At least two authenticated orgs:
  ```bash
  sf org login web --alias my-source
  sf org login web --alias my-target
  ```

## Installation

### From Source (Local Development)

```bash
git clone https://github.com/Marceswan/sf-cli-migrator.git
cd sf-cli-migrator
npm install
npm run build
sf plugins link .
```

### Verify Installation

```bash
sf fileorg migrate --help
```

## Usage

The plugin supports two modes: **interactive** (menu-driven) and **flag-driven** (scriptable).

### Interactive Mode

Run the command with no flags to launch the interactive menu:

```bash
sf fileorg migrate
```

You'll see:

```
  ╔══════════════════════════════════════╗
  ║   SF File Migrator (sf plugin)      ║
  ║   ContentDocument Migration Tool    ║
  ╚══════════════════════════════════════╝

  ✓ 4 authenticated org(s) available.

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

The menu guides you through connecting orgs, selecting an object, choosing a match field (with autocomplete), setting an optional SOQL filter, and choosing dry-run vs. live mode.

### Flag Mode

Provide all four required flags for direct, scriptable execution:

```bash
sf fileorg migrate \
  --source-org my-source \
  --target-org my-target \
  --object Account \
  --match-field External_Id__c
```

### Flags

| Flag | Short | Required | Description |
|------|-------|----------|-------------|
| `--source-org` | `-s` | For flag mode | Org to migrate files FROM (username or alias) |
| `--target-org` | `-t` | For flag mode | Org to migrate files TO (username or alias) |
| `--object` | `-o` | For flag mode | Source object API name (e.g., `Account`, `Case`) |
| `--match-field` | `-m` | For flag mode | Field to match records between orgs (e.g., `External_Id__c`, `Name`) |
| `--where` | `-w` | No | SOQL WHERE clause to filter source records |
| `--dry-run` | `-d` | No | Preview what would be migrated without making changes |

If any of the four "required" flags are omitted, the plugin falls into interactive mode (pre-filling whichever flags were provided).

### Examples

Dry run — preview Account file migration using an external ID:

```bash
sf fileorg migrate \
  --source-org sandbox \
  --target-org prod \
  --object Account \
  --match-field External_Id__c \
  --dry-run
```

Migrate Case files created after a specific date:

```bash
sf fileorg migrate \
  --source-org sandbox \
  --target-org prod \
  --object Case \
  --match-field CaseNumber \
  --where "CreatedDate >= 2024-01-01T00:00:00Z"
```

Migrate files for a custom object, filtered by owner:

```bash
sf fileorg migrate \
  --source-org dev \
  --target-org staging \
  --object Equipment_Rental__c \
  --match-field Rental_Number__c \
  --where "OwnerId = '005xx000001234'"
```

Interactive mode with source org pre-filled:

```bash
sf fileorg migrate --source-org my-sandbox
```

### Filtering Records

The `--where` flag accepts any valid SOQL WHERE clause (without the `WHERE` keyword):

```
CreatedDate >= 2024-01-01T00:00:00Z
OwnerId = '005xx000001234'
Status = 'Closed'
Name LIKE 'ACME%'
```

Omit the flag to migrate files for all records of the selected object.

## Limitations

- **10 MB per file** — Files larger than 10 MB are flagged and skipped (Salesforce REST API limit). They appear in the summary as skipped files.
- **Latest version only** — Only the most recent version of each file is migrated (`IsLatest = true`).
- **API limits** — Each file download/upload consumes API calls. Monitor your org's daily API usage for large migrations.
- **Session expiry** — If an org session has expired, the plugin will tell you. Refresh with `sf org login web`.
- **Record matching** — Records in the source org that don't have a matching record (by the chosen field) in the target org are skipped.

## How the Migration Pipeline Works

The migration runs in 8 steps:

1. **Query source records** — `SELECT Id, {matchField} FROM {object}` with optional WHERE filter
2. **Find ContentDocumentLinks** — Identifies all files attached to the source records
3. **Fetch ContentVersion metadata** — Gets file details (title, size, extension) for the latest version of each document
4. **Map records to target** — Queries the target org for records matching by the chosen field and builds a source-to-target ID map
5. **Download files** — Downloads file binaries from the source org to a temp directory
6. **Upload files** — Uploads each file as a new ContentVersion (base64) in the target org
7. **Resolve new ContentDocumentIds** — Queries back the newly created ContentVersions to get their ContentDocumentIds
8. **Create ContentDocumentLinks** — Links the new files to the correct target records

SOQL queries are chunked in batches of 200 IDs to stay within SOQL character limits, and `queryMore` handles pagination for result sets over 2,000 records.

## Uninstalling

```bash
sf plugins unlink sf-cli-migrator
```

## Development

### Build

```bash
npm run build        # Compile TypeScript → lib/
npm run clean        # Remove compiled output
```

### Link for Testing

```bash
sf plugins link .    # After building, makes `sf fileorg migrate` available
```

### Project Structure

```
src/
├── commands/fileorg/migrate.ts   # oclif command class (flag parsing, dual-mode routing)
├── lib/
│   ├── migration.ts              # 8-step migration pipeline
│   ├── interactive.ts            # Inquirer-based interactive menu
│   └── temp.ts                   # Temp directory management
└── index.ts                      # Plugin export
```

## License

MIT
