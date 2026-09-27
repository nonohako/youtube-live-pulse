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
    private readonly DispatcherTimer _heartbeat = new() { Interval = TimeSpan.FromSeconds(1) };
    private bool _lastSweeping;
    private bool _closeHintShown;
    private DateTime _lastTrim = DateTime.MinValue;
    private MonitorSweepResult? _lastSweepSent;
    private int _ticksSinceState;
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
    // "(네이티브)" was the name while the Electron app was still installed.
    private static readonly string[] DesktopShortcutNames = ["라이브 펄스.lnk", "라이브 펄스 (네이티브).lnk"];
    private readonly PortableLayout? _personal;
    internal bool IsPersonal => _personal is not null;
    internal string WebViewProfilePath => _personal?.WebViewProfile
        ?? Path.Combine(Path.GetTempPath(), "LivePulseNativePrototype", "WebView2");
    // Logs stay with the data so rebuilding app/ never discards them.
    private string LogDirectory => _personal is { } layout && Directory.Exists(layout.DataDirectory)
        ? layout.DataDirectory : AppContext.BaseDirectory;

    internal PrototypeApp(string[] args, PortableLayout? personal = null)
    {
        _args = args;
        _personal = personal;
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
        var menu = _tray.ContextMenuStrip;
        menu.Items.Add("라이브 펄스 열기", null, (_, _) => ShowWindow());
        menu.Items.Add("지금 새로고침", null, async (_, _) =>
        {
            try { await RefreshAsync(); }
            catch (Exception error) { Console.Error.WriteLine($"NATIVE_TRAY_REFRESH_FAILED {error.Message}"); }
        });
        if (IsPersonal)
        {
            menu.Items.Add(new Forms.ToolStripSeparator());
            var startup = new Forms.ToolStripMenuItem("Windows 로그인 때 자동 실행") { CheckOnClick = true };
            startup.Click += (_, _) =>
            {
                try
                {
                    using var partial = JsonDocument.Parse(startup.Checked ? """{"startAtLogin":true}""" : """{"startAtLogin":false}""");
                    UpdateSettings(partial.RootElement);
                }
                catch (Exception error) { System.Windows.MessageBox.Show($"설정을 저장하지 못했습니다.\n{error.Message}", "라이브 펄스"); }
            };
            menu.Opening += (_, _) => startup.Checked = _monitorStore?.ReadStartAtLogin() == true;
            menu.Items.Add(startup);
        }
        menu.Items.Add(new Forms.ToolStripSeparator());
        menu.Items.Add("종료", null, (_, _) => Quit());
        _tray.MouseClick += (_, args) => { if (args.Button == Forms.MouseButtons.Left) ShowWindow(); };
        _tray.BalloonTipClicked += (_, _) =>
        {
            if (_lastNotificationUrl is { } url) OpenUrl(url);
        };
        // The timer refreshes a visible UI only. Monitor and cloud loops run independently.
        // Sweep start/finish is pushed promptly; otherwise the full state refreshes every 30 s.
        _heartbeat.Tick += (_, _) =>
        {
            var sweeping = _monitorScheduler?.IsSweeping == true;
            var last = _monitorScheduler?.LastSweep;
            var sweepChanged = !ReferenceEquals(last, _lastSweepSent);
            if (sweeping == _lastSweeping && !sweepChanged && ++_ticksSinceState < 30) return;
            _lastSweeping = sweeping;
            _lastSweepSent = last;
            _ticksSinceState = 0;
            if (sweepChanged) UpdateTrayText();
            if (sweepChanged && _window is null) TrimMemory();
            _window?.SendState();
        };
        _heartbeat.Start();
        try
        {
            var startupTimer = Stopwatch.StartNew();
            StartIsolatedMonitor();
            Console.WriteLine($"NATIVE_STARTUP_MONITOR_MS {startupTimer.ElapsedMilliseconds} since-process={(DateTime.Now - Process.GetCurrentProcess().StartTime).TotalMilliseconds:F0}");
            // Registry/shortcut repair (COM) is not needed for the first paint.
            if (IsPersonal) _ = Dispatcher.BeginInvoke(DispatcherPriority.ApplicationIdle, RepairPersonalShellEntries);
        }
        catch (Exception error)
        {
            Console.Error.WriteLine($"ISOLATED_MONITOR_START_FAILED {error.Message}");
            Environment.ExitCode = 1;
            var diagnostic = "";
            if (IsPersonal)
            {
                try
                {
                    var path = Path.Combine(LogDirectory, "startup-error.log");
                    File.AppendAllText(path, $"{DateTimeOffset.Now:O}\nExecutable: {Environment.ProcessPath}\n"
                        + $"Database: {_personal!.Database}\n{error}\n\n");
                    diagnostic = $"\n\n진단 기록: {path}";
                }
                catch (Exception) { /* Logging must not hide the original startup failure. */ }
            }
            if (!_args.Contains("--monitor-smoke"))
                System.Windows.MessageBox.Show($"감시를 시작하지 못했습니다.\n{error.Message}{diagnostic}", IsPersonal ? "라이브 펄스" : "라이브 펄스 시제품");
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

    // Like Electron: the tooltip shows how many channels are live.
    private void UpdateTrayText()
    {
        if (_tray is null || _stateReader is null) return;
        try
        {
            var live = _stateReader.CountLiveChannels();
            _tray.Text = Volatile.Read(ref _lastCloudError) is not null ? "라이브 펄스 · 클라우드 오류"
                : live > 0 ? $"라이브 펄스 · {live}개 채널 LIVE" : "라이브 펄스 · YouTube 채널 확인 중";
        }
        catch (Exception error) { Console.Error.WriteLine($"NATIVE_TRAY_TEXT_FAILED {error.Message}"); }
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
        // Electron semantics: running means a sweep is in progress, not that the loop exists.
        state["monitor"]!["running"] = _monitorScheduler?.IsSweeping == true;
        state["monitor"]!["nextCheckAt"] = _monitorScheduler?.NextSweepAt?.ToString("O");
        state["monitor"]!["warning"] = _monitorTask is { IsCompleted: true } ? "감시가 중단됐습니다. 앱을 다시 시작하세요."
            : _monitorBackup?.LastError;
        if (_monitorScheduler?.CurrentChannelId is { } checking)
            foreach (var channel in state["channels"]!.AsArray())
                if ((string?)channel!["id"] == checking && (string?)channel["status"] != "error") channel["status"] = "checking";
        state["app"]!["nativePersonal"] = IsPersonal;
        state["app"]!["loginSettingApplied"] = IsPersonal
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
        _monitorScheduler?.Wake();
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
        if (_snapshotClient is not null) _snapshotClient.ApiKey = _monitorStore.ReadApiKey();
        if (partial.TryGetProperty("pollIntervalSeconds", out _) || partial.TryGetProperty("apiKey", out _))
        {
            _snapshotClient?.ExpireOfficialMetadata();
            _monitorScheduler?.Wake();
        }
        if (IsPersonal) ApplyPersonalLoginSetting();
        _window?.SendState();
    }

    private void RepairPersonalShellEntries()
    {
        // A moved folder (for example to another drive) repairs its own entries on the next launch.
        try { ApplyPersonalLoginSetting(); }
        catch (Exception error) { Console.Error.WriteLine($"NATIVE_LOGIN_ENTRY_FAILED {error.Message}"); }
        try { RepairDesktopShortcut(); }
        catch (Exception error) { Console.Error.WriteLine($"NATIVE_SHORTCUT_REPAIR_FAILED {error.Message}"); }
    }

    private void ApplyPersonalLoginSetting()
    {
        if (_stateReader is null || _personal is null) return;
        var enabled = _monitorStore!.ReadStartAtLogin();
        using var key = Registry.CurrentUser.CreateSubKey(RunKeyPath, writable: true)
            ?? throw new IOException("Windows 시작 항목을 열 수 없습니다.");
        var current = key.GetValue(RunValueName) as string;
        // Never overwrite an unrelated entry that happens to use the product name.
        if (current is not null && !IsOwnRunCommand(current)) return;
        if (current is not null && IsElectronRunCommand(current))
        {
            var preserved = Path.Combine(_personal.DataDirectory, "electron-startup-command.txt");
            if (!File.Exists(preserved)) File.WriteAllText(preserved, current);
        }
        var nativeCommand = RunCommand(Environment.ProcessPath!);
        if (enabled)
        {
            if (!string.Equals(current, nativeCommand, StringComparison.OrdinalIgnoreCase))
                key.SetValue(RunValueName, nativeCommand, RegistryValueKind.String);
        }
        else if (current is not null) key.DeleteValue(RunValueName, throwOnMissingValue: false);
    }

    private static bool IsPersonalLoginSettingApplied(bool enabled)
    {
        using var key = Registry.CurrentUser.OpenSubKey(RunKeyPath);
        var current = key?.GetValue(RunValueName) as string;
        return enabled ? string.Equals(current, RunCommand(Environment.ProcessPath!), StringComparison.OrdinalIgnoreCase)
            : current is null;
    }

    internal static string RunCommand(string executable) => $"\"{executable}\" --hidden";

    private static string? QuotedExecutable(string command)
    {
        if (!command.StartsWith('"')) return null;
        var end = command.IndexOf('"', 1);
        return end > 1 ? command[1..end] : null;
    }

    private static bool IsElectronRunCommand(string command)
        => Path.GetFileName(QuotedExecutable(command) ?? "") == "라이브 펄스.exe";

    // Native builds (the earlier fixed-path prototype or this portable app at any location)
    // and the replaced Electron app own the "라이브 펄스" login entry.
    internal static bool IsOwnRunCommand(string command)
        => QuotedExecutable(command) is { } executable
            && (IsElectronRunCommand(command)
                || Path.GetFileName(executable) is "LivePulse.exe" or "LivePulse.NativePrototype.exe");

    private static void RepairDesktopShortcut()
    {
        foreach (var name in DesktopShortcutNames)
        {
            var path = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), name);
            if (File.Exists(path)) RepairShortcut(path);
        }
    }

    private static void RepairShortcut(string path)
    {
        var shellType = Type.GetTypeFromProgID("WScript.Shell") ?? throw new IOException("WScript.Shell을 사용할 수 없습니다.");
        dynamic shell = Activator.CreateInstance(shellType)!;
        try
        {
            dynamic shortcut = shell.CreateShortcut(path);
            string target = shortcut.TargetPath;
            var executable = Environment.ProcessPath!;
            if (string.Equals(target, executable, StringComparison.OrdinalIgnoreCase)
                || Path.GetFileName(target) is not ("LivePulse.exe" or "LivePulse.NativePrototype.exe"))
                return;
            shortcut.TargetPath = executable;
            shortcut.Arguments = "";
            shortcut.WorkingDirectory = Path.GetDirectoryName(executable);
            shortcut.IconLocation = executable + ",0";
            shortcut.Save();
        }
        finally { System.Runtime.InteropServices.Marshal.FinalReleaseComObject(shell); }
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
        _snapshotClient?.ExpireOfficialMetadata();
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
        // New tray icons start in the hidden overflow area, so say once that the app keeps running.
        if (!_closeHintShown && _tray is not null && !_args.Contains("--ui-smoke") && !_args.Contains("--lifecycle-smoke")
            && !_args.Contains("--lifecycle-stress"))
        {
            _closeHintShown = true;
            _lastNotificationUrl = null;
            _tray.BalloonTipTitle = "라이브 펄스";
            _tray.BalloonTipText = "창을 닫아도 트레이에서 계속 감시합니다. 완전히 끄려면 트레이 아이콘 → 종료를 누르세요.";
            _tray.ShowBalloonTip(4000);
        }
        // Let the WebView and chart data go, then return the freed memory to Windows.
        _ = Dispatcher.BeginInvoke(DispatcherPriority.ApplicationIdle, TrimMemory);
    }

    // Tray-only memory: a compacting collection that decommits free GC memory, then an
    // empty working set. Runs only while no window exists, at most once a minute.
    private void TrimMemory()
    {
        if (_window is not null || DateTime.UtcNow - _lastTrim < TimeSpan.FromMinutes(1)) return;
        _lastTrim = DateTime.UtcNow;
        System.Runtime.GCSettings.LargeObjectHeapCompactionMode = System.Runtime.GCLargeObjectHeapCompactionMode.CompactOnce;
        GC.Collect(2, GCCollectionMode.Aggressive, blocking: true, compacting: true);
        using var process = Process.GetCurrentProcess();
        SetProcessWorkingSetSize(process.Handle, -1, -1);
    }

    [System.Runtime.InteropServices.DllImport("kernel32.dll")]
    private static extern bool SetProcessWorkingSetSize(IntPtr process, nint minimum, nint maximum);

    internal void Quit()
    {
        if (_quitting) return;
        _quitting = true;
        // Disappear immediately; the monitor may still finish a write or backup in the background.
        if (_tray is not null) _tray.Visible = false;
        if (_window is { } open) { _window = null; open.DisposeSession(); }
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
        if (_personal is { } layout)
        {
            if (!Directory.Exists(layout.DataDirectory))
                throw new DirectoryNotFoundException($"개인 데이터 폴더가 없습니다.\n폴더: {layout.DataDirectory}\n"
                    + "app 폴더와 data 폴더를 같은 상위 폴더에 함께 두세요.");
            if (File.GetAttributes(layout.DataDirectory).HasFlag(FileAttributes.ReparsePoint))
                throw new InvalidDataException("연결된 개인용 데이터 폴더는 사용할 수 없습니다.");
            if (Process.GetProcessesByName("라이브 펄스").Length != 0)
                throw new InvalidOperationException("기존 Electron 앱을 종료한 뒤 네이티브 앱을 시작하세요.");
            StartMonitorForDatabase(layout.Database, personal: true);
            return;
        }
        if (optionIndex < 0)
        {
            if (_args.Contains("--monitor-smoke") || _args.Contains("--monitor-smoke-twice") || _args.Contains("--ui-smoke"))
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

        StartMonitorForDatabase(database, personal: false);
    }

    private void StartMonitorForDatabase(string database, bool personal)
    {
        _monitorLease = NativeStoreLease.Acquire(database);
        if (personal)
        {
            // Under the lease: roll back a crash journal, or restore the newest valid backup
            // (preserving a corrupt primary). No valid copy stops startup visibly.
            var recovery = NativeStoreRecovery.OpenForStartup(database);
            if (recovery.Restored)
                File.AppendAllText(Path.Combine(LogDirectory, "runtime-error.log"),
                    $"{DateTimeOffset.Now:O}\nRESTORED from {recovery.Source}; preserved {recovery.PreservedPrimary ?? "(none)"}\n\n");
        }
        var store = new NativeMonitorStore(database);
        _monitorStore = store;
        _snapshotClient = new YouTubeSnapshotClient { ApiKey = store.ReadApiKey() };
        _monitorBackup = new NativeBackupCheckpoint(database);
        if (File.Exists(database + ".bak.1"))
            _monitorBackup.AssumeBackupAt(File.GetLastWriteTimeUtc(database + ".bak.1"));
        var runner = new NativeMonitorRunner(store, _snapshotClient, _monitorEffects, _monitorBackup);
        _monitorScheduler = new NativeMonitorScheduler(store, runner);
        _monitorCancellation = new CancellationTokenSource();
        _monitorTask = Task.Run(() => _monitorScheduler.RunAsync(_monitorCancellation.Token));
        _ = ObserveMonitorAsync(_monitorTask);
        _cloudSync = new NativeCloudSync(database, _monitorBackup);
        _stateReader = new NativeStateReader(database);
        _cloudTask = Task.Run(() => RunCloudLoopAsync(_monitorCancellation.Token));
        _ = ObserveCloudAsync(_cloudTask);
        Console.WriteLine($"NATIVE_MONITOR_STARTED personal={personal} windowCreated={_window is not null}");
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
                    UpdateTrayText();
                    _window?.SendState();
                }));
                Console.WriteLine($"ISOLATED_CLOUD_SYNC configured={result.Configured} pages={result.Pages} "
                    + $"observations={result.Observations}");
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { break; }
            catch (Exception error) when (error is not OutOfMemoryException)
            {
                Volatile.Write(ref _lastCloudError, error.Message);
                _ = Dispatcher.BeginInvoke((Action)(() =>
                {
                    UpdateTrayText();
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
            var details = RecordRuntimeFailure(error);
            _monitorCancellation?.Cancel();
            Environment.ExitCode = 1;
            if (!_quitting)
                _ = Dispatcher.BeginInvoke((Action)(() =>
                {
                    if (!_args.Contains("--monitor-smoke"))
                        System.Windows.MessageBox.Show($"클라우드 동기화가 중단됐습니다.\n{details}", "라이브 펄스");
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
            var details = RecordRuntimeFailure(error);
            _monitorCancellation?.Cancel();
            Environment.ExitCode = 1;
            if (!_quitting)
                _ = Dispatcher.BeginInvoke((Action)(() =>
                {
                    if (!_args.Contains("--monitor-smoke"))
                        System.Windows.MessageBox.Show($"감시가 중단됐습니다.\n{details}", "라이브 펄스");
                    Quit();
                }));
        }
    }

    private string RecordRuntimeFailure(Exception error)
    {
        var details = error.Message + "\n원인: " + error.GetBaseException().Message;
        try
        {
            var path = Path.Combine(LogDirectory, "runtime-error.log");
            File.AppendAllText(path, $"{DateTimeOffset.Now:O}\n{error}\n\n");
            return details + "\n진단 기록: " + path;
        }
        catch (Exception) { return details; }
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
