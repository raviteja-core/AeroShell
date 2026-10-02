import * as fs from 'node:fs';
import * as path from 'node:path';

export interface GpuFallbackFlag {
  armedAt: number;
  electronVersion: string;
}

export interface GpuFallbackPolicyOptions {
  maxCrashes?: number; // default 3
  windowMs?: number;   // default 5 minutes
  expiryMs?: number;   // default 7 days
}

export class GpuFallbackTracker {
  private crashTimes: number[] = [];
  private maxCrashes: number;
  private windowMs: number;

  constructor(opts?: { maxCrashes?: number; windowMs?: number }) {
    this.maxCrashes = opts?.maxCrashes ?? 3;
    this.windowMs = opts?.windowMs ?? 5 * 60 * 1000;
  }

  /**
   * Records a GPU process crash timestamp.
   * Returns true if crash count within windowMs reaches maxCrashes (triggering fallback).
   */
  public recordCrash(now: number = Date.now()): boolean {
    this.crashTimes.push(now);
    // Prune older than windowMs
    this.crashTimes = this.crashTimes.filter((t) => now - t <= this.windowMs);
    return this.crashTimes.length >= this.maxCrashes;
  }

  public getCrashCount(): number {
    return this.crashTimes.length;
  }

  public reset(): void {
    this.crashTimes = [];
  }
}

const FLAG_FILENAME = 'gpu-fallback.json';
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export function getFallbackFilePath(userDataDir: string): string {
  return path.join(userDataDir, FLAG_FILENAME);
}

export function armGpuFallback(
  userDataDir: string,
  electronVersion: string,
  armedAt: number = Date.now()
): void {
  const filePath = getFallbackFilePath(userDataDir);
  const data: GpuFallbackFlag = {
    armedAt,
    electronVersion,
  };
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

/**
 * Checks whether GPU hardware acceleration should be disabled on this launch.
 * Ignores the flag if electronVersion differs or if the flag is older than 7 days.
 */
export function isGpuFallbackActive(
  userDataDir: string,
  currentElectronVersion: string,
  now: number = Date.now()
): boolean {
  const filePath = getFallbackFilePath(userDataDir);
  if (!fs.existsSync(filePath)) {
    return false;
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as GpuFallbackFlag;

    if (!parsed || typeof parsed.armedAt !== 'number' || typeof parsed.electronVersion !== 'string') {
      return false;
    }

    // Ignore if electron version differs (retry hardware once on upgrade)
    if (parsed.electronVersion !== currentElectronVersion) {
      return false;
    }

    // Ignore if older than 7 days
    if (now - parsed.armedAt > SEVEN_DAYS_MS) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

export function clearGpuFallback(userDataDir: string): void {
  const filePath = getFallbackFilePath(userDataDir);
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {}
}
