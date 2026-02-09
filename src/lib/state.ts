import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'fs-extra';

const STATE_DIR = path.join(os.tmpdir(), 'sf-filebuddy-migrate', '.state');

// ─── Types ───────────────────────────────────────────────────────────────────

export interface MigrationStateConfig {
  objectApiName: string;
  sourceMatchField: string;
  targetMatchField: string;
  whereClause: string | null;
  sourceInstanceUrl: string;
  targetInstanceUrl: string;
}

export interface MigrationState {
  version: number;
  stateId: string;
  createdAt: string;
  updatedAt: string;
  config: MigrationStateConfig;
  tempDir: string;
  status: 'in_progress' | 'paused' | 'completed';
  /** Map of sourceContentDocumentId → targetContentDocumentId for completed uploads */
  completed: Record<string, string>;
  stats: {
    filesFound: number;
    filesUploaded: number;
    filesFailed: number;
    filesSkipped: number;
    linksCreated: number;
  };
}

export interface MigrationStateSummary {
  stateId: string;
  config: MigrationStateConfig;
  status: string;
  stats: MigrationState['stats'];
  createdAt: string;
  updatedAt: string;
}

// ─── Functions ───────────────────────────────────────────────────────────────

/**
 * Generate a deterministic state ID from migration config.
 * Same config = same state file, enabling resume.
 */
export function generateStateId(config: MigrationStateConfig): string {
  const key = [
    config.objectApiName,
    config.sourceMatchField,
    config.targetMatchField,
    config.whereClause ?? '',
    config.sourceInstanceUrl,
    config.targetInstanceUrl,
  ].join('|');

  const hash = crypto.createHash('sha256').update(key).digest('hex').slice(0, 8);
  return `${config.objectApiName}_${config.sourceMatchField}_${hash}`;
}

/**
 * Load an existing migration state file.
 */
export async function loadState(stateId: string): Promise<MigrationState | null> {
  const filePath = path.join(STATE_DIR, `${stateId}.json`);
  if (await fs.pathExists(filePath)) {
    return fs.readJson(filePath) as Promise<MigrationState>;
  }
  return null;
}

/**
 * Save migration state atomically (write to .tmp, then rename).
 * Prevents corruption if process is killed mid-write.
 */
export async function saveState(stateId: string, state: MigrationState): Promise<void> {
  await fs.ensureDir(STATE_DIR);
  const filePath = path.join(STATE_DIR, `${stateId}.json`);
  const tmpPath = `${filePath}.tmp`;

  state.updatedAt = new Date().toISOString();

  await fs.writeJson(tmpPath, state, { spaces: 2 });
  await fs.rename(tmpPath, filePath);
}

/**
 * List all saved migration states with summary info.
 */
export async function listStates(): Promise<MigrationStateSummary[]> {
  if (!await fs.pathExists(STATE_DIR)) return [];

  const files = await fs.readdir(STATE_DIR);
  const states: MigrationStateSummary[] = [];

  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      const state = await fs.readJson(path.join(STATE_DIR, file)) as MigrationState;
      states.push({
        stateId: state.stateId,
        config: state.config,
        status: state.status,
        stats: state.stats,
        createdAt: state.createdAt,
        updatedAt: state.updatedAt,
      });
    } catch {
      // skip corrupted state files
    }
  }

  return states;
}

/**
 * Delete a migration state file.
 */
export async function deleteState(stateId: string): Promise<void> {
  const filePath = path.join(STATE_DIR, `${stateId}.json`);
  if (await fs.pathExists(filePath)) {
    await fs.remove(filePath);
  }
}

/**
 * Create a fresh migration state object.
 */
export function createState(stateId: string, config: MigrationStateConfig): MigrationState {
  const tempBase = path.join(os.tmpdir(), 'sf-filebuddy-migrate');
  return {
    version: 1,
    stateId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    config,
    tempDir: path.join(tempBase, stateId),
    status: 'in_progress',
    completed: {},
    stats: {
      filesFound: 0,
      filesUploaded: 0,
      filesFailed: 0,
      filesSkipped: 0,
      linksCreated: 0,
    },
  };
}
