using System.Windows;
using System.IO;
using System.Security.Principal;

namespace LivePulse.Windows;

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
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        args = ResolveArguments(args, Environment.ProcessPath!, local);
        var app = new PrototypeApp(args);
        if (!app.IsPersonalInstalled) { app.Run(); return; }

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

    internal static string[] ResolveArguments(string[] args, string executable, string local)
    {
        var installed = Path.Combine(local, "Programs", "LivePulseNative", "LivePulse.NativePrototype.exe");
        if (string.Equals(Path.GetFullPath(executable), Path.GetFullPath(installed), StringComparison.OrdinalIgnoreCase)
            && (args.Length == 0 || args is ["--hidden"]))
            return [.. args, "--personal-db", Path.Combine(local, "LivePulseNative", "live-pulse.sqlite")];
        return args;
    }

    private static void VerifyStartup()
    {
        var local = Path.Combine(Path.GetTempPath(), "LivePulseStartupTest");
        var installed = Path.Combine(local, "Programs", "LivePulseNative", "LivePulse.NativePrototype.exe");
        var expected = Path.Combine(local, "LivePulseNative", "live-pulse.sqlite");
        if (!ResolveArguments([], installed, local).SequenceEqual(new[] { "--personal-db", expected })
            || !ResolveArguments(["--hidden"], installed, local).SequenceEqual(new[] { "--hidden", "--personal-db", expected })
            || ResolveArguments([], Path.Combine(local, "dev.exe"), local).Length != 0
            || !ResolveArguments(["--lifecycle-smoke"], installed, local).SequenceEqual(new[] { "--lifecycle-smoke" })
            || !ResolveArguments(["--personal-db", "explicit"], installed, local).SequenceEqual(new[] { "--personal-db", "explicit" }))
            throw new InvalidOperationException("Native startup argument regression");
        Console.WriteLine("NATIVE_STARTUP_TESTS_PASSED");
    }
}
