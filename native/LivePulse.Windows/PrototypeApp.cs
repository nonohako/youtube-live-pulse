using System.Drawing;
using System.IO;
using System.Windows;
using System.Windows.Threading;
using LivePulse.Core;
using LivePulse.NativeStore;
using Forms = System.Windows.Forms;

namespace LivePulse.Windows;

internal sealed class PrototypeApp : System.Windows.Application
{
    private readonly string[] _args;
    private Forms.NotifyIcon? _tray;
    private PrototypeWindow? _window;
    private bool _quitting;
    private readonly DispatcherTimer _heartbeat = new() { Interval = TimeSpan.FromSeconds(30) };
    private CancellationTokenSource? _monitorCancellation;
    private Task? _monitorTask;
    private YouTubeSnapshotClient? _snapshotClient;
    private NativeMonitorScheduler? _monitorScheduler;
    private readonly PrototypeEffectSink _monitorEffects = new();

    internal PrototypeApp(string[] args)
    {
        _args = args;
        ShutdownMode = ShutdownMode.OnExplicitShutdown;
    }

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        var iconPath = Path.Combine(AppContext.BaseDirectory, "assets", "pulse.ico");
        _tray = new Forms.NotifyIcon
        {
            Icon = File.Exists(iconPath) ? new Icon(iconPath) : SystemIcons.Application,
            Text = "라이브 펄스 마이그레이션 시제품 (감시 미연결)",
            Visible = true,
            ContextMenuStrip = new Forms.ContextMenuStrip()
        };
        _tray.ContextMenuStrip.Items.Add("시제품 창 열기", null, (_, _) => ShowWindow());
        _tray.ContextMenuStrip.Items.Add("종료", null, (_, _) => Quit());
        _tray.DoubleClick += (_, _) => ShowWindow();
        // The timer stands in for an independent background loop. It does not access user data.
        _heartbeat.Tick += (_, _) => { };
        _heartbeat.Start();
        try { StartIsolatedMonitor(); }
        catch (Exception error)
        {
            Console.Error.WriteLine($"ISOLATED_MONITOR_START_FAILED {error.Message}");
            Environment.ExitCode = 1;
            if (!_args.Contains("--monitor-smoke"))
                System.Windows.MessageBox.Show($"격리 감시를 시작하지 못했습니다.\n{error.Message}", "라이브 펄스 시제품");
            Quit();
            return;
        }
        if (_args.Contains("--lifecycle-smoke") || _args.Contains("--lifecycle-stress"))
            Dispatcher.BeginInvoke(async () => await RunLifecycleSmokeAsync());
        else if (_args.Contains("--monitor-smoke"))
            Dispatcher.BeginInvoke(async () => await RunMonitorSmokeAsync());
        else if (!_args.Contains("--hidden"))
            ShowWindow();
    }

    internal void ShowWindow()
    {
        if (_quitting) return;
        if (_window is not null)
        {
            _window.Activate();
            return;
        }
        var window = new PrototypeWindow(this);
        _window = window;
        window.Show();
        _ = window.InitializeAsync();
    }

    internal void CloseToTray(PrototypeWindow window)
    {
        if (!ReferenceEquals(_window, window)) return;
        _window = null;
        window.DisposeSession();
    }

    internal void Quit()
    {
        if (_quitting) return;
        _quitting = true;
        _heartbeat.Stop();
        _monitorCancellation?.Cancel();
        _ = FinishQuitAsync();
    }

    private async Task FinishQuitAsync()
    {
        if (_monitorTask is not null)
            try { await _monitorTask; }
            catch (Exception error) { Console.Error.WriteLine($"ISOLATED_MONITOR_STOP_FAILED {error.Message}"); }
        _snapshotClient?.Dispose();
        _monitorCancellation?.Dispose();
        if (_window is not null)
        {
            var window = _window;
            _window = null;
            window.DisposeSession();
        }
        if (_tray is not null)
        {
            _tray.Visible = false;
            _tray.ContextMenuStrip?.Dispose();
            _tray.Dispose();
            _tray = null;
        }
        Shutdown();
    }

    private void StartIsolatedMonitor()
    {
        var optionIndex = Array.IndexOf(_args, "--isolated-monitor-db");
        if (optionIndex < 0)
        {
            if (_args.Contains("--monitor-smoke") || _args.Contains("--monitor-smoke-twice"))
                throw new ArgumentException("감시 스모크에는 --isolated-monitor-db 경로가 필요합니다.");
            return;
        }
        if (_args.Contains("--monitor-smoke-twice") && !_args.Contains("--monitor-smoke"))
            throw new ArgumentException("두 주기 검증에는 --monitor-smoke 옵션이 필요합니다.");
        if (!_args.Contains("--hidden") || optionIndex != _args.LastIndexOf("--isolated-monitor-db")
            || optionIndex + 1 >= _args.Length || _args.Contains("--lifecycle-smoke")
            || _args.Contains("--lifecycle-stress"))
            throw new ArgumentException("격리 감시는 --hidden 및 단일 DB 경로가 필요합니다.");
        var database = _args[optionIndex + 1];
        if (!Path.IsPathFullyQualified(database))
            throw new ArgumentException("격리 DB에는 절대 경로가 필요합니다.");
        database = Path.GetFullPath(database);
        var repository = FindRepositoryRoot();
        var allowedRoot = Path.GetFullPath(Path.Combine(repository, "artifacts", "migration-isolated-data"));
        if (!database.StartsWith(allowedRoot + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)
            || !database.EndsWith(".probe.sqlite", StringComparison.OrdinalIgnoreCase)
            || !File.Exists(database))
            throw new ArgumentException("격리 DB는 artifacts/migration-isolated-data 아래의 별도 *.probe.sqlite 복사본이어야 합니다.");
        for (var directory = new DirectoryInfo(Path.GetDirectoryName(database)!);
             directory is not null && directory.FullName.StartsWith(repository, StringComparison.OrdinalIgnoreCase);
             directory = directory.Parent)
            if (directory.Attributes.HasFlag(FileAttributes.ReparsePoint))
                throw new InvalidDataException("연결된 폴더의 DB는 사용할 수 없습니다.");
        if (File.GetAttributes(database).HasFlag(FileAttributes.ReparsePoint))
            throw new InvalidDataException("연결된 DB 파일은 사용할 수 없습니다.");

        var store = new NativeMonitorStore(database);
        _snapshotClient = new YouTubeSnapshotClient();
        var runner = new NativeMonitorRunner(store, _snapshotClient, _monitorEffects);
        _monitorScheduler = new NativeMonitorScheduler(store, runner);
        _monitorCancellation = new CancellationTokenSource();
        _monitorTask = Task.Run(() => _monitorScheduler.RunAsync(_monitorCancellation.Token));
        _ = ObserveMonitorAsync(_monitorTask);
        Console.WriteLine($"ISOLATED_MONITOR_STARTED windowCreated={_window is not null}");
    }

    private static string FindRepositoryRoot()
    {
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
            if (File.Exists(Path.Combine(directory.FullName, "AGENTS.md"))
                && File.Exists(Path.Combine(directory.FullName, "package.json")))
                return directory.FullName;
        throw new DirectoryNotFoundException("저장소 루트 밖에서는 격리 감시를 시작할 수 없습니다.");
    }

    private async Task ObserveMonitorAsync(Task task)
    {
        try { await task; }
        catch (Exception error)
        {
            Console.Error.WriteLine($"ISOLATED_MONITOR_FAILED {error.Message}");
            Environment.ExitCode = 1;
            if (!_quitting)
                _ = Dispatcher.BeginInvoke((Action)(() =>
                {
                    if (!_args.Contains("--monitor-smoke"))
                        System.Windows.MessageBox.Show($"격리 감시가 중단됐습니다.\n{error.Message}", "라이브 펄스 시제품");
                    Quit();
                }));
        }
    }

    private async Task RunMonitorSmokeAsync()
    {
        try
        {
            if (_window is not null || _monitorScheduler is null)
                throw new InvalidOperationException("숨김 시작에서 감시만 실행하지 못했습니다.");
            var requiredSweeps = _args.Contains("--monitor-smoke-twice") ? 2 : 1;
            var deadline = DateTimeOffset.UtcNow.AddSeconds(requiredSweeps == 2 ? 120 : 60);
            MonitorSweepResult? lastObserved = null;
            var sweepCount = 0;
            while (!_quitting && DateTimeOffset.UtcNow < deadline)
            {
                if (_monitorScheduler.LastSweep is { } sweep && !ReferenceEquals(sweep, lastObserved))
                {
                    lastObserved = sweep;
                    sweepCount++;
                    if (sweep.Errors.Count != 0 || sweep.Completed.Count == 0)
                        throw new InvalidDataException($"공개 채널 확인 {sweepCount}회차가 실패했습니다.");
                    using var process = System.Diagnostics.Process.GetCurrentProcess();
                    process.Refresh();
                    Console.WriteLine($"NATIVE_MONITOR_SWEEP cycle={sweepCount} channels={sweep.Completed.Count} "
                        + $"privateMiB={process.PrivateMemorySize64 / 1048576.0:F1} "
                        + $"workingMiB={process.WorkingSet64 / 1048576.0:F1}");
                    if (sweepCount < requiredSweeps) continue;
                    Console.WriteLine($"NATIVE_MONITOR_SMOKE_PASSED sweeps={sweepCount} channels={sweep.Completed.Count} "
                        + $"suppressedNotifications={_monitorEffects.NotificationCount} "
                        + $"suppressedUrls={_monitorEffects.UrlCount} windowCreated={_window is not null}");
                    return;
                }
                await Task.Delay(100);
            }
            if (!_quitting) throw new TimeoutException("요청한 감시 주기가 제한 시간 안에 끝나지 않았습니다.");
        }
        catch (Exception error)
        {
            Console.Error.WriteLine($"NATIVE_MONITOR_SMOKE_FAILED {error.Message}");
            Environment.ExitCode = 1;
        }
        finally { Quit(); }
    }

    private async Task RunLifecycleSmokeAsync()
    {
        try
        {
            Console.WriteLine($"COLD windowCreated={_window is not null}");
            if (_args.Contains("--lifecycle-stress"))
            {
                ShowWindow();
                var opening = _window ?? throw new InvalidOperationException("경합 테스트 창 생성 실패");
                CloseToTray(opening);
                ShowWindow();
                var reopened = _window ?? throw new InvalidOperationException("빠른 재열기 실패");
                await reopened.Ready;
                if (!await reopened.ProbeBridgeAsync()) throw new InvalidOperationException("빠른 재열기 브리지 실패");
                CloseToTray(reopened);
                Console.WriteLine("RACE closeDuringOpeningAndReopen=passed");
            }
            var cycles = _args.Contains("--lifecycle-stress") ? 20 : 3;
            for (var i = 1; i <= cycles; i++)
            {
                ShowWindow();
                var window = _window ?? throw new InvalidOperationException("창 생성 실패");
                await window.Ready;
                if (!await window.ProbeBridgeAsync()) throw new InvalidOperationException("브리지 상태 요청 실패");
                if (i == 1)
                {
                    var output = Path.Combine(Path.GetTempPath(), "livepulse-native-prototype.png");
                    await window.CaptureAsync(output);
                    Console.WriteLine($"CAPTURE {output}");
                }
                Console.WriteLine($"OPEN {i} browser={window.BrowserProcessId}");
                CloseToTray(window);
                var timer = System.Diagnostics.Stopwatch.StartNew();
                while (window.IsBrowserProcessAlive && timer.Elapsed < TimeSpan.FromSeconds(10))
                    await Task.Delay(100);
                Console.WriteLine($"CLOSED {i} browserAlive={window.IsBrowserProcessAlive} exitMs={timer.ElapsedMilliseconds}");
                if (window.IsBrowserProcessAlive) throw new InvalidOperationException("WebView 브라우저 프로세스가 종료되지 않음");
                using var process = System.Diagnostics.Process.GetCurrentProcess();
                process.Refresh();
                Console.WriteLine($"TRAY {i} privateMiB={process.PrivateMemorySize64 / 1048576.0:F1} workingMiB={process.WorkingSet64 / 1048576.0:F1}");
            }
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error);
            Environment.ExitCode = 1;
        }
        finally { Quit(); }
    }
}

internal sealed class PrototypeEffectSink : IMonitorEffectSink
{
    private int notificationCount;
    private int urlCount;
    public int NotificationCount => Volatile.Read(ref notificationCount);
    public int UrlCount => Volatile.Read(ref urlCount);

    public Task NotifyAsync(MonitorNotification notification, CancellationToken cancellationToken)
    {
        Interlocked.Increment(ref notificationCount);
        return Task.CompletedTask;
    }

    public Task OpenUrlAsync(string url, CancellationToken cancellationToken)
    {
        Interlocked.Increment(ref urlCount);
        return Task.CompletedTask;
    }
}
