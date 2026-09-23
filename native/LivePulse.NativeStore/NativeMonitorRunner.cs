using LivePulse.Core;

namespace LivePulse.NativeStore;

public interface IMonitorEffectSink
{
    Task NotifyAsync(MonitorNotification notification, CancellationToken cancellationToken);
    Task OpenUrlAsync(string url, CancellationToken cancellationToken);
}

public sealed record MonitorRunResult(string ChannelId, long SavedRevision, int EventsPlanned,
    int NotificationsPlanned, int UrlsPlanned, IReadOnlyList<string> EffectErrors,
    IReadOnlyList<string> SnapshotWarnings);

// Manual poll proof. Scheduling and Windows effects are intentionally outside this class.
public sealed class NativeMonitorRunner(NativeMonitorStore store, IYouTubeSnapshotSource source,
    IMonitorEffectSink effects)
{
    private readonly SemaphoreSlim gate = new(1, 1);

    public async Task<MonitorRunResult> RunChannelOnceAsync(string channelId, MonitorSettings settings,
        CancellationToken cancellationToken = default)
    {
        await gate.WaitAsync(cancellationToken);
        try
        {
            var previous = store.Load(channelId);
            var snapshot = await source.FetchChannelSnapshotAsync(channelId, cancellationToken);
            cancellationToken.ThrowIfCancellationRequested();
            if (snapshot.SuccessfulSourceCount == 0)
                throw new InvalidDataException("모든 공개 데이터 소스 확인에 실패해 감시 상태를 저장하지 않았습니다.");
            var plan = MonitorChangePlanner.Plan(channelId, previous.Tracking,
                previous.LastSubscriberSample, settings, snapshot);
            var revision = store.Commit(channelId, previous.Revision, snapshot, plan);

            var errors = new List<string>();
            foreach (var notification in plan.Notifications)
            {
                try { await effects.NotifyAsync(notification, cancellationToken); }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { break; }
                catch (Exception error) { errors.Add($"알림 실패: {error.GetType().Name}"); }
            }
            if (!cancellationToken.IsCancellationRequested)
                foreach (var url in plan.UrlsToOpen)
                {
                    try { await effects.OpenUrlAsync(url, cancellationToken); }
                    catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { break; }
                    catch (Exception error) { errors.Add($"URL 열기 실패: {error.GetType().Name}"); }
                }
            return new MonitorRunResult(channelId, revision, plan.Events.Count,
                plan.Notifications.Count, plan.UrlsToOpen.Count, errors, snapshot.Warnings);
        }
        finally { gate.Release(); }
    }
}
