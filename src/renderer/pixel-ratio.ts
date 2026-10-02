/**
 * Explicit pixel ratio policy for viewport rendering under varying memory pressure.
 *
 * Requirements:
 * - NORMAL: min(dpr, 2)
 * - WARN: min(dpr, 1), or 0.75 if dpr <= 1
 * - CRITICAL: 0.75
 */
export function computeTargetPixelRatio(
  level: 'NORMAL' | 'WARN' | 'CRITICAL',
  dpr: number
): number {
  if (level === 'CRITICAL') {
    return 0.75;
  }
  if (level === 'WARN') {
    return dpr <= 1 ? 0.75 : Math.min(dpr, 1);
  }
  // NORMAL
  return Math.min(dpr, 2);
}
