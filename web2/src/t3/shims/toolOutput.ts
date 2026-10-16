/**
 * Stand-in for T3 Code's `@t3tools/shared/toolOutput` (packages/shared/src/toolOutput.ts @ e3b35d1b, MIT):
 * only `toolOutputIndicatesFailure`, verbatim. The MCP-app and HTML-render readers have no herdr source.
 */

/** Some providers report completion even when command output describes a failure. */
export function toolOutputIndicatesFailure(text: string): boolean {
  return (
    /file not found|no files found|enoent|no such file|commandnotfoundexception|command not found|is not recognized as the name of a cmdlet|a parameter cannot be found that matches parameter name/i.test(
      text,
    ) ||
    (/cannot find path/i.test(text) && /because it does not exist/i.test(text)) ||
    (/is not recognized/i.test(text) && /the term '/i.test(text)) ||
    /<exited with exit code\s+[1-9]\d*\s*>/i.test(text) ||
    /exit(?:ed)? with exit code\s+[1-9]\d*/i.test(text) ||
    /exit code\s*[:\s]\s*[1-9]\d*\b/i.test(text)
  );
}
