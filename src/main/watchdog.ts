import { app, BrowserWindow } from 'electron';
import { Channels } from '../shared/ipc-contract';
import {
  evaluatePressure,
  initialPressureState,
  PressureState,
  DEFAULT_PRESSURE_CONFIG,
  MemorySnapshot,
} from './pressure-evaluator';

export interface WatchdogOptions {
  win: BrowserWindow;
  getNative: () => any;
  getActiveGpu: () => { vendorId?: number; deviceId?: number } | undefined;
  visibleIntervalMs?: number; // default 2500 ms
  hiddenIntervalMs?: number;  // default 15000 ms
}

export class PressureWatchdog {
  private win: BrowserWindow;
  private getNative: () => any;
  private getActiveGpu: () => { vendorId?: number; deviceId?: number } | undefined;
  private visibleIntervalMs: number;
  private hiddenIntervalMs: number;
  private state: PressureState;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private isDisposed = false;

  constructor(opts: WatchdogOptions) {
    this.win = opts.win;
    this.getNative = opts.getNative;
    this.getActiveGpu = opts.getActiveGpu;
    this.visibleIntervalMs = opts.visibleIntervalMs ?? 2500;
    this.hiddenIntervalMs = opts.hiddenIntervalMs ?? 15000;
    this.state = initialPressureState();

    this.win.once('closed', () => {
      this.stop();
    });
  }

  public start(): void {
    if (this.isDisposed || this.running) return;
    this.running = true;
    this.scheduleNextTick(0);
  }

  public stop(): void {
    this.running = false;
    this.isDisposed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  public getState(): PressureState {
    return { ...this.state };
  }

  private scheduleNextTick(delayMs: number): void {
    if (!this.running || this.isDisposed || this.win.isDestroyed()) return;

    this.timer = setTimeout(async () => {
      await this.tick();
      if (this.running && !this.isDisposed && !this.win.isDestroyed()) {
        const isVisible = this.win.isVisible() && !this.win.isMinimized();
        const nextDelay = isVisible ? this.visibleIntervalMs : this.hiddenIntervalMs;
        this.scheduleNextTick(nextDelay);
      }
    }, delayMs);

    if (this.timer.unref) {
      this.timer.unref();
    }
  }

  public async tick(): Promise<void> {
    if (this.isDisposed || this.win.isDestroyed()) return;

    try {
      const native = this.getNative();
      if (!native) return;

      const sysMem = native.getSystemMemoryInfo();
      const metrics = app.getAppMetrics();

      const rendererMetric = metrics.find((m) => m.type === 'Tab');
      const gpuMetric = metrics.find((m) => m.type === 'GPU');

      const rendererMemoryMB = rendererMetric ? rendererMetric.memory.workingSetSize / 1024 : 0;
      const gpuProcessMemoryMB = gpuMetric ? gpuMetric.memory.workingSetSize / 1024 : undefined;

      // DXGI hardware info + PDH counters
      const rawGpus = native.getGpuHardwareInfo() || [];
      const activeGpu = this.getActiveGpu();

      let activeAdapter = rawGpus.find(
        (g: any) =>
          !g.isSoftware &&
          g.dedicatedVramMB > 0 &&
          activeGpu?.vendorId !== undefined &&
          g.vendorId === activeGpu.vendorId &&
          g.deviceId === activeGpu.deviceId
      );

      if (!activeAdapter) {
        activeAdapter = rawGpus.find((g: any) => !g.isSoftware && g.dedicatedVramMB > 0) || rawGpus[0];
      }

      // Query PDH counters if we have an active adapter
      let adapterVramUsageMB: number | undefined = undefined;
      const pids: number[] = [];
      if (gpuMetric?.pid) pids.push(gpuMetric.pid);
      if (rendererMetric?.pid) pids.push(rendererMetric.pid);

      try {
        const counters = await native.getGpuCounters(pids);
        if (counters && Array.isArray(counters.adapters) && activeAdapter?.luid) {
          const match = counters.adapters.find((a: any) => a.luid === activeAdapter.luid);
          if (match) {
            adapterVramUsageMB = match.dedicatedUsageMB;
          }
        }
      } catch (err) {
        // PDH error degrades gracefully
      }

      let availPhysMB = sysMem.availPhysMB;

      // Test-only override for E2E pressure pipeline testing (compiled out of prod)
      if (process.env.AEROSHELL_TEST_FORCE_RAM_PRESSURE === '1') {
        availPhysMB = Math.round(sysMem.totalPhysMB * 0.06); // 6% of total RAM -> triggers WARN (<8%), above CRITICAL (<4%)
      }

      const snapshot: MemorySnapshot = {
        system: {
          totalPhysMB: sysMem.totalPhysMB,
          availPhysMB,
        },
        rendererMemoryMB,
        gpuProcessMemoryMB,
        activeAdapterVram: activeAdapter
          ? {
              luid: activeAdapter.luid,
              isSoftware: activeAdapter.isSoftware,
              dedicatedVramMB: activeAdapter.dedicatedVramMB,
              vramBudgetMB: activeAdapter.vramBudgetMB,
              adapterVramUsageMB,
            }
          : null,
      };

      const result = evaluatePressure(snapshot, this.state, DEFAULT_PRESSURE_CONFIG);
      this.state = result.newState;

      if (result.event && !this.win.isDestroyed()) {
        this.win.webContents.send(Channels.memoryPressure, result.event);
      }
    } catch (err) {
      console.warn('[watchdog] Error evaluating memory pressure:', err);
    }
  }
}
