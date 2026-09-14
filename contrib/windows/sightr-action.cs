using System;
using System.Diagnostics;
using System.IO;
using System.Text;

internal static class SightrAction
{
    // Windows has no argv — a process receives one string and each runtime re-splits it with
    // CommandLineToArgvW's rules. Rejoining with a bare space therefore loses the boundaries: a path
    // with a space becomes two arguments. Quote when needed, escape embedded quotes, and double the
    // backslashes that immediately precede a quote (only there — that is the rule).
    private static string Quote(string arg)
    {
        if (arg.Length > 0 && arg.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return arg;

        var sb = new StringBuilder();
        sb.Append('"');
        for (var i = 0; i < arg.Length; i++)
        {
            var backslashes = 0;
            while (i < arg.Length && arg[i] == '\\') { backslashes++; i++; }
            if (i == arg.Length) { sb.Append('\\', backslashes * 2); break; }
            if (arg[i] == '"') { sb.Append('\\', backslashes * 2 + 1); }
            else { sb.Append('\\', backslashes); }
            sb.Append(arg[i]);
        }
        sb.Append('"');
        return sb.ToString();
    }

    private static int Main(string[] args)
    {
        var executable = Process.GetCurrentProcess().MainModule.FileName;
        var root = Path.GetFullPath(Path.Combine(Path.GetDirectoryName(executable), ".."));
        if (root.StartsWith(@"\\?\", StringComparison.Ordinal)) root = root.Substring(4);

        var script = Path.Combine(root, "contrib", "windows", "sightr-ctl.ps1");
        var quoted = new string[args.Length];
        for (var i = 0; i < args.Length; i++) quoted[i] = Quote(args[i]);
        var start = new ProcessStartInfo
        {
            FileName = Path.Combine(Environment.SystemDirectory, @"WindowsPowerShell\v1.0\powershell.exe"),
            Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File " + Quote(script) +
                (quoted.Length > 0 ? " " + string.Join(" ", quoted) : ""),
            UseShellExecute = false,
        };
        using (var child = Process.Start(start))
        {
            child.WaitForExit();
            return child.ExitCode;
        }
    }
}
