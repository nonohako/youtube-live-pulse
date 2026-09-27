namespace LivePulse.Core;

public sealed record ChannelTrackingState(IReadOnlyList<string>? SeenVideoIds,
    IReadOnlyList<string>? SeenPostIds, IReadOnlyList<string> OpenedBroadcastIds,
    string? LastVideoId = null, string? LastPostId = null);

// RecordLocalStatistics=false leaves subscriber/view history to the cloud collector while it is healthy.
public sealed record MonitorSettings(bool AutoOpenLive, bool AutoOpenUpcoming,
    bool NotifyNewVideos, bool NotifyNewPosts, bool RecordLocalStatistics = true);

public sealed record SubscriberObservation(DateTimeOffset At, long Count);
public sealed record MonitorEvent(string ChannelId, string Type, string SourceId,
    string Title, string Detail, string Url);
public sealed record MonitorNotification(string Title, string Body, string Url);
public sealed record MonitorChangePlan(ChannelTrackingState NextTrackingState,
    IReadOnlyList<MonitorEvent> Events, IReadOnlyList<MonitorNotification> Notifications,
    IReadOnlyList<string> UrlsToOpen, SubscriberObservation? SubscriberSampleToAppend);

// Pure decision step. The runner commits NextTrackingState before performing side effects.
public static partial class MonitorChangePlanner
{
    private const int RecentIdLimit = 100;
    private static readonly TimeSpan SubscriberHeartbeat = TimeSpan.FromHours(6);
    // An unseen item published longer ago than this resurfaced in a list (reordering, a newly
    // listed Short, an old stream replay); it is marked seen without a "new" alert.
    public static readonly TimeSpan NewContentWindow = TimeSpan.FromDays(2);

    [System.Text.RegularExpressions.GeneratedRegex(@"(\d+)\s*(초|분|시간|일|주|개월|달|년|seconds?|minutes?|hours?|days?|weeks?|months?|years?)\s*(전|ago)",
        System.Text.RegularExpressions.RegexOptions.IgnoreCase | System.Text.RegularExpressions.RegexOptions.CultureInvariant)]
    private static partial System.Text.RegularExpressions.Regex RelativeAgePattern();

    // knownPublishedAt holds recorded publish times (cloud collector first, then local metadata).
    public static bool IsOldContent(DateTimeOffset? publishedAt, string? publishedText, DateTimeOffset checkedAt)
    {
        if (publishedAt is { } published) return checkedAt - published > NewContentWindow;
        var match = RelativeAgePattern().Match(publishedText ?? "");
        if (!match.Success || !int.TryParse(match.Groups[1].Value, out var amount)) return false;
        var unit = match.Groups[2].Value.ToLowerInvariant();
        // Relative text is coarse ("2일 전" means 2 to 3 days), so only clearly old items qualify.
        return unit is "주" or "개월" or "달" or "년" || unit.StartsWith("week") || unit.StartsWith("month")
            || unit.StartsWith("year") || ((unit == "일" || unit.StartsWith("day")) && amount >= 3);
    }

    public static MonitorChangePlan Plan(string channelId, ChannelTrackingState previous,
        SubscriberObservation? lastSubscriberSample, MonitorSettings settings, YouTubeSnapshot snapshot,
        IReadOnlyDictionary<string, DateTimeOffset>? knownPublishedAt = null)
    {
        if (string.IsNullOrWhiteSpace(channelId)) throw new ArgumentException("채널 ID가 필요합니다.", nameof(channelId));
        var recentVideos = snapshot.RecentVideos.DistinctBy(item => item.Id, StringComparer.Ordinal).ToArray();
        var recentPosts = snapshot.RecentPosts.DistinctBy(item => item.Id, StringComparer.Ordinal).ToArray();
        var seenVideos = previous.SeenVideoIds?.ToHashSet(StringComparer.Ordinal) ?? new HashSet<string>(StringComparer.Ordinal);
        var seenPosts = previous.SeenPostIds?.ToHashSet(StringComparer.Ordinal) ?? new HashSet<string>(StringComparer.Ordinal);
        VideoCandidate[] newVideos = previous.SeenVideoIds is null ? []
            : recentVideos.Where(item => !seenVideos.Contains(item.Id)).ToArray();
        YouTubePageParser.CommunityPost[] newPosts = previous.SeenPostIds is null ? []
            : recentPosts.Where(item => !seenPosts.Contains(item.Id)).ToArray();
        newVideos = newVideos.Where(video => !IsOldContent(
            knownPublishedAt is not null && knownPublishedAt.TryGetValue(video.Id, out var known) ? known
                : DateTimeOffset.TryParse(video.PublishedAt, System.Globalization.CultureInfo.InvariantCulture,
                    System.Globalization.DateTimeStyles.AssumeUniversal, out var parsed) ? parsed : null,
            video.PublishedText, snapshot.CheckedAt)).ToArray();
        newPosts = newPosts.Where(post => !IsOldContent(null, post.PublishedText, snapshot.CheckedAt)).ToArray();
        var events = new List<MonitorEvent>();
        var notifications = new List<MonitorNotification>();
        var urlsToOpen = new List<string>();

        foreach (var video in newVideos.Reverse())
        {
            events.Add(new MonitorEvent(channelId, "video", video.Id, "새 동영상", video.Title, video.Url));
            if (settings.NotifyNewVideos)
                notifications.Add(new MonitorNotification($"{snapshot.Metadata.Title} · 새 동영상", video.Title, video.Url));
        }
        foreach (var post in newPosts.Reverse())
        {
            events.Add(new MonitorEvent(channelId, "post", post.Id, "새 게시물", post.Text, post.Url));
            if (settings.NotifyNewPosts)
                notifications.Add(new MonitorNotification($"{snapshot.Metadata.Title} · 새 게시물",
                    post.Text.Length > 160 ? post.Text[..160] : post.Text, post.Url));
        }

        var opened = previous.OpenedBroadcastIds.Distinct(StringComparer.Ordinal).ToList();
        var openedSet = opened.ToHashSet(StringComparer.Ordinal);
        if (settings.AutoOpenLive && snapshot.Live is { IsLive: true } live && openedSet.Add($"live:{live.Id}"))
        {
            events.Add(new MonitorEvent(channelId, "live", live.Id, "라이브 시작", live.Title, live.Url));
            notifications.Add(new MonitorNotification($"{snapshot.Metadata.Title} · LIVE", live.Title, live.Url));
            urlsToOpen.Add(live.Url);
            opened.Add($"live:{live.Id}");
        }
        if (settings.AutoOpenUpcoming)
            foreach (var upcoming in snapshot.Upcoming.Where(item => item.IsUpcoming))
            {
                if (!openedSet.Add($"upcoming:{upcoming.Id}")) continue;
                events.Add(new MonitorEvent(channelId, "upcoming", upcoming.Id, "예약 방송 발견",
                    upcoming.Title, upcoming.Url));
                notifications.Add(new MonitorNotification($"{snapshot.Metadata.Title} · 예약 방송",
                    upcoming.Title, upcoming.Url));
                urlsToOpen.Add(upcoming.Url);
                opened.Add($"upcoming:{upcoming.Id}");
            }

        var next = new ChannelTrackingState(
            RetainRecent(previous.SeenVideoIds, recentVideos.Select(item => item.Id)),
            RetainRecent(previous.SeenPostIds, recentPosts.Select(item => item.Id)),
            opened.TakeLast(RecentIdLimit).ToArray(), snapshot.LatestVideo?.Id ?? previous.LastVideoId,
            snapshot.LatestPost?.Id ?? previous.LastPostId);
        var count = snapshot.Metadata.SubscriberCount;
        var subscriberSample = count is >= 0 && (lastSubscriberSample is null || lastSubscriberSample.Count != count
            || snapshot.CheckedAt - lastSubscriberSample.At >= SubscriberHeartbeat)
            ? new SubscriberObservation(snapshot.CheckedAt, count.Value) : null;
        return new MonitorChangePlan(next, events, notifications, urlsToOpen, subscriberSample);
    }

    private static IReadOnlyList<string>? RetainRecent(IReadOnlyList<string>? previous, IEnumerable<string> observed)
    {
        var observedIds = observed.Where(id => !string.IsNullOrEmpty(id)).ToArray();
        if (previous is null && observedIds.Length == 0) return null;
        var ids = new List<string>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var id in (previous ?? []).Concat(observedIds))
            if (!string.IsNullOrEmpty(id) && seen.Add(id)) ids.Add(id);
        return ids.TakeLast(RecentIdLimit).ToArray();
    }
}
