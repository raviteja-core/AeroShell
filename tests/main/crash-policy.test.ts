import { describe, it, expect } from 'vitest';
import {
  evaluateRenderProcessGone,
  RenderProcessGoneReason,
  DEFAULT_CRASH_POLICY_CONFIG,
} from '../../src/main/crash-policy';

describe('evaluateRenderProcessGone (table-driven)', () => {
  const cases: Array<{
    reason: RenderProcessGoneReason;
    history: number[];
    expectedType: 'ignore' | 'error-page' | 'reload';
    expectedSafeMode?: boolean;
    description: string;
  }> = [
    {
      reason: 'clean-exit',
      history: [],
      expectedType: 'ignore',
      description: 'clean-exit is ignored without reload',
    },
    {
      reason: 'integrity-failure',
      history: [],
      expectedType: 'error-page',
      description: 'integrity-failure immediately routes to error page',
    },
    {
      reason: 'oom',
      history: [],
      expectedType: 'reload',
      expectedSafeMode: true,
      description: 'oom triggers reload with safeMode enabled',
    },
    {
      reason: 'memory-eviction',
      history: [],
      expectedType: 'reload',
      expectedSafeMode: true,
      description: 'memory-eviction triggers reload with safeMode enabled',
    },
    {
      reason: 'crashed',
      history: [],
      expectedType: 'reload',
      expectedSafeMode: false,
      description: 'crashed triggers standard reload on first occurrence',
    },
    {
      reason: 'killed',
      history: [],
      expectedType: 'reload',
      expectedSafeMode: false,
      description: 'killed triggers standard reload on first occurrence',
    },
    {
      reason: 'abnormal-exit',
      history: [],
      expectedType: 'reload',
      expectedSafeMode: false,
      description: 'abnormal-exit triggers standard reload on first occurrence',
    },
    {
      reason: 'launch-failed',
      history: [],
      expectedType: 'reload',
      expectedSafeMode: false,
      description: 'launch-failed triggers standard reload on first occurrence',
    },
  ];

  for (const c of cases) {
    it(c.description, () => {
      const res = evaluateRenderProcessGone(c.reason, c.history, 1000);
      expect(res.action.type).toBe(c.expectedType);
      if (res.action.type === 'reload' && c.expectedSafeMode !== undefined) {
        expect(res.action.safeMode).toBe(c.expectedSafeMode);
      }
    });
  }

  it('triggers error page when crash limit (3) is exceeded within window', () => {
    const now = 100000;
    // 3 prior crashes within 5 minutes
    const history = [now - 10000, now - 5000, now - 1000];
    const res = evaluateRenderProcessGone('crashed', history, now);
    expect(res.action.type).toBe('error-page');
    expect(res.updatedHistory.length).toBe(4);
  });

  it('allows reload if prior crashes expired beyond sliding window', () => {
    const now = 1000000;
    // 3 prior crashes that occurred 10 minutes ago
    const history = [now - 600000, now - 590000, now - 580000];
    const res = evaluateRenderProcessGone('crashed', history, now);
    expect(res.action.type).toBe('reload');
    expect(res.updatedHistory.length).toBe(1); // Old entries pruned
  });
});
