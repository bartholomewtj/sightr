import type { AgentCommand } from "./types.ts";

export const CURSOR: readonly AgentCommand[] = [
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
