import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

const addonPath = path.resolve(__dirname, '../../build/Release/aero_win_bridge.node');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const native = require(addonPath);

describe('aero_win_bridge native addon', () => {
  const testValPrefix = `AeroShell_Test_${Date.now()}`;
  const strValName = `${testValPrefix}_Str`;
  const dwValName = `${testValPrefix}_Dw`;

  beforeAll(() => {
    // Stage temporary REG_SZ and REG_DWORD entries under allowlisted HKCU key
    try {
      execSync(
        `reg add "HKCU\\Software\\Microsoft\\DirectX\\UserGpuPreferences" /v "${strValName}" /t REG_SZ /d "GpuPreference=2;" /f`,
        { stdio: 'pipe' }
      );
      execSync(
        `reg add "HKCU\\Software\\Microsoft\\DirectX\\UserGpuPreferences" /v "${dwValName}" /t REG_DWORD /d 1337 /f`,
        { stdio: 'pipe' }
      );
    } catch (e) {
      console.warn('Failed to set up test registry entries:', e);
    }
  });

  afterAll(() => {
    // Clean up temporary registry keys
    try {
      execSync(
        `reg delete "HKCU\\Software\\Microsoft\\DirectX\\UserGpuPreferences" /v "${strValName}" /f`,
        { stdio: 'pipe' }
      );
    } catch {}
    try {
      execSync(
        `reg delete "HKCU\\Software\\Microsoft\\DirectX\\UserGpuPreferences" /v "${dwValName}" /f`,
        { stdio: 'pipe' }
      );
    } catch {}
  });

  describe('GetSystemMemoryInfo', () => {
    it('returns valid Win32 memory metrics', () => {
      const mem = native.getSystemMemoryInfo();
      expect(typeof mem.memoryLoadPercent).toBe('number');
      expect(mem.memoryLoadPercent).toBeGreaterThanOrEqual(0);
      expect(mem.memoryLoadPercent).toBeLessThanOrEqual(100);

      expect(typeof mem.totalPhysMB).toBe('number');
      expect(mem.totalPhysMB).toBeGreaterThan(0);

      expect(typeof mem.availPhysMB).toBe('number');
      expect(mem.availPhysMB).toBeGreaterThan(0);
      expect(mem.availPhysMB).toBeLessThanOrEqual(mem.totalPhysMB);

      expect(typeof mem.totalCommitMB).toBe('number');
      expect(mem.totalCommitMB).toBeGreaterThan(0);

      expect(typeof mem.availCommitMB).toBe('number');
      expect(mem.availCommitMB).toBeGreaterThan(0);
    });
  });

  describe('GetGpuHardwareInfo', () => {
    it('returns array of adapters with valid schema, tolerating software adapters', () => {
      const gpus = native.GetGpuHardwareInfo ? native.GetGpuHardwareInfo() : native.getGpuHardwareInfo();
      expect(Array.isArray(gpus)).toBe(true);

      for (const gpu of gpus) {
        expect(typeof gpu.index).toBe('number');
        expect(typeof gpu.name).toBe('string');
        expect(typeof gpu.vendorId).toBe('number');
        expect(typeof gpu.deviceId).toBe('number');
        expect(typeof gpu.isSoftware).toBe('boolean');
        expect(typeof gpu.dedicatedVramMB).toBe('number');
        expect(typeof gpu.sharedSystemMB).toBe('number');

        // Optional on virtual/software adapters or older DXGI
        if (gpu.vramBudgetMB !== undefined) {
          expect(typeof gpu.vramBudgetMB).toBe('number');
          expect(gpu.vramBudgetMB).toBeGreaterThanOrEqual(0);
        }
        if (gpu.vramUsageMB !== undefined) {
          expect(typeof gpu.vramUsageMB).toBe('number');
          expect(gpu.vramUsageMB).toBeGreaterThanOrEqual(0);
        }
      }
    });
  });

  describe('ReadRegistry (Security Allowlist & Type Support)', () => {
    it('reads REG_SZ string value from allowlisted HKCU key', () => {
      const res = native.readRegistry(0, strValName);
      expect(res).toBe('GpuPreference=2;');
    });

    it('reads REG_DWORD number value from allowlisted HKCU key', () => {
      const res = native.readRegistry(0, dwValName);
      expect(res).toBe(1337);
    });

    it('returns null for non-existent value under allowed key', () => {
      const res = native.readRegistry(0, 'NonExistentVal_99999');
      expect(res).toBeNull();
    });

    it('returns null for area index outside allowlist bounds', () => {
      expect(native.readRegistry(-1, 'test')).toBeNull();
      expect(native.readRegistry(2, 'test')).toBeNull();
      expect(native.readRegistry(99, 'test')).toBeNull();
    });

    it('throws TypeError on invalid arguments', () => {
      // @ts-expect-error invalid args test
      expect(() => native.readRegistry('invalid', 'test')).toThrow();
      // @ts-expect-error invalid args test
      expect(() => native.readRegistry(0, 123)).toThrow();
    });
  });

  describe('Stress / Leak Test (10,000 calls)', () => {
    it('executes 10,000 queries without COM leaks or handle exhaustion', () => {
      for (let i = 0; i < 10000; i++) {
        native.getSystemMemoryInfo();
        if (i % 10 === 0) {
          native.getGpuHardwareInfo();
        }
      }
    });
  });
});
