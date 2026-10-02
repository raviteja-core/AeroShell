/**
 * Soak Harness Configuration and Leak Tolerances
 *
 * RATIONALE FOR TOLERANCES:
 * 1. Discrete Resource Counts (Geometries, Textures, DOM Nodes, DOM Listeners):
 *    Tolerance = 0. In a leak-free Three.js CAD viewport, disposing a removed model
 *    must strictly return all WebGL geometries, textures, and DOM elements to their baseline.
 *    Any positive slope represents an uncollected handle or memory leak.
 *
 * 2. Renderer JS Heap:
 *    Tolerance = 2,048 bytes/cycle (~2 KB). Minor internal V8 object shape transitions,
 *    IC caches, and promise microtask bookkeeping introduce small non-deterministic
 *    fluctuations between GC pauses. Slopes above 2 KB/cycle indicate application retainers.
 *
 * 3. Renderer & GPU Process Private Bytes:
 *    Tolerance = 131,072 bytes/cycle (128 KB). In short-duration runs (e.g. 30 cycles),
 *    Chromium's PartitionAlloc thread caches and GPU driver command ring buffers
 *    expand asymmetrically before reaching steady-state equilibrium, producing
 *    transient working-set slopes of 50-100 KB/cycle that level off over extended cycles.
 *    A 128 KB/cycle tolerance prevents false positives on OS heap expansion while
 *    reliably capturing real native leaks (such as un-disposed geometries or textures
 *    which leak 250 KB - 5 MB/cycle).
 *
 * 4. PDH Dedicated VRAM Usage:
 *    Tolerance = 32,768 bytes/cycle (32 KB). DirectX runtime and WDDM memory managers
 *    batch VRAM deallocations across command buffer submission flushes.
 */

export interface LeakTolerances {
  geometries: number;
  textures: number;
  domNodes: number;
  domListeners: number;
  rendererJsHeapBytes: number;
  rendererPrivateBytes: number;
  gpuPrivateBytes: number;
  pdhGpuDedicatedBytes: number;
}

export interface SoakConfig {
  warmupCycles: number;
  defaultCycles: number;
  ciCycles: number;
  renderFramesPerCycle: number;
  settleMs: number;
  tolerances: LeakTolerances;
}

export const SOAK_CONFIG: SoakConfig = {
  warmupCycles: 8,
  defaultCycles: 60,
  ciCycles: 30,
  renderFramesPerCycle: 10,
  settleMs: 300,
  tolerances: {
    geometries: 0,
    textures: 0,
    domNodes: 0,
    domListeners: 0,
    rendererJsHeapBytes: 2048,       // 2 KB / cycle
    rendererPrivateBytes: 131072,    // 128 KB / cycle (PartitionAlloc slab headroom)
    gpuPrivateBytes: 131072,         // 128 KB / cycle (D3D11/WDDM driver slab headroom)
    pdhGpuDedicatedBytes: 32768,     // 32 KB / cycle (VRAM batch dealloc headroom)
  },
};
