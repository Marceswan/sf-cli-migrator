import os from 'node:os';
import path from 'node:path';
import fs from 'fs-extra';

const TEMP_BASE = path.join(os.tmpdir(), 'sf-fileorg-migrate');

export function createTempDirPath(): string {
  return path.join(TEMP_BASE, Date.now().toString());
}

export async function prepareTempDir(): Promise<string> {
  const tempDir = createTempDirPath();
  await fs.ensureDir(tempDir);
  return tempDir;
}

export async function cleanupTempDir(tempDir: string): Promise<void> {
  if (await fs.pathExists(tempDir)) {
    await fs.remove(tempDir);
  }
}
