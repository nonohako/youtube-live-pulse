using System.Diagnostics;
using System.IO;
using System.Text.Json;
using System.Text.Json.Nodes;
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
    private string? _subscriberId;
    private List<(string ChannelId, string VideoId)> _selectedVideos = [];
    private bool? _lastActive;

    internal bool WindowActive => !_disposed && IsVisible && WindowState != WindowState.Minimized;

    private JsonObject ReadWindowState()
    {
        var state = _app.ReadState(_subscriberId, _selectedVideos);
        state["app"]!["windowActive"] = WindowActive;
        return state;
    }

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

    internal async Task ProbeRefreshAsync()
    {
        var view = _view ?? throw new InvalidOperationException("WebView가 준비되지 않음");
        async Task WaitFor(string expression, string failure)
        {
            for (var attempt = 0; attempt < 50; attempt++)
            {
                if (await view.ExecuteScriptAsync(expression) == "true") return;
                await Task.Delay(100);
            }
            throw new InvalidOperationException(failure);
        }
        await view.ExecuteScriptAsync("""
            window.__lpStateEvents = 0;
            window.livePulse.onState(() => window.__lpStateEvents++);
            window.__lpRefreshReady = false;
            (async () => {
              const state = await window.livePulse.getState();
              window.__lpChannel = state.channels[0].id;
              window.__lpVideo = 'abcdefghijk'; // The generated multi-sample fixture video.
              await openSubscriberChart(window.__lpChannel, 'all');
              window.__lpSubscriberCount = appState.channels[0].subscriberHistory.length;
              window.__lpRefreshReady = window.__lpSubscriberCount > 120;
            })();
            """);
        await WaitFor("window.__lpRefreshReady", "구독자 상세 스모크에는 120개 초과 fixture 표본이 필요합니다.");
        await view.ExecuteScriptAsync("window.__lpStateEvents = 0");
        SendState();
        await WaitFor("window.__lpStateEvents > 0 && appState.channels[0].subscriberHistory.length >= window.__lpSubscriberCount",
            "상태 갱신이 구독자 상세 기록을 축소함");

        WindowState = WindowState.Minimized;
        await WaitFor("windowActive === false && countdownTimer === null", "최소화 시 카운트다운이 멈추지 않음");
        var before = await view.ExecuteScriptAsync("window.__lpStateEvents");
        SendState();
        SendState();
        await Task.Delay(200);
        if (await view.ExecuteScriptAsync("window.__lpStateEvents") != before)
            throw new InvalidOperationException("최소화 중 상태를 전송함");
        _app.ShowWindow();
        await WaitFor($"windowActive === true && countdownTimer !== null && window.__lpStateEvents > {before} && appState.channels[0].subscriberHistory.length >= window.__lpSubscriberCount",
            "복원 시 활성 상태와 전체 기록을 갱신하지 못함");

        await view.ExecuteScriptAsync("elements.subscriberDialog.close()");
        await WaitFor("appState.channels[0].subscriberHistory.length <= 120", "구독자 창을 닫아도 구독이 해제되지 않음");
        await view.ExecuteScriptAsync("""
            window.__lpRefreshReady = false;
            (async () => {
              await openVideoViewChart(window.__lpChannel, window.__lpVideo);
              window.__lpVideoCount = appState.channels[0].videoViewHistories.find(video => video.videoId === window.__lpVideo).samples.length;
              try { await window.livePulse.watchAnalytics({subscriberId: 'invalid', videos: []}); }
              catch { window.__lpRefreshReady = window.__lpVideoCount > 2; }
            })();
            """);
        await WaitFor("window.__lpRefreshReady", "영상 상세 또는 잘못된 구독 요청 검증 실패");
        await view.ExecuteScriptAsync("window.__lpStateEvents = 0");
        SendState();
        await WaitFor("window.__lpStateEvents > 0 && appState.channels[0].videoViewHistories.find(video => video.videoId === window.__lpVideo).samples.length >= window.__lpVideoCount",
            "상태 갱신 또는 잘못된 요청이 영상 상세 기록을 축소함");
        await view.ExecuteScriptAsync("elements.videoViewDialog.close()");
        await WaitFor("appState.channels[0].videoViewHistories.find(video => video.videoId === window.__lpVideo).samples.length === 2", "영상 창을 닫아도 구독이 해제되지 않음");
        Console.WriteLine("NATIVE_UI_REFRESH_PASSED subscriber video invalidScope release minimize restore");
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
        Icon = System.Windows.Media.Imaging.BitmapFrame.Create(new Uri(Path.Combine(AppContext.BaseDirectory, "assets", "pulse.ico")));
        Width = 1180;
        Height = 800;
        MinWidth = 900;
        MinHeight = 660;
        _layout.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        _layout.RowDefinitions.Add(new RowDefinition());
        if (!app.IsPersonal) _layout.Children.Add(new TextBlock
        {
            Text = app.HasRealState
                ? "격리 감시 데이터 표시 중 · 실제 알림과 Chrome 열기는 아직 연결되지 않았습니다."
                : "마이그레이션 수명 시제품 · 실제 감시는 아직 연결되지 않았습니다.",
            Padding = new Thickness(12),
            Background = System.Windows.Media.Brushes.DarkSlateBlue,
            Foreground = System.Windows.Media.Brushes.White
        });
        Content = _layout;
        StateChanged += (_, _) => UpdateWindowActivity();
        IsVisibleChanged += (_, _) => UpdateWindowActivity();
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
                if (args.IsSuccess)
                {
                    _lastActive = null;
                    UpdateWindowActivity();
                    _ready.TrySetResult();
                }
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
                    result = ReadWindowState();
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
                    {
                        var requestedSubscriber = subscriber.ValueKind == JsonValueKind.Null ? null : subscriber.GetString();
                        // Validate before replacing the current subscription; a rejected request must not drop it.
                        var state = _app.ReadState(requestedSubscriber, selected);
                        _subscriberId = requestedSubscriber;
                        _selectedVideos = selected;
                        state["app"]!["windowActive"] = WindowActive;
                        result = state;
                    }
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
                    var removedId = target.GetString()!;
                    // Removal sends state immediately, so release this channel's scope first.
                    if (_subscriberId == removedId) _subscriberId = null;
                    _selectedVideos = _selectedVideos.Where(item => item.ChannelId != removedId).ToList();
                    result = _app.RemoveChannel(removedId);
                    break;
                case "updateSettings":
                    if (!root.TryGetProperty("params", out var settings) || settings.ValueKind != JsonValueKind.Object)
                        throw new InvalidDataException("설정 값이 올바르지 않습니다.");
                    _app.UpdateSettings(settings);
                    result = ReadWindowState();
                    break;
                case "refresh":
                    await _app.RefreshAsync();
                    result = ReadWindowState();
                    break;
                case "checkForUpdates":
                    result = ReadWindowState();
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

    private void UpdateWindowActivity()
    {
        if (_disposed || _browserFailed || _view?.CoreWebView2 is not { } core) return;
        var active = WindowActive;
        if (_lastActive == active) return;
        _lastActive = active;
        try
        {
            core.PostWebMessageAsJson(JsonSerializer.Serialize(new
            { session = _session, @event = "active", value = active }));
            if (active) SendState();
        }
        catch (Exception error) { Console.Error.WriteLine($"NATIVE_WINDOW_ACTIVITY_FAILED {error.Message}"); }
    }

    internal void SendState()
    {
        if (!WindowActive || _browserFailed) return;
        try
        {
            if (_view?.CoreWebView2 is not { } core) return;
            core.PostWebMessageAsJson(JsonSerializer.Serialize(new
            { session = _session, @event = "state", value = ReadWindowState() }));
        }
        catch (Exception error) { Console.Error.WriteLine($"NATIVE_STATE_REFRESH_FAILED {error.Message}"); }
    }

    internal void DisposeSession()
    {
        if (_disposed) return;
        _disposed = true;
        _subscriberId = null;
        _selectedVideos.Clear();
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
