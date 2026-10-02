import { describe, it, expect } from 'vitest';
import {
  evaluatePressure,
  initialPressureState,
  DEFAULT_PRESSURE_CONFIG,
  MemorySnapshot,
  PressureState,
} from '../../src/main/pressure-evaluator';

describe('PressureEvaluator', () => {
  const healthySnapshot: MemorySnapshot = {
    system: {
      totalPhysMB: 16384,
      availPhysMB: 8192,
    },
    rendererMemoryMB: 200,
    gpuProcessMemoryMB: 150,
    activeAdapterVram: {
      luid: 'luid_0x00000000_0x0000DD74_phys_0',
      isSoftware: false,
      dedicatedVramMB: 4096,
      vramBudgetMB: 3500,
      adapterVramUsageMB: 1000,
    },
  };

  it('starts in NORMAL state and produces no event on healthy snapshot', () => {
    const s0 = initialPressureState();
    const res = evaluatePressure(healthySnapshot, s0);
    expect(res.newState.currentSeverity).toBe('NORMAL');
    expect(res.event).toBeUndefined();
  });

  describe('Immediate Escalation', () => {
    it('escalates immediately to WARN on RAM breach', () => {
      const s0 = initialPressureState();
      // Total 16384 MB -> 8% = 1310.72 MB. Avail 1000 MB < 1310 MB -> WARN
      const ramWarnSnapshot: MemorySnapshot = {
        ...healthySnapshot,
        system: { totalPhysMB: 16384, availPhysMB: 1000 },
      };

      const res = evaluatePressure(ramWarnSnapshot, s0);
      expect(res.newState.currentSeverity).toBe('WARN');
      expect(res.event).toBeDefined();
      expect(res.event?.severity).toBe('WARN');
      expect(res.event?.reasons[0]).toContain('[Win32 Memory]');
    });

    it('escalates immediately from NORMAL to CRITICAL on renderer memory spike', () => {
      const s0 = initialPressureState();
      const critSnapshot: MemorySnapshot = {
        ...healthySnapshot,
        rendererMemoryMB: 1600, // > 1536 MB
      };

      const res = evaluatePressure(critSnapshot, s0);
      expect(res.newState.currentSeverity).toBe('CRITICAL');
      expect(res.event?.severity).toBe('CRITICAL');
      expect(res.event?.reasons[0]).toContain('[Renderer Memory]');
    });

    it('escalates immediately to WARN on active GPU VRAM ratio breach', () => {
      const s0 = initialPressureState();
      const vramWarnSnapshot: MemorySnapshot = {
        ...healthySnapshot,
        activeAdapterVram: {
          ...healthySnapshot.activeAdapterVram!,
          vramBudgetMB: 3000,
          adapterVramUsageMB: 2500, // 83.3% >= 80%
        },
      };

      const res = evaluatePressure(vramWarnSnapshot, s0);
      expect(res.newState.currentSeverity).toBe('WARN');
      expect(res.event?.severity).toBe('WARN');
      expect(res.event?.reasons[0]).toContain('[PDH GPU Adapter]');
    });
  });

  describe('Hysteresis & De-escalation', () => {
    it('requires N=3 consecutive healthy ticks below exit thresholds to de-escalate to NORMAL', () => {
      let state: PressureState = {
        currentSeverity: 'WARN',
        consecutiveHealthyTicks: 0,
        reasons: ['Initial WARN'],
      };

      // Tick 1: Healthy snapshot
      let res = evaluatePressure(healthySnapshot, state);
      expect(res.newState.currentSeverity).toBe('WARN');
      expect(res.newState.consecutiveHealthyTicks).toBe(1);
      expect(res.event).toBeUndefined();
      state = res.newState;

      // Tick 2: Healthy snapshot
      res = evaluatePressure(healthySnapshot, state);
      expect(res.newState.currentSeverity).toBe('WARN');
      expect(res.newState.consecutiveHealthyTicks).toBe(2);
      expect(res.event).toBeUndefined();
      state = res.newState;

      // Tick 3: Healthy snapshot -> De-escalates to NORMAL
      res = evaluatePressure(healthySnapshot, state);
      expect(res.newState.currentSeverity).toBe('NORMAL');
      expect(res.newState.consecutiveHealthyTicks).toBe(0);
      expect(res.event).toBeDefined();
      expect(res.event?.severity).toBe('NORMAL');
    });

    it('prevents flapping when oscillating around threshold', () => {
      let state: PressureState = {
        currentSeverity: 'WARN',
        consecutiveHealthyTicks: 0,
        reasons: ['Initial WARN'],
      };

      // Renderer memory exit threshold is 850 MB, entry is 1024 MB.
      // Oscillating snapshot at 900 MB is below entry (1024), but ABOVE exit (850).
      const oscillatingSnapshot: MemorySnapshot = {
        ...healthySnapshot,
        rendererMemoryMB: 900,
      };

      // Ticks 1 and 2 under oscillating load
      for (let i = 0; i < 5; i++) {
        const res = evaluatePressure(oscillatingSnapshot, state);
        expect(res.newState.currentSeverity).toBe('WARN'); // Holds WARN, never flips
        expect(res.newState.consecutiveHealthyTicks).toBe(0); // Cannot accumulate healthy ticks
        expect(res.event).toBeUndefined();
        state = res.newState;
      }
    });

    it('resets healthy counter if interrupted before 3 ticks', () => {
      let state: PressureState = {
        currentSeverity: 'WARN',
        consecutiveHealthyTicks: 0,
        reasons: ['Initial WARN'],
      };

      // Tick 1: Healthy
      let res = evaluatePressure(healthySnapshot, state);
      expect(res.newState.consecutiveHealthyTicks).toBe(1);
      state = res.newState;

      // Tick 2: Healthy
      res = evaluatePressure(healthySnapshot, state);
      expect(res.newState.consecutiveHealthyTicks).toBe(2);
      state = res.newState;

      // Tick 3: Spike back to WARN
      const spikeSnapshot: MemorySnapshot = {
        ...healthySnapshot,
        rendererMemoryMB: 1100,
      };
      res = evaluatePressure(spikeSnapshot, state);
      expect(res.newState.currentSeverity).toBe('WARN');
      expect(res.newState.consecutiveHealthyTicks).toBe(0); // Reset!
      state = res.newState;

      // Tick 4: Healthy again
      res = evaluatePressure(healthySnapshot, state);
      expect(res.newState.consecutiveHealthyTicks).toBe(1);
    });
  });

  describe('Signal Degradation & Fallback Handling', () => {
    it('gracefully ignores missing PDH adapter metrics without error', () => {
      const noPdhSnapshot: MemorySnapshot = {
        ...healthySnapshot,
        activeAdapterVram: {
          luid: 'luid_0x00000000_0x0000DD74_phys_0',
          isSoftware: false,
          dedicatedVramMB: 4096,
          vramBudgetMB: 3500,
          adapterVramUsageMB: undefined, // PDH failed / unavailable
        },
      };

      const res = evaluatePressure(noPdhSnapshot, initialPressureState());
      expect(res.newState.currentSeverity).toBe('NORMAL');
      expect(res.event).toBeUndefined();
    });

    it('ignores software adapters for VRAM pressure evaluation', () => {
      const softwareSnapshot: MemorySnapshot = {
        ...healthySnapshot,
        activeAdapterVram: {
          luid: 'luid_0x00000000_0x0000EEAB_phys_0',
          isSoftware: true,
          dedicatedVramMB: 0,
          vramBudgetMB: 8000,
          adapterVramUsageMB: 7500, // 93% if computed, but ignored because isSoftware is true
        },
      };

      const res = evaluatePressure(softwareSnapshot, initialPressureState());
      expect(res.newState.currentSeverity).toBe('NORMAL');
      expect(res.event).toBeUndefined();
    });

    it('handles null or missing active adapter gracefully', () => {
      const noGpuSnapshot: MemorySnapshot = {
        ...healthySnapshot,
        activeAdapterVram: null,
      };

      const res = evaluatePressure(noGpuSnapshot, initialPressureState());
      expect(res.newState.currentSeverity).toBe('NORMAL');
      expect(res.event).toBeUndefined();
    });

    it('handles zero or missing VRAM budget by falling back to dedicatedVramMB', () => {
      const zeroBudgetSnapshot: MemorySnapshot = {
        ...healthySnapshot,
        activeAdapterVram: {
          luid: 'luid_0x00000000_0x0000DD74_phys_0',
          isSoftware: false,
          dedicatedVramMB: 4000,
          vramBudgetMB: 0, // Fallback to dedicatedVramMB
          adapterVramUsageMB: 3500, // 3500 / 4000 = 87.5% >= 80% (WARN)
        },
      };

      const res = evaluatePressure(zeroBudgetSnapshot, initialPressureState());
      expect(res.newState.currentSeverity).toBe('WARN');
      expect(res.event?.severity).toBe('WARN');
      expect(res.event?.reasons[0]).toContain('[PDH GPU Adapter]');
    });
  });
});
