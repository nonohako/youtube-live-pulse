using LivePulse.Core;

namespace LivePulse.NativeStore;

public sealed record MonitorPollConfiguration(TimeSpan Interval, IReadOnlyList<string> ChannelIds,
    MonitorSettings Settings);

public sealed record MonitorSweepResult(DateTimeOffset FinishedAt, IReadOnlyList<MonitorRunResult> Completed,
    IReadOnlyList<string> Errors)
{
    public IReadOnlyDictionary<string, string> ChannelErrors { get; init; } = new Dictionary<string, string>();
}

// Polling loop for one DB. The host owns cancellation and the writer lease.
public sealed class NativeMonitorScheduler(NativeMonitorStore store, NativeMonitorRunner runner,
    Func<TimeSpan, CancellationToken, Task>? wait = null)
{
    private readonly Func<TimeSpan, CancellationToken, Task> delay = wait ?? Task.Delay;
    private MonitorSweepResult? lastSweep;
    private int running;
    private int sweeping;
    private long nextSweepTicks;
    private string? currentChannelId;
    private CancellationTokenSource? pendingWait;
    private readonly SemaphoreSlim sweepGate = new(1, 1);

    public MonitorSweepResult? LastSweep => Volatile.Read(ref lastSweep);
    public bool IsSweeping => Volatile.Read(ref sweeping) != 0;
    public string? CurrentChannelId => Volatile.Read(ref currentChannelId);

    // Ends the current wait so the next sweep starts now and later waits use fresh settings
    // (Electron restarted its timer after a channel, interval or API key change).
    public void Wake()
    {
        try { Volatile.Read(ref pendingWait)?.Cancel(); }
        catch (ObjectDisposedException) { }
    }
    public DateTimeOffset? NextSweepAt => Interlocked.Read(ref nextSweepTicks) is var ticks and > 0
        ? new DateTimeOffset(ticks, TimeSpan.Zero) : null;

    public async Task<MonitorSweepResult> RunNowAsync(CancellationToken cancellationToken = default)
        => (await SweepAsync(cancellationToken)).Result;

    public async Task RunAsync(CancellationToken cancellationToken)
    {
        if (Interlocked.CompareExchange(ref running, 1, 0) != 0)
            throw new InvalidOperationException("감시 주기 실행은 한 번만 시작할 수 있습니다.");
        var nextDelay = TimeSpan.FromMilliseconds(250);
        try
        {
            while (!cancellationToken.IsCancellationRequested)
            {
                Interlocked.Exchange(ref nextSweepTicks, DateTimeOffset.UtcNow.Add(nextDelay).UtcTicks);
                using (var wait = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken))
                {
                    Volatile.Write(ref pendingWait, wait);
                    try { await delay(nextDelay, wait.Token); }
                    catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested) { }
                    finally { Volatile.Write(ref pendingWait, null); }
                }
                var sweep = await SweepAsync(cancellationToken);
                nextDelay = sweep.Interval;
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { }
        finally
        {
            Interlocked.Exchange(ref nextSweepTicks, 0);
            Interlocked.Exchange(ref running, 0);
        }
    }

    private async Task<(MonitorSweepResult Result, TimeSpan Interval)> SweepAsync(CancellationToken cancellationToken)
    {
        await sweepGate.WaitAsync(cancellationToken);
        Interlocked.Exchange(ref sweeping, 1);
        try
        {
            MonitorPollConfiguration configuration;
            try { configuration = store.ReadPollConfiguration(); }
            catch (Exception error) when (error is not OperationCanceledException and not OutOfMemoryException)
            {
                Volatile.Write(ref lastSweep, new MonitorSweepResult(DateTimeOffset.UtcNow, [],
                    [$"감시 설정 읽기 실패: {error.Message}"]));
                throw;
            }
            var completed = new List<MonitorRunResult>();
            var errors = new List<string>();
            var channelErrors = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var channelId in configuration.ChannelIds)
            {
                cancellationToken.ThrowIfCancellationRequested();
                Volatile.Write(ref currentChannelId, channelId);
                try { completed.Add(await runner.RunChannelOnceAsync(channelId, configuration.Settings, cancellationToken)); }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { throw; }
                catch (Exception error) when (error is not OutOfMemoryException)
                {
                    var message = $"채널 {channelId} 확인 실패: {error.Message}";
                    errors.Add(message);
                    channelErrors[channelId] = message;
                    try { store.RecordChannelFailure(channelId, error.Message, DateTimeOffset.UtcNow); }
                    catch (Exception recordError) when (recordError is not OutOfMemoryException) { }
                }
                finally { Volatile.Write(ref currentChannelId, null); }
            }
            var result = new MonitorSweepResult(DateTimeOffset.UtcNow, completed, errors)
            { ChannelErrors = channelErrors };
            Volatile.Write(ref lastSweep, result);
            return (result, configuration.Interval);
        }
        finally
        {
            Interlocked.Exchange(ref sweeping, 0);
            sweepGate.Release();
        }
    }
}
