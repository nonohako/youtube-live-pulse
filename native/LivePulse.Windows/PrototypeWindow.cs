using System.Diagnostics;
using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;

namespace LivePulse.Windows;

internal sealed class PrototypeWindow : Window
{
    private const string LocalPage = "https://appassets.livepulse.invalid/src/renderer/index.html";
    private readonly PrototypeApp _app;
    private readonly Grid _layout = new();
    private readonly TaskCompletionSource _ready = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private WebView2? _view;
    private CoreWebView2Environment? _environment;
    private readonly string _session = Guid.NewGuid().ToString("N");
    private bool _disposed;
    private int _browserProcessId;

    internal Task Ready => _ready.Task;
    internal int BrowserProcessId => _browserProcessId;
    internal async Task CaptureAsync(string path)
    {
        if (_view?.CoreWebView2 is not { } core) throw new InvalidOperationException("WebView가 준비되지 않음");
        await using var output = File.Create(path);
        await core.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, output);
    }
    internal async Task<bool> ProbeBridgeAsync()
    {
        if (_view is null) return false;
        var presence = await _view.ExecuteScriptAsync("typeof window.livePulse");
        Console.WriteLine($"BRIDGE presence={presence}");
        await _view.ExecuteScriptAsync("window.__lpProbe = 'pending'; Promise.all([window.livePulse.getState(), window.livePulse.watchAnalytics({subscriberId:null,videos:[]})]).then(([state, analytics]) => window.__lpProbe = state.channels.length === 0 && state.analyticsLazy === true && analytics.channels.length === 0).catch(error => window.__lpProbe = error.message)");
        for (var attempt = 0; attempt < 50; attempt++)
        {
            var result = await _view.ExecuteScriptAsync("window.__lpProbe");
            if (result == "true") return true;
            if (result != "\"pending\"")
            {
                Console.WriteLine($"BRIDGE fixture={result}");
                return false;
            }
            await Task.Delay(100);
        }
        Console.WriteLine("BRIDGE fixture=timeout");
        return false;
    }
    internal bool IsBrowserProcessAlive
    {
        get
        {
            if (_browserProcessId == 0) return false;
            try { return !Process.GetProcessById(_browserProcessId).HasExited; }
            catch (ArgumentException) { return false; }
        }
    }

    internal PrototypeWindow(PrototypeApp app)
    {
        _app = app;
        Title = "라이브 펄스 · 마이그레이션 시제품";
        Width = 1180;
        Height = 800;
        MinWidth = 900;
        MinHeight = 660;
        _layout.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        _layout.RowDefinitions.Add(new RowDefinition());
        _layout.Children.Add(new TextBlock
        {
            Text = "마이그레이션 수명 시제품 · 실제 감시, 저장, 알림은 아직 연결되지 않았습니다.",
            Padding = new Thickness(12),
            Background = System.Windows.Media.Brushes.DarkSlateBlue,
            Foreground = System.Windows.Media.Brushes.White
        });
        Content = _layout;
        Closing += (_, args) =>
        {
            if (!_disposed)
            {
                args.Cancel = true;
                _app.CloseToTray(this);
            }
        };
    }

    internal async Task InitializeAsync()
    {
        try
        {
            var view = new WebView2();
            _view = view;
            Grid.SetRow(view, 1);
            _layout.Children.Add(view);
            var profile = Path.Combine(Path.GetTempPath(), "LivePulseNativePrototype", "WebView2");
            _environment = await CoreWebView2Environment.CreateAsync(userDataFolder: profile);
            if (_disposed) return;
            await view.EnsureCoreWebView2Async(_environment);
            if (_disposed) return;
            var core = view.CoreWebView2;
            _browserProcessId = (int)core.BrowserProcessId;
            core.SetVirtualHostNameToFolderMapping("appassets.livepulse.invalid", AppContext.BaseDirectory, CoreWebView2HostResourceAccessKind.Deny);
            core.Settings.AreDevToolsEnabled = false;
            core.Settings.AreHostObjectsAllowed = false;
            core.Settings.IsWebMessageEnabled = true;
            core.NavigationStarting += (_, args) =>
            {
                if (!string.Equals(args.Uri, LocalPage, StringComparison.Ordinal)) args.Cancel = true;
            };
            core.NewWindowRequested += (_, args) => args.Handled = true;
            core.PermissionRequested += (_, args) => args.State = CoreWebView2PermissionState.Deny;
            core.WebMessageReceived += OnWebMessage;
            var bridge = File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "bridge.js"))
                .Replace("__SESSION__", _session, StringComparison.Ordinal);
            await core.AddScriptToExecuteOnDocumentCreatedAsync(bridge);
            if (_disposed) return;
            core.NavigationCompleted += (_, args) =>
            {
                if (args.IsSuccess) _ready.TrySetResult();
                else _ready.TrySetException(new InvalidOperationException($"WebView 탐색 실패: {args.WebErrorStatus}"));
            };
            core.Navigate(LocalPage);
        }
        catch (Exception error)
        {
            if (_disposed) return;
            _ready.TrySetException(error);
            _layout.Children.Add(new TextBlock
            {
                Text = $"화면을 열지 못했습니다. 트레이에서 다시 열어 주세요.\n{error.Message}",
                Padding = new Thickness(16)
            });
        }
    }

    private void OnWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs args)
    {
        if (_disposed || _view?.CoreWebView2 is not { } core || args.Source != LocalPage) return;
        if (args.WebMessageAsJson.Length > 64 * 1024) return;
        try
        {
            using var document = JsonDocument.Parse(args.WebMessageAsJson);
            var root = document.RootElement;
            if (root.GetProperty("session").GetString() != _session) return;
            var id = root.GetProperty("id").GetInt32();
            if (id <= 0) return;
            var method = root.GetProperty("method").GetString();
            object? result = null;
            string? error = null;
            switch (method)
            {
                case "getState":
                    using (var fixture = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixture-state.json"))))
                        result = fixture.RootElement.Clone();
                    break;
                case "watchAnalytics":
                    if (!root.TryGetProperty("params", out var scope) ||
                        scope.ValueKind != JsonValueKind.Object ||
                        !scope.TryGetProperty("subscriberId", out var subscriber) ||
                        subscriber.ValueKind != JsonValueKind.Null ||
                        !scope.TryGetProperty("videos", out var videos) ||
                        videos.ValueKind != JsonValueKind.Array || videos.GetArrayLength() != 0)
                    {
                        error = "이 수명 시제품에서는 비어 있는 분석 범위만 허용합니다.";
                        break;
                    }
                    using (var fixture = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixture-state.json"))))
                        result = fixture.RootElement.Clone();
                    break;
                case "hideWindow":
                    Dispatcher.BeginInvoke(() => _app.CloseToTray(this));
                    break;
                case "quit":
                    Dispatcher.BeginInvoke(_app.Quit);
                    break;
                default:
                    error = "이 기능은 수명 시제품에 연결되지 않았습니다.";
                    break;
            }
            if (!_disposed) core.PostWebMessageAsJson(JsonSerializer.Serialize(new { session = _session, id, result, error }));
        }
        catch (Exception)
        {
            // Invalid messages cannot reach native operations.
        }
    }

    internal void DisposeSession()
    {
        if (_disposed) return;
        _disposed = true;
        _ready.TrySetCanceled();
        if (_view is not null)
        {
            if (_view.CoreWebView2 is { } core) core.WebMessageReceived -= OnWebMessage;
            _layout.Children.Remove(_view);
            _view.Dispose();
            _view = null;
        }
        _environment = null;
        Close();
    }
}
