// Test-only native entry: Windows cannot exec a shebang fixture with shell:false.
// Keep the actual Herdr behavior in the same Node script used by POSIX tests.
using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text;
using System.Threading.Tasks;

public static class FixtureCli {
    static string Quote(string value) {
        var result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') result.Append('\\', slashes * 2 + 1);
            else result.Append('\\', slashes);
            result.Append(c);
            slashes = 0;
        }
        result.Append('\\', slashes * 2);
        return result.Append('"').ToString();
    }

    public static int Main(string[] args) {
        string self = Assembly.GetExecutingAssembly().Location;
        string dir = Path.GetDirectoryName(self);
        string entry = Path.Combine(dir, Path.GetFileNameWithoutExtension(self) + ".cjs");
        // pi/codex remain presence-only unless a test supplies a Node body.
        if (!File.Exists(entry)) {
            if (Path.GetFileNameWithoutExtension(self) != "herdr") return 0;
            entry = Path.Combine(dir, "herdr");
        }
        var command = new StringBuilder(Quote(entry));
        foreach (string arg in args) command.Append(' ').Append(Quote(arg));
        var start = new ProcessStartInfo(File.ReadAllText(Path.Combine(dir, ".node-path")), command.ToString());
        start.UseShellExecute = false;
        start.CreateNoWindow = true;
        start.RedirectStandardOutput = true;
        start.RedirectStandardError = true;
        start.RedirectStandardInput = true;
        using (var child = Process.Start(start)) {
            child.StandardInput.Close();
            // Explicit byte streams also work when the caller has no console.
            var stdout = child.StandardOutput.BaseStream.CopyToAsync(Console.OpenStandardOutput());
            var stderr = child.StandardError.BaseStream.CopyToAsync(Console.OpenStandardError());
            child.WaitForExit();
            Task.WaitAll(stdout, stderr);
            return child.ExitCode;
        }
    }
}
