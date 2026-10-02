import * as fs from 'node:fs';
import * as path from 'node:path';

const RESERVED_DEVICE_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

/**
 * Resolve `requested` strictly inside `root`. Returns canonical path or null on any violation.
 * Pure Node.js function with zero Electron dependencies.
 */
export function resolveInside(root: string, requested: string): string | null {
  if (typeof root !== 'string' || typeof requested !== 'string') {
    return null;
  }

  // 1. Decode URI component safely
  let decoded: string;
  try {
    decoded = decodeURIComponent(requested);
  } catch {
    return null;
  }

  // 2. Reject NUL characters, colons (drive letters, alternate data streams), and device prefixes
  if (decoded.includes('\0') || decoded.includes(':')) {
    return null;
  }
  if (
    decoded.startsWith('\\\\?\\') ||
    decoded.startsWith('\\\\.\\') ||
    decoded.startsWith('//?/') ||
    decoded.startsWith('//./')
  ) {
    return null;
  }

  // Normalize separators to slash for segment inspection
  const normalizedSlashes = decoded.replace(/\\/g, '/');
  const segments = normalizedSlashes.split('/').filter(Boolean);

  for (const seg of segments) {
    // Reject trailing dot or trailing space in any segment (Windows NTFS quirk)
    if (seg.endsWith('.') || seg.endsWith(' ')) {
      return null;
    }

    // Reject Windows reserved device names (CON, PRN, AUX, NUL, COM1-9, LPT1-9, with or without extension)
    const baseName = seg.split('.')[0]!.toUpperCase();
    if (RESERVED_DEVICE_NAMES.has(baseName)) {
      return null;
    }
  }

  // Strip leading slashes/backslashes
  const cleanRel = decoded.replace(/^[/\\]+/, '');

  // 3. Resolve candidate path relative to root
  const candidate = path.resolve(root, '.' + path.sep + cleanRel);

  // 4. Logical path containment check using path.relative (never startsWith)
  const rel = path.relative(root, candidate);
  if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
    return null;
  }

  // 5. Canonical realpath check using fs.realpathSync.native to defeat symlinks, junctions, and casing
  try {
    const realRoot = fs.realpathSync.native(root);
    const realCandidate = fs.realpathSync.native(candidate);

    const realRel = path.relative(realRoot, realCandidate);
    if (!realRel || realRel === '..' || realRel.startsWith('..' + path.sep) || path.isAbsolute(realRel)) {
      return null;
    }

    return realCandidate;
  } catch {
    // If candidate or root cannot be resolved (file does not exist or unreadable), reject
    return null;
  }
}
