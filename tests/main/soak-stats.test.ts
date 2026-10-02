import { describe, it, expect } from 'vitest';
import {
  olsRegression,
  theilSenSlope,
  bootstrapSlopeConfidenceInterval,
  wilsonConfidenceInterval,
  evaluateSeries,
} from '../../src/soak/soak-stats';

describe('Soak Stats: Regression and Estimators', () => {
  it('olsRegression computes correct slope, intercept and R2 for linear series', () => {
    const x = [1, 2, 3, 4, 5];
    const y = [12, 14, 16, 18, 20]; // y = 2x + 10
    const res = olsRegression(x, y);

    expect(res.slope).toBeCloseTo(2, 5);
    expect(res.intercept).toBeCloseTo(10, 5);
    expect(res.r2).toBeCloseTo(1, 5);
  });

  it('theilSenSlope resists extreme outliers', () => {
    const x = [1, 2, 3, 4, 5, 6, 7];
    // Baseline slope = 5, with an extreme transient outlier at index 3
    const y = [5, 10, 15, 999999, 25, 30, 35];
    const slope = theilSenSlope(x, y);

    expect(slope).toBeCloseTo(5, 1);
  });

  it('bootstrapSlopeConfidenceInterval returns valid confidence bounds', () => {
    const x = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const y = [10, 20, 31, 39, 50, 61, 70, 79, 90, 101]; // ~10 per step
    const [lower, upper] = bootstrapSlopeConfidenceInterval(x, y, 200);

    expect(lower).toBeLessThan(upper);
    expect(lower).toBeGreaterThan(8);
    expect(upper).toBeLessThan(12);
  });

  it('wilsonConfidenceInterval calculates valid proportion intervals', () => {
    const [lowerClean, upperClean] = wilsonConfidenceInterval(10, 10);
    expect(lowerClean).toBeGreaterThan(0.6);
    expect(upperClean).toBe(1.0);

    const [lowerZero, upperZero] = wilsonConfidenceInterval(0, 10);
    expect(lowerZero).toBe(0.0);
    expect(upperZero).toBeLessThan(0.4);
  });

  it('evaluateSeries flags leak when lower CI bound exceeds tolerance', () => {
    const cycles = [6, 7, 8, 9, 10];
    const leakingValues = [1000, 2000, 3000, 4000, 5000]; // +1000 per cycle
    const res = evaluateSeries(cycles, leakingValues, 100);

    expect(res.isLeak).toBe(true);
    expect(res.theilSenSlope).toBe(1000);
  });

  it('evaluateSeries passes when series is flat below tolerance', () => {
    const cycles = [6, 7, 8, 9, 10];
    const flatValues = [1000, 1002, 999, 1001, 1000];
    const res = evaluateSeries(cycles, flatValues, 50);

    expect(res.isLeak).toBe(false);
  });
});
