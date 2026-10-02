export type RenderProcessGoneReason =
  | 'clean-exit'
  | 'abnormal-exit'
  | 'killed'
  | 'crashed'
  | 'oom'
  | 'launch-failed'
  | 'integrity-failure'
  | 'memory-eviction';

export type RenderRecoveryAction =
  | { type: 'ignore' }
  | { type: 'error-page'; url: string; reason: string }
  | { type: 'reload'; safeMode: boolean; attempt: number; maxAttempts: number };

export interface CrashPolicyConfig {
  maxCrashes: number;
  windowMs: number;
  errorPageUrl: string;
}

export const DEFAULT_CRASH_POLICY_CONFIG: CrashPolicyConfig = {
  maxCrashes: 3,
  windowMs: 5 * 60 * 1000, // 5 minutes
  errorPageUrl: 'aeroshell-app://app/crash-error.html',
};

/**
 * Pure function evaluating the recovery action for render-process-gone.
 *
 * Rationale:
 * - 'clean-exit': Expected exit; no recovery needed.
 * - 'integrity-failure': Code signing or security policy violation; reloading could loop or re-expose vulnerabilities, so immediately show static error page.
 * - 'oom': Out of memory; reload with safeMode enabled so large CAD assemblies are not automatically re-allocated.
 * - 'memory-eviction': OS-level memory eviction; reload with safeMode enabled.
 * - 'crashed' | 'abnormal-exit' | 'killed' | 'launch-failed': Unexpected fault; reload up to maxCrashes per windowMs, then fallback to error page.
 */
export function evaluateRenderProcessGone(
  reason: RenderProcessGoneReason,
  crashHistory: number[],
  now: number = Date.now(),
  config: CrashPolicyConfig = DEFAULT_CRASH_POLICY_CONFIG
): { action: RenderRecoveryAction; updatedHistory: number[] } {
  if (reason === 'clean-exit') {
    return {
      action: { type: 'ignore' },
      updatedHistory: crashHistory,
    };
  }

  if (reason === 'integrity-failure') {
    return {
      action: {
        type: 'error-page',
        url: config.errorPageUrl,
        reason: 'Integrity failure detected; automatic reload halted.',
      },
      updatedHistory: crashHistory,
    };
  }

  // Filter history to current sliding window
  const activeHistory = crashHistory.filter((t) => now - t <= config.windowMs);
  activeHistory.push(now);

  if (activeHistory.length > config.maxCrashes) {
    return {
      action: {
        type: 'error-page',
        url: config.errorPageUrl,
        reason: `Crash loop exceeded limit (${activeHistory.length} crashes in ${config.windowMs / 1000}s).`,
      },
      updatedHistory: activeHistory,
    };
  }

  const safeMode = reason === 'oom' || reason === 'memory-eviction';

  return {
    action: {
      type: 'reload',
      safeMode,
      attempt: activeHistory.length,
      maxAttempts: config.maxCrashes,
    },
    updatedHistory: activeHistory,
  };
}
