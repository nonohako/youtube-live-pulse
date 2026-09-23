using System.Drawing;
using System.IO;
using System.Windows;
using System.Windows.Threading;
using Forms = System.Windows.Forms;

namespace LivePulse.Windows;

internal sealed class PrototypeApp : System.Windows.Application
{
    private readonly string[] _args;
    private Forms.NotifyIcon? _tray;
    private PrototypeWindow? _window;
    private bool _quitting;
    private readonly DispatcherTimer _heartbeat = new() { Interval = TimeSpan.FromSeconds(30) };

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
        if (_args.Contains("--lifecycle-smoke") || _args.Contains("--lifecycle-stress"))
            Dispatcher.BeginInvoke(async () => await RunLifecycleSmokeAsync());
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
