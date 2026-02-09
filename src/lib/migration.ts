import path from 'node:path';
import fs from 'fs-extra';
import { Connection } from '@salesforce/core';
import { prepareTempDir, cleanupTempDir } from './temp.js';

const BATCH_SIZE = 200;
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB REST API limit

// ─── Types ───────────────────────────────────────────────────────────────────

export interface MigrationLogger {
  log: (msg: string) => void;
  warn: (msg: string) => void;
  startSpinner: (msg: string) => void;
  updateSpinner: (msg: string) => void;
  stopSpinner: (msg: string) => void;
  stopSpinnerFail: (msg: string) => void;
}

export interface MigrationOptions {
  sourceConn: Connection;
  targetConn: Connection;
  objectApiName: string;
  sourceMatchField: string;
  targetMatchField: string;
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

interface ContentVersionRecord {
  Id: string;
  ContentDocumentId: string;
  Title: string;
  PathOnClient: string;
  FileExtension: string;
  ContentSize: number;
  Description: string | null;
  VersionNumber: string;
}

interface DownloadedFile extends ContentVersionRecord {
  localPath: string;
}

// ─── Main Pipeline ───────────────────────────────────────────────────────────

export async function runMigration(options: MigrationOptions): Promise<MigrationResults> {
  const {
    sourceConn,
    targetConn,
    objectApiName,
    sourceMatchField,
    targetMatchField,
    whereClause,
    dryRun = false,
    logger,
  } = options;

  const results: MigrationResults = {
    filesFound: 0,
    filesUploaded: 0,
    filesFailed: 0,
    filesSkipped: 0,
    linksCreated: 0,
    errors: [],
  };

  let tempDir: string | undefined;

  try {
    // ─── Step 1: Query source records ─────────────────────────────────────
    logger.startSpinner('Querying source records...');

    const where = whereClause ? ` WHERE ${whereClause}` : '';
    // If sourceMatchField is Id, no need to add it to SELECT (it's always included)
    const sourceSelectFields = sourceMatchField === 'Id'
      ? 'Id'
      : `Id, ${sourceMatchField}`;
    const sourceRecords = await queryAll(
      sourceConn,
      `SELECT ${sourceSelectFields} FROM ${objectApiName}${where}`
    );

    if (sourceRecords.length === 0) {
      logger.stopSpinnerFail('No records found in source org matching your criteria.');
      return results;
    }

    logger.stopSpinner(`Found ${sourceRecords.length} source records.`);

    // ─── Step 2: Find associated ContentDocumentLinks ─────────────────────
    logger.startSpinner('Finding associated files...');

    const sourceIds = sourceRecords.map((r) => r.Id as string);
    const links = await queryAllChunked(
      sourceConn,
      sourceIds,
      (chunk) =>
        `SELECT ContentDocumentId, LinkedEntityId
         FROM ContentDocumentLink
         WHERE LinkedEntityId IN (${chunk.map((id) => `'${id}'`).join(',')})`
    );

    if (links.length === 0) {
      logger.stopSpinnerFail('No files (ContentDocumentLinks) found for these records.');
      return results;
    }

    // Build map: ContentDocumentId -> [LinkedEntityId, ...]
    const docToEntityMap = new Map<string, string[]>();
    for (const link of links) {
      const docId = link.ContentDocumentId as string;
      const entityId = link.LinkedEntityId as string;
      if (!docToEntityMap.has(docId)) {
        docToEntityMap.set(docId, []);
      }
      docToEntityMap.get(docId)!.push(entityId);
    }

    const uniqueDocIds = [...docToEntityMap.keys()];
    logger.stopSpinner(`Found ${uniqueDocIds.length} unique files across ${links.length} links.`);

    // ─── Step 3: Query ContentVersion details ─────────────────────────────
    logger.startSpinner('Fetching file metadata...');

    const contentVersions = await queryAllChunked(
      sourceConn,
      uniqueDocIds,
      (chunk) =>
        `SELECT Id, ContentDocumentId, Title, PathOnClient, FileExtension,
                ContentSize, Description, VersionNumber
         FROM ContentVersion
         WHERE ContentDocumentId IN (${chunk.map((id) => `'${id}'`).join(',')})
         AND IsLatest = true`
    ) as unknown as ContentVersionRecord[];

    results.filesFound = contentVersions.length;
    logger.stopSpinner(`Found ${contentVersions.length} file versions to migrate.`);

    // Check for oversized files
    const oversized = contentVersions.filter((cv) => cv.ContentSize > MAX_FILE_SIZE);
    if (oversized.length > 0) {
      logger.warn(`${oversized.length} file(s) exceed 10 MB and will be skipped (Bulk API needed).`);
      for (const f of oversized) {
        logger.warn(`  - ${f.Title} (${formatBytes(f.ContentSize)})`);
      }
      results.filesSkipped += oversized.length;
    }

    const migrateableVersions = contentVersions.filter((cv) => cv.ContentSize <= MAX_FILE_SIZE);

    // ─── Step 4: Build the target record ID map ───────────────────────────
    logger.startSpinner('Mapping records in target org...');

    // Get source match field values (e.g., source.Id or source.External_Id__c)
    const sourceMatchValues = [
      ...new Set(
        sourceRecords
          .map((r) => r[sourceMatchField])
          .filter(Boolean)
          .map(String)
      ),
    ];

    // Build source record Id -> source match value map
    const sourceIdToMatchValue = new Map<string, string>();
    for (const rec of sourceRecords) {
      const val = rec[sourceMatchField];
      if (val) sourceIdToMatchValue.set(rec.Id as string, String(val));
    }

    // Query target records where targetMatchField matches source values
    const targetRecords = await queryAllChunked(
      targetConn,
      sourceMatchValues,
      (chunk) =>
        `SELECT Id, ${targetMatchField} FROM ${objectApiName}
         WHERE ${targetMatchField} IN (${chunk.map((v) => `'${escSoql(v)}'`).join(',')})`
    );

    // Build target match value -> target Id map
    const targetMatchToId = new Map<string, string>();
    for (const rec of targetRecords) {
      targetMatchToId.set(String(rec[targetMatchField]), rec.Id as string);
    }

    // Build source entity Id -> target entity Id map
    const sourceToTargetEntityMap = new Map<string, string>();
    let unmatchedCount = 0;
    for (const rec of sourceRecords) {
      const matchVal = sourceIdToMatchValue.get(rec.Id as string);
      if (matchVal && targetMatchToId.has(matchVal)) {
        sourceToTargetEntityMap.set(rec.Id as string, targetMatchToId.get(matchVal)!);
      } else {
        unmatchedCount++;
      }
    }

    const mappedMsg = `Mapped ${sourceToTargetEntityMap.size} records.` +
      (unmatchedCount > 0 ? ` ${unmatchedCount} unmatched (files for these will be skipped).` : '');
    logger.stopSpinner(mappedMsg);

    // ─── Dry Run Report ───────────────────────────────────────────────────
    if (dryRun) {
      logger.log('');
      logger.log('  ── Dry Run Summary ──');
      logger.log(`  Records matched:    ${sourceToTargetEntityMap.size}`);
      logger.log(`  Files to migrate:   ${migrateableVersions.length}`);
      logger.log(`  Files oversized:    ${oversized.length}`);
      logger.log(`  Records unmatched:  ${unmatchedCount}`);
      logger.log('  ─────────────────────');
      logger.log('');
      return results;
    }

    // ─── Step 5: Download files from source ───────────────────────────────
    tempDir = await prepareTempDir();
    logger.startSpinner('Downloading files from source...');

    const downloadedFiles: DownloadedFile[] = [];
    for (let i = 0; i < migrateableVersions.length; i++) {
      const cv = migrateableVersions[i];
      logger.updateSpinner(`Downloading files from source... (${i + 1}/${migrateableVersions.length}) ${cv.Title}`);

      try {
        const filePath = path.join(tempDir, `${cv.Id}_${cv.PathOnClient}`);
        await downloadContentVersion(sourceConn, cv.Id, filePath);
        downloadedFiles.push({ ...cv, localPath: filePath });
      } catch (err) {
        results.filesFailed++;
        results.errors.push({ file: cv.Title, stage: 'download', error: (err as Error).message });
        logger.warn(`Failed to download: ${cv.Title} — ${(err as Error).message}`);
      }
    }

    logger.stopSpinner(`Downloaded ${downloadedFiles.length} files.`);

    // ─── Step 6: Upload ContentVersions and resolve ContentDocumentIds ────
    logger.startSpinner('Uploading files to target org...');

    const sourceDocToTargetDoc = new Map<string, string>();
    // Collect version IDs per batch for periodic resolution
    let pendingUploads: Array<{ versionId: string; sourceDocId: string }> = [];

    for (let i = 0; i < downloadedFiles.length; i++) {
      const file = downloadedFiles[i];
      logger.updateSpinner(`Uploading files to target org... (${i + 1}/${downloadedFiles.length}) ${file.Title}`);

      try {
        const fileData = await fs.readFile(file.localPath);
        const base64Body = fileData.toString('base64');

        const insertResult = await targetConn.sobject('ContentVersion').create({
          Title: file.Title,
          PathOnClient: file.PathOnClient,
          VersionData: base64Body,
          Description: file.Description || '',
        });

        if (insertResult.success) {
          results.filesUploaded++;
          const versionId = insertResult.id;
          if (versionId) {
            pendingUploads.push({ versionId, sourceDocId: file.ContentDocumentId });
          }
        } else {
          throw new Error(insertResult.errors?.join(', ') || 'Unknown insert error');
        }
      } catch (err) {
        results.filesFailed++;
        results.errors.push({ file: file.Title, stage: 'upload', error: (err as Error).message });
        logger.warn(`Failed to upload: ${file.Title} — ${(err as Error).message}`);
      }

      // Resolve ContentDocumentIds every BATCH_SIZE uploads (or at the end)
      if (pendingUploads.length >= BATCH_SIZE || (i === downloadedFiles.length - 1 && pendingUploads.length > 0)) {
        await resolveContentDocumentIds(targetConn, pendingUploads, sourceDocToTargetDoc);
        pendingUploads = [];
      }
    }

    logger.stopSpinner(`Uploaded ${results.filesUploaded} files. Resolved ${sourceDocToTargetDoc.size} document IDs.`);

    if (sourceDocToTargetDoc.size === 0 && results.filesUploaded > 0) {
      logger.warn('No document ID mappings resolved — ContentDocumentLinks cannot be created.');
    }

    // ─── Step 8: Create ContentDocumentLinks in target ────────────────────
    logger.startSpinner('Creating ContentDocumentLinks in target...');

    const linksToCreate: Array<{
      ContentDocumentId: string;
      LinkedEntityId: string;
      ShareType: string;
      Visibility: string;
    }> = [];

    for (const [sourceDocId, sourceEntityIds] of docToEntityMap.entries()) {
      const targetDocId = sourceDocToTargetDoc.get(sourceDocId);
      if (!targetDocId) continue;

      for (const sourceEntityId of sourceEntityIds) {
        const targetEntityId = sourceToTargetEntityMap.get(sourceEntityId);
        if (!targetEntityId) continue;

        linksToCreate.push({
          ContentDocumentId: targetDocId,
          LinkedEntityId: targetEntityId,
          ShareType: 'V',
          Visibility: 'AllUsers',
        });
      }
    }

    // Insert in batches
    for (let i = 0; i < linksToCreate.length; i += BATCH_SIZE) {
      const batch = linksToCreate.slice(i, i + BATCH_SIZE);
      logger.updateSpinner(
        `Creating ContentDocumentLinks in target... (${Math.min(i + BATCH_SIZE, linksToCreate.length)}/${linksToCreate.length})`
      );

      try {
        const insertResults = await targetConn.sobject('ContentDocumentLink').create(batch);
        const batchResults = Array.isArray(insertResults) ? insertResults : [insertResults];
        for (const r of batchResults) {
          if (r.success) {
            results.linksCreated++;
          } else {
            results.errors.push({ stage: 'link', error: r.errors?.join(', ') || 'Unknown' });
          }
        }
      } catch (err) {
        results.errors.push({ stage: 'link_batch', error: (err as Error).message });
        logger.warn(`Link batch error: ${(err as Error).message}`);
      }
    }

    logger.stopSpinner(`Created ${results.linksCreated} ContentDocumentLinks.`);

    if (results.linksCreated === 0 && results.filesUploaded > 0) {
      logger.warn('Files were uploaded but no ContentDocumentLinks were created.');
      logger.warn(`  Source-to-target record mappings: ${sourceToTargetEntityMap.size}`);
      logger.warn(`  Source-to-target document mappings: ${sourceDocToTargetDoc.size}`);
      logger.warn(`  Links attempted: ${linksToCreate.length}`);
    }

    // ─── Cleanup ──────────────────────────────────────────────────────────
    if (tempDir) {
      await cleanupTempDir(tempDir);
    }
  } catch (err) {
    logger.stopSpinnerFail('Error');
    results.errors.push({ stage: 'fatal', error: (err as Error).message });
    logger.log(`\n  Fatal error: ${(err as Error).message}\n`);
    if (tempDir) {
      await cleanupTempDir(tempDir);
    }
  }

  return results;
}

// ─── Helper Functions ─────────────────────────────────────────────────────────

interface QueryResult {
  done: boolean;
  nextRecordsUrl?: string;
  records: Array<Record<string, unknown>>;
}

async function queryAll(conn: Connection, soql: string): Promise<Array<Record<string, unknown>>> {
  const records: Array<Record<string, unknown>> = [];
  let result = (await conn.query(soql)) as unknown as QueryResult;
  records.push(...result.records);

  while (!result.done) {
    result = (await conn.queryMore(result.nextRecordsUrl!)) as unknown as QueryResult;
    records.push(...result.records);
  }

  return records;
}

async function queryAllChunked(
  conn: Connection,
  ids: string[],
  soqlBuilder: (chunk: string[]) => string,
  chunkSize = BATCH_SIZE
): Promise<Array<Record<string, unknown>>> {
  const allRecords: Array<Record<string, unknown>> = [];
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const records = await queryAll(conn, soqlBuilder(chunk));
    allRecords.push(...records);
  }
  return allRecords;
}

async function resolveContentDocumentIds(
  conn: Connection,
  uploads: Array<{ versionId: string; sourceDocId: string }>,
  resultMap: Map<string, string>
): Promise<void> {
  if (uploads.length === 0) return;

  const idToSourceDoc = new Map<string, string>();
  for (const u of uploads) {
    idToSourceDoc.set(u.versionId, u.sourceDocId);
  }

  // Use direct REST API call to query ContentDocumentIds — bypasses jsforce Query object
  const ids = uploads.map((u) => u.versionId);
  const soql = `SELECT Id, ContentDocumentId FROM ContentVersion WHERE Id IN (${ids.map((id) => `'${id}'`).join(',')})`;
  const apiVersion = conn.getApiVersion();
  const url = `${conn.instanceUrl}/services/data/v${apiVersion}/query?q=${encodeURIComponent(soql)}`;

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${conn.accessToken!}` },
  });

  if (!response.ok) {
    throw new Error(`ContentDocumentId resolution query failed: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as { records: Array<{ Id: string; ContentDocumentId: string }> };
  for (const rec of data.records) {
    const sourceDocId = idToSourceDoc.get(rec.Id);
    if (sourceDocId) {
      resultMap.set(sourceDocId, rec.ContentDocumentId);
    }
  }
}

async function downloadContentVersion(
  conn: Connection,
  contentVersionId: string,
  outputPath: string
): Promise<void> {
  const apiVersion = conn.getApiVersion();
  const fullUrl = `${conn.instanceUrl}/services/data/v${apiVersion}/sobjects/ContentVersion/${contentVersionId}/VersionData`;

  const response = await fetch(fullUrl, {
    headers: { Authorization: `Bearer ${conn.accessToken!}` },
    redirect: 'follow',
  });

  if (!response.ok) {
    throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(outputPath, buffer);
}

function escSoql(val: string): string {
  return val.replace(/'/g, "\\'");
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
