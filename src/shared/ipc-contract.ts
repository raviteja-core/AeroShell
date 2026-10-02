import { z } from 'zod';

export const Channels = {
  getTelemetry: 'aeroshell:get-telemetry',
  memoryPressure: 'aeroshell:memory-pressure',
  captureHeapSnapshot: 'aeroshell:capture-heap-snapshot',
} as const;

export const GpuAdapter = z.object({
  index: z.number().int(),
  name: z.string(),
  vendorId: z.number().int(),
  deviceId: z.number().int(),
  isSoftware: z.boolean(),
  dedicatedVramMB: z.number().finite(),
  sharedSystemMB: z.number().finite(),
  vramBudgetMB: z.number().finite().optional(),
  // Renamed per DEV-012: IDXGIAdapter3 QueryVideoMemoryInfo reports calling-process VRAM
  mainProcessVramUsageMB: z.number().finite().optional(),
  // Extended for M5 PDH performance counters
  adapterVramUsageMB: z.number().finite().optional(),
  gpuProcessVramMB: z.number().finite().optional(),
});

export const SystemMemory = z.object({
  memoryLoadPercent: z.number().finite(),
  totalPhysMB: z.number().finite(),
  availPhysMB: z.number().finite(),
  totalCommitMB: z.number().finite(),
  availCommitMB: z.number().finite(),
});

export const ProcessMetric = z.object({
  type: z.string(),
  pid: z.number().int(),
  workingSetMB: z.number().finite(),
});

export const V8Memory = z.object({
  usedHeapMB: z.number().finite(),
  heapLimitMB: z.number().finite(),
});

export const GpuFeatureStatus = z.object({
  webgl: z.string().optional(),
  webgl2: z.string().optional(),
  gpu_compositing: z.string().optional(),
});

export const ActiveGpu = z.object({
  vendorId: z.number().int().optional(),
  deviceId: z.number().int().optional(),
});

// Telemetry output strips unknown keys by default
export const Telemetry = z.object({
  gpus: z.array(GpuAdapter),
  system: SystemMemory,
  processes: z.array(ProcessMetric),
  v8: V8Memory,
  gpuFeatures: GpuFeatureStatus.optional(),
  activeGpu: ActiveGpu.optional(),
});

export const PressureEvent = z.object({
  severity: z.enum(['WARN', 'CRITICAL']),
  reasons: z.array(z.string()),
  availPhysMB: z.number().finite(),
  vramUsagePct: z.number().finite().nullable(),
});

export type Telemetry = z.infer<typeof Telemetry>;
export type PressureEvent = z.infer<typeof PressureEvent>;
export type GpuAdapter = z.infer<typeof GpuAdapter>;

// Request payload: strictly reject unknown keys
export const SnapshotRequest = z.object({
  reason: z.string().max(80),
}).strict();

export type SnapshotRequest = z.infer<typeof SnapshotRequest>;
