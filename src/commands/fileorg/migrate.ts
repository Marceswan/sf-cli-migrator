import { SfCommand, Flags } from '@salesforce/sf-plugins-core';
import { Messages } from '@salesforce/core';
import { action } from '@oclif/core/ux';
import chalk from 'chalk';
import { runMigration, MigrationLogger, MigrationResults } from '../../lib/migration.js';
import { runInteractive } from '../../lib/interactive.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('sf-cli-migrator', 'fileorg.migrate');

export default class Migrate extends SfCommand<MigrationResults | void> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly flags = {
    'source-org': Flags.requiredOrg({
      char: 's',
      summary: messages.getMessage('flags.source-org.summary'),
      required: false,
    }),
    'target-org': Flags.requiredOrg({
      char: 't',
      summary: messages.getMessage('flags.target-org.summary'),
      required: false,
    }),
    object: Flags.string({
      char: 'o',
      summary: messages.getMessage('flags.object.summary'),
    }),
    'match-field': Flags.string({
      char: 'm',
      summary: messages.getMessage('flags.match-field.summary'),
    }),
    where: Flags.string({
      char: 'w',
      summary: messages.getMessage('flags.where.summary'),
    }),
    'dry-run': Flags.boolean({
      char: 'd',
      summary: messages.getMessage('flags.dry-run.summary'),
      default: false,
    }),
  };

  public async run(): Promise<MigrationResults | void> {
    const { flags } = await this.parse(Migrate);

    const logger: MigrationLogger = {
      log: (msg) => this.log(msg),
      warn: (msg) => this.warn(msg),
      startSpinner: (msg) => action.start(msg),
      updateSpinner: (msg) => {
        action.status = msg;
      },
      stopSpinner: (msg) => action.stop(msg),
      stopSpinnerFail: (msg) => action.stop(msg),
    };

    const hasAllRequired =
      flags['source-org'] && flags['target-org'] && flags.object && flags['match-field'];

    if (hasAllRequired) {
      // ── Flag mode: direct execution ──────────────────────────────────────
      const sourceConn = flags['source-org']!.getConnection();
      const targetConn = flags['target-org']!.getConnection();

      const startTime = Date.now();
      const results = await runMigration({
        sourceConn,
        targetConn,
        objectApiName: flags.object!,
        matchField: flags['match-field']!,
        whereClause: flags.where,
        dryRun: flags['dry-run'],
        logger,
      });
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

      this.displayResults(results, elapsed);
      return results;
    } else {
      // ── Interactive mode: launch menu ────────────────────────────────────
      const prefilled: Parameters<typeof runInteractive>[0] = {};

      if (flags['source-org']) {
        prefilled.sourceConn = flags['source-org'].getConnection();
        prefilled.sourceLabel = `${flags['source-org'].getUsername() ?? ''} (${prefilled.sourceConn.instanceUrl})`;
      }
      if (flags['target-org']) {
        prefilled.targetConn = flags['target-org'].getConnection();
        prefilled.targetLabel = `${flags['target-org'].getUsername() ?? ''} (${prefilled.targetConn.instanceUrl})`;
      }

      await runInteractive(prefilled, logger);
    }
  }

  private displayResults(results: MigrationResults, elapsed: string): void {
    this.log(chalk.cyan('\n  ══════════════════════════════'));
    this.log(chalk.cyan.bold('  Migration Results'));
    this.log(chalk.cyan('  ──────────────────────────────'));
    this.log(`  Files found:     ${results.filesFound}`);
    this.log(`  Files uploaded:  ${chalk.green(String(results.filesUploaded))}`);
    this.log(`  Files skipped:   ${chalk.yellow(String(results.filesSkipped))}`);
    this.log(`  Files failed:    ${chalk.red(String(results.filesFailed))}`);
    this.log(`  Links created:   ${chalk.green(String(results.linksCreated))}`);
    this.log(`  Time elapsed:    ${elapsed}s`);

    if (results.errors.length > 0) {
      this.log(chalk.red(`\n  Errors (${results.errors.length}):`));
      for (const e of results.errors.slice(0, 10)) {
        this.log(chalk.red(`    [${e.stage}] ${e.file ?? ''} — ${e.error}`));
      }
      if (results.errors.length > 10) {
        this.log(chalk.red(`    ... and ${results.errors.length - 10} more`));
      }
    }

    this.log(chalk.cyan('  ══════════════════════════════\n'));
  }
}
