import { app, protocol } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { resolveInside } from './path-guard';

export const APP_SCHEME = 'aeroshell-app';
export const ASSET_SCHEME = 'aeroshell-asset';

export const ASSET_EXT = new Set(['.glb', '.gltf', '.bin', '.drc', '.ktx2', '.wasm', '.json']);

export const ASSET_MIME: Record<string, string> = {
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.drc': 'application/octet-stream',
  '.ktx2': 'image/ktx2',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
};

export const APP_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

export const CSP = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self'",
  `img-src 'self' ${ASSET_SCHEME}: data: blob:`,
  "font-src 'self'",
  `connect-src 'self' ${ASSET_SCHEME}:`,
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
].join('; ');

export function registerSchemes(): void {
  // Must be called BEFORE app.ready
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        codeCache: true,
      },
    },
    {
      scheme: ASSET_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        corsEnabled: true,
      },
    },
  ]);
}

function parseRange(
  rangeHeader: string,
  totalSize: number
): { start: number; end: number } | 'invalid' {
  const trimmed = rangeHeader.trim();

  // Multi-range requests (e.g. bytes=0-10,20-30) are rejected with 416 to prevent multipart DoS attacks
  if (trimmed.includes(',')) {
    return 'invalid';
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(trimmed);
  if (!match) return 'invalid';

  const [, startStr, endStr] = match;
  let start: number;
  let end: number;

  if (startStr && endStr) {
    start = parseInt(startStr, 10);
    end = parseInt(endStr, 10);
  } else if (startStr && !endStr) {
    // Open-ended: bytes=start-
    start = parseInt(startStr, 10);
    end = totalSize - 1;
  } else if (!startStr && endStr) {
    // Suffix: bytes=-suffix
    const suffix = parseInt(endStr, 10);
    if (suffix <= 0) return 'invalid';
    start = Math.max(0, totalSize - suffix);
    end = totalSize - 1;
  } else {
    return 'invalid';
  }

  if (isNaN(start) || isNaN(end) || start > end || start >= totalSize) {
    return 'invalid';
  }

  end = Math.min(end, totalSize - 1);
  return { start, end };
}

export function registerProtocolHandlers(): void {
  // Must be called AFTER app.ready
  const uiRoot = fs.existsSync(path.join(__dirname, '..', 'renderer'))
    ? path.resolve(__dirname, '..', 'renderer')
    : path.join(app.getAppPath(), 'dist', 'renderer');
  const modelRoot =
    process.env.AEROSHELL_TEST_MODEL_ROOT && fs.existsSync(process.env.AEROSHELL_TEST_MODEL_ROOT)
      ? process.env.AEROSHELL_TEST_MODEL_ROOT
      : path.join(app.getPath('userData'), 'Models');

  fs.mkdirSync(modelRoot, { recursive: true });

  protocol.handle(APP_SCHEME, async (req) => {
    let u: URL;
    try {
      u = new URL(req.url);
    } catch {
      return new Response('Bad Request', { status: 400 });
    }

    if (u.host !== 'app') {
      return new Response('Not Found', { status: 404 });
    }

    const relPath = u.pathname === '/' || u.pathname === '' ? '/index.html' : u.pathname;
    const file = resolveInside(uiRoot, relPath);
    if (!file) {
      return new Response('Forbidden', { status: 403 });
    }

    try {
      const stat = fs.statSync(file);
      if (!stat.isFile()) {
        return new Response('Forbidden', { status: 403 });
      }

      const ext = path.extname(file).toLowerCase();
      const contentType = APP_MIME[ext] ?? 'application/octet-stream';

      const h = new Headers();
      h.set('Content-Type', contentType);
      h.set('Content-Length', String(stat.size));
      h.set('Content-Security-Policy', CSP);
      h.set('Cross-Origin-Opener-Policy', 'same-origin');
      h.set('Cross-Origin-Embedder-Policy', 'require-corp');
      h.set('X-Content-Type-Options', 'nosniff');

      const stream = fs.createReadStream(file);
      const webStream = Readable.toWeb(stream) as ReadableStream<Uint8Array>;
      return new Response(webStream, { status: 200, headers: h });
    } catch {
      return new Response('Not Found', { status: 404 });
    }
  });

  protocol.handle(ASSET_SCHEME, async (req) => {
    let u: URL;
    try {
      u = new URL(req.url);
    } catch {
      return new Response('Bad Request', { status: 400 });
    }

    if (u.host !== 'models') {
      return new Response('Not Found', { status: 404 });
    }

    const file = resolveInside(modelRoot, u.pathname);
    if (!file) {
      return new Response('Forbidden', { status: 403 });
    }

    const ext = path.extname(file).toLowerCase();
    if (!ASSET_EXT.has(ext)) {
      return new Response('Forbidden', { status: 403 });
    }

    try {
      const stat = fs.statSync(file);
      if (!stat.isFile()) {
        return new Response('Forbidden', { status: 403 });
      }

      const totalSize = stat.size;
      const contentType = ASSET_MIME[ext] ?? 'application/octet-stream';

      const h = new Headers();
      h.set('Content-Type', contentType);
      h.set('Access-Control-Allow-Origin', 'aeroshell-app://app');
      h.set('Vary', 'Origin');
      h.set('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length');
      h.set('Cross-Origin-Resource-Policy', 'same-origin');
      h.set('X-Content-Type-Options', 'nosniff');
      h.set('Accept-Ranges', 'bytes');

      const rangeHeader = req.headers.get('range');
      if (rangeHeader) {
        const range = parseRange(rangeHeader, totalSize);
        if (range === 'invalid') {
          h.set('Content-Range', `bytes */${totalSize}`);
          return new Response('Range Not Satisfiable', { status: 416, headers: h });
        }

        const { start, end } = range;
        const chunkSize = end - start + 1;
        h.set('Content-Range', `bytes ${start}-${end}/${totalSize}`);
        h.set('Content-Length', String(chunkSize));

        const stream = fs.createReadStream(file, { start, end });
        req.signal?.addEventListener('abort', () => stream.destroy());
        const webStream = Readable.toWeb(stream) as ReadableStream<Uint8Array>;
        return new Response(webStream, { status: 206, headers: h });
      }

      // Full asset response
      h.set('Content-Length', String(totalSize));
      const stream = fs.createReadStream(file);
      req.signal?.addEventListener('abort', () => stream.destroy());
      const webStream = Readable.toWeb(stream) as ReadableStream<Uint8Array>;
      return new Response(webStream, { status: 200, headers: h });
    } catch {
      return new Response('Not Found', { status: 404 });
    }
  });
}
