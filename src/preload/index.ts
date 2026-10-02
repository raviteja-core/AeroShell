import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';
import { Channels, PressureEvent, Telemetry, WindowStateEvent } from '../shared/ipc-contract';

const api = Object.freeze({
  getTelemetry: async (): Promise<Telemetry> => {
    const raw = await ipcRenderer.invoke(Channels.getTelemetry);
    return Telemetry.parse(raw);
  },
  captureHeapSnapshot: async (reason: string): Promise<{ file: string }> => {
    return ipcRenderer.invoke(Channels.captureHeapSnapshot, { reason });
  },
  onMemoryPressure: (cb: (e: PressureEvent) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, raw: unknown) => {
      const parsed = PressureEvent.safeParse(raw);
      if (parsed.success) {
        cb(parsed.data);
      }
    };
    ipcRenderer.on(Channels.memoryPressure, handler);
    return () => {
      ipcRenderer.removeListener(Channels.memoryPressure, handler);
    };
  },
  onWindowState: (cb: (e: WindowStateEvent) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, raw: unknown) => {
      const parsed = WindowStateEvent.safeParse(raw);
      if (parsed.success) {
        cb(parsed.data);
      }
    };
    ipcRenderer.on(Channels.windowState, handler);
    return () => {
      ipcRenderer.removeListener(Channels.windowState, handler);
    };
  },
});

contextBridge.exposeInMainWorld('aeroPlatform', api);
