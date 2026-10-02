import { z } from 'zod';

export const SignalMetricsSchema = z.object({
  rendererJsHeapBytes: z.number().finite(),
  rendererPrivateBytes: z.number().finite(),
  gpuPrivateBytes: z.number().finite(),
  pdhGpuDedicatedBytes: z.number().finite().nullable(),
  geometries: z.number().int(),
  textures: z.number().int(),
  domNodes: z.number().int(),
  domListeners: z.number().int(),
  userAgentMemoryBytes: z.number().finite().nullable(),
});

export const RegressionResultSchema = z.object({
  slope: z.number().finite(),
  intercept: z.number().finite(),
  r2: z.number().finite(),
  theilSenSlope: z.number().finite(),
  lowerCI95: z.number().finite(),
  upperCI95: z.number().finite(),
  isLeak: z.boolean(),
  tolerance: z.number().finite(),
});

export const EnvironmentBlockSchema = z.object({
  platform: z.string(),
  arch: z.string(),
  windowsBuild: z.string().optional(),
  cpu: z.string(),
  totalRamMB: z.number().finite(),
  gpuAdapter: z.string(),
  electronVersion: z.string(),
  chromiumVersion: z.string(),
  nodeVersion: z.string(),
  v8Version: z.string(),
});

export const CycleSampleSchema = z.object({
  cycle: z.number().int(),
  timestamp: z.string(),
  signals: SignalMetricsSchema,
});

export const SoakReportSchema = z.object({
  timestamp: z.string(),
  durationSeconds: z.number().finite(),
  totalCycles: z.number().int(),
  warmupCycles: z.number().int(),
  environment: EnvironmentBlockSchema,
  regressions: z.record(z.string(), RegressionResultSchema),
  verdict: z.enum(['PASS', 'FAIL']),
  failedSignals: z.array(z.string()),
  heapSnapshotPaths: z.array(z.string()).optional(),
  measureUserAgentSpecificMemorySupported: z.boolean(),
}).strict();

export type SignalMetrics = z.infer<typeof SignalMetricsSchema>;
export type RegressionResult = z.infer<typeof RegressionResultSchema>;
export type EnvironmentBlock = z.infer<typeof EnvironmentBlockSchema>;
export type CycleSample = z.infer<typeof CycleSampleSchema>;
export type SoakReport = z.infer<typeof SoakReportSchema>;
