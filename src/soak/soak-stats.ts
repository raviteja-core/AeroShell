/**
 * Statistical estimation functions for Soak Harness Leak Detection.
 */

export interface RegressionResult {
  slope: number;
  intercept: number;
  r2: number;
  theilSenSlope: number;
  lowerCI95: number;
  upperCI95: number;
  isLeak: number extends never ? false : boolean;
}

/**
 * Calculates Ordinary Least Squares (OLS) slope, intercept, and R^2 coefficient.
 */
export function olsRegression(
  x: number[],
  y: number[]
): { slope: number; intercept: number; r2: number } {
  const n = x.length;
  if (n < 2) return { slope: 0, intercept: y[0] ?? 0, r2: 0 };

  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumX2 = 0;
  let sumY2 = 0;

  for (let i = 0; i < n; i++) {
    const xi = x[i]!;
    const yi = y[i]!;
    sumX += xi;
    sumY += yi;
    sumXY += xi * yi;
    sumX2 += xi * xi;
    sumY2 += yi * yi;
  }

  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return { slope: 0, intercept: sumY / n, r2: 0 };

  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;

  const yMean = sumY / n;
  let ssTot = 0;
  let ssRes = 0;

  for (let i = 0; i < n; i++) {
    const xi = x[i]!;
    const yi = y[i]!;
    const yPred = slope * xi + intercept;
    ssRes += (yi - yPred) * (yi - yPred);
    ssTot += (yi - yMean) * (yi - yMean);
  }

  const r2 = ssTot === 0 ? 1 : Math.max(0, 1 - ssRes / ssTot);
  return { slope, intercept, r2 };
}

/**
 * Calculates Theil-Sen median slope estimator (robust against up to 29% outliers).
 */
export function theilSenSlope(x: number[], y: number[]): number {
  const n = x.length;
  if (n < 2) return 0;

  const slopes: number[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = x[j]! - x[i]!;
      if (dx !== 0) {
        slopes.push((y[j]! - y[i]!) / dx);
      }
    }
  }

  if (slopes.length === 0) return 0;
  slopes.sort((a, b) => a - b);
  const mid = Math.floor(slopes.length / 2);
  const midVal = slopes[mid] ?? 0;
  const midPrev = slopes[mid - 1] ?? midVal;
  return slopes.length % 2 !== 0 ? midVal : (midPrev + midVal) / 2;
}

/**
 * Calculates bootstrap 95% confidence interval for Theil-Sen slope via resampling with replacement.
 */
export function bootstrapSlopeConfidenceInterval(
  x: number[],
  y: number[],
  resamples = 500,
  alpha = 0.05
): [number, number] {
  const n = x.length;
  if (n < 2) return [0, 0];

  const bootstrapSlopes: number[] = [];

  for (let r = 0; r < resamples; r++) {
    const sampleX: number[] = new Array(n);
    const sampleY: number[] = new Array(n);
    for (let i = 0; i < n; i++) {
      const idx = Math.floor(Math.random() * n);
      sampleX[i] = x[idx]!;
      sampleY[i] = y[idx]!;
    }
    bootstrapSlopes.push(theilSenSlope(sampleX, sampleY));
  }

  bootstrapSlopes.sort((a, b) => a - b);
  const lowerIndex = Math.floor((alpha / 2) * resamples);
  const upperIndex = Math.min(resamples - 1, Math.floor((1 - alpha / 2) * resamples));

  return [bootstrapSlopes[lowerIndex] ?? 0, bootstrapSlopes[upperIndex] ?? 0];
}

/**
 * Calculates Wilson score 95% confidence interval for binomial proportion k / n.
 */
export function wilsonConfidenceInterval(
  k: number,
  n: number,
  z = 1.96
): [number, number] {
  if (n === 0) return [0, 0];

  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;

  return [
    Math.max(0, Number((center - margin).toFixed(4))),
    Math.min(1, Number((center + margin).toFixed(4))),
  ];
}

/**
 * Evaluates a series of samples across cycles against a leak tolerance.
 */
export function evaluateSeries(
  cycles: number[],
  values: number[],
  tolerance: number
): RegressionResult {
  const ols = olsRegression(cycles, values);
  const ts = theilSenSlope(cycles, values);
  const [lowerCI, upperCI] = bootstrapSlopeConfidenceInterval(cycles, values, 300);

  // Discrete counts must be strictly 0; continuous metrics check lower bound > tolerance
  const isLeak = lowerCI > tolerance;

  return {
    slope: Number(ols.slope.toFixed(2)),
    intercept: Number(ols.intercept.toFixed(2)),
    r2: Number(ols.r2.toFixed(4)),
    theilSenSlope: Number(ts.toFixed(2)),
    lowerCI95: Number(lowerCI.toFixed(2)),
    upperCI95: Number(upperCI.toFixed(2)),
    isLeak,
  };
}
