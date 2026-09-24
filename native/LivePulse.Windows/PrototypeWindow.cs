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
    private bool _browserFailed;
    private int _browserProcessId;

    internal Task Ready => _ready.Task;
    internal int BrowserProcessId => _browserProcessId;
    internal async Task CaptureAsync(string path)
    {
        if (_view?.CoreWebView2 is not { } core) throw new InvalidOperationException("WebView가 준비되지 않음");
        await using var output = File.Create(path);
        await core.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, output);
    }
    internal async Task<bool> ProbeBridgeAsync(int expectedChannels = 0)
    {
        if (_view is null) return false;
        var presence = await _view.ExecuteScriptAsync("typeof window.livePulse");
        Console.WriteLine($"BRIDGE presence={presence}");
        await _view.ExecuteScriptAsync($"window.__lpProbe = 'pending'; Promise.all([window.livePulse.getState(), window.livePulse.watchAnalytics({{subscriberId:null,videos:[]}})]).then(([state, analytics]) => window.__lpProbe = state.channels.length === {expectedChannels} && state.analyticsLazy === true && analytics.channels.length === {expectedChannels}).catch(error => window.__lpProbe = error.message)");
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
    internal async Task<bool> ProbeRenderedCardsAsync(int expected)
    {
        if (_view is null) return false;
        for (var attempt = 0; attempt < 50; attempt++)
        {
            if (await _view.ExecuteScriptAsync("document.querySelectorAll('.channel-card').length") == expected.ToString())
                return true;
            await Task.Delay(100);
        }
        return false;
    }
    internal async Task<bool> ProbeActionsAsync()
    {
        if (_view is null) return false;
        await _view.ExecuteScriptAsync("""
            window.__lpActions = 'pending';
            (async () => {
              const before = await window.livePulse.getState();
              const id = 'UCbbbbbbbbbbbbbbbbbbbbbb';
              await window.livePulse.addChannel(id);
              const added = await window.livePulse.getState();
              if (!added.channels.some(channel => channel.id === id)) return false;
              const changed = await window.livePulse.updateSettings({pollIntervalSeconds: 45});
              if (changed.settings.pollIntervalSeconds !== 45) return false;
              await window.livePulse.removeChannel(id);
              await window.livePulse.updateSettings({pollIntervalSeconds: before.settings.pollIntervalSeconds});
              const after = await window.livePulse.getState();
              return !after.channels.some(channel => channel.id === id) &&
                after.channels.length === before.channels.length;
            })().then(value => window.__lpActions = value).catch(error => window.__lpActions = error.message);
            """);
        for (var attempt = 0; attempt < 100; attempt++)
        {
            var result = await _view.ExecuteScriptAsync("window.__lpActions");
            if (result == "true") return true;
            if (result != "\"pending\"")
            {
                Console.Error.WriteLine($"NATIVE_UI_ACTIONS_FAILED {result}");
                return false;
            }
            await Task.Delay(100);
        }
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
        Title = app.IsPersonal ? "라이브 펄스" : "라이브 펄스 · 마이그레이션 시제품";
        Width = 1180;
        Height = 800;
        MinWidth = 900;
        MinHeight = 660;
        _layout.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        _layout.RowDefinitions.Add(new RowDefinition());
        _layout.Children.Add(new TextBlock
        {
            Text = app.IsPersonal
                ? "개인용 네이티브 실행 · 창을 닫아도 감시와 동기화는 계속됩니다."
                : app.HasRealState
                ? "격리 감시 데이터 표시 중 · 실제 알림과 Chrome 열기는 아직 연결되지 않았습니다."
                : "마이그레이션 수명 시제품 · 실제 감시는 아직 연결되지 않았습니다.",
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
            var profile = _app.WebViewProfilePath;
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
            core.ProcessFailed += OnBrowserProcessFailed;
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

    private async void OnWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs args)
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
            try { switch (method)
            {
                case "getState":
                    result = _app.ReadState();
                    break;
                case "watchAnalytics":
                    if (!root.TryGetProperty("params", out var scope) ||
                        scope.ValueKind != JsonValueKind.Object ||
                        !scope.TryGetProperty("subscriberId", out var subscriber) ||
                        subscriber.ValueKind is not (JsonValueKind.Null or JsonValueKind.String) ||
                        !scope.TryGetProperty("videos", out var videos) ||
                        videos.ValueKind != JsonValueKind.Array || videos.GetArrayLength() > 4)
                    {
                        error = "분석 요청이 올바르지 않습니다.";
                        break;
                    }
                    var selected = new List<(string ChannelId, string VideoId)>();
                    foreach (var video in videos.EnumerateArray())
                    {
                        if (video.ValueKind != JsonValueKind.Object ||
                            !video.TryGetProperty("channelId", out var channelId) || channelId.ValueKind != JsonValueKind.String ||
                            !video.TryGetProperty("videoId", out var videoId) || videoId.ValueKind != JsonValueKind.String)
                        {
                            error = "분석 영상이 올바르지 않습니다.";
                            break;
                        }
                        selected.Add((channelId.GetString()!, videoId.GetString()!));
                    }
                    if (error is null)
                        result = _app.ReadState(subscriber.ValueKind == JsonValueKind.Null ? null : subscriber.GetString(), selected);
                    break;
                case "hideWindow":
                    _ = Dispatcher.BeginInvoke(() => _app.CloseToTray(this));
                    break;
                case "addChannel":
                    if (!root.TryGetProperty("params", out var input) || input.ValueKind != JsonValueKind.String)
                        throw new InvalidDataException("채널 입력이 올바르지 않습니다.");
                    result = await _app.AddChannelAsync(input.GetString()!);
                    break;
                case "removeChannel":
                    if (!root.TryGetProperty("params", out var target) || target.ValueKind != JsonValueKind.String)
                        throw new InvalidDataException("채널 ID가 올바르지 않습니다.");
                    result = _app.RemoveChannel(target.GetString()!);
                    break;
                case "updateSettings":
                    if (!root.TryGetProperty("params", out var settings) || settings.ValueKind != JsonValueKind.Object)
                        throw new InvalidDataException("설정 값이 올바르지 않습니다.");
                    result = _app.UpdateSettings(settings);
                    break;
                case "refresh":
                    result = await _app.RefreshAsync();
                    break;
                case "checkForUpdates":
                    result = _app.ReadState();
                    break;
                case "openUrl":
                    if (!root.TryGetProperty("params", out var address) || address.ValueKind != JsonValueKind.String)
                        throw new InvalidDataException("주소가 올바르지 않습니다.");
                    result = _app.OpenUrl(address.GetString()!);
                    break;
                case "importCloudConnection":
                    result = _app.ImportCloudConnection();
                    break;
                case "importSubscriberHistory":
                    if (!root.TryGetProperty("params", out var importChannel)
                        || importChannel.ValueKind != JsonValueKind.String)
                        throw new InvalidDataException("구독자 기록 채널이 올바르지 않습니다.");
                    result = await _app.ImportSubscriberHistoryAsync(importChannel.GetString()!);
                    break;
                case "quit":
                    _ = Dispatcher.BeginInvoke(_app.Quit);
                    break;
                default:
                    error = "이 기능은 수명 시제품에 연결되지 않았습니다.";
                    break;
            } }
            catch (Exception requestError)
            {
                Console.Error.WriteLine($"NATIVE_BRIDGE_REQUEST_FAILED {requestError.Message}");
                error = "요청을 처리하지 못했습니다.";
            }
            if (!_disposed) core.PostWebMessageAsJson(JsonSerializer.Serialize(new { session = _session, id, result, error }));
        }
        catch (Exception)
        {
            // Invalid messages cannot reach native operations.
        }
    }

    private void OnBrowserProcessFailed(object? sender, CoreWebView2ProcessFailedEventArgs args)
    {
        if (_disposed || _browserFailed) return;
        _browserFailed = true;
        Console.Error.WriteLine($"NATIVE_WEBVIEW_FAILED kind={args.ProcessFailedKind}");
        _ready.TrySetException(new InvalidOperationException($"WebView2 프로세스가 종료됐습니다: {args.ProcessFailedKind}"));
        _ = Dispatcher.BeginInvoke(() => _app.CloseToTray(this));
    }

    internal void SendState()
    {
        if (_disposed || _browserFailed) return;
        try
        {
            if (_view?.CoreWebView2 is not { } core) return;
            core.PostWebMessageAsJson(JsonSerializer.Serialize(new
            { session = _session, @event = "state", value = _app.ReadState() }));
        }
        catch (Exception error) { Console.Error.WriteLine($"NATIVE_STATE_REFRESH_FAILED {error.Message}"); }
    }

    internal void DisposeSession()
    {
        if (_disposed) return;
        _disposed = true;
        _ready.TrySetCanceled();
        if (_view is not null)
        {
            try
            {
                if (_view.CoreWebView2 is { } core)
                {
                    core.WebMessageReceived -= OnWebMessage;
                    core.ProcessFailed -= OnBrowserProcessFailed;
                }
            }
            catch (InvalidOperationException) when (_browserFailed) { }
            _layout.Children.Remove(_view);
            _view.Dispose();
            _view = null;
        }
        _environment = null;
        Close();
    }
}
