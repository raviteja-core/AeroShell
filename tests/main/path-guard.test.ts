import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { resolveInside } from '../../src/main/path-guard';

describe('Path Guard: resolveInside()', () => {
  const tmpDir = path.join(os.tmpdir(), `aeroshell_test_${Date.now()}`);
  const rootDir = path.join(tmpDir, 'Models');
  const outsideDir = path.join(tmpDir, 'Outside');
  const validFile = path.join(rootDir, 'valid_model.glb');
  const outsideFile = path.join(outsideDir, 'secret.glb');
  let junctionCreated = false;
  let junctionSkippedReason = '';

  beforeAll(() => {
    fs.mkdirSync(rootDir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(validFile, 'GLB_HEADER_DATA');
    fs.writeFileSync(outsideFile, 'SECRET_OUTSIDE_DATA');

    // Attempt to create a junction escape inside root pointing outside
    try {
      const junctionPath = path.join(rootDir, 'escape_junction');
      fs.symlinkSync(outsideDir, junctionPath, 'junction');
      junctionCreated = true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      junctionSkippedReason = `Junction creation failed: ${msg}`;
    }
  });

  afterAll(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('resolves a valid file inside root', () => {
    const res = resolveInside(rootDir, 'valid_model.glb');
    expect(res).not.toBeNull();
    expect(res!.toLowerCase()).toBe(fs.realpathSync.native(validFile).toLowerCase());
  });

  it('resolves valid nested files inside root', () => {
    const subDir = path.join(rootDir, 'sub');
    fs.mkdirSync(subDir, { recursive: true });
    const subFile = path.join(subDir, 'part.gltf');
    fs.writeFileSync(subFile, '{}');

    const res = resolveInside(rootDir, 'sub/part.gltf');
    expect(res).not.toBeNull();
    expect(res!.toLowerCase()).toBe(fs.realpathSync.native(subFile).toLowerCase());
  });

  it('rejects relative traversal with ..\\', () => {
    expect(resolveInside(rootDir, '..\\secret.glb')).toBeNull();
    expect(resolveInside(rootDir, '../secret.glb')).toBeNull();
    expect(resolveInside(rootDir, 'sub/../../secret.glb')).toBeNull();
  });

  it('rejects URL-encoded traversal (%2e%2e%2f and %2e%2e%5c)', () => {
    expect(resolveInside(rootDir, '%2e%2e%2fsecret.glb')).toBeNull();
    expect(resolveInside(rootDir, '%2e%2e%5csecret.glb')).toBeNull();
    expect(resolveInside(rootDir, 'sub%2f%2e%2e%2f%2e%2e%2fsecret.glb')).toBeNull();
  });

  it('rejects prefix collision sibling bypass (Models-evil)', () => {
    const evilSibling = path.join(tmpDir, 'Models-evil');
    fs.mkdirSync(evilSibling, { recursive: true });
    fs.writeFileSync(path.join(evilSibling, 'hack.glb'), 'HACK');

    // A flawed startsWith(root) would match root=".../Models" against ".../Models-evil"
    expect(resolveInside(rootDir, '../Models-evil/hack.glb')).toBeNull();
  });

  it('rejects absolute Windows drive paths (C:\\)', () => {
    expect(resolveInside(rootDir, 'C:\\Windows\\notepad.exe')).toBeNull();
    expect(resolveInside(rootDir, 'C:/Windows/notepad.exe')).toBeNull();
  });

  it('rejects NUL bytes (\\0)', () => {
    expect(resolveInside(rootDir, 'valid_model.glb\0.png')).toBeNull();
    expect(resolveInside(rootDir, 'valid_model%00.glb')).toBeNull();
  });

  it('rejects NTFS Alternate Data Streams (file.glb:stream)', () => {
    expect(resolveInside(rootDir, 'valid_model.glb:stream')).toBeNull();
    expect(resolveInside(rootDir, 'valid_model.glb::$DATA')).toBeNull();
  });

  it('rejects device namespace prefixes (\\\\?\\ and \\\\.\\)', () => {
    expect(resolveInside(rootDir, '\\\\?\\C:\\Windows')).toBeNull();
    expect(resolveInside(rootDir, '\\\\.\\PhysicalDrive0')).toBeNull();
  });

  it('rejects Windows reserved device names (CON, PRN, AUX, NUL, COM1, LPT1)', () => {
    expect(resolveInside(rootDir, 'CON')).toBeNull();
    expect(resolveInside(rootDir, 'con.glb')).toBeNull();
    expect(resolveInside(rootDir, 'AUX.json')).toBeNull();
    expect(resolveInside(rootDir, 'NUL')).toBeNull();
    expect(resolveInside(rootDir, 'PRN.bin')).toBeNull();
    expect(resolveInside(rootDir, 'COM1.gltf')).toBeNull();
    expect(resolveInside(rootDir, 'LPT1')).toBeNull();
  });

  it('rejects trailing dot and trailing space in path segments', () => {
    expect(resolveInside(rootDir, 'valid_model.glb.')).toBeNull();
    expect(resolveInside(rootDir, 'valid_model.glb ')).toBeNull();
    expect(resolveInside(rootDir, 'sub./part.gltf')).toBeNull();
    expect(resolveInside(rootDir, 'sub /part.gltf')).toBeNull();
  });

  it('rejects non-existent files', () => {
    expect(resolveInside(rootDir, 'does_not_exist.glb')).toBeNull();
  });

  it('defeats directory junction escape', () => {
    if (!junctionCreated) {
      console.warn(`[SKIP] Junction escape test skipped: ${junctionSkippedReason}`);
      // As instructed: never skip silently, report skip status explicitly
      expect(junctionSkippedReason.length).toBeGreaterThan(0);
      return;
    }

    // escape_junction is inside rootDir, but points to outsideDir
    const escapedTarget = resolveInside(rootDir, 'escape_junction/secret.glb');
    expect(escapedTarget).toBeNull();
  });
});
