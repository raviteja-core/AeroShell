import { BrowserWindow, ipcMain, app } from 'electron';
import * as v8 from 'node:v8';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { Channels, Telemetry, SnapshotRequest } from '../shared/ipc-contract';
import { assertTrusted, handleCaptureHeapSnapshot } from './ipc-guards';

function loadNativeAddon() {
  const devPath = path.resolve(__dirname, '../../build/Release/aero_win_bridge.node');
  if (fs.existsSync(devPath)) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require(devPath);
  }
  const unpackedPath = path.join(
    app.getAppPath().replace('app.asar', 'app.asar.unpacked'),
    'build',
    'Release',
    'aero_win_bridge.node'
  );
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(unpackedPath);
}

// Lazy load addon handle
let nativeAddon: any = null;
function getNative() {
  if (!nativeAddon) {
    nativeAddon = loadNativeAddon();
  }
  return nativeAddon;
}

export async function collectTelemetry(): Promise<Telemetry> {
  const native = getNative();
  const heap = v8.getHeapStatistics();

  const rawGpus = native.getGpuHardwareInfo();
  const gpus = rawGpus.map((g: any) => ({
    index: g.index,
    name: g.name,
    vendorId: g.vendorId,
    deviceId: g.deviceId,
    isSoftware: g.isSoftware,
    dedicatedVramMB: g.dedicatedVramMB,
    sharedSystemMB: g.sharedSystemMB,
    vramBudgetMB: g.vramBudgetMB,
    // DEV-012: Map native vramUsageMB (calling-process VRAM) to mainProcessVramUsageMB
    mainProcessVramUsageMB: g.vramUsageMB,
  }));

  const system = native.getSystemMemoryInfo();
  const processes = app.getAppMetrics().map((m) => ({
    type: m.type,
    pid: m.pid,
    workingSetMB: m.memory.workingSetSize / 1024, // KB -> MB conversion
  }));

  const v8Stats = {
    usedHeapMB: heap.used_heap_size / (1024 * 1024),
    heapLimitMB: heap.heap_size_limit / (1024 * 1024),
  };

  return Telemetry.parse({
    gpus,
    system,
    processes,
    v8: v8Stats,
  });
}

export function registerIpc(win: BrowserWindow): void {
  ipcMain.handle(Channels.getTelemetry, async (event) => {
    assertTrusted(event, win);
    const telemetry = await collectTelemetry();
    return Telemetry.parse(telemetry);
  });

  ipcMain.handle(Channels.captureHeapSnapshot, async (event, rawPayload) => {
    assertTrusted(event, win);
    const { reason } = SnapshotRequest.parse(rawPayload);
    const native = getNative();

    return handleCaptureHeapSnapshot({
      userDataDir: app.getPath('userData'),
      reason,
      isDev: !app.isPackaged,
      readRegistry: (area, name) => native.readRegistry(area, name),
      writeHeapSnapshot: (filename) => v8.writeHeapSnapshot(filename),
    });
  });
}
