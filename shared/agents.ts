/**
 * The single decision site for which agents exist. AGENT_FAMILIES, canonicalAgent, the icon map,
 * slash-command CATALOG, JournalRoots, and journal env reads derive from this list. Adding a harness
 * is one entry here plus its adapters.
 *
 * This file is deliberately import-free: it is loaded by both the browser and the Bun bridge.
 */

export interface AgentCommand {
  /** Includes the leading slash, e.g. "/compact". */
  command: string;
  /** One-line, action-oriented description. */
  description: string;
  /** True if the command commonly takes an argument — tap inserts it into the composer to edit. */
  takesArg: boolean;
  /** Placeholder shown after insert, e.g. "[instructions]" / "<model>". Empty if no arg. */
  argHint: string;
  /** True for the handful surfaced first on a phone. The rest are reachable via search. */
  common: boolean;
  /** Destructive/disruptive enough to warrant a two-tap confirm (e.g. /clear wipes context). */
  dangerous: boolean;
}

type SlashCommand = AgentCommand;

export interface BrandIcon {
  bg: string;
  fg: string;
  mode: "fill" | "stroke" | "text";
  d?: string;
  text?: string;
}

interface JournalSpec {
  rootEnv: string;
  homeEnv?: string;
  homeDefault: readonly string[];
  subdir: readonly string[];
}

interface AgentDescriptor {
  readonly id: string;
  readonly family: string;
  readonly prefixes: readonly string[];
  readonly label: string;
  readonly brand?: BrandIcon;
  readonly catalog?: readonly AgentCommand[];
  readonly journal?: JournalSpec;
}

const CLAUDE: readonly SlashCommand[] = [
  { command: "/compact", description: "Summarize the conversation to free up context; optional focus", takesArg: true, argHint: "[instructions]", common: true, dangerous: false },
  { command: "/clear", description: "Start a fresh conversation with empty context", takesArg: false, argHint: "", common: true, dangerous: true },
  { command: "/model", description: "Switch the model; opens a picker if no name given", takesArg: true, argHint: "[model]", common: true, dangerous: false },
  { command: "/resume", description: "Resume a previous conversation by id, name, or picker", takesArg: true, argHint: "[session]", common: true, dangerous: false },
  { command: "/init", description: "Generate a starter CLAUDE.md for this project", takesArg: false, argHint: "", common: true, dangerous: false },
  { command: "/review", description: "Review a GitHub pull request by number (lists open PRs if none)", takesArg: true, argHint: "[PR]", common: true, dangerous: false },
  { command: "/status", description: "Show version, model, account, and connectivity info", takesArg: false, argHint: "", common: true, dangerous: false },
  { command: "/usage", description: "Show session cost, plan limits, and activity stats", takesArg: false, argHint: "", common: true, dangerous: false },
  { command: "/context", description: "Visualize context-window usage with optimization hints", takesArg: false, argHint: "", common: true, dangerous: false },
  { command: "/memory", description: "Edit CLAUDE.md memory files and auto-memory entries", takesArg: false, argHint: "", common: true, dangerous: false },
  { command: "/help", description: "Show help and list available commands", takesArg: false, argHint: "", common: true, dangerous: false },
  { command: "/add-dir", description: "Add an extra working directory for file access", takesArg: true, argHint: "<path>", common: false, dangerous: false },
  { command: "/agents", description: "Manage subagent configurations and view running agents", takesArg: false, argHint: "", common: false, dangerous: false },
  { command: "/branch", description: "Fork the conversation here to explore a different direction", takesArg: true, argHint: "[name]", common: false, dangerous: false },
  { command: "/btw", description: "Ask a quick side question without adding it to history", takesArg: true, argHint: "<question>", common: false, dangerous: false },
  { command: "/cd", description: "Move the session to a new working directory", takesArg: true, argHint: "<path>", common: false, dangerous: false },
  { command: "/code-review", description: "Review the current diff for bugs and cleanups", takesArg: true, argHint: "[level]", common: false, dangerous: false },
  { command: "/config", description: "Open settings, or set a value with key=value", takesArg: true, argHint: "[key=value]", common: false, dangerous: false },
  { command: "/copy", description: "Copy the last assistant response to the clipboard", takesArg: true, argHint: "[N]", common: false, dangerous: false },
  { command: "/cost", description: "Show token cost and usage for the current session", takesArg: false, argHint: "", common: false, dangerous: false },
  { command: "/deep-research", description: "Fan out web searches and synthesize a cited report", takesArg: true, argHint: "<question>", common: false, dangerous: false },
  { command: "/diff", description: "Open an interactive viewer of uncommitted changes", takesArg: false, argHint: "", common: false, dangerous: false },
  { command: "/doctor", description: "Diagnose and verify your Claude Code installation", takesArg: false, argHint: "", common: false, dangerous: false },
  { command: "/effort", description: "Set the model reasoning effort level", takesArg: true, argHint: "[low|medium|high|max]", common: false, dangerous: false },
  { command: "/export", description: "Export the conversation as plain text", takesArg: true, argHint: "[filename]", common: false, dangerous: false },
  { command: "/fast", description: "Toggle fast mode on or off", takesArg: true, argHint: "[on|off]", common: false, dangerous: false },
  { command: "/feedback", description: "Submit feedback or report a bug to Anthropic", takesArg: true, argHint: "[report]", common: false, dangerous: false },
  { command: "/fork", description: "Spawn a background subagent that inherits this conversation", takesArg: true, argHint: "<directive>", common: false, dangerous: false },
  { command: "/goal", description: "Set a completion condition; keep working until it is met", takesArg: true, argHint: "[condition|clear]", common: false, dangerous: false },
  { command: "/hooks", description: "View hook configurations for tool events", takesArg: false, argHint: "", common: false, dangerous: false },
  { command: "/ide", description: "Manage IDE integrations and show connection status", takesArg: false, argHint: "", common: false, dangerous: false },
  { command: "/login", description: "Sign in to your Anthropic account", takesArg: false, argHint: "", common: false, dangerous: false },
  { command: "/logout", description: "Sign out from your Anthropic account", takesArg: false, argHint: "", common: false, dangerous: true },
  { command: "/loop", description: "Run a prompt repeatedly on an interval (self-paced if none)", takesArg: true, argHint: "[interval] [prompt]", common: false, dangerous: false },
  { command: "/mcp", description: "Manage MCP server connections and auth", takesArg: true, argHint: "[subcommand]", common: false, dangerous: false },
  { command: "/permissions", description: "Manage allow, ask, and deny rules for tools", takesArg: false, argHint: "", common: false, dangerous: false },
  { command: "/plan", description: "Switch into plan mode; optionally seed a description", takesArg: true, argHint: "[description]", common: false, dangerous: false },
  { command: "/plugin", description: "Manage plugins — list, install, enable, or disable", takesArg: true, argHint: "[subcommand]", common: false, dangerous: false },
  { command: "/recap", description: "Generate a one-line summary of the current session", takesArg: false, argHint: "", common: false, dangerous: false },
  { command: "/release-notes", description: "View the changelog in a version picker", takesArg: false, argHint: "", common: false, dangerous: false },
  { command: "/rename", description: "Rename the current session", takesArg: true, argHint: "[name]", common: false, dangerous: false },
  { command: "/rewind", description: "Roll back code and conversation to a checkpoint", takesArg: false, argHint: "", common: false, dangerous: true },
  { command: "/security-review", description: "Analyze pending changes for security vulnerabilities", takesArg: false, argHint: "", common: false, dangerous: false },
  { command: "/simplify", description: "Review changed code for cleanups and apply fixes", takesArg: true, argHint: "[target]", common: false, dangerous: false },
  { command: "/skills", description: "List available skills and toggle their visibility", takesArg: false, argHint: "", common: false, dangerous: false },
  { command: "/statusline", description: "Configure the shell status line display", takesArg: true, argHint: "[description]", common: false, dangerous: false },
  { command: "/tasks", description: "View and manage background tasks for this session", takesArg: false, argHint: "", common: false, dangerous: false },
  { command: "/terminal-setup", description: "Configure terminal keybindings (e.g. Shift+Enter)", takesArg: false, argHint: "", common: false, dangerous: false },
  { command: "/theme", description: "Change the color theme", takesArg: false, argHint: "", common: false, dangerous: false },
  { command: "/vim", description: "Toggle Vim editing mode for the prompt", takesArg: false, argHint: "", common: false, dangerous: false },
  { command: "/exit", description: "Exit the CLI (detaches if attached to a background session)", takesArg: false, argHint: "", common: false, dangerous: true },
];

const PI: readonly SlashCommand[] = [
  { command: "/compact", description: "Manually compact context, optionally with instructions", takesArg: true, argHint: "[instructions]", common: true, dangerous: false },
  { command: "/new", description: "Start a new session, clearing the current context", takesArg: false, argHint: "", common: true, dangerous: true },
  { command: "/model", description: "Switch the active model", takesArg: false, argHint: "", common: true, dangerous: false },
  { command: "/resume", description: "Pick a previous session to resume", takesArg: false, argHint: "", common: true, dangerous: false },
  { command: "/session", description: "Show session file, id, messages, tokens, and cost", takesArg: false, argHint: "", common: true, dangerous: false },
  { command: "/tree", description: "Jump to any earlier point in the session and continue", takesArg: false, argHint: "", common: true, dangerous: false },
  { command: "/fork", description: "Start a new session from an earlier user message", takesArg: false, argHint: "", common: true, dangerous: false },
  { command: "/share", description: "Upload as a private gist with a shareable HTML link", takesArg: false, argHint: "", common: true, dangerous: false },
  { command: "/copy", description: "Copy the last assistant message to the clipboard", takesArg: false, argHint: "", common: true, dangerous: false },
  { command: "/reload", description: "Reload keybindings, extensions, skills, prompts, and context", takesArg: false, argHint: "", common: true, dangerous: false },
  { command: "/hotkeys", description: "Show all keyboard shortcuts", takesArg: false, argHint: "", common: true, dangerous: false },
  { command: "/login", description: "Sign in — manage OAuth or API-key credentials", takesArg: false, argHint: "", common: false, dangerous: false },
  { command: "/logout", description: "Sign out and clear stored credentials", takesArg: false, argHint: "", common: false, dangerous: true },
  { command: "/scoped-models", description: "Enable or disable models for Ctrl+P cycling", takesArg: false, argHint: "", common: false, dangerous: false },
  { command: "/settings", description: "Thinking level, theme, message delivery, transport", takesArg: false, argHint: "", common: false, dangerous: false },
  { command: "/name", description: "Set the session's display name", takesArg: true, argHint: "<name>", common: false, dangerous: false },
  { command: "/trust", description: "Save a project trust decision for future sessions", takesArg: false, argHint: "", common: false, dangerous: false },
  { command: "/clone", description: "Duplicate the current active branch into a new session", takesArg: false, argHint: "", common: false, dangerous: false },
  { command: "/export", description: "Export the session to HTML or JSONL", takesArg: true, argHint: "[format]", common: false, dangerous: false },
  { command: "/import", description: "Import and resume a session from a JSONL file", takesArg: true, argHint: "<file>", common: false, dangerous: false },
  { command: "/changelog", description: "Display version history", takesArg: false, argHint: "", common: false, dangerous: false },
  { command: "/quit", description: "Quit pi", takesArg: false, argHint: "", common: false, dangerous: true },
];

const CURSOR: readonly SlashCommand[] = [
  { command: "/plan", description: "Switch into plan mode to design before coding", takesArg: false, argHint: "", common: true, dangerous: false },
  { command: "/ask", description: "Switch into ask mode — explore without editing", takesArg: false, argHint: "", common: true, dangerous: false },
  { command: "/model", description: "Switch the model for this session", takesArg: true, argHint: "[model]", common: true, dangerous: false },
  { command: "/resume", description: "Resume a previous conversation", takesArg: true, argHint: "[chat id]", common: true, dangerous: false },
  { command: "/summarize", description: "Compress context to free space in the window", takesArg: false, argHint: "", common: true, dangerous: false },
  { command: "/compress", description: "Alias for /summarize", takesArg: false, argHint: "", common: false, dangerous: false },
  { command: "/mcp", description: "Manage MCP server connections", takesArg: true, argHint: "[subcommand]", common: true, dangerous: false },
  { command: "/login", description: "Sign in to Cursor", takesArg: false, argHint: "", common: false, dangerous: false },
  { command: "/logout", description: "Sign out and clear stored authentication", takesArg: false, argHint: "", common: false, dangerous: true },
  { command: "/about", description: "Show version, system, and account information", takesArg: false, argHint: "", common: false, dangerous: false },
  { command: "/models", description: "List available models for this account", takesArg: false, argHint: "", common: false, dangerous: false },
];

const BRANDS: Record<string, BrandIcon> = {
  claude: { bg: "#D97757", fg: "#FFFFFF", mode: "fill", d: "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z" },
  pi: { bg: "#09090B", fg: "#FFFFFF", mode: "fill", d: "M0 0v24h6v-6h6v-6H6V6h6v6h6V0Zm18 12v12h6V12Z" },
};

// AGY_BRAND is represented inline in the descriptor so AGENTS remains the only brand table.

export const AGENTS = [
  { id: "claude", family: "claude", prefixes: ["claude"], label: "Claude Code", brand: BRANDS.claude, catalog: CLAUDE, journal: { rootEnv: "SIGHTR_CLAUDE_ROOT", homeDefault: [".claude"], subdir: ["projects"] } },
  // Do not add bare "pi": it would fold unrelated names such as pilot/pino onto pi.
  { id: "pi", family: "pi", prefixes: ["pi-", "pi."], label: "pi", brand: BRANDS.pi, catalog: PI, journal: { rootEnv: "SIGHTR_PI_ROOT", homeEnv: "PI_CODING_AGENT_DIR", homeDefault: [".pi", "agent"], subdir: ["sessions"] } },
  { id: "grok", family: "grok", prefixes: ["grok"], label: "Grok Build", catalog: [], journal: { rootEnv: "SIGHTR_GROK_ROOT", homeEnv: "GROK_HOME", homeDefault: [".grok"], subdir: ["sessions"] } },
  // Placeholder until Antigravity has a real mark; keep the neutral initial tile explicit.
  { id: "agy", family: "agy", prefixes: ["agy", "antigravity"], label: "Antigravity CLI", brand: { bg: "#1B1B1F", fg: "#FFFFFF", mode: "text", text: "A" }, catalog: [] },
  // Brand + slash catalog + journal + live TUI harness (command approval / trust).
  { id: "cursor", family: "cursor", prefixes: ["cursor"], label: "Cursor CLI", brand: { bg: "#141414", fg: "#FFFFFF", mode: "text", text: "C" }, catalog: CURSOR, journal: { rootEnv: "SIGHTR_CURSOR_ROOT", homeDefault: [".cursor"], subdir: ["projects"] } },
] as const satisfies readonly AgentDescriptor[];

export type AgentId = typeof AGENTS[number]["id"];

export const AGENT_IDS: readonly string[] = AGENTS.map((agent) => agent.id);

export function descriptorFor(id: string): AgentDescriptor | undefined {
  return AGENTS.find((agent) => agent.id === id);
}

export const AGENT_FAMILIES: readonly string[] = [...new Set(AGENTS.map((agent) => agent.family))];

const FAMILY_NAMES = new Set<string>(AGENT_FAMILIES);

/** Fold a reported agent variant onto its descriptor id. */
export function canonicalAgent(key: string): string {
  if (key === "") return "";
  if (FAMILY_NAMES.has(key)) return key;
  for (const agent of AGENTS) {
    if (agent.prefixes.some((prefix) => key.startsWith(prefix))) return agent.family;
  }
  return key;
}
