using System.Windows;
using System.IO;
using System.Security.Principal;

namespace LivePulse.Windows;

// Portable personal layout: <root>/app/LivePulse.exe beside <root>/data/live-pulse.sqlite.
// The marker file in app/ is written by native/publish-portable.ps1, so a development build
// never opens personal data and a marked build never falls back to fixture data.
internal sealed record PortableLayout(string Root, string AppDirectory, string DataDirectory)
{
    internal const string MarkerName = "LivePulse.portable";
    internal string Database => Path.Combine(DataDirectory, "live-pulse.sqlite");
    internal string WebViewProfile => Path.Combine(DataDirectory, "WebView2");

    internal static PortableLayout? Find(string appDirectory)
    {
        var app = Path.GetFullPath(appDirectory).TrimEnd(Path.DirectorySeparatorChar);
        if (!File.Exists(Path.Combine(app, MarkerName))) return null;
        var root = Path.GetDirectoryName(app) ?? throw new InvalidDataException("포터블 앱 폴더 위치가 올바르지 않습니다.");
        return new PortableLayout(root, app, Path.Combine(root, "data"));
    }
}

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        if (args is ["--startup-self-test"])
        {
            VerifyStartup();
            return;
        }
        var layout = PortableLayout.Find(AppContext.BaseDirectory);
        // Diagnostic and isolated arguments keep their own behavior even inside a portable build.
        var personal = layout is not null && (args.Length == 0 || args is ["--hidden"]) ? layout : null;
        var app = new PrototypeApp(args, personal);
        if (personal is null) { app.Run(); return; }

        // The DB lease remains the writer guard. This gate also routes double-clicks
        // to the existing window before another tray or database connection is created.
        var identity = WindowsIdentity.GetCurrent().User!.Value;
        using var show = new EventWaitHandle(false, EventResetMode.AutoReset, @"Local\LivePulseNative.Show." + identity);
        using var instance = new Mutex(false, @"Local\LivePulseNative.Instance." + identity);
        bool ownsInstance;
        try { ownsInstance = instance.WaitOne(0); }
        catch (AbandonedMutexException) { ownsInstance = true; }
        if (!ownsInstance)
        {
            if (!args.Contains("--hidden")) show.Set();
            return;
        }
        var listener = ThreadPool.RegisterWaitForSingleObject(show,
            (_, _) => app.Dispatcher.BeginInvoke((Action)app.ShowWindow), null, Timeout.Infinite, false);
        try { app.Run(); }
        finally { listener.Unregister(null); instance.ReleaseMutex(); }
    }

    private static void VerifyStartup()
    {
        var root = Path.Combine(Path.GetTempPath(), "LivePulseStartupTest-" + Guid.NewGuid().ToString("N"));
        var app = Path.Combine(root, "app");
        Directory.CreateDirectory(app);
        try
        {
            if (PortableLayout.Find(app) is not null)
                throw new InvalidOperationException("Unmarked build selected personal data");
            File.WriteAllText(Path.Combine(app, PortableLayout.MarkerName), "");
            var layout = PortableLayout.Find(app + Path.DirectorySeparatorChar)
                ?? throw new InvalidOperationException("Marked build was not portable");
            if (layout.Database != Path.Combine(root, "data", "live-pulse.sqlite")
                || layout.WebViewProfile != Path.Combine(root, "data", "WebView2"))
                throw new InvalidOperationException("Portable data path regression");
            var command = PrototypeApp.RunCommand(Path.Combine(app, "LivePulse.exe"));
            if (!PrototypeApp.IsOwnRunCommand(command)
                || !PrototypeApp.IsOwnRunCommand(@"""C:\Users\x\AppData\Local\Programs\LivePulseNative\LivePulse.NativePrototype.exe"" --hidden --personal-db ""C:\x.sqlite""")
                || !PrototypeApp.IsOwnRunCommand(@"""D:\moved\app\LivePulse.exe"" --hidden")
                || !PrototypeApp.IsOwnRunCommand(@"""C:\Users\x\AppData\Local\Programs\youtube-live-pulse\라이브 펄스.exe"" --hidden")
                || PrototypeApp.IsOwnRunCommand(@"""C:\Other\Tool.exe"" --hidden")
                || PrototypeApp.IsOwnRunCommand("LivePulse.exe"))
                throw new InvalidOperationException("Windows login entry ownership regression");
        }
        finally { Directory.Delete(root, recursive: true); }
        Console.WriteLine("NATIVE_STARTUP_TESTS_PASSED");
    }
}
