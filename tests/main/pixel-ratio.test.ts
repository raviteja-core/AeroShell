import { describe, it, expect } from 'vitest';
import { computeTargetPixelRatio } from '../../src/renderer/pixel-ratio';

describe('computeTargetPixelRatio', () => {
  it('computes correct ratio for dpr = 1', () => {
    expect(computeTargetPixelRatio('NORMAL', 1)).toBe(1);
    expect(computeTargetPixelRatio('WARN', 1)).toBe(0.75);
    expect(computeTargetPixelRatio('CRITICAL', 1)).toBe(0.75);
  });

  it('computes correct ratio for dpr = 1.5', () => {
    expect(computeTargetPixelRatio('NORMAL', 1.5)).toBe(1.5);
    expect(computeTargetPixelRatio('WARN', 1.5)).toBe(1);
    expect(computeTargetPixelRatio('CRITICAL', 1.5)).toBe(0.75);
  });

  it('computes correct ratio for dpr = 2', () => {
    expect(computeTargetPixelRatio('NORMAL', 2)).toBe(2);
    expect(computeTargetPixelRatio('WARN', 2)).toBe(1);
    expect(computeTargetPixelRatio('CRITICAL', 2)).toBe(0.75);
  });

  it('clamps high dpr (>2) to 2 under NORMAL', () => {
    expect(computeTargetPixelRatio('NORMAL', 3)).toBe(2);
    expect(computeTargetPixelRatio('WARN', 3)).toBe(1);
    expect(computeTargetPixelRatio('CRITICAL', 3)).toBe(0.75);
  });

  it('handles low dpr (<1) under WARN', () => {
    expect(computeTargetPixelRatio('WARN', 0.8)).toBe(0.75);
  });
});
