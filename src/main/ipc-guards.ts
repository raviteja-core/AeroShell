import * as fs from 'node:fs';
import * as path from 'node:path';

export interface MinimalFrame {
  url: string;
}

export interface MinimalWebContents {
  mainFrame: MinimalFrame | null;
}

export interface MinimalWindow {
  webContents: MinimalWebContents | null;
}

export interface MinimalInvokeEvent {
  senderFrame: MinimalFrame | null;
}

/**
 * Validates that an incoming IPC invoke originates strictly from the top-level main frame
 * of the authoritative application window, matching standard scheme `aeroshell-app:` and host `app`.
 * Fails closed on null frame, mismatched frame, or untrusted origin.
 * Pure TypeScript logic with zero Electron runtime imports.
 */
export function assertTrusted(
  event: MinimalInvokeEvent,
  expectedWindow: MinimalWindow
): void {
  // Fail closed if senderFrame is missing or null
  if (!event || !event.senderFrame) {
    throw new Error('IPC rejected: null senderFrame');
  }

  // Must strictly be the mainFrame of the authoritative window (rejects unapproved frames and iframes)
  if (
    !expectedWindow ||
    !expectedWindow.webContents ||
    !expectedWindow.webContents.mainFrame ||
    event.senderFrame !== expectedWindow.webContents.mainFrame
  ) {
    throw new Error('IPC rejected: unauthorized sender frame');
  }

  const rawUrl = event.senderFrame.url;
  if (!rawUrl) {
    throw new Error('IPC rejected: empty sender URL');
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('IPC rejected: invalid sender URL');
  }

  // Compare parsed protocol and host strictly, preventing prefix bypasses like aeroshell-app://app.evil/
  if (parsed.protocol !== 'aeroshell-app:' || parsed.host !== 'app') {
    throw new Error(`IPC rejected: untrusted origin ${parsed.origin}`);
  }
}

export interface HeapSnapshotOptions {
  userDataDir: string;
  reason: string;
  isDev: boolean;
  readRegistry: (area: number, name: string) => string | number | null;
  writeHeapSnapshot: (filename: string) => Promise<string> | string;
  now?: () => number;
}

let lastSnapshotTime = 0;
const RATE_LIMIT_MS = 60_000;
const MAX_SNAPSHOTS = 5;

/**
 * Executes a controlled heap snapshot capture with diagnostics authorization,
 * rate limiting (1 per 60s), minimum 50 MB free disk space verification,
 * and a 5-file retention ceiling.
 */
export function handleCaptureHeapSnapshot(
  opts: HeapSnapshotOptions
): { file: string } | Promise<{ file: string }> {
  // 1. Diagnostics authorization check: active dev build OR registry policy EnableDiagnostics == 1
  let regPolicy: string | number | null = null;
  try {
    regPolicy = opts.readRegistry(1, 'EnableDiagnostics');
  } catch {
    regPolicy = null;
  }

  const diagnosticsAllowed = opts.isDev || regPolicy === 1;
  if (!diagnosticsAllowed) {
    throw new Error('Diagnostics disabled by policy');
  }

  // 2. Rate limiting: 1 snapshot per 60 seconds
  const currentTime = opts.now ? opts.now() : Date.now();
  if (currentTime - lastSnapshotTime < RATE_LIMIT_MS) {
    const waitSec = Math.ceil((RATE_LIMIT_MS - (currentTime - lastSnapshotTime)) / 1000);
    throw new Error(`Rate limit exceeded: please wait ${waitSec}s before capturing another snapshot`);
  }

  // 3. Free disk space verification (minimum 50 MB required)
  if (typeof (fs as any).statfsSync === 'function') {
    try {
      if (fs.existsSync(opts.userDataDir)) {
        const stats = (fs as any).statfsSync(opts.userDataDir);
        const freeMB = (stats.bavail * stats.bsize) / (1024 * 1024);
        if (freeMB < 50) {
          throw new Error(`Insufficient disk space: ${Math.round(freeMB)} MB available, minimum 50 MB required`);
        }
      }
    } catch (err: any) {
      if (err?.message?.includes('Insufficient disk space')) {
        throw err;
      }
    }
  }

  // 4. Sanitize filename and prepare destination directory
  const sanitizedReason = opts.reason.replace(/[^\w-]/g, '_').slice(0, 80);
  const diagDir = path.join(opts.userDataDir, 'Diagnostics');
  fs.mkdirSync(diagDir, { recursive: true });

  const targetFile = path.join(diagDir, `heap-${currentTime}-${sanitizedReason}.heapsnapshot`);

  const pruneOldSnapshots = () => {
    try {
      const files = fs
        .readdirSync(diagDir)
        .filter((f) => f.startsWith('heap-') && f.endsWith('.heapsnapshot'))
        .map((f) => {
          const fullPath = path.join(diagDir, f);
          const match = /^heap-(\d+)-/.exec(f);
          const fileTime = match && match[1] ? parseInt(match[1], 10) : 0;
          return {
            name: f,
            fullPath,
            time: fileTime || fs.statSync(fullPath).mtimeMs,
          };
        })
        .sort((a, b) => b.time - a.time);

      if (files.length > MAX_SNAPSHOTS) {
        const toDelete = files.slice(MAX_SNAPSHOTS);
        for (const item of toDelete) {
          try {
            fs.unlinkSync(item.fullPath);
          } catch {}
        }
      }
    } catch (err) {
      console.warn('[diagnostics] Failed to prune heap snapshots:', err);
    }
  };

  const writeResult = opts.writeHeapSnapshot(targetFile);

  if (writeResult instanceof Promise) {
    return writeResult.then((actualPath) => {
      lastSnapshotTime = currentTime;
      pruneOldSnapshots();
      return { file: (typeof actualPath === 'string' && actualPath) ? actualPath : targetFile };
    });
  }

  lastSnapshotTime = currentTime;
  pruneOldSnapshots();
  return { file: (typeof writeResult === 'string' && writeResult) ? writeResult : targetFile };
}

/** Reset internal rate limiter state (useful for test isolation) */
export function _resetRateLimiter(): void {
  lastSnapshotTime = 0;
}
