import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  assertTrusted,
  handleCaptureHeapSnapshot,
  handleCaptureContentTracing,
  _resetRateLimiter,
  MinimalFrame,
  MinimalWindow,
} from '../../src/main/ipc-guards';
import { SnapshotRequest } from '../../src/shared/ipc-contract';

describe('IPC Guards: assertTrusted()', () => {
  const mainFrame: MinimalFrame = { url: 'aeroshell-app://app/index.html' };
  const mockWindow: MinimalWindow = {
    webContents: {
      mainFrame,
    },
  };

  it('passes when sender is mainFrame with valid aeroshell-app://app URL', () => {
    expect(() => {
      assertTrusted({ senderFrame: mainFrame }, mockWindow);
    }).not.toThrow();
  });

  it('fails closed when senderFrame is null', () => {
    expect(() => {
      assertTrusted({ senderFrame: null }, mockWindow);
    }).toThrow(/null senderFrame/i);
  });

  it('fails closed when senderFrame does not match mainFrame (e.g. child iframe)', () => {
    const childFrame: MinimalFrame = { url: 'aeroshell-app://app/index.html' };
    expect(() => {
      assertTrusted({ senderFrame: childFrame }, mockWindow);
    }).toThrow(/unauthorized sender frame/i);
  });

  it('rejects origin prefix-bypass attempt (aeroshell-app://app.evil/)', () => {
    const evilFrame: MinimalFrame = { url: 'aeroshell-app://app.evil/index.html' };
    const win: MinimalWindow = { webContents: { mainFrame: evilFrame } };
    expect(() => {
      assertTrusted({ senderFrame: evilFrame }, win);
    }).toThrow(/untrusted origin/i);
  });

  it('rejects file:// URL', () => {
    const fileFrame: MinimalFrame = { url: 'file:///C:/dev/index.html' };
    const win: MinimalWindow = { webContents: { mainFrame: fileFrame } };
    expect(() => {
      assertTrusted({ senderFrame: fileFrame }, win);
    }).toThrow(/untrusted origin/i);
  });

  it('rejects asset scheme URL (aeroshell-asset://models/x)', () => {
    const assetFrame: MinimalFrame = { url: 'aeroshell-asset://models/x' };
    const win: MinimalWindow = { webContents: { mainFrame: assetFrame } };
    expect(() => {
      assertTrusted({ senderFrame: assetFrame }, win);
    }).toThrow(/untrusted origin/i);
  });
});

describe('IPC Guards: handleCaptureHeapSnapshot()', () => {
  let tmpUserDir: string;

  beforeEach(() => {
    _resetRateLimiter();
    tmpUserDir = path.join(os.tmpdir(), `aeroshell_diag_${Date.now()}_${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(tmpUserDir, { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpUserDir, { recursive: true, force: true });
    } catch {}
  });

  it('rejects when diagnostics are disabled by policy in production', () => {
    expect(() => {
      handleCaptureHeapSnapshot({
        userDataDir: tmpUserDir,
        reason: 'test',
        isDev: false,
        readRegistry: () => 0, // EnableDiagnostics not set or 0
        writeHeapSnapshot: () => 'mock.heapsnapshot',
      });
    }).toThrow(/Diagnostics disabled by policy/i);
  });

  it('allows snapshot when isDev is true', () => {
    const res = handleCaptureHeapSnapshot({
      userDataDir: tmpUserDir,
      reason: 'dev-test',
      isDev: true,
      readRegistry: () => null,
      writeHeapSnapshot: (f) => {
        fs.writeFileSync(f, 'MOCK_HEAP');
        return f;
      },
    });
    expect(res.file).toContain('.heapsnapshot');
    expect(fs.existsSync(res.file)).toBe(true);
  });

  it('allows snapshot when registry DWORD EnableDiagnostics is 1', () => {
    const res = handleCaptureHeapSnapshot({
      userDataDir: tmpUserDir,
      reason: 'reg-allowed',
      isDev: false,
      readRegistry: (_area, name) => (name === 'EnableDiagnostics' ? 1 : null),
      writeHeapSnapshot: (f) => {
        fs.writeFileSync(f, 'MOCK_HEAP');
        return f;
      },
    });
    expect(res.file).toContain('reg-allowed');
  });

  it('rate limits calls to 1 per 60 seconds', () => {
    let nowTime = 100000;
    const nowFn = () => nowTime;

    handleCaptureHeapSnapshot({
      userDataDir: tmpUserDir,
      reason: 'first',
      isDev: true,
      readRegistry: () => null,
      writeHeapSnapshot: (f) => f,
      now: nowFn,
    });

    // 2nd call 10 seconds later
    nowTime += 10000;
    expect(() => {
      handleCaptureHeapSnapshot({
        userDataDir: tmpUserDir,
        reason: 'second',
        isDev: true,
        readRegistry: () => null,
        writeHeapSnapshot: (f) => f,
        now: nowFn,
      });
    }).toThrow(/Rate limit exceeded/i);

    // Call after 61 seconds succeeds
    nowTime += 61000;
    expect(() => {
      handleCaptureHeapSnapshot({
        userDataDir: tmpUserDir,
        reason: 'third',
        isDev: true,
        readRegistry: () => null,
        writeHeapSnapshot: (f) => f,
        now: nowFn,
      });
    }).not.toThrow();
  });

  it('sanitizes filename characters in reason', () => {
    const res = handleCaptureHeapSnapshot({
      userDataDir: tmpUserDir,
      reason: 'malicious/path:..*name',
      isDev: true,
      readRegistry: () => null,
      writeHeapSnapshot: (f) => f,
    });
    const filename = path.basename(res.file);
    expect(filename).toContain('malicious_path____name');
    expect(filename).not.toContain(':');
    expect(filename).not.toContain('*');
  });

  it('caps retained snapshot files at 5: 6th file prunes the oldest snapshot file', () => {
    let time = 1000000;
    const writtenFiles: string[] = [];

    for (let i = 1; i <= 6; i++) {
      time += 65000; // Step beyond 60s rate limit
      const res = handleCaptureHeapSnapshot({
        userDataDir: tmpUserDir,
        reason: `snap-${i}`,
        isDev: true,
        readRegistry: () => null,
        writeHeapSnapshot: (f) => {
          fs.writeFileSync(f, `HEAP_${i}`);
          return f;
        },
        now: () => time,
      });
      writtenFiles.push(path.basename(res.file));
    }

    const diagFiles = fs.readdirSync(path.join(tmpUserDir, 'Diagnostics'));
    // Exactly 5 snapshots retained
    expect(diagFiles.length).toBe(5);
    // Oldest snapshot (file 1) was pruned
    expect(diagFiles).not.toContain(writtenFiles[0]);
    // Latest snapshot (file 6) is retained
    expect(diagFiles).toContain(writtenFiles[5]);
  });

});

describe('Zod Schema Strictness (SnapshotRequest)', () => {
  it('accepts valid payload', () => {
    const valid = SnapshotRequest.parse({ reason: 'diagnostic_test' });
    expect(valid.reason).toBe('diagnostic_test');
  });

  it('strictly rejects unknown payload keys', () => {
    expect(() => {
      SnapshotRequest.parse({
        reason: 'test',
        extraField: 'evil',
      });
    }).toThrow();
  });

  it('rejects oversized reason strings', () => {
    expect(() => {
      SnapshotRequest.parse({
        reason: 'a'.repeat(81),
      });
    }).toThrow();
  });
});

describe('IPC Guards: handleCaptureContentTracing()', () => {
  let tmpUserDir: string;

  beforeEach(() => {
    _resetRateLimiter();
    tmpUserDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeroshell-tracing-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpUserDir, { recursive: true, force: true });
    } catch {}
  });

  it('rejects capture in production mode when policy is disabled', async () => {
    await expect(
      handleCaptureContentTracing({
        userDataDir: tmpUserDir,
        durationSeconds: 2,
        isDev: false,
        readRegistry: () => null,
        recordTracing: async (f) => f,
      })
    ).rejects.toThrow(/diagnostics disabled by policy/i);
  });

  it('allows capture in production mode when EnableDiagnostics DWORD is 1', async () => {
    const res = await handleCaptureContentTracing({
      userDataDir: tmpUserDir,
      durationSeconds: 2,
      isDev: false,
      readRegistry: (_area, name) => (name === 'EnableDiagnostics' ? 1 : null),
      recordTracing: async (f) => {
        fs.writeFileSync(f, '{"traceEvents":[]}');
        return f;
      },
    });

    expect(fs.existsSync(res.filePath)).toBe(true);
  });

  it('strictly rejects invalid duration (<1 or >10)', async () => {
    await expect(
      handleCaptureContentTracing({
        userDataDir: tmpUserDir,
        durationSeconds: 0,
        isDev: true,
        readRegistry: () => null,
        recordTracing: async (f) => f,
      })
    ).rejects.toThrow(/invalid tracing duration/i);

    await expect(
      handleCaptureContentTracing({
        userDataDir: tmpUserDir,
        durationSeconds: 15,
        isDev: true,
        readRegistry: () => null,
        recordTracing: async (f) => f,
      })
    ).rejects.toThrow(/invalid tracing duration/i);
  });

  it('enforces 60-second rate limiting', async () => {
    let mockTime = 100000;
    await handleCaptureContentTracing({
      userDataDir: tmpUserDir,
      durationSeconds: 2,
      isDev: true,
      readRegistry: () => null,
      recordTracing: async (f) => {
        fs.writeFileSync(f, '{}');
        return f;
      },
      now: () => mockTime,
    });

    // 10 seconds later: should reject
    mockTime += 10000;
    await expect(
      handleCaptureContentTracing({
        userDataDir: tmpUserDir,
        durationSeconds: 2,
        isDev: true,
        readRegistry: () => null,
        recordTracing: async (f) => f,
        now: () => mockTime,
      })
    ).rejects.toThrow(/rate limit exceeded/i);

    // 65 seconds later: should pass
    mockTime += 55000;
    const res2 = await handleCaptureContentTracing({
      userDataDir: tmpUserDir,
      durationSeconds: 2,
      isDev: true,
      readRegistry: () => null,
      recordTracing: async (f) => {
        fs.writeFileSync(f, '{}');
        return f;
      },
      now: () => mockTime,
    });
    expect(fs.existsSync(res2.filePath)).toBe(true);
  });

  it('retains maximum of 3 trace files and rotates oldest', async () => {
    let time = 100000;
    const writtenFiles: string[] = [];

    for (let i = 1; i <= 5; i++) {
      time += 65000;
      const res = await handleCaptureContentTracing({
        userDataDir: tmpUserDir,
        durationSeconds: 2,
        isDev: true,
        readRegistry: () => null,
        recordTracing: async (f) => {
          fs.writeFileSync(f, `TRACE_${i}`);
          return f;
        },
        now: () => time,
      });
      writtenFiles.push(path.basename(res.filePath));
    }

    const diagFiles = fs.readdirSync(path.join(tmpUserDir, 'Diagnostics'));
    expect(diagFiles.length).toBe(3);
    expect(diagFiles).not.toContain(writtenFiles[0]);
    expect(diagFiles).not.toContain(writtenFiles[1]);
    expect(diagFiles).toContain(writtenFiles[4]);
  });
});
