import { Object3D, Mesh, Material, Texture, BufferGeometry } from 'three';

export interface CachedModelEntry {
  url: string;
  model: Object3D;
  estimatedBytes: number;
  refCount: number;
  lastUsed: number;
}

export interface ModelCacheOptions {
  maxSizeBytes?: number; // Default 256 MB
  loader?: (url: string) => Promise<Object3D>;
}

/**
 * Calculates estimated memory in bytes consumed by a Three.js Object3D hierarchy
 * (BufferGeometry vertex attributes/indices and Texture image pixels).
 */
export function estimateModelBytes(root: Object3D): number {
  let bytes = 0;
  const seenGeometries = new Set<string>();
  const seenTextures = new Set<string>();

  root.traverse((obj) => {
    if (obj instanceof Mesh || (obj as any).isMesh) {
      const mesh = obj as Mesh;
      const geom = mesh.geometry;
      if (geom && !seenGeometries.has(geom.uuid)) {
        seenGeometries.add(geom.uuid);
        for (const name in geom.attributes) {
          const attr = geom.attributes[name];
          if (attr && attr.array) {
            bytes += attr.array.byteLength;
          }
        }
        if (geom.index && geom.index.array) {
          bytes += geom.index.array.byteLength;
        }
      }

      const materials: Material[] = Array.isArray(mesh.material)
        ? mesh.material
        : mesh.material
        ? [mesh.material]
        : [];

      for (const mat of materials) {
        for (const key of Object.keys(mat)) {
          const val = (mat as any)[key];
          if (val && (val.isTexture || val instanceof Texture) && !seenTextures.has(val.uuid)) {
            seenTextures.add(val.uuid);
            if (val.image) {
              const width = val.image.width || 0;
              const height = val.image.height || 0;
              // Assume 4 bytes per pixel (RGBA)
              bytes += width * height * 4;
            }
          }
        }
      }
    }
  });

  return Math.max(bytes, 1024); // Minimum 1 KB
}

/**
 * Recursively disposes geometries, materials, and textures for an Object3D hierarchy.
 */
export function disposeHierarchy(root: Object3D): void {
  root.traverse((obj) => {
    if (obj instanceof Mesh || (obj as any).isMesh) {
      const mesh = obj as Mesh;
      if (mesh.geometry) {
        mesh.geometry.dispose();
      }

      const materials: Material[] = Array.isArray(mesh.material)
        ? mesh.material
        : mesh.material
        ? [mesh.material]
        : [];

      for (const mat of materials) {
        for (const key of Object.keys(mat)) {
          const val = (mat as any)[key];
          if (val && (val.isTexture || val instanceof Texture)) {
            if (val.image && typeof val.image.close === 'function') {
              try {
                val.image.close(); // ImageBitmap closure
              } catch {}
            }
            val.dispose();
          }
        }
        mat.dispose();
      }
    }
  });
}

export class ModelCache {
  private entries: Map<string, CachedModelEntry> = new Map();
  private inFlight: Map<string, Promise<Object3D>> = new Map();
  private maxSizeBytes: number;
  private currentSizeBytes = 0;
  private customLoader: ((url: string) => Promise<Object3D>) | null = null;

  constructor(options?: ModelCacheOptions) {
    this.maxSizeBytes = options?.maxSizeBytes ?? 256 * 1024 * 1024; // 256 MB
    this.customLoader = options?.loader ?? null;
  }

  public async load(
    url: string,
    loaderFn?: (url: string) => Promise<Object3D>
  ): Promise<Object3D> {
    const existing = this.entries.get(url);
    if (existing) {
      existing.refCount++;
      existing.lastUsed = Date.now();
      return existing.model;
    }

    // De-duplicate in-flight loads for identical URLs
    const inFlightPromise = this.inFlight.get(url);
    if (inFlightPromise) {
      const model = await inFlightPromise;
      const entry = this.entries.get(url);
      if (entry) {
        entry.refCount++;
        entry.lastUsed = Date.now();
      }
      return model;
    }

    const loader = loaderFn ?? this.customLoader;
    if (!loader) {
      throw new Error(`No loader available to load model from ${url}`);
    }

    const loadPromise = (async () => {
      try {
        const model = await loader(url);
        const estimatedBytes = estimateModelBytes(model);

        // If inserting this would exceed budget, evict unreferenced entries
        if (this.currentSizeBytes + estimatedBytes > this.maxSizeBytes) {
          this.evict(this.currentSizeBytes + estimatedBytes - this.maxSizeBytes);
        }

        const entry: CachedModelEntry = {
          url,
          model,
          estimatedBytes,
          refCount: 1,
          lastUsed: Date.now(),
        };

        this.entries.set(url, entry);
        this.currentSizeBytes += estimatedBytes;
        return model;
      } finally {
        this.inFlight.delete(url);
      }
    })();

    this.inFlight.set(url, loadPromise);
    return loadPromise;
  }

  public release(url: string): void {
    const entry = this.entries.get(url);
    if (entry && entry.refCount > 0) {
      entry.refCount--;
      entry.lastUsed = Date.now();
    }
  }

  public evict(targetBytes?: number): number {
    let freedBytes = 0;

    // Filter unreferenced entries (refCount === 0)
    const candidates = Array.from(this.entries.values()).filter((e) => e.refCount === 0);
    // Sort LRU (oldest lastUsed first)
    candidates.sort((a, b) => a.lastUsed - b.lastUsed);

    for (const entry of candidates) {
      if (targetBytes !== undefined && freedBytes >= targetBytes) {
        break;
      }

      disposeHierarchy(entry.model);
      this.entries.delete(entry.url);
      this.currentSizeBytes -= entry.estimatedBytes;
      freedBytes += entry.estimatedBytes;
    }

    return freedBytes;
  }

  public clear(): void {
    for (const entry of this.entries.values()) {
      disposeHierarchy(entry.model);
    }
    this.entries.clear();
    this.inFlight.clear();
    this.currentSizeBytes = 0;
  }

  public getStats(): { count: number; totalEstimatedMB: number } {
    return {
      count: this.entries.size,
      totalEstimatedMB: Number((this.currentSizeBytes / (1024 * 1024)).toFixed(2)),
    };
  }

  public getEntry(url: string): CachedModelEntry | undefined {
    return this.entries.get(url);
  }
}
