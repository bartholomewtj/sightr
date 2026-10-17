// Adapted from T3 Code apps/web/src/components/chat/ContextWindowMeter.logic.ts @ db5919d87 (MIT, see THIRD_PARTY.md).
// Changes: kept formatContextWindowCost and formatContextWindowCompactionMessage verbatim; the
// provider-instance, model-name and Claude resume-compaction helpers are gone (no provider catalog;
// web2 never branches on a harness). Added from T3 apps/web/src/lib/contextWindow.ts @ db5919d87: the
// `ContextWindowSnapshot` subset, its derivation from `Thread.contextUsage` (T3's providerThread
// branch) and formatContextWindowTokens (verbatim). Added: manualCompactionCommand, the slash
// catalog check T3's providerSupportsManualCompaction makes.
import type { ThreadTokenUsageSnapshot } from "@shared/v2/contracts";

export interface ContextWindowSnapshot {
  readonly usedTokens: number;
  readonly totalProcessedTokens: number | null;
  readonly maxTokens: number | null;
  readonly remainingTokens: number | null;
  readonly usedPercentage: number | null;
  readonly remainingPercentage: number | null;
  readonly cost: { readonly amount: number; readonly currency: string } | null;
  readonly compactsAutomatically: boolean | null;
  readonly autoCompactThreshold: number | null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The meter's view of `Thread.contextUsage`, or null when the thread has none. */
export function contextWindowSnapshot(usage: ThreadTokenUsageSnapshot | null | undefined): ContextWindowSnapshot | null {
  if (!usage || !Number.isFinite(usage.usedTokens)) return null;
  const maxTokens = asFiniteNumber(usage.maxTokens);
  const usedTokens = Math.max(0, usage.usedTokens);
  const usedPercentage = maxTokens !== null && maxTokens > 0 ? Math.min(100, (usedTokens / maxTokens) * 100) : null;
  return {
    usedTokens,
    totalProcessedTokens: asFiniteNumber(usage.totalProcessedTokens),
    maxTokens,
    remainingTokens: maxTokens === null ? null : Math.max(0, Math.round(maxTokens - usedTokens)),
    usedPercentage,
    remainingPercentage: usedPercentage === null ? null : Math.max(0, 100 - usedPercentage),
    cost: usage.cost ?? null,
    compactsAutomatically: null,
    autoCompactThreshold: null,
  };
}

/** The harness's compaction command when its slash catalog has one (`/compact`), else null. */
export function manualCompactionCommand(commands: ReadonlyArray<{ readonly command: string }>): string | null {
  return commands.some((c) => c.command === "/compact") ? "/compact" : null;
}

export function formatContextWindowTokens(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "0";
  }
  if (value < 1_000) {
    return `${Math.round(value)}`;
  }
  if (value < 10_000) {
    return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  }
  if (value < 999_500) {
    return `${Math.round(value / 1_000)}k`;
  }
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}

export function formatContextWindowCompactionMessage(
  modelDisplayName: string | null | undefined,
  autoCompactThreshold?: number | null,
): string {
  if (typeof autoCompactThreshold === "number" && autoCompactThreshold > 0) {
    return `Compacts automatically at ${autoCompactThreshold.toLocaleString("en-US")} tokens.`;
  }
  return modelDisplayName
    ? `Context for ${modelDisplayName} compacts automatically when needed.`
    : "Context compacts automatically when needed.";
}

export function formatContextWindowCost(cost: {
  readonly amount: number;
  readonly currency: string;
}): string {
  const fractionDigits = Math.abs(cost.amount) > 0 && Math.abs(cost.amount) < 0.01 ? 4 : 2;
  return `${cost.currency} ${cost.amount.toFixed(fractionDigits)}`;
}
