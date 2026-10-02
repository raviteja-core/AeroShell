import { app, BrowserWindow, crashReporter, Details, RenderProcessGoneDetails } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { GpuFallbackTracker, armGpuFallback } from './gpu-fallback-policy';

const MAX_LOG_SIZE_BYTES = 1024 * 1024; // 1 MB rotation threshold
const MAX_LOG_FILES = 3;
const MAX_RENDERER_CRASHES = 3;
const CRASH_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

export function initCrashReporter(): void {
  try {
    crashReporter.start({
      productName: 'AeroShell',
      companyName: 'AeroShell',
      submitURL: '',
      uploadToServer: false,
      compress: true,
    });
  } catch (err) {
    console.warn('[crash-monitor] Failed to initialize crashReporter:', err);
  }
}

export function recordIncident(userDataDir: string, incident: Record<string, unknown>): void {
  try {
    const diagDir = path.join(userDataDir, 'Diagnostics');
    fs.mkdirSync(diagDir, { recursive: true });

    const logPath = path.join(diagDir, 'crashes.jsonl');

    // Check size rotation
    if (fs.existsSync(logPath)) {
      const stat = fs.statSync(logPath);
      if (stat.size >= MAX_LOG_SIZE_BYTES) {
        rotateLogFiles(diagDir);
      }
    }

    const entry = JSON.stringify({
      timestamp: new Date().toISOString(),
      ...incident,
    }) + '\n';

    fs.appendFileSync(logPath, entry, 'utf8');
  } catch (err) {
    console.warn('[crash-monitor] Failed to record crash incident:', err);
  }
}

function rotateLogFiles(diagDir: string): void {
  try {
    const oldestPath = path.join(diagDir, `crashes.${MAX_LOG_FILES - 1}.jsonl`);
    if (fs.existsSync(oldestPath)) {
      fs.unlinkSync(oldestPath);
    }

    for (let i = MAX_LOG_FILES - 2; i >= 1; i--) {
      const src = path.join(diagDir, `crashes.${i}.jsonl`);
      const dest = path.join(diagDir, `crashes.${i + 1}.jsonl`);
      if (fs.existsSync(src)) {
        fs.renameSync(src, dest);
      }
    }

    const currentLog = path.join(diagDir, 'crashes.jsonl');
    const firstRotated = path.join(diagDir, 'crashes.1.jsonl');
    if (fs.existsSync(currentLog)) {
      fs.renameSync(currentLog, firstRotated);
    }
  } catch (err) {
    console.warn('[crash-monitor] Failed to rotate crash logs:', err);
  }
}

export class CrashMonitor {
  private win: BrowserWindow;
  private rendererCrashTimes: number[] = [];
  private gpuTracker: GpuFallbackTracker;

  constructor(win: BrowserWindow) {
    this.win = win;
    this.gpuTracker = new GpuFallbackTracker({ maxCrashes: 3, windowMs: CRASH_WINDOW_MS });
    this.attachListeners();
  }

  private attachListeners(): void {
    const userData = app.getPath('userData');

    // 1. Renderer process termination listener
    this.win.webContents.on('render-process-gone', (_event, details: RenderProcessGoneDetails) => {
      recordIncident(userData, {
        event: 'render-process-gone',
        processType: 'renderer',
        reason: details.reason,
        exitCode: details.exitCode,
      });

      const now = Date.now();
      this.rendererCrashTimes.push(now);
      this.rendererCrashTimes = this.rendererCrashTimes.filter((t) => now - t <= CRASH_WINDOW_MS);

      if (this.rendererCrashTimes.length <= MAX_RENDERER_CRASHES) {
        console.warn(
          `[crash-monitor] Renderer terminated (${details.reason}). Recovering window (attempt ${this.rendererCrashTimes.length}/${MAX_RENDERER_CRASHES})...`
        );
        this.win.webContents.reload();
      } else {
        console.error(
          `[crash-monitor] Renderer crash loop exceeded limit (${this.rendererCrashTimes.length} crashes in 5m). Loading static fallback error page.`
        );
        void this.win.loadURL('aeroshell-app://app/crash-error.html');
      }
    });

    // 2. Child process (GPU, Utility) termination listener
    app.on('child-process-gone', (_event, details: Details) => {
      recordIncident(userData, {
        processType: details.type,
        reason: details.reason,
        exitCode: details.exitCode,
        name: details.name,
      });

      if (details.type === 'GPU') {
        const armed = this.gpuTracker.recordCrash();
        if (armed) {
          console.error(
            '[crash-monitor] GPU process crashed 3 times in 5 minutes. Arming software fallback for subsequent launch.'
          );
          armGpuFallback(userData, process.versions.electron);
        }
      }
    });
  }

  public getRendererCrashCount(): number {
    return this.rendererCrashTimes.length;
  }
}
