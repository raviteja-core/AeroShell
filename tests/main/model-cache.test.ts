import { describe, it, expect, vi } from 'vitest';
import { BoxGeometry, Mesh, MeshBasicMaterial, Object3D } from 'three';
import { ModelCache, estimateModelBytes } from '../../src/renderer/model-cache';

function createMockModel(name: string, vertexCount = 100): Object3D {
  const geom = new BoxGeometry(1, 1, 1);
  const mat = new MeshBasicMaterial({ color: 0xff0000 });
  const mesh = new Mesh(geom, mat);
  mesh.name = name;
  return mesh;
}

describe('ModelCache', () => {
  it('estimates model bytes based on geometry attributes', () => {
    const model = createMockModel('box');
    const bytes = estimateModelBytes(model);
    expect(bytes).toBeGreaterThanOrEqual(1024);
  });

  it('loads and caches a model, increasing refCount on subsequent loads', async () => {
    const loader = vi.fn().mockImplementation(async (url: string) => createMockModel(url));
    const cache = new ModelCache({ loader });

    const m1 = await cache.load('model-a.glb');
    expect(loader).toHaveBeenCalledTimes(1);
    expect(cache.getStats().count).toBe(1);

    const m2 = await cache.load('model-a.glb');
    expect(loader).toHaveBeenCalledTimes(1); // Cached, no second load
    expect(m1).toBe(m2);

    const entry = cache.getEntry('model-a.glb');
    expect(entry?.refCount).toBe(2);
  });

  it('de-duplicates in-flight concurrent loads for the same URL', async () => {
    let resolvePromise: (val: Object3D) => void;
    const delayedLoader = vi.fn().mockImplementation(
      () =>
        new Promise<Object3D>((res) => {
          resolvePromise = res;
        })
    );

    const cache = new ModelCache({ loader: delayedLoader });

    const p1 = cache.load('concurrent.glb');
    const p2 = cache.load('concurrent.glb');

    expect(delayedLoader).toHaveBeenCalledTimes(1);

    const mock = createMockModel('concurrent');
    resolvePromise!(mock);

    const [res1, res2] = await Promise.all([p1, p2]);
    expect(res1).toBe(mock);
    expect(res2).toBe(mock);
    expect(cache.getEntry('concurrent.glb')?.refCount).toBe(2);
  });

  it('releases models and evicts unreferenced entries under LRU', async () => {
    const cache = new ModelCache();
    const m1 = createMockModel('m1');
    const m2 = createMockModel('m2');

    const geomDispose1 = vi.spyOn((m1 as Mesh).geometry, 'dispose');
    const geomDispose2 = vi.spyOn((m2 as Mesh).geometry, 'dispose');

    await cache.load('m1.glb', async () => m1);
    await cache.load('m2.glb', async () => m2);

    expect(cache.getStats().count).toBe(2);

    // Both have refCount = 1 -> evict() does not evict referenced entries
    const freedInitial = cache.evict();
    expect(freedInitial).toBe(0);
    expect(cache.getStats().count).toBe(2);

    // Release m1 -> refCount becomes 0
    cache.release('m1.glb');
    expect(cache.getEntry('m1.glb')?.refCount).toBe(0);

    // Now evict frees m1 and calls dispose
    const freed = cache.evict();
    expect(freed).toBeGreaterThan(0);
    expect(cache.getStats().count).toBe(1);
    expect(geomDispose1).toHaveBeenCalledTimes(1);
    expect(geomDispose2).not.toHaveBeenCalled();
  });

  it('clears all entries and disposes geometries on clear()', async () => {
    const cache = new ModelCache();
    const m1 = createMockModel('m1');
    const geomDispose = vi.spyOn((m1 as Mesh).geometry, 'dispose');

    await cache.load('m1.glb', async () => m1);
    expect(cache.getStats().count).toBe(1);

    cache.clear();
    expect(cache.getStats().count).toBe(0);
    expect(geomDispose).toHaveBeenCalledTimes(1);
  });
});
