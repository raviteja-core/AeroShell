export type PressureSeverity = 'NORMAL' | 'WARN' | 'CRITICAL';

export interface ActiveAdapterVramSnapshot {
  luid: string;
  isSoftware: boolean;
  dedicatedVramMB: number;
  vramBudgetMB?: number | undefined;
  adapterVramUsageMB?: number | undefined; // From PDH \GPU Adapter Memory(*)\Dedicated Usage
}

export interface MemorySnapshot {
  system: {
    totalPhysMB: number;
    availPhysMB: number;
  };
  rendererMemoryMB: number; // Renderer working set or JS heap (NOT main V8)
  gpuProcessMemoryMB?: number | undefined; // GPU process working set / private bytes
  activeAdapterVram?: ActiveAdapterVramSnapshot | null | undefined;
}

export interface PressureState {
  currentSeverity: PressureSeverity;
  consecutiveHealthyTicks: number;
  reasons: string[];
}

export interface PressureConfig {
  hysteresisTicks: number;
  systemRamMinAvailMB: number;
  systemRamMinAvailPercent: number;
  systemRamCriticalAvailMB: number;
  systemRamCriticalAvailPercent: number;
  rendererWarnMB: number;
  rendererCriticalMB: number;
  gpuProcessWarnMB: number;
  gpuProcessCriticalMB: number;
  vramWarnRatio: number;
  vramCriticalRatio: number;
  // Hysteresis lower exit thresholds
  systemRamExitPercent: number;
  systemRamExitMinMB: number;
  rendererExitMB: number;
  gpuProcessExitMB: number;
  vramExitRatio: number;
}

export const DEFAULT_PRESSURE_CONFIG: PressureConfig = {
  hysteresisTicks: 3,
  systemRamMinAvailMB: 500,
  systemRamMinAvailPercent: 0.08,
  systemRamCriticalAvailMB: 300,
  systemRamCriticalAvailPercent: 0.04,
  rendererWarnMB: 1024,
  rendererCriticalMB: 1536,
  gpuProcessWarnMB: 1024,
  gpuProcessCriticalMB: 1536,
  vramWarnRatio: 0.80,
  vramCriticalRatio: 0.90,
  // Lower exit thresholds to avoid oscillation / flapping
  systemRamExitPercent: 0.10,
  systemRamExitMinMB: 600,
  rendererExitMB: 850,
  gpuProcessExitMB: 850,
  vramExitRatio: 0.70,
};

export interface PressureEventOutput {
  severity: PressureSeverity;
  reasons: string[];
  availPhysMB: number;
  vramUsagePct: number | null;
}

export interface EvaluationResult {
  newState: PressureState;
  event?: PressureEventOutput;
}

const SEVERITY_LEVELS: Record<PressureSeverity, number> = {
  NORMAL: 0,
  WARN: 1,
  CRITICAL: 2,
};

export function initialPressureState(): PressureState {
  return {
    currentSeverity: 'NORMAL',
    consecutiveHealthyTicks: 0,
    reasons: [],
  };
}

export function evaluatePressure(
  snapshot: MemorySnapshot,
  prevState: PressureState,
  config: PressureConfig = DEFAULT_PRESSURE_CONFIG
): EvaluationResult {
  const criticalReasons: string[] = [];
  const warnReasons: string[] = [];

  // 1. System RAM check (labeled: [Win32 GlobalMemoryStatusEx])
  const ramCriticalFloor = Math.max(config.systemRamCriticalAvailMB, snapshot.system.totalPhysMB * config.systemRamCriticalAvailPercent);
  const ramWarnFloor = Math.max(config.systemRamMinAvailMB, snapshot.system.totalPhysMB * config.systemRamMinAvailPercent);

  if (snapshot.system.availPhysMB < ramCriticalFloor) {
    criticalReasons.push(
      `[Win32 Memory] Available RAM critically low: ${Math.round(snapshot.system.availPhysMB)} MB (floor: ${Math.round(ramCriticalFloor)} MB)`
    );
  } else if (snapshot.system.availPhysMB < ramWarnFloor) {
    warnReasons.push(
      `[Win32 Memory] Available RAM low: ${Math.round(snapshot.system.availPhysMB)} MB (floor: ${Math.round(ramWarnFloor)} MB)`
    );
  }

  // 2. Renderer JS Heap / Working Set check (labeled: [Renderer Memory])
  if (snapshot.rendererMemoryMB >= config.rendererCriticalMB) {
    criticalReasons.push(
      `[Renderer Memory] Private memory critical: ${Math.round(snapshot.rendererMemoryMB)} MB >= ${config.rendererCriticalMB} MB`
    );
  } else if (snapshot.rendererMemoryMB >= config.rendererWarnMB) {
    warnReasons.push(
      `[Renderer Memory] Private memory high: ${Math.round(snapshot.rendererMemoryMB)} MB >= ${config.rendererWarnMB} MB`
    );
  }

  // 3. GPU Process Private Bytes check (labeled: [GPU Process Memory])
  if (snapshot.gpuProcessMemoryMB !== undefined) {
    if (snapshot.gpuProcessMemoryMB >= config.gpuProcessCriticalMB) {
      criticalReasons.push(
        `[GPU Process Memory] Private memory critical: ${Math.round(snapshot.gpuProcessMemoryMB)} MB >= ${config.gpuProcessCriticalMB} MB`
      );
    } else if (snapshot.gpuProcessMemoryMB >= config.gpuProcessWarnMB) {
      warnReasons.push(
        `[GPU Process Memory] Private memory high: ${Math.round(snapshot.gpuProcessMemoryMB)} MB >= ${config.gpuProcessWarnMB} MB`
      );
    }
  }

  // 4. Active Adapter VRAM check via PDH (labeled: [PDH GPU Adapter Memory])
  // Evaluated only for active adapter (match activeGpu IDs to DXGI, non-software, dedicated VRAM > 0)
  let vramUsagePct: number | null = null;
  const adapter = snapshot.activeAdapterVram;
  if (
    adapter &&
    !adapter.isSoftware &&
    adapter.dedicatedVramMB > 0 &&
    typeof adapter.adapterVramUsageMB === 'number'
  ) {
    const effectiveBudget = adapter.vramBudgetMB && adapter.vramBudgetMB > 0
      ? adapter.vramBudgetMB
      : adapter.dedicatedVramMB;

    if (effectiveBudget > 0) {
      const ratio = adapter.adapterVramUsageMB / effectiveBudget;
      vramUsagePct = Number((ratio * 100).toFixed(1));

      if (ratio >= config.vramCriticalRatio) {
        criticalReasons.push(
          `[PDH GPU Adapter] VRAM usage critical: ${Math.round(adapter.adapterVramUsageMB)} MB / ${Math.round(effectiveBudget)} MB (${vramUsagePct}%)`
        );
      } else if (ratio >= config.vramWarnRatio) {
        warnReasons.push(
          `[PDH GPU Adapter] VRAM usage high: ${Math.round(adapter.adapterVramUsageMB)} MB / ${Math.round(effectiveBudget)} MB (${vramUsagePct}%)`
        );
      }
    }
  }

  // Determine instantaneous raw severity
  let rawSeverity: PressureSeverity = 'NORMAL';
  let activeReasons: string[] = [];

  if (criticalReasons.length > 0) {
    rawSeverity = 'CRITICAL';
    activeReasons = [...criticalReasons, ...warnReasons];
  } else if (warnReasons.length > 0) {
    rawSeverity = 'WARN';
    activeReasons = warnReasons;
  }

  const rawLevel = SEVERITY_LEVELS[rawSeverity];
  const prevLevel = SEVERITY_LEVELS[prevState.currentSeverity];

  // A. Immediate Escalation: rawLevel > prevLevel
  if (rawLevel > prevLevel) {
    const newState: PressureState = {
      currentSeverity: rawSeverity,
      consecutiveHealthyTicks: 0,
      reasons: activeReasons,
    };
    return {
      newState,
      event: {
        severity: rawSeverity,
        reasons: activeReasons,
        availPhysMB: snapshot.system.availPhysMB,
        vramUsagePct,
      },
    };
  }

  // B. Same Severity: rawLevel === prevLevel
  if (rawLevel === prevLevel) {
    return {
      newState: {
        currentSeverity: prevState.currentSeverity,
        consecutiveHealthyTicks: 0,
        reasons: activeReasons.length > 0 ? activeReasons : prevState.reasons,
      },
    };
  }

  // C. De-escalation Candidate: rawLevel < prevLevel
  // Check strict lower exit thresholds for hysteresis
  const ramExitFloor = Math.max(config.systemRamExitMinMB, snapshot.system.totalPhysMB * config.systemRamExitPercent);
  const isRamClear = snapshot.system.availPhysMB >= ramExitFloor;
  const isRendererClear = snapshot.rendererMemoryMB < config.rendererExitMB;
  const isGpuClear = snapshot.gpuProcessMemoryMB === undefined || snapshot.gpuProcessMemoryMB < config.gpuProcessExitMB;

  let isVramClear = true;
  if (
    adapter &&
    !adapter.isSoftware &&
    adapter.dedicatedVramMB > 0 &&
    typeof adapter.adapterVramUsageMB === 'number'
  ) {
    const effectiveBudget = adapter.vramBudgetMB && adapter.vramBudgetMB > 0 ? adapter.vramBudgetMB : adapter.dedicatedVramMB;
    if (effectiveBudget > 0) {
      isVramClear = (adapter.adapterVramUsageMB / effectiveBudget) < config.vramExitRatio;
    }
  }

  const isBelowExitThresholds = isRamClear && isRendererClear && isGpuClear && isVramClear;

  if (isBelowExitThresholds) {
    const newHealthyCount = prevState.consecutiveHealthyTicks + 1;
    if (newHealthyCount >= config.hysteresisTicks) {
      // Step down one level or jump to rawSeverity
      const targetSeverity: PressureSeverity = prevLevel === 2 && rawLevel === 1 ? 'WARN' : rawSeverity;
      const newState: PressureState = {
        currentSeverity: targetSeverity,
        consecutiveHealthyTicks: 0,
        reasons: activeReasons,
      };
      return {
        newState,
        event: {
          severity: targetSeverity,
          reasons: activeReasons,
          availPhysMB: snapshot.system.availPhysMB,
          vramUsagePct,
        },
      };
    } else {
      // Healthy tick recorded, but waiting for N consecutive ticks
      return {
        newState: {
          currentSeverity: prevState.currentSeverity,
          consecutiveHealthyTicks: newHealthyCount,
          reasons: prevState.reasons,
        },
      };
    }
  }

  // Not below exit thresholds (oscillating near entry threshold) -> reset healthy ticks to prevent flapping
  return {
    newState: {
      currentSeverity: prevState.currentSeverity,
      consecutiveHealthyTicks: 0,
      reasons: prevState.reasons,
    },
  };
}
