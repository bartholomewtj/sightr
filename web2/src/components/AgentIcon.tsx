/**
 * The harness icon on a thread row. Copied from v1 (web/src/components/agent-icon.tsx and
 * agent-icon-data.ts) so web2 keeps it when v1 retires (T15); brand marks still come from
 * `shared/agents.ts`.
 */
import { AGENTS, canonicalAgent, type BrandIcon } from "@shared/agents";
import { initials } from "@v1/lib/format";

import { cn } from "@/lib/utils";

/** Brand marks are owned by the shared agent descriptors. */
export const AGENT_BRANDS: Record<string, BrandIcon> = Object.fromEntries(
  AGENTS.flatMap((agent) => ("brand" in agent ? [[agent.id, agent.brand] as const] : [])),
);

// Resolve a herdr-detected agent name to a brand key, tolerating variants like "claude-code" / "pi-go".
function brandKey(agent: string): string | undefined {
  const key = canonicalAgent(agent.toLowerCase().trim());
  return AGENT_BRANDS[key] ? key : undefined;
}

/**
 * A square "app icon" tile for an agent, as inline SVG (CSP-safe; the tile carries its own brand
 * background so the mark reads on either theme). Unknown agents (and `shell`) get a neutral initials
 * tile. Size comes from `className` (e.g. `size-5`).
 */
export function AgentIcon({ agent, className }: { agent: string | null | undefined; className?: string }) {
  const brand = agent ? AGENT_BRANDS[brandKey(agent) ?? ""] : undefined;

  if (!brand) {
    return (
      <span
        className={cn(
          "inline-flex shrink-0 items-center justify-center rounded-[22%] border bg-muted text-[0.5em] font-semibold uppercase leading-none text-muted-foreground",
          className,
        )}
        role="img"
        aria-label={agent ? `${agent} icon` : "agent icon"}
      >
        {initials(agent ?? "")}
      </span>
    );
  }

  const stroke = brand.mode === "stroke";
  return (
    <svg viewBox="0 0 24 24" className={cn("shrink-0", className)} role="img" aria-label={`${agent} logo`}>
      <rect width="24" height="24" rx="5.3" fill={brand.bg} />
      {brand.mode === "text" ? (
        <text x="12" y="12" textAnchor="middle" dominantBaseline="central" fontSize="12" fontWeight="600" fill={brand.fg}>
          {brand.text}
        </text>
      ) : (
        /* Inset the 24x24 mark to ~62% so every logo carries uniform app-icon padding. */
        <g
          transform="translate(4.6 4.6) scale(0.617)"
          fill={stroke ? "none" : brand.fg}
          stroke={stroke ? brand.fg : undefined}
          strokeWidth={stroke ? 2 : undefined}
          strokeLinecap={stroke ? "square" : undefined}
        >
          <path d={brand.d} />
        </g>
      )}
    </svg>
  );
}
