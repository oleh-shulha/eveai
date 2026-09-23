/**
 * SDE Downloader -- downloads EVE static data in JSONL format from CCP.
 *
 * Usage: npm run sde:download (or the in-app refresh in src/eve/sde-refresh.ts)
 *
 * Downloads from SDE_ARCHIVE_URL and extracts JSONL files to SDE_DATA_DIR
 * (default: ./data/sde/).
 *
 * CCP provides the SDE in two formats:
 *   - JSON Lines (.jsonl) -- preferred for streaming, lower memory
 *   - YAML (.yaml) -- alternative, can be slow for large files
 *
 * The SDE was reworked in September 2025. New format:
 *   - name fields are localized objects: {en: "Tritanium", ru: "Тританиум", ...}
 *   - some fields renamed (nameID → name)
 *   - bsd/universe folders removed
 */

import 'dotenv/config';
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  identityFromHeaders,
  SDE_ARCHIVE_URL,
  sdeIdentityPath,
  type SdeUpstreamIdentity,
} from './sde-source.js';

// Deliberately no src/config.js import: setup must work before the operator
// has filled in the rest of .env (bot tokens, OpenAI key, EVE credentials).
const SDE_DATA_DIR = process.env.SDE_DATA_DIR || './data/sde';

const SDE_DOWNLOAD_TIMEOUT_MS = 5 * 60_000; // 5 minutes for ~100MB download
const EXTRACT_TIMEOUT_MS = 5 * 60_000; // bound extraction so a hung/corrupt archive can't block forever

export type SdeDownloadResult = {
  dataDir: string;
  zipPath: string;
  identity: SdeUpstreamIdentity;
};

type Logger = (message: string) => void;

const consoleLogger: Logger = (message) => console.log(message);

/**
 * Downloads and extracts the archive, returning the validators the server sent
 * with the bytes actually written. The caller records them, so "is my snapshot
 * current?" later compares like with like instead of guessing from a date.
 */
export async function downloadSdeArchive(
  options: { dataDir?: string; log?: Logger; signal?: AbortSignal } = {},
): Promise<SdeDownloadResult> {
  const dataDir = options.dataDir ?? SDE_DATA_DIR;
  const log = options.log ?? consoleLogger;
  mkdirSync(dataDir, { recursive: true });
  const zipPath = join(dataDir, 'sde-latest.zip');

  const identity = await downloadFile(SDE_ARCHIVE_URL, zipPath, log, options.signal);
  await extractZip(zipPath, dataDir, log);
  // The loader runs as its own process for `npm run setup`, so the validators
  // travel with the extracted files instead of dying with this one.
  writeFileSync(sdeIdentityPath(dataDir), JSON.stringify(identity), 'utf8');
  return { dataDir, zipPath, identity };
}

async function downloadFile(
  url: string,
  dest: string,
  log: Logger,
  signal?: AbortSignal,
): Promise<SdeUpstreamIdentity> {
  log(`[sde-download] Downloading ${url}...`);
  const res = await fetch(url, {
    signal: signal ?? AbortSignal.timeout(SDE_DOWNLOAD_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Failed to download SDE: HTTP ${res.status} ${res.statusText}`);
  }
  if (!res.body) {
    throw new Error('No response body');
  }

  const fileStream = createWriteStream(dest);
  await pipeline(res.body as unknown as NodeJS.ReadableStream, fileStream);
  log(`[sde-download] Saved to ${dest}`);
  return identityFromHeaders(res.headers);
}

async function extractZip(zipPath: string, destDir: string, log: Logger): Promise<void> {
  log(`[sde-download] Extracting to ${destDir}...`);

  // Use node's built-in unzip via child_process since node:zlib doesn't handle zip archives
  const { execFileSync } = await import('node:child_process');
  try {
    execFileSync('unzip', ['-o', zipPath, '-d', destDir], { stdio: 'inherit', timeout: EXTRACT_TIMEOUT_MS });
  } catch (err) {
    // ENOENT means unzip is not installed; any other error means the archive
    // itself is bad — don't silently fall through to a confusing Python trace.
    if ((err as NodeJS.ErrnoException).code && (err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`unzip failed (archive may be corrupt): ${(err as Error).message}`);
    }
    // Fallback: try with python3 (paths passed via sys.argv, not string interpolation)
    log('[sde-download] unzip not found, trying python3...');
    execFileSync('python3', [
      '-c',
      'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); z.extractall(sys.argv[2]); print("Extracted",len(z.namelist()),"files")',
      zipPath,
      destDir,
    ], { stdio: 'inherit', timeout: EXTRACT_TIMEOUT_MS });
  }
}

async function main(): Promise<void> {
  await downloadSdeArchive();
  console.log('[sde-download] Done. Now run: npm run sde:load');
}

// Importing this module (the in-app refresh does) must never start a download.
const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isMain) {
  main().catch((err) => {
    console.error('[sde-download] Error:', err);
    process.exit(1);
  });
}
