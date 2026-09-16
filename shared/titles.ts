/**
 * Terminal titles that name the host or a plugin, not what the pane is doing. Windows Terminal
 * sets "Windows PowerShell", "Command Prompt", etc.; Cursor sometimes reports "Terminal Session";
 * win-terminal-browser and Herdr's plugin tab name leak through as OSC titles on neighbouring
 * agent panes. Loaded by bridge and web so pane naming stays consistent.
 */
const HOST_PROFILE_TITLE =
  /^(Administrator:\s*)?(Windows PowerShell|Command Prompt|PowerShell(?:\s+7)?|pwsh)(?:\s*\(\d+\))?$/i;

export function isHostProfileTerminalTitle(title: string): boolean {
  const trimmed = title.trim();
  if (HOST_PROFILE_TITLE.test(trimmed)) return true;
  const folded = trimmed.toLowerCase().replace(/[\s-]+/g, "");
  return (
    folded === "winterminalbrowser" ||
    folded === "terminalbrowser" ||
    folded === "terminalsession"
  );
}
