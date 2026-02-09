import inquirer from 'inquirer';
import autocompletePrompt from 'inquirer-autocomplete-prompt';
import chalk from 'chalk';
import { AuthInfo, Connection, Org, OrgAuthorization } from '@salesforce/core';
import { runMigration, MigrationLogger, MigrationResults, formatBytes } from './migration.js';
import {
  generateStateId,
  loadState,
  saveState,
  deleteState,
  createState,
  listStates,
  MigrationState,
  MigrationStateConfig,
} from './state.js';
import { cleanupTempDir } from './temp.js';

inquirer.registerPrompt('autocomplete', autocompletePrompt);

// ─── State ──────────────────────────────────────────────────────────────────

let sourceConn: Connection | null = null;
let targetConn: Connection | null = null;
let sourceLabel: string | null = null;
let targetLabel: string | null = null;

// ─── Banner ─────────────────────────────────────────────────────────────────

function showBanner(): void {
  console.log(chalk.cyan.bold('\n  ╔══════════════════════════════════════╗'));
  console.log(chalk.cyan.bold('  ║   SF File Migrator (sf plugin)      ║'));
  console.log(chalk.cyan.bold('  ║   ContentDocument Migration Tool    ║'));
  console.log(chalk.cyan.bold('  ╚══════════════════════════════════════╝\n'));
}

// ─── Connection Status ──────────────────────────────────────────────────────

function connectionStatus(): void {
  const src = sourceConn
    ? chalk.green(`● ${sourceLabel}`)
    : chalk.gray('○ Not connected');
  const tgt = targetConn
    ? chalk.green(`● ${targetLabel}`)
    : chalk.gray('○ Not connected');

  console.log(chalk.dim('  ─────────────────────────────────'));
  console.log(`  Source: ${src}`);
  console.log(`  Target: ${tgt}`);
  console.log(chalk.dim('  ─────────────────────────────────\n'));
}

// ─── List Available Orgs ────────────────────────────────────────────────────

async function listAvailableOrgs(): Promise<OrgAuthorization[]> {
  try {
    const auths = await AuthInfo.listAllAuthorizations();
    return auths.filter((a) => !a.error);
  } catch {
    return [];
  }
}

function formatOrgChoice(auth: OrgAuthorization): string {
  const alias = auth.aliases && auth.aliases.length > 0 ? chalk.bold(auth.aliases[0]) : '';
  const username = chalk.dim(auth.username ?? '');
  const url = auth.instanceUrl ? chalk.dim(`(${auth.instanceUrl.replace('https://', '')})`) : '';
  const tags: string[] = [];

  if (auth.isDevHub) tags.push(chalk.magenta('DevHub'));
  if (auth.isScratchOrg) tags.push(chalk.blue('Scratch'));
  if (
    auth.instanceUrl &&
    (auth.instanceUrl.includes('sandbox') ||
      auth.instanceUrl.includes('test.salesforce') ||
      auth.instanceUrl.includes('--'))
  ) {
    tags.push(chalk.yellow('Sandbox'));
  }

  const tagStr = tags.length > 0 ? ` ${tags.join(' ')}` : '';
  return `${alias ? `${alias} — ` : ''}${username} ${url}${tagStr}`;
}

// ─── Connect Org ────────────────────────────────────────────────────────────

async function connectOrg(orgType: 'source' | 'target'): Promise<void> {
  const label = orgType === 'source' ? 'Source (FROM)' : 'Target (TO)';

  const orgs = await listAvailableOrgs();

  if (orgs.length === 0) {
    console.log(chalk.yellow('\n  No authenticated orgs found.'));
    console.log(chalk.dim('  Run `sf org login web --alias myorg` to add one.\n'));
    return;
  }

  const choices = orgs.map((auth) => ({
    name: formatOrgChoice(auth),
    value: auth.username,
    short: auth.aliases?.[0] ?? auth.username,
  }));

  const { selection } = await inquirer.prompt([
    {
      type: 'list',
      name: 'selection',
      message: `${label} — Select an org:`,
      choices,
      pageSize: 15,
    },
  ]);

  try {
    const org = await Org.create({ aliasOrUsername: selection });
    const conn = org.getConnection();

    // Verify the connection works
    const identity = await conn.identity();
    const connLabel = `${identity.username} (${conn.instanceUrl})`;

    console.log(chalk.green(`\n  ✓ Connected as ${connLabel}\n`));

    if (orgType === 'source') {
      sourceConn = conn;
      sourceLabel = connLabel;
    } else {
      targetConn = conn;
      targetLabel = connLabel;
    }
  } catch (err) {
    console.error(chalk.red(`\n  ✗ Failed: ${(err as Error).message}`));
    console.log(chalk.yellow('  Tip: Run `sf org login web --alias myorg` to refresh the session.\n'));
  }
}

// ─── Describe Object (list fields) ─────────────────────────────────────────

interface FieldInfo {
  name: string;
  label: string;
  type: string;
  externalId: boolean;
  unique: boolean;
  idLookup: boolean;
}

async function getObjectFields(conn: Connection, objectApiName: string): Promise<FieldInfo[]> {
  const describe = await conn.describe(objectApiName);
  return describe.fields
    .filter((f) => f.type !== 'address' && f.type !== 'location')
    .map((f) => ({
      name: f.name,
      label: f.label,
      type: f.type,
      externalId: f.externalId ?? false,
      unique: f.unique ?? false,
      idLookup: f.idLookup ?? false,
    }));
}

// ─── Describe Global (list all objects) ─────────────────────────────────────

interface ObjectInfo {
  name: string;
  label: string;
  custom: boolean;
}

async function getAllObjects(conn: Connection): Promise<ObjectInfo[]> {
  const result = await conn.describeGlobal();
  return result.sobjects
    .filter((o) => o.queryable && o.createable)
    .map((o) => ({
      name: o.name,
      label: o.label,
      custom: o.custom,
    }));
}

// ─── Execute Migration (with SIGINT + state) ───────────────────────────────

async function executeMigration(
  config: {
    objectApiName: string;
    sourceMatchField: string;
    targetMatchField: string;
    whereClause?: string;
    dryRun: boolean;
  },
  logger: MigrationLogger,
  existingState: MigrationState | null = null,
): Promise<void> {
  if (!sourceConn || !targetConn) return;

  const stateConfig: MigrationStateConfig = {
    objectApiName: config.objectApiName,
    sourceMatchField: config.sourceMatchField,
    targetMatchField: config.targetMatchField,
    whereClause: config.whereClause ?? null,
    sourceInstanceUrl: sourceConn.instanceUrl,
    targetInstanceUrl: targetConn.instanceUrl,
  };
  const stateId = generateStateId(stateConfig);

  let currentState = existingState ?? createState(stateId, stateConfig);

  // Don't track state for dry runs
  if (!config.dryRun) {
    currentState.status = 'in_progress';
    await saveState(stateId, currentState);
  }

  // SIGINT handler — remove framework handlers so we can do cooperative shutdown
  let aborted = false;
  const existingSigintListeners = process.listeners('SIGINT');
  process.removeAllListeners('SIGINT');
  const sigintHandler = (): void => {
    if (aborted) {
      console.log(chalk.red('\n  Force quit.'));
      process.exit(1);
    }
    aborted = true;
    console.log(chalk.yellow('\n  Ctrl+C detected — finishing current batch and saving progress...'));
  };
  process.on('SIGINT', sigintHandler);

  const onProgress = config.dryRun ? null : (update: { completed: Record<string, string>; stats: Record<string, number> }): void => {
    Object.assign(currentState.completed, update.completed);
    Object.assign(currentState.stats, update.stats);
    saveState(stateId, currentState).catch(() => {});
  };

  const startTime = Date.now();

  try {
    const results = await runMigration({
      sourceConn,
      targetConn,
      objectApiName: config.objectApiName,
      sourceMatchField: config.sourceMatchField,
      targetMatchField: config.targetMatchField,
      whereClause: config.whereClause,
      dryRun: config.dryRun,
      logger,
      state: existingState,
      onProgress,
      shouldAbort: () => aborted,
      stateId,
    });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    displayResults(results, elapsed);

    // Post-migration state handling (skip for dry runs)
    if (!config.dryRun) {
      if (aborted) {
        currentState.status = 'paused';
        Object.assign(currentState.stats, results);
        await saveState(stateId, currentState);
        console.log(chalk.yellow('  Progress saved. Use "Resume Migration" to continue.\n'));
      } else {
        await deleteState(stateId);
        await cleanupTempDir(currentState.tempDir);
        console.log(chalk.green('  Migration complete — state cleaned up.\n'));
      }
    }
  } finally {
    process.removeListener('SIGINT', sigintHandler);
    for (const listener of existingSigintListeners) {
      process.on('SIGINT', listener as NodeJS.SignalsListener);
    }
  }
}

// ─── Start Migration Flow ───────────────────────────────────────────────────

async function startMigration(logger: MigrationLogger): Promise<void> {
  if (!sourceConn || !targetConn) {
    console.log(chalk.red('\n  Both source and target orgs must be connected first.\n'));
    return;
  }

  // Step 1: Load all objects for autocomplete
  console.log('');
  let allObjects: ObjectInfo[];
  try {
    logger.startSpinner('Loading objects from source org...');
    allObjects = await getAllObjects(sourceConn);
    logger.stopSpinner(`${allObjects.length} queryable objects loaded.`);
  } catch (err) {
    logger.stopSpinnerFail(`Could not describe objects: ${(err as Error).message}`);
    return;
  }

  // Build autocomplete choices — custom objects first, then standard
  const customObjs = allObjects.filter((o) => o.custom);
  const standardObjs = allObjects.filter((o) => !o.custom);
  const objectChoices = [...customObjs, ...standardObjs].map((o) => ({
    name: `${o.name} — ${o.label}${o.custom ? chalk.blue(' [Custom]') : ''}`,
    value: o.name,
    short: o.name,
  }));

  const { objectApiName } = await inquirer.prompt([
    {
      type: 'autocomplete',
      name: 'objectApiName',
      message: 'Source object (start typing to filter):',
      source: (_answers: unknown, input: string) => {
        const term = (input || '').toLowerCase();
        return objectChoices.filter(
          (c) => c.value.toLowerCase().includes(term) || c.name.toLowerCase().includes(term)
        );
      },
      pageSize: 12,
    },
  ]);

  // Step 2: Choose the match field with autocomplete
  let fields: FieldInfo[];
  try {
    logger.startSpinner(`Describing ${objectApiName}...`);
    fields = await getObjectFields(sourceConn, objectApiName);
    logger.stopSpinner(`${objectApiName}: ${fields.length} fields found.`);
  } catch (err) {
    logger.stopSpinnerFail(`Could not describe ${objectApiName}: ${(err as Error).message}`);
    return;
  }

  // Build field choices — recommended first, then the rest
  const recommended = fields.filter(
    (f) => f.externalId || f.unique || f.idLookup || f.name === 'Name'
  );
  const others = fields.filter((f) => !recommended.includes(f));

  const fieldChoices = [
    ...recommended.map((f) => ({
      name: `${f.name} — ${f.label}${f.externalId ? chalk.green(' [External ID]') : ''}${f.unique ? chalk.yellow(' [Unique]') : ''}${f.idLookup ? chalk.dim(' [IdLookup]') : ''}`,
      value: f.name,
      short: f.name,
    })),
    ...others.map((f) => ({
      name: `${f.name} — ${f.label}`,
      value: f.name,
      short: f.name,
    })),
  ];

  const { sourceMatchField } = await inquirer.prompt([
    {
      type: 'autocomplete',
      name: 'sourceMatchField',
      message: 'Source match field (field on source org to match by):',
      source: (_answers: unknown, input: string) => {
        const term = (input || '').toLowerCase();
        if (!term) return fieldChoices;
        return fieldChoices.filter(
          (c) => c.value.toLowerCase().includes(term) || c.name.toLowerCase().includes(term)
        );
      },
      pageSize: 12,
    },
  ]);

  // Ask if the target uses a different match field
  const { useDifferentTargetField } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'useDifferentTargetField',
      message: `Use a different field on the target org? (Currently: ${sourceMatchField})`,
      default: false,
    },
  ]);

  let targetMatchField = sourceMatchField;
  if (useDifferentTargetField) {
    // Describe the target org's object to get its fields
    let targetFields: FieldInfo[];
    try {
      logger.startSpinner(`Describing ${objectApiName} on target org...`);
      targetFields = await getObjectFields(targetConn!, objectApiName);
      logger.stopSpinner(`${objectApiName}: ${targetFields.length} fields found on target.`);
    } catch (err) {
      logger.stopSpinnerFail(`Could not describe ${objectApiName} on target: ${(err as Error).message}`);
      return;
    }

    const targetRecommended = targetFields.filter(
      (f) => f.externalId || f.unique || f.idLookup || f.name === 'Name'
    );
    const targetOthers = targetFields.filter((f) => !targetRecommended.includes(f));

    const targetFieldChoices = [
      ...targetRecommended.map((f) => ({
        name: `${f.name} — ${f.label}${f.externalId ? chalk.green(' [External ID]') : ''}${f.unique ? chalk.yellow(' [Unique]') : ''}${f.idLookup ? chalk.dim(' [IdLookup]') : ''}`,
        value: f.name,
        short: f.name,
      })),
      ...targetOthers.map((f) => ({
        name: `${f.name} — ${f.label}`,
        value: f.name,
        short: f.name,
      })),
    ];

    const answer = await inquirer.prompt([
      {
        type: 'autocomplete',
        name: 'targetMatchField',
        message: 'Target match field (field on target org to match against):',
        source: (_answers: unknown, input: string) => {
          const term = (input || '').toLowerCase();
          if (!term) return targetFieldChoices;
          return targetFieldChoices.filter(
            (c) => c.value.toLowerCase().includes(term) || c.name.toLowerCase().includes(term)
          );
        },
        pageSize: 12,
      },
    ]);
    targetMatchField = answer.targetMatchField;
  }

  const { whereClause } = await inquirer.prompt([
    {
      type: 'input',
      name: 'whereClause',
      message: 'Optional SOQL WHERE clause (leave blank for all records):',
      default: '',
    },
  ]);

  const { dryRun } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'dryRun',
      message: 'Run in dry-run mode first? (Preview only, no changes)',
      default: true,
    },
  ]);

  // Check for existing state matching this config
  let existingState: MigrationState | null = null;
  if (!dryRun && sourceConn && targetConn) {
    const stateConfig: MigrationStateConfig = {
      objectApiName,
      sourceMatchField,
      targetMatchField,
      whereClause: whereClause || null,
      sourceInstanceUrl: sourceConn.instanceUrl,
      targetInstanceUrl: targetConn.instanceUrl,
    };
    const stateId = generateStateId(stateConfig);
    existingState = await loadState(stateId);

    if (existingState) {
      const uploaded = Object.keys(existingState.completed).length;
      console.log(chalk.yellow(`\n  Previous migration state found: ${uploaded} files already uploaded.`));

      const { resumeChoice } = await inquirer.prompt([
        {
          type: 'list',
          name: 'resumeChoice',
          message: 'What would you like to do?',
          choices: [
            { name: `Resume from where you left off (${uploaded} files done)`, value: 'resume' },
            { name: 'Start fresh (discard previous progress)', value: 'fresh' },
          ],
        },
      ]);

      if (resumeChoice === 'fresh') {
        await deleteState(stateId);
        await cleanupTempDir(existingState.tempDir);
        existingState = null;
      }
    }
  }

  const matchDisplay = sourceMatchField === targetMatchField
    ? sourceMatchField
    : `${sourceMatchField} → ${targetMatchField}`;

  console.log(chalk.cyan('\n  ── Migration Configuration ──'));
  console.log(`  Object:      ${objectApiName}`);
  console.log(`  Match:       ${matchDisplay}`);
  console.log(`  Filter:      ${whereClause || '(all records)'}`);
  console.log(`  Mode:        ${dryRun ? 'DRY RUN (preview)' : chalk.yellow('LIVE — will write to target')}`);
  console.log(`  Source:      ${sourceLabel}`);
  console.log(`  Target:      ${targetLabel}`);
  if (existingState) {
    console.log(`  Resume:      ${chalk.green(`Yes — ${Object.keys(existingState.completed).length} files previously completed`)}`);
  }
  console.log(chalk.cyan('  ─────────────────────────────\n'));

  const { confirmed } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'confirmed',
      message: dryRun
        ? 'Proceed with dry run?'
        : '⚠ This will INSERT records into the target org. Proceed?',
      default: dryRun,
    },
  ]);

  if (!confirmed) {
    console.log(chalk.yellow('  Migration cancelled.\n'));
    return;
  }

  console.log('');
  await executeMigration(
    { objectApiName, sourceMatchField, targetMatchField, whereClause: whereClause || undefined, dryRun },
    logger,
    existingState,
  );
}

// ─── Resume Migration ────────────────────────────────────────────────────────

async function resumeMigration(logger: MigrationLogger): Promise<void> {
  if (!sourceConn || !targetConn) {
    console.log(chalk.red('\n  Both source and target orgs must be connected first.\n'));
    return;
  }

  const states = await listStates();
  const resumeable = states.filter((s) => s.status !== 'completed');

  if (resumeable.length === 0) {
    console.log(chalk.yellow('\n  No saved migration states found.\n'));
    return;
  }

  const choices = resumeable.map((s) => ({
    name: `${s.config.objectApiName} (${s.config.sourceMatchField}${s.config.sourceMatchField !== s.config.targetMatchField ? ` → ${s.config.targetMatchField}` : ''})` +
      chalk.dim(` | ${s.stats?.filesUploaded ?? 0} uploaded | ${s.status} | ${s.updatedAt}`),
    value: s.stateId,
    short: s.stateId,
  }));

  const { selectedStateId } = await inquirer.prompt([
    {
      type: 'list',
      name: 'selectedStateId',
      message: 'Select a migration to resume:',
      choices,
    },
  ]);

  const stateData = await loadState(selectedStateId as string);
  if (!stateData) {
    console.log(chalk.red('\n  Could not load state file.\n'));
    return;
  }

  // Verify connected orgs match the state config
  if (sourceConn.instanceUrl !== stateData.config.sourceInstanceUrl ||
      targetConn.instanceUrl !== stateData.config.targetInstanceUrl) {
    console.log(chalk.red('\n  Connected orgs do not match the saved state:'));
    console.log(chalk.red(`    State source: ${stateData.config.sourceInstanceUrl}`));
    console.log(chalk.red(`    Connected:    ${sourceConn.instanceUrl}`));
    console.log(chalk.red(`    State target: ${stateData.config.targetInstanceUrl}`));
    console.log(chalk.red(`    Connected:    ${targetConn.instanceUrl}\n`));
    return;
  }

  const completedCount = Object.keys(stateData.completed).length;
  const matchDisplay = stateData.config.sourceMatchField === stateData.config.targetMatchField
    ? stateData.config.sourceMatchField
    : `${stateData.config.sourceMatchField} → ${stateData.config.targetMatchField}`;

  console.log(chalk.cyan('\n  ── Resuming Migration ──'));
  console.log(`  Object:      ${stateData.config.objectApiName}`);
  console.log(`  Match:       ${matchDisplay}`);
  console.log(`  Filter:      ${stateData.config.whereClause || '(all records)'}`);
  console.log(`  Source:      ${sourceLabel}`);
  console.log(`  Target:      ${targetLabel}`);
  console.log(`  Progress:    ${chalk.green(`${completedCount} files already uploaded`)}`);
  console.log(chalk.cyan('  ─────────────────────────\n'));

  const { confirmed } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'confirmed',
      message: 'Resume this migration?',
      default: true,
    },
  ]);

  if (!confirmed) {
    console.log(chalk.yellow('  Cancelled.\n'));
    return;
  }

  console.log('');
  await executeMigration(
    {
      objectApiName: stateData.config.objectApiName,
      sourceMatchField: stateData.config.sourceMatchField,
      targetMatchField: stateData.config.targetMatchField,
      whereClause: stateData.config.whereClause ?? undefined,
      dryRun: false,
    },
    logger,
    stateData,
  );
}

// ─── Display Results ────────────────────────────────────────────────────────

function displayResults(results: MigrationResults, elapsed: string): void {
  console.log(chalk.cyan('\n  ══════════════════════════════'));
  console.log(chalk.cyan.bold('  Migration Results'));
  console.log(chalk.cyan('  ──────────────────────────────'));
  console.log(`  Files found:     ${results.filesFound}`);
  console.log(`  Files uploaded:  ${chalk.green(String(results.filesUploaded))}`);
  console.log(`  Files skipped:   ${chalk.yellow(String(results.filesSkipped))}`);
  console.log(`  Files failed:    ${chalk.red(String(results.filesFailed))}`);
  console.log(`  Links created:   ${chalk.green(String(results.linksCreated))}`);
  console.log(`  Time elapsed:    ${elapsed}s`);

  if (results.errors.length > 0) {
    console.log(chalk.red(`\n  Errors (${results.errors.length}):`));
    for (const e of results.errors.slice(0, 10)) {
      console.log(chalk.red(`    [${e.stage}] ${e.file || ''} — ${e.error}`));
    }
    if (results.errors.length > 10) {
      console.log(chalk.red(`    ... and ${results.errors.length - 10} more`));
    }
  }

  console.log(chalk.cyan('  ══════════════════════════════\n'));
}

// ─── Main Menu ──────────────────────────────────────────────────────────────

async function mainMenu(logger: MigrationLogger): Promise<void> {
  connectionStatus();

  // Check for saved migration states to show resume option
  const savedStates = await listStates();
  const resumeableStates = savedStates.filter((s) => s.status !== 'completed');

  const choices: Array<{ name: string; value: string } | inquirer.Separator> = [
    { name: 'Connect Source Org (migrate FROM)', value: 'connect_source' },
    { name: 'Connect Target Org (migrate TO)', value: 'connect_target' },
    new inquirer.Separator(),
    { name: 'Start Migration', value: 'migrate' },
  ];

  if (resumeableStates.length > 0) {
    choices.push({
      name: `Resume Migration (${resumeableStates.length} saved)`,
      value: 'resume',
    });
  }

  choices.push(
    new inquirer.Separator(),
    { name: 'Disconnect Source', value: 'disconnect_source' },
    { name: 'Disconnect Target', value: 'disconnect_target' },
    { name: 'Exit', value: 'exit' },
  );

  const { action: menuAction } = await inquirer.prompt([
    {
      type: 'list',
      name: 'action',
      message: 'What would you like to do?',
      choices,
    },
  ]);

  switch (menuAction) {
    case 'connect_source':
      await connectOrg('source');
      break;
    case 'connect_target':
      await connectOrg('target');
      break;
    case 'migrate':
      await startMigration(logger);
      break;
    case 'resume':
      await resumeMigration(logger);
      break;
    case 'disconnect_source':
      sourceConn = null;
      sourceLabel = null;
      console.log(chalk.yellow('  Source disconnected.\n'));
      break;
    case 'disconnect_target':
      targetConn = null;
      targetLabel = null;
      console.log(chalk.yellow('  Target disconnected.\n'));
      break;
    case 'exit':
      console.log(chalk.dim('  Goodbye!\n'));
      return;
  }

  await mainMenu(logger);
}

// ─── Entry Point ────────────────────────────────────────────────────────────

export interface InteractivePrefilledFlags {
  sourceConn?: Connection;
  sourceLabel?: string;
  targetConn?: Connection;
  targetLabel?: string;
}

export async function runInteractive(
  prefilledFlags: InteractivePrefilledFlags,
  logger: MigrationLogger
): Promise<void> {
  // Apply any pre-filled connections from command flags
  if (prefilledFlags.sourceConn) {
    sourceConn = prefilledFlags.sourceConn;
    sourceLabel = prefilledFlags.sourceLabel ?? sourceConn.instanceUrl;
  }
  if (prefilledFlags.targetConn) {
    targetConn = prefilledFlags.targetConn;
    targetLabel = prefilledFlags.targetLabel ?? targetConn.instanceUrl;
  }

  showBanner();

  const orgs = await listAvailableOrgs();
  if (orgs.length > 0) {
    console.log(chalk.green(`  ✓ ${orgs.length} authenticated org(s) available.\n`));
  } else {
    console.log(chalk.dim('  ℹ No authenticated orgs found. Run `sf org login web` to add one.\n'));
  }

  await mainMenu(logger);
}
