const { app } = require('electron');
const path = require('node:path');

app.whenReady().then(() => {
  try {
    const addonPath = path.resolve(__dirname, '..', 'build', 'Release', 'aero_win_bridge.node');
    console.log('[native-smoke] Loading native addon from:', addonPath);
    const native = require(addonPath);

    console.log('[native-smoke] Calling getGpuHardwareInfo()...');
    const gpus = native.getGpuHardwareInfo();
    console.log('[native-smoke] GPU Hardware Info:', JSON.stringify(gpus, null, 2));

    console.log('[native-smoke] Calling getSystemMemoryInfo()...');
    const memory = native.getSystemMemoryInfo();
    console.log('[native-smoke] System Memory Info:', JSON.stringify(memory, null, 2));

    console.log('[native-smoke] Calling readRegistry(0, "dummy")...');
    const reg = native.readRegistry(0, 'dummy');
    console.log('[native-smoke] Registry read result:', reg);

    console.log('[native-smoke] Calling getGpuCounters([process.pid])...');
    native.getGpuCounters([process.pid]).then(async (counters) => {
      console.log('[native-smoke] GPU Counters (call 1):', JSON.stringify(counters, null, 2));
      let totalMs = 0;
      const count = 5;
      for (let i = 0; i < count; i++) {
        const c = await native.getGpuCounters([process.pid]);
        totalMs += c.elapsedMs;
      }
      console.log(`[native-smoke] Average over ${count} subsequent calls: ${(totalMs / count).toFixed(2)} ms/call`);
      console.log('[native-smoke] Native Electron Smoke: SUCCESS');
      app.exit(0);
    }).catch((err) => {
      console.error('[native-smoke] getGpuCounters error:', err);
      app.exit(1);
    });
  } catch (err) {
    console.error('[native-smoke] Native Electron Smoke: FAILED', err);
    app.exit(1);
  }
});
