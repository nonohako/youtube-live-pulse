using System.Drawing;
using System.Diagnostics;
using System.IO;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Windows;
using System.Windows.Threading;
using LivePulse.Core;
using LivePulse.NativeStore;
using Microsoft.Win32;
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
    private Task? _cloudTask;
    private NativeCloudSync? _cloudSync;
    private NativeStateReader? _stateReader;
    private NativeMonitorStore? _monitorStore;
    private NativeCloudSyncResult? _lastCloudSync;
    private string? _lastCloudError;
    private YouTubeSnapshotClient? _snapshotClient;
    private NativeMonitorScheduler? _monitorScheduler;
    private NativeBackupCheckpoint? _monitorBackup;
    private NativeStoreLease? _monitorLease;
    private readonly PrototypeEffectSink _monitorEffects;
    private string? _lastNotificationUrl;
    private const string RunKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string RunValueName = "라이브 펄스";
    internal bool IsPersonal => _args.Contains("--personal-db");
    internal bool IsPersonalInstalled => IsPersonal && string.Equals(
        Environment.ProcessPath,
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Programs", "LivePulseNative", "LivePulse.NativePrototype.exe"),
        StringComparison.OrdinalIgnoreCase);
    internal string WebViewProfilePath => IsPersonal
        ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "LivePulseNative", "WebView2")
        : Path.Combine(Path.GetTempPath(), "LivePulseNativePrototype", "WebView2");

    internal PrototypeApp(string[] args)
    {
        _args = args;
        _monitorEffects = new PrototypeEffectSink(this, IsPersonal);
        ShutdownMode = ShutdownMode.OnExplicitShutdown;
    }

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        var iconPath = Path.Combine(AppContext.BaseDirectory, "assets", "pulse.ico");
        _tray = new Forms.NotifyIcon
        {
            Icon = File.Exists(iconPath) ? new Icon(iconPath) : SystemIcons.Application,
            Text = IsPersonal ? "라이브 펄스" : "라이브 펄스 마이그레이션 시제품",
            Visible = true,
            ContextMenuStrip = new Forms.ContextMenuStrip()
        };
        _tray.ContextMenuStrip.Items.Add(IsPersonal ? "창 열기" : "시제품 창 열기", null, (_, _) => ShowWindow());
        _tray.ContextMenuStrip.Items.Add("종료", null, (_, _) => Quit());
        _tray.DoubleClick += (_, _) => ShowWindow();
        _tray.BalloonTipClicked += (_, _) =>
        {
            if (_lastNotificationUrl is { } url) OpenUrl(url);
        };
        // The timer refreshes a visible UI only. Monitor and cloud loops run independently.
        _heartbeat.Tick += (_, _) => _window?.SendState();
        _heartbeat.Start();
        try
        {
            StartIsolatedMonitor();
            if (IsPersonalInstalled) ApplyPersonalLoginSetting();
        }
        catch (Exception error)
        {
            Console.Error.WriteLine($"ISOLATED_MONITOR_START_FAILED {error.Message}");
            Environment.ExitCode = 1;
            if (!_args.Contains("--monitor-smoke"))
                System.Windows.MessageBox.Show($"감시를 시작하지 못했습니다.\n{error.Message}", IsPersonal ? "라이브 펄스" : "라이브 펄스 시제품");
            Quit();
            return;
        }
        if (_args.Contains("--lifecycle-smoke") || _args.Contains("--lifecycle-stress"))
            Dispatcher.BeginInvoke(async () => await RunLifecycleSmokeAsync());
        else if (_args.Contains("--ui-smoke"))
            Dispatcher.BeginInvoke(async () => await RunUiSmokeAsync());
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
            if (_window.WindowState == WindowState.Minimized) _window.WindowState = WindowState.Normal;
            _window.Show();
            _window.Activate();
            return;
        }
        var window = new PrototypeWindow(this);
        _window = window;
        window.Show();
        _ = window.InitializeAsync();
    }

    internal bool HasRealState => _stateReader is not null;

    internal JsonObject ReadState(string? subscriberId = null,
        IReadOnlyList<(string ChannelId, string VideoId)>? selectedVideos = null)
    {
        if (_stateReader is null)
            return JsonNode.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixture-state.json")))!.AsObject();
        var state = _stateReader.Read(subscriberId, selectedVideos, _monitorScheduler?.LastSweep);
        state["monitor"]!["running"] = _monitorTask is { IsCompleted: false };
        state["app"]!["nativePersonal"] = IsPersonal;
        state["app"]!["loginSettingApplied"] = IsPersonalInstalled
            && IsPersonalLoginSettingApplied(state["settings"]!["startAtLogin"]?.GetValue<bool>() == true);
        if (Volatile.Read(ref _lastCloudError) is { } error)
            state["cloud"]!["error"] = $"클라우드 동기화 실패: {error}";
        return state;
    }

    internal async Task<object> AddChannelAsync(string input)
    {
        if (_snapshotClient is null || _monitorStore is null || _monitorBackup is null)
            throw new InvalidOperationException("격리 감시가 시작되지 않았습니다.");
        var resolved = await _snapshotClient.ResolveChannelInputAsync(input);
        _monitorStore.AddChannel(resolved);
        _cloudSync?.ReplayForNewChannel();
        _monitorBackup.AfterCommit(false);
        _window?.SendState();
        return new { ok = true, channelId = resolved.Id };
    }

    internal object RemoveChannel(string channelId)
    {
        if (_monitorStore is null || _monitorBackup is null)
            throw new InvalidOperationException("격리 감시가 시작되지 않았습니다.");
        _monitorStore.RemoveChannel(channelId);
        _monitorBackup.AfterCommit(false);
        _window?.SendState();
        return new { ok = true };
    }

    internal void UpdateSettings(JsonElement partial)
    {
        if (_monitorStore is null || _monitorBackup is null)
            throw new InvalidOperationException("격리 감시가 시작되지 않았습니다.");
        _monitorStore.UpdateSettings(partial);
        _monitorBackup.AfterCommit(false);
        if (IsPersonalInstalled) ApplyPersonalLoginSetting();
        _window?.SendState();
    }

    private void ApplyPersonalLoginSetting()
    {
        if (_stateReader is null || !IsPersonalInstalled) return;
        var enabled = _stateReader.Read()["settings"]!["startAtLogin"]?.GetValue<bool>() == true;
        using var key = Registry.CurrentUser.CreateSubKey(RunKeyPath, writable: true)
            ?? throw new IOException("Windows 시작 항목을 열 수 없습니다.");
        var current = key.GetValue(RunValueName) as string;
        var oldExecutable = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Programs", "youtube-live-pulse", "라이브 펄스.exe");
        var oldCommand = $"\"{oldExecutable}\" --hidden";
        var nativeCommand = PersonalRunCommand();
        if (current is not null && !string.Equals(current, oldCommand, StringComparison.OrdinalIgnoreCase)
            && !string.Equals(current, nativeCommand, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("다른 Windows 시작 항목을 덮어쓰지 않았습니다.");
        if (string.Equals(current, oldCommand, StringComparison.OrdinalIgnoreCase))
        {
            var preserved = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "LivePulseNative", "electron-startup-command.txt");
            if (!File.Exists(preserved)) File.WriteAllText(preserved, oldCommand);
        }
        if (enabled) key.SetValue(RunValueName, nativeCommand, RegistryValueKind.String);
        else if (current is not null) key.DeleteValue(RunValueName, throwOnMissingValue: false);
    }

    private bool IsPersonalLoginSettingApplied(bool enabled)
    {
        using var key = Registry.CurrentUser.OpenSubKey(RunKeyPath);
        var current = key?.GetValue(RunValueName) as string;
        return enabled ? string.Equals(current, PersonalRunCommand(), StringComparison.OrdinalIgnoreCase)
            : current is null;
    }

    private string PersonalRunCommand()
    {
        var database = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "LivePulseNative", "live-pulse.sqlite");
        return $"\"{Environment.ProcessPath}\" --hidden --personal-db \"{database}\"";
    }

    internal object ImportCloudConnection()
    {
        if (_monitorStore is null) throw new InvalidOperationException("격리 감시가 시작되지 않았습니다.");
        var picker = new Microsoft.Win32.OpenFileDialog
        {
            Title = "클라우드 연결 파일 선택", Filter = "JSON 연결 파일 (*.json)|*.json",
            CheckFileExists = true, Multiselect = false
        };
        if (picker.ShowDialog(_window) != true) return new { canceled = true };
        var info = new FileInfo(picker.FileName);
        if (info.Length > 4096) throw new InvalidDataException("클라우드 연결 파일이 너무 큽니다.");
        using var document = JsonDocument.Parse(File.ReadAllText(picker.FileName));
        var root = document.RootElement;
        if (root.ValueKind != JsonValueKind.Object
            || !root.TryGetProperty("cloudUrl", out var url) || url.ValueKind != JsonValueKind.String
            || !root.TryGetProperty("cloudToken", out var token) || token.ValueKind != JsonValueKind.String)
            throw new InvalidDataException("클라우드 연결 파일 형식이 올바르지 않습니다.");
        if (string.IsNullOrWhiteSpace(url.GetString()) || string.IsNullOrWhiteSpace(token.GetString()))
            throw new InvalidDataException("클라우드 연결 주소와 읽기 키가 필요합니다.");
        using var partial = JsonDocument.Parse(JsonSerializer.Serialize(new
        { cloudUrl = url.GetString(), cloudToken = token.GetString() }));
        UpdateSettings(partial.RootElement);
        return new { canceled = false };
    }

    internal async Task<object> ImportSubscriberHistoryAsync(string channelId)
    {
        if (_monitorStore is null || _monitorBackup is null)
            throw new InvalidOperationException("격리 감시가 시작되지 않았습니다.");
        _ = _monitorStore.Load(channelId);
        var picker = new Microsoft.Win32.OpenFileDialog
        {
            Title = "구독자 기록 가져오기", Filter = "Excel 통합 문서 (*.xlsx)|*.xlsx",
            CheckFileExists = true, Multiselect = false
        };
        if (picker.ShowDialog(_window) != true) return new { canceled = true };
        var workbook = await Task.Run(() => SubscriberXlsxImport.Read(picker.FileName));
        var merged = _monitorStore.ImportSubscriberDays(channelId, workbook.Days);
        _monitorBackup.AfterCommit(false);
        _window?.SendState();
        return new { canceled = false, fileName = Path.GetFileName(picker.FileName),
            added = merged.Added, skippedExisting = merged.SkippedExisting,
            skippedInvalid = workbook.SkippedInvalid, skippedDuplicate = workbook.SkippedDuplicate };
    }

    internal async Task RefreshAsync()
    {
        if (_monitorScheduler is null || _monitorCancellation is null)
            throw new InvalidOperationException("격리 감시가 시작되지 않았습니다.");
        await _monitorScheduler.RunNowAsync(_monitorCancellation.Token);
        _window?.SendState();
    }

    internal object OpenUrl(string address)
    {
        if (!Uri.TryCreate(address, UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttps
            || uri.Host is not ("youtube.com" or "www.youtube.com" or "m.youtube.com" or "youtu.be")
            || uri.UserInfo.Length != 0 || !uri.IsDefaultPort)
            throw new InvalidDataException("허용되지 않은 YouTube 주소입니다.");
        var candidates = new[]
        {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Google", "Chrome", "Application", "chrome.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
                "Google", "Chrome", "Application", "chrome.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),
                "Google", "Chrome", "Application", "chrome.exe")
        };
        var chrome = candidates.FirstOrDefault(File.Exists);
        var start = chrome is null ? new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true }
            : new ProcessStartInfo(chrome) { UseShellExecute = false, CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden };
        if (chrome is not null) start.ArgumentList.Add(uri.AbsoluteUri);
        _ = Process.Start(start) ?? throw new IOException("브라우저를 열지 못했습니다.");
        return new { ok = true };
    }

    internal Task ShowNotificationAsync(MonitorNotification notification, CancellationToken cancellationToken)
        => Dispatcher.InvokeAsync(() =>
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (_tray is null) return;
            _lastNotificationUrl = notification.Url;
            _tray.BalloonTipTitle = notification.Title[..Math.Min(63, notification.Title.Length)];
            _tray.BalloonTipText = notification.Body[..Math.Min(255, notification.Body.Length)];
            _tray.ShowBalloonTip(5000);
        }).Task;

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
        if (_cloudTask is not null)
            try { await _cloudTask; }
            catch (OperationCanceledException) when (_quitting) { }
            catch (Exception error) { Console.Error.WriteLine($"ISOLATED_CLOUD_STOP_FAILED {error.Message}"); }
        _cloudSync?.Dispose();
        _snapshotClient?.Dispose();
        _monitorCancellation?.Dispose();
        _monitorLease?.Dispose();
        _monitorLease = null;
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
        var personalIndex = Array.IndexOf(_args, "--personal-db");
        if (optionIndex >= 0 && personalIndex >= 0)
            throw new ArgumentException("격리 DB와 개인용 DB를 동시에 지정할 수 없습니다.");
        if (optionIndex < 0 && personalIndex < 0)
        {
            if (_args.Contains("--monitor-smoke") || _args.Contains("--monitor-smoke-twice") || _args.Contains("--ui-smoke"))
                throw new ArgumentException("감시 스모크에는 --isolated-monitor-db 경로가 필요합니다.");
            return;
        }
        if (personalIndex >= 0)
        {
            if (personalIndex + 1 >= _args.Length || _args.Contains("--monitor-smoke")
                || _args.Contains("--ui-smoke") || _args.Contains("--lifecycle-smoke")
                || _args.Contains("--lifecycle-stress"))
                throw new ArgumentException("개인용 실행에는 준비된 DB의 절대 경로가 필요합니다.");
            var personalDatabase = _args[personalIndex + 1];
            if (!Path.IsPathFullyQualified(personalDatabase))
                throw new ArgumentException("개인용 DB에는 절대 경로가 필요합니다.");
            personalDatabase = Path.GetFullPath(personalDatabase);
            var expected = Path.GetFullPath(Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "LivePulseNative", "live-pulse.sqlite"));
            if (!string.Equals(personalDatabase, expected, StringComparison.OrdinalIgnoreCase)
                || !File.Exists(personalDatabase) || !File.Exists(personalDatabase + ".bak.1"))
                throw new InvalidDataException("개인용 DB와 첫 백업을 지정된 로컬 앱 데이터 폴더에 준비하세요.");
            if (File.GetAttributes(personalDatabase).HasFlag(FileAttributes.ReparsePoint)
                || new DirectoryInfo(Path.GetDirectoryName(personalDatabase)!).Attributes.HasFlag(FileAttributes.ReparsePoint))
                throw new InvalidDataException("연결된 개인용 데이터 경로는 사용할 수 없습니다.");
            if (Process.GetProcessesByName("라이브 펄스").Length != 0)
                throw new InvalidOperationException("기존 Electron 앱을 종료한 뒤 개인용 네이티브 앱을 시작하세요.");
            StartMonitorForDatabase(personalDatabase, requireBackup: true);
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

        StartMonitorForDatabase(database, requireBackup: false);
    }

    private void StartMonitorForDatabase(string database, bool requireBackup)
    {
        _monitorLease = NativeStoreLease.Acquire(database);
        if (requireBackup)
        {
            NativeStoreRecovery.Validate(database);
            NativeStoreRecovery.Validate(database + ".bak.1");
        }
        var store = new NativeMonitorStore(database);
        _monitorStore = store;
        _snapshotClient = new YouTubeSnapshotClient();
        _monitorBackup = new NativeBackupCheckpoint(database);
        var runner = new NativeMonitorRunner(store, _snapshotClient, _monitorEffects, _monitorBackup);
        _monitorScheduler = new NativeMonitorScheduler(store, runner);
        _monitorCancellation = new CancellationTokenSource();
        _monitorTask = Task.Run(() => _monitorScheduler.RunAsync(_monitorCancellation.Token));
        _ = ObserveMonitorAsync(_monitorTask);
        _cloudSync = new NativeCloudSync(database, _monitorBackup);
        _stateReader = new NativeStateReader(database);
        _cloudTask = Task.Run(() => RunCloudLoopAsync(_monitorCancellation.Token));
        _ = ObserveCloudAsync(_cloudTask);
        Console.WriteLine($"NATIVE_MONITOR_STARTED personal={requireBackup} windowCreated={_window is not null}");
    }

    private async Task RunCloudLoopAsync(CancellationToken cancellationToken)
    {
        await Task.Delay(250, cancellationToken);
        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                var result = await _cloudSync!.SyncOnceAsync(cancellationToken);
                Volatile.Write(ref _lastCloudSync, result);
                Volatile.Write(ref _lastCloudError, null);
                _ = Dispatcher.BeginInvoke((Action)(() =>
                {
                    if (_tray is not null) _tray.Text = IsPersonal ? "라이브 펄스 · 감시 중" : "라이브 펄스 시제품 · 감시 중";
                    _window?.SendState();
                }));
                Console.WriteLine($"ISOLATED_CLOUD_SYNC configured={result.Configured} pages={result.Pages} "
                    + $"observations={result.Observations}");
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { break; }
            catch (NativeBackupException) { throw; }
            catch (Exception error) when (error is not OutOfMemoryException)
            {
                Volatile.Write(ref _lastCloudError, error.Message);
                _ = Dispatcher.BeginInvoke((Action)(() =>
                {
                    if (_tray is not null) _tray.Text = IsPersonal ? "라이브 펄스 · 클라우드 오류" : "라이브 펄스 시제품 · 클라우드 오류";
                    _window?.SendState();
                }));
                Console.Error.WriteLine($"ISOLATED_CLOUD_SYNC_FAILED {error.Message}");
            }
            await Task.Delay(TimeSpan.FromMinutes(1), cancellationToken);
        }
    }

    private async Task ObserveCloudAsync(Task task)
    {
        try { await task; }
        catch (OperationCanceledException) when (_quitting) { }
        catch (Exception error)
        {
            Console.Error.WriteLine($"ISOLATED_CLOUD_FATAL {error.Message}");
            Environment.ExitCode = 1;
            if (!_quitting)
                _ = Dispatcher.BeginInvoke((Action)(() =>
                {
                    if (!_args.Contains("--monitor-smoke"))
                        System.Windows.MessageBox.Show($"격리 클라우드 동기화가 중단됐습니다.\n{error.Message}", "라이브 펄스 시제품");
                    Quit();
                }));
        }
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
                        + $"backups={_monitorBackup?.BackupCount} "
                        + $"cloudConfigured={Volatile.Read(ref _lastCloudSync)?.Configured} "
                        + $"cloudError={Volatile.Read(ref _lastCloudError) is not null} "
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

    private async Task RunUiSmokeAsync()
    {
        try
        {
            if (_stateReader is null) throw new InvalidOperationException("실제 저장소가 연결되지 않았습니다.");
            ShowWindow();
            var window = _window ?? throw new InvalidOperationException("창을 만들지 못했습니다.");
            await window.Ready;
            var channelCount = _stateReader.Read()["channels"]!.AsArray().Count;
            if (!await window.ProbeBridgeAsync(channelCount)
                || !await window.ProbeRenderedCardsAsync(channelCount))
                throw new InvalidOperationException("실제 상태 브리지 또는 채널 카드 표시 실패");
            if (_args.Contains("--ui-smoke-actions") && !await window.ProbeActionsAsync())
                throw new InvalidOperationException("채널 추가·삭제 또는 설정 저장 실패");
            if (_args.Contains("--ui-smoke-refresh")) await window.ProbeRefreshAsync();
            Console.WriteLine($"NATIVE_UI_SMOKE_PASSED channels={channelCount} browser={window.BrowserProcessId}");
            CloseToTray(window);
            var timer = System.Diagnostics.Stopwatch.StartNew();
            while (window.IsBrowserProcessAlive && timer.Elapsed < TimeSpan.FromSeconds(10))
                await Task.Delay(100);
            if (window.IsBrowserProcessAlive) throw new InvalidOperationException("창을 닫은 뒤 WebView 프로세스가 남았습니다.");
            Console.WriteLine("NATIVE_UI_CLOSED browserAlive=false");
        }
        catch (Exception error)
        {
            Console.Error.WriteLine($"NATIVE_UI_SMOKE_FAILED {error.Message}");
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

internal sealed class PrototypeEffectSink(PrototypeApp app, bool enabled) : IMonitorEffectSink
{
    private int notificationCount;
    private int urlCount;
    public int NotificationCount => Volatile.Read(ref notificationCount);
    public int UrlCount => Volatile.Read(ref urlCount);

    public Task NotifyAsync(MonitorNotification notification, CancellationToken cancellationToken)
    {
        Interlocked.Increment(ref notificationCount);
        return enabled ? app.ShowNotificationAsync(notification, cancellationToken) : Task.CompletedTask;
    }

    public Task OpenUrlAsync(string url, CancellationToken cancellationToken)
    {
        Interlocked.Increment(ref urlCount);
        if (enabled) app.OpenUrl(url);
        return Task.CompletedTask;
    }
}
