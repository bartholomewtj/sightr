/**
 * Terminal profile default window titles — Windows Terminal sets "Windows PowerShell",
 * "Command Prompt", "PowerShell 7", etc. They name the host shell, not what the pane is doing.
 * Loaded by bridge and web so pane naming stays consistent.
 */
const HOST_PROFILE_TITLE =
  /^(Administrator:\s*)?(Windows PowerShell|Command Prompt|PowerShell(?:\s+7)?|pwsh)(?:\s*\(\d+\))?$/i;

export function isHostProfileTerminalTitle(title: string): boolean {
  return HOST_PROFILE_TITLE.test(title.trim());
}
