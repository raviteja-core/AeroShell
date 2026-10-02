import {
  Scene,
  PerspectiveCamera,
  WebGLRenderer,
  BoxGeometry,
  MeshStandardMaterial,
  Mesh,
  AmbientLight,
  DirectionalLight,
  Color,
  Object3D,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

export interface ViewportMetrics {
  fps: number;
  frameTimeP50: number;
  frameTimeP95: number;
  geometries: number;
  textures: number;
  drawCalls: number;
  triangles: number;
  frame: number;
  pixelRatio: number;
}

export type CacheEvictionHook = () => void;

export interface VisibilitySource {
  readonly isVisible: boolean;
  addEventListener(event: 'visibilitychange', handler: () => void): void;
  removeEventListener(event: 'visibilitychange', handler: () => void): void;
}

export class DocumentVisibilitySource implements VisibilitySource {
  get isVisible(): boolean {
    return typeof document !== 'undefined' && document.visibilityState === 'visible';
  }
  addEventListener(event: 'visibilitychange', handler: () => void): void {
    if (typeof document !== 'undefined') {
      document.addEventListener(event, handler);
    }
  }
  removeEventListener(event: 'visibilitychange', handler: () => void): void {
    if (typeof document !== 'undefined') {
      document.removeEventListener(event, handler);
    }
  }
}

export class RenderLoopController {
  private isPausedByVisibility = false;
  private isPausedByContextLoss = false;
  private isPausedByWindowState = false;
  private onStart: () => void;
  private onStop: () => void;
  private visibilitySource: VisibilitySource;
  private boundHandler: () => void;

  constructor(
    onStart: () => void,
    onStop: () => void,
    visibilitySource: VisibilitySource = new DocumentVisibilitySource()
  ) {
    this.onStart = onStart;
    this.onStop = onStop;
    this.visibilitySource = visibilitySource;
    this.boundHandler = this.handleVisibilityChange.bind(this);
    this.visibilitySource.addEventListener('visibilitychange', this.boundHandler);

    if (!this.visibilitySource.isVisible) {
      this.isPausedByVisibility = true;
    }
  }

  public handleVisibilityChange(): void {
    if (!this.visibilitySource.isVisible) {
      this.isPausedByVisibility = true;
      this.onStop();
    } else {
      this.isPausedByVisibility = false;
      if (!this.isPausedByContextLoss && !this.isPausedByWindowState) {
        this.onStart();
      }
    }
  }

  public setContextLost(lost: boolean): void {
    this.isPausedByContextLoss = lost;
    if (lost) {
      this.onStop();
    } else if (!this.isPausedByVisibility && !this.isPausedByWindowState) {
      this.onStart();
    }
  }

  public setWindowState(state: 'normal' | 'minimized' | 'maximized' | 'hidden'): void {
    const isPaused = (state === 'minimized' || state === 'hidden');
    this.isPausedByWindowState = isPaused;
    if (isPaused) {
      this.onStop();
    } else if (!this.isPausedByVisibility && !this.isPausedByContextLoss) {
      this.onStart();
    }
  }

  public isRunning(): boolean {
    return !this.isPausedByVisibility && !this.isPausedByContextLoss && !this.isPausedByWindowState;
  }

  public dispose(): void {
    this.visibilitySource.removeEventListener('visibilitychange', this.boundHandler);
  }
}

/**
 * RETENTION POLICY (CAD-001):
 * Do NOT free CPU-side geometry arrays (e.g. geometry.attributes) after initial GPU upload
 * unless the model records its canonical source URL and is reloaded from aeroshell-asset://
 * upon WebGL context restoration.
 *
 * Adhering to this policy allows Three.js to lazily re-upload all vertex buffer objects (VBOs)
 * directly from retained CPU memory when the WebGL context is restored, guaranteeing seamless
 * recovery without network round-trips or model re-parsing.
 */
export class CadViewport {
  private canvas: HTMLCanvasElement;
  private renderer: WebGLRenderer;
  private scene: Scene;
  private camera: PerspectiveCamera;
  private animFrameId: number | null = null;
  private controller: RenderLoopController;

  // Rolling frame time metrics over 60 samples
  private frameDeltas: number[] = [];
  private lastRafTime = 0;
  private currentFps = 0;
  private p50 = 0;
  private p95 = 0;

  // Scene entities
  private defaultMesh: Mesh | null = null;
  private loadedModel: Object3D | null = null;
  private modelUrl: string | null = null;

  // Active resize observer
  private resizeObserver: ResizeObserver | null = null;

  // UI Banner reference
  private bannerEl: HTMLElement | null = null;

  // Optional cache eviction hook for CRITICAL memory pressure
  public onEvictOptionalCaches: CacheEvictionHook | null = null;

  constructor(
    canvas: HTMLCanvasElement,
    bannerEl?: HTMLElement | null,
    visibilitySource?: VisibilitySource
  ) {
    this.canvas = canvas;
    this.bannerEl = bannerEl ?? null;

    this.renderer = new WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });

    // Clamp initial pixel ratio to min(devicePixelRatio, 2)
    const baseRatio = Math.min(window.devicePixelRatio || 1, 2);
    this.renderer.setPixelRatio(baseRatio);

    this.scene = new Scene();
    this.scene.background = new Color('#121212');

    this.camera = new PerspectiveCamera(45, 1, 0.1, 1000);
    this.camera.position.set(0, 0, 5);

    this.initLights();
    this.initDefaultGeometry();

    // Render loop controller manages visibility pausing and context-loss pausing
    this.controller = new RenderLoopController(
      () => this.startLoop(),
      () => this.stopLoop(),
      visibilitySource
    );

    this.initContextListeners();
    this.initResizeObserver();

    if (this.controller.isRunning()) {
      this.startLoop();
    }
  }

  private initLights(): void {
    const ambient = new AmbientLight(0xffffff, 0.8);
    this.scene.add(ambient);

    const dirLight = new DirectionalLight(0xffffff, 1.2);
    dirLight.position.set(5, 10, 7);
    this.scene.add(dirLight);
  }

  private initDefaultGeometry(): void {
    const geometry = new BoxGeometry(1.5, 1.5, 1.5);
    const material = new MeshStandardMaterial({
      color: 0x38bdf8,
      metalness: 0.3,
      roughness: 0.4,
    });

    this.defaultMesh = new Mesh(geometry, material);
    this.scene.add(this.defaultMesh);
  }

  private initContextListeners(): void {
    // 1. WebGL Context Loss Handler
    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.controller.setContextLost(true);
      if (this.bannerEl) {
        this.bannerEl.textContent = 'WebGL context lost. Restoring GPU state...';
        this.bannerEl.classList.remove('hidden');
      }
      console.warn('[cad-viewport] WebGL context lost.');
    });

    // 2. WebGL Context Restored Handler
    this.canvas.addEventListener('webglcontextrestored', () => {
      this.restoreGpuResources();
      this.controller.setContextLost(false);
      if (this.bannerEl) {
        this.bannerEl.classList.add('hidden');
        this.bannerEl.textContent = '';
      }
      console.info('[cad-viewport] WebGL context restored.');
    });
  }

  private initResizeObserver(): void {
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => {
        this.resize();
      });
      const container = this.canvas.parentElement ?? document.body;
      this.resizeObserver.observe(container);
    }
    this.resize();
  }

  public resize(): void {
    const parent = this.canvas.parentElement;
    const w = parent ? parent.clientWidth : window.innerWidth;
    const h = parent ? parent.clientHeight : window.innerHeight;

    if (w === 0 || h === 0) return;

    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();

    // Sizing handled through setSize(w, h, false) and CSS layout
    // The 3rd argument false prevents Three.js from setting inline style on canvas
    this.renderer.setSize(w, h, false);
  }

  private restoreGpuResources(): void {
    // Per CAD-001 retention policy, CPU-side geometry buffers are retained in memory.
    // Three.js lazily re-creates WebGL buffers and re-uploads attributes on next render().
    this.camera.updateProjectionMatrix();
  }

  public startLoop(): void {
    if (this.animFrameId !== null || !this.controller.isRunning()) return;
    this.lastRafTime = performance.now();

    const loop = (now: number) => {
      this.animFrameId = requestAnimationFrame(loop);

      const delta = now - this.lastRafTime;
      this.lastRafTime = now;

      // Update frame statistics
      this.recordFrameDelta(delta);

      // Rotate entities
      if (this.defaultMesh) {
        this.defaultMesh.rotation.x += 0.005;
        this.defaultMesh.rotation.y += 0.01;
      }
      if (this.loadedModel) {
        this.loadedModel.rotation.y += 0.01;
      }

      this.renderer.render(this.scene, this.camera);
    };

    this.animFrameId = requestAnimationFrame(loop);
  }

  public stopLoop(): void {
    if (this.animFrameId !== null) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
  }

  private recordFrameDelta(delta: number): void {
    if (delta <= 0) return;
    this.frameDeltas.push(delta);
    if (this.frameDeltas.length > 60) {
      this.frameDeltas.shift();
    }

    const sum = this.frameDeltas.reduce((a, b) => a + b, 0);
    const avg = sum / this.frameDeltas.length;
    this.currentFps = Math.round(1000 / avg);

    const sorted = [...this.frameDeltas].sort((a, b) => a - b);
    const midIdx = Math.floor(sorted.length * 0.5);
    const p95Idx = Math.min(Math.floor(sorted.length * 0.95), sorted.length - 1);

    this.p50 = sorted[midIdx] ?? delta;
    this.p95 = sorted[p95Idx] ?? delta;
  }

  public getMetrics(): ViewportMetrics {
    const mem = this.renderer.info.memory;
    const render = this.renderer.info.render;

    return {
      fps: this.currentFps,
      frameTimeP50: Number(this.p50.toFixed(1)),
      frameTimeP95: Number(this.p95.toFixed(1)),
      geometries: mem.geometries,
      textures: mem.textures,
      drawCalls: render.calls,
      triangles: render.triangles,
      frame: render.frame,
      pixelRatio: this.renderer.getPixelRatio(),
    };
  }

  public setPressure(level: 'NORMAL' | 'WARN' | 'CRITICAL'): void {
    const container = this.canvas.parentElement ?? this.canvas;
    container.classList.remove('pressure-warn', 'pressure-critical');

    if (level === 'WARN') {
      container.classList.add('pressure-warn');
      this.renderer.setPixelRatio(1);
      this.resize();
    } else if (level === 'CRITICAL') {
      container.classList.add('pressure-critical');
      this.renderer.setPixelRatio(1);
      this.resize();
      if (this.onEvictOptionalCaches) {
        this.onEvictOptionalCaches();
      }
    } else {
      // NORMAL
      const baseRatio = Math.min(window.devicePixelRatio || 1, 2);
      this.renderer.setPixelRatio(baseRatio);
      this.resize();
    }
  }

  public setWindowState(state: 'normal' | 'minimized' | 'maximized' | 'hidden'): void {
    this.controller.setWindowState(state);
  }

  /**
   * Load model asset from secure custom protocol and verify off-thread worker transfer
   */
  public async loadModelFromAsset(assetUrl: string): Promise<void> {
    this.modelUrl = assetUrl;

    const resp = await fetch(assetUrl);
    if (!resp.ok) {
      throw new Error(`Failed to load asset from ${assetUrl}: HTTP ${resp.status}`);
    }

    const buffer = await resp.arrayBuffer();

    // 1. Verify off-thread worker communication with transferable ArrayBuffer
    // Clone buffer for worker so original buffer remains intact for GLTFLoader
    const workerBuf = buffer.slice(0);
    await new Promise<void>((resolve, reject) => {
      const worker = new Worker('./parse-worker.js');
      worker.onmessage = (e) => {
        worker.terminate();
        if (e.data?.status === 'PARSED') {
          resolve();
        } else {
          reject(new Error('Worker parsing error'));
        }
      };
      worker.onerror = (err) => {
        worker.terminate();
        reject(err);
      };
      worker.postMessage({ buffer: workerBuf }, [workerBuf]);
    });

    // 2. Parse model with Three.js GLTFLoader
    const loader = new GLTFLoader();
    await new Promise<void>((resolve, reject) => {
      loader.parse(
        buffer,
        '',
        (gltf) => {
          if (this.loadedModel) {
            this.scene.remove(this.loadedModel);
          }
          if (this.defaultMesh) {
            this.scene.remove(this.defaultMesh);
          }
          this.loadedModel = gltf.scene;
          this.scene.add(this.loadedModel);
          resolve();
        },
        (err) => reject(err)
      );
    });
  }

  public getGlContext(): WebGLRenderingContext | WebGL2RenderingContext {
    return this.renderer.getContext();
  }

  public dispose(): void {
    this.stopLoop();
    this.controller.dispose();
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
    }

    if (this.defaultMesh) {
      this.defaultMesh.geometry.dispose();
      if (Array.isArray(this.defaultMesh.material)) {
        for (const mat of this.defaultMesh.material) mat.dispose();
      } else {
        this.defaultMesh.material.dispose();
      }
      this.scene.remove(this.defaultMesh);
      this.defaultMesh = null;
    }

    if (this.loadedModel) {
      this.scene.remove(this.loadedModel);
      this.loadedModel = null;
    }

    this.renderer.dispose();
  }
}
