import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  GpuFallbackTracker,
  armGpuFallback,
  isGpuFallbackActive,
  clearGpuFallback,
} from '../../src/main/gpu-fallback-policy';

describe('GpuFallbackPolicy', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aero-gpu-fallback-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  describe('GpuFallbackTracker', () => {
    it('triggers fallback when 3 crashes occur within 5 minutes', () => {
      const tracker = new GpuFallbackTracker();
      const baseTime = 1_000_000;

      // Crash 1 at t=0
      expect(tracker.recordCrash(baseTime)).toBe(false);
      expect(tracker.getCrashCount()).toBe(1);

      // Crash 2 at t=2 minutes
      expect(tracker.recordCrash(baseTime + 2 * 60 * 1000)).toBe(false);
      expect(tracker.getCrashCount()).toBe(2);

      // Crash 3 at t=4 minutes (within 5m window)
      expect(tracker.recordCrash(baseTime + 4 * 60 * 1000)).toBe(true);
      expect(tracker.getCrashCount()).toBe(3);
    });

    it('does not trigger fallback when crashes are spaced apart beyond 5 minutes', () => {
      const tracker = new GpuFallbackTracker();
      const baseTime = 1_000_000;

      // Crash 1 at t=0
      tracker.recordCrash(baseTime);

      // Crash 2 at t=6 minutes (Crash 1 expired)
      tracker.recordCrash(baseTime + 6 * 60 * 1000);
      expect(tracker.getCrashCount()).toBe(1);

      // Crash 3 at t=8 minutes
      tracker.recordCrash(baseTime + 8 * 60 * 1000);
      expect(tracker.getCrashCount()).toBe(2);
      expect(tracker.recordCrash(baseTime + 8 * 60 * 1000)).toBe(true); // 3rd within window
    });
  });

  describe('isGpuFallbackActive & armGpuFallback', () => {
    const currentVersion = '44.5.1';
    const now = 2_000_000_000;

    it('returns false when flag file does not exist', () => {
      expect(isGpuFallbackActive(tmpDir, currentVersion, now)).toBe(false);
    });

    it('returns true when valid flag exists for current version within 7 days', () => {
      armGpuFallback(tmpDir, currentVersion, now);
      expect(isGpuFallbackActive(tmpDir, currentVersion, now + 1000)).toBe(true);
    });

    it('ignores flag file when electronVersion differs (retries hardware on update)', () => {
      armGpuFallback(tmpDir, '43.0.0', now);
      expect(isGpuFallbackActive(tmpDir, currentVersion, now + 1000)).toBe(false);
    });

    it('ignores flag file when older than 7 days', () => {
      const eightDaysMs = 8 * 24 * 60 * 60 * 1000;
      armGpuFallback(tmpDir, currentVersion, now);
      expect(isGpuFallbackActive(tmpDir, currentVersion, now + eightDaysMs)).toBe(false);
    });

    it('clears flag file properly', () => {
      armGpuFallback(tmpDir, currentVersion, now);
      expect(isGpuFallbackActive(tmpDir, currentVersion, now)).toBe(true);

      clearGpuFallback(tmpDir);
      expect(isGpuFallbackActive(tmpDir, currentVersion, now)).toBe(false);
    });
  });
});
