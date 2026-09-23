using System.Net;
using System.Text;
using System.Text.RegularExpressions;

namespace LivePulse.Core;

public sealed record YouTubeSnapshot(DateTimeOffset CheckedAt, YouTubePageParser.ChannelMetadata Metadata,
    Broadcast? Live, IReadOnlyList<Broadcast> Upcoming, VideoCandidate? LatestVideo,
    YouTubePageParser.CommunityPost? LatestPost, IReadOnlyList<VideoCandidate> RecentVideos,
    IReadOnlyList<YouTubePageParser.CommunityPost> RecentPosts, IReadOnlyList<string> Warnings);

// Read-only public-page diagnostic. It does not poll, notify, open URLs, or persist data.
public sealed class YouTubeSnapshotClient : IDisposable
{
    private const string Origin = "https://www.youtube.com";
    private const int MaxPageBytes = 8 * 1024 * 1024;
    private static readonly Regex ChannelIdPattern = new("^UC[A-Za-z0-9_-]{22}$",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);
    private readonly HttpClient http;
    private readonly bool ownsHttp;

    public YouTubeSnapshotClient(HttpClient? httpClient = null)
    {
        ownsHttp = httpClient is null;
        http = httpClient ?? new HttpClient(new HttpClientHandler
        {
            AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate | DecompressionMethods.Brotli
        });
    }

    public async Task<YouTubeSnapshot> FetchChannelSnapshotAsync(string channelId,
        CancellationToken cancellationToken = default)
    {
        if (!ChannelIdPattern.IsMatch(channelId)) throw new ArgumentException("올바르지 않은 YouTube 채널 ID입니다.", nameof(channelId));
        var channelUrl = $"{Origin}/channel/{channelId}";
        var now = DateTimeOffset.UtcNow;
        var streamsTask = FetchVideosAsync($"{channelUrl}/streams", now, true, cancellationToken);
        var videosTask = FetchVideosAsync($"{channelUrl}/videos", now, true, cancellationToken);
        var shortsTask = FetchVideosAsync($"{channelUrl}/shorts", now, false, cancellationToken);
        var postsTask = FetchPostsAsync($"{channelUrl}/posts", cancellationToken);
        var feedTask = FetchFeedAsync($"{Origin}/feeds/videos.xml?channel_id={channelId}", cancellationToken);
        var liveTask = FetchLiveAsync($"{channelUrl}/live", now, cancellationToken);
        await Task.WhenAll(streamsTask, videosTask, shortsTask, postsTask, feedTask, liveTask);
        return Compose(await streamsTask, await videosTask, await shortsTask, await postsTask,
            await feedTask, await liveTask);
    }

    private async Task<VideoPage> FetchVideosAsync(string url, DateTimeOffset now, bool includeMetadata,
        CancellationToken cancellationToken)
    {
        var page = await FetchAsync(url, cancellationToken);
        if (!page.Success) return new VideoPage(false, page.StatusCode, false, [], null);
        var data = YouTubePageParser.ParseInitialData(page.Body);
        return new VideoPage(true, null, data is not null, YouTubePageParser.ParseVideos(data, now),
            includeMetadata ? YouTubePageParser.ParseChannelMetadata(data, page.Body) : null);
    }

    private async Task<PostsPage> FetchPostsAsync(string url, CancellationToken cancellationToken)
    {
        var page = await FetchAsync(url, cancellationToken);
        if (!page.Success) return new PostsPage(false, page.StatusCode, []);
        return new PostsPage(true, null, YouTubePageParser.ParsePosts(YouTubePageParser.ParseInitialData(page.Body))
            .Take(8).ToArray());
    }

    private async Task<FeedPage> FetchFeedAsync(string url, CancellationToken cancellationToken)
    {
        var page = await FetchAsync(url, cancellationToken);
        return new FeedPage(page.Success, page.StatusCode,
            page.Success ? YouTubePageParser.ParseVideoFeed(page.Body) : []);
    }

    private async Task<LivePage> FetchLiveAsync(string url, DateTimeOffset now, CancellationToken cancellationToken)
    {
        var page = await FetchAsync(url, cancellationToken);
        return new LivePage(page.Success, page.StatusCode,
            page.Success ? YouTubeBroadcast.ParsePlayer(page.Body, page.FinalUrl, now) : null);
    }

    private static YouTubeSnapshot Compose(VideoPage streams, VideoPage videos, VideoPage shorts,
        PostsPage posts, FeedPage feed, LivePage live)
    {
        var metadata = (streams.HasInitialData ? streams.Metadata : videos.HasInitialData ? videos.Metadata
            : streams.Success ? streams.Metadata : videos.Metadata)
            ?? new YouTubePageParser.ChannelMetadata("YouTube 채널", "", "확인 중", null);
        var listedVideos = streams.Videos.Concat(videos.Videos).DistinctBy(item => item.Id, StringComparer.Ordinal).ToArray();
        var pageLive = listedVideos.FirstOrDefault(item => item.IsLive);
        var currentLive = YouTubeBroadcast.SelectCurrentLive(live.Player,
            pageLive is null ? null : AsBroadcast(pageLive), live.Success);
        var upcoming = listedVideos.Where(item => item.IsUpcoming && item.Id != currentLive?.Id)
            .Select(AsBroadcast).ToList();
        if (live.Player?.IsUpcoming == true && live.Player.Id != currentLive?.Id) upcoming.Add(live.Player);
        var sortedUpcoming = upcoming.OrderBy(item => DateTimeOffset.TryParse(item.ScheduledStart,
                out var start) ? start : DateTimeOffset.MaxValue)
            .DistinctBy(item => item.Id, StringComparer.Ordinal).Take(5).ToArray();
        var recentVideos = YouTubeBroadcast.SelectRecentVideos(videos.Videos, feed.Videos, streams.Videos, shorts.Videos);
        var warnings = new List<string>();
        Warn(warnings, "방송 목록", streams);
        Warn(warnings, "동영상 목록", videos);
        Warn(warnings, "쇼츠 목록", shorts);
        Warn(warnings, "게시물", posts);
        Warn(warnings, "새 영상", feed);
        Warn(warnings, "현재 라이브", live);
        return new YouTubeSnapshot(DateTimeOffset.UtcNow, metadata, currentLive, sortedUpcoming,
            recentVideos.FirstOrDefault(), posts.Posts.FirstOrDefault(), recentVideos, posts.Posts, warnings);
    }

    private static Broadcast AsBroadcast(VideoCandidate item)
        => new(item.Id, item.Title, item.Url, item.ThumbnailUrl, item.ScheduledStart, item.IsLive, item.IsUpcoming);

    private static void Warn(List<string> warnings, string label, ParsedPage result)
    {
        if (!result.Success) warnings.Add($"{label} 확인 실패{(result.StatusCode is { } status ? $" (HTTP {status})" : "")}");
    }

    private async Task<PageResult> FetchAsync(string url, CancellationToken cancellationToken)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(15));
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, url);
            request.Headers.TryAddWithoutValidation("accept-language", "ko-KR,ko;q=0.9,en-US;q=0.7,en;q=0.6");
            request.Headers.TryAddWithoutValidation("user-agent",
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/136.0.0.0 Safari/537.36");
            request.Headers.TryAddWithoutValidation("cookie", "SOCS=CAI");
            using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
            if (!response.IsSuccessStatusCode) return new PageResult(false, "", response.RequestMessage?.RequestUri?.ToString(),
                (int)response.StatusCode);
            if (response.Content.Headers.ContentLength > MaxPageBytes) return new PageResult(false, "",
                response.RequestMessage?.RequestUri?.ToString());
            await using var stream = await response.Content.ReadAsStreamAsync(timeout.Token);
            using var buffer = new MemoryStream();
            var chunk = new byte[32 * 1024];
            while (true)
            {
                var count = await stream.ReadAsync(chunk, timeout.Token);
                if (count == 0) break;
                if (buffer.Length + count > MaxPageBytes) return new PageResult(false, "",
                    response.RequestMessage?.RequestUri?.ToString());
                buffer.Write(chunk, 0, count);
            }
            return new PageResult(true, Encoding.UTF8.GetString(buffer.GetBuffer().AsSpan(0, (int)buffer.Length)),
                response.RequestMessage?.RequestUri?.ToString());
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested) { return new PageResult(false, ""); }
        catch (Exception error) when (error is HttpRequestException or IOException or InvalidDataException)
        {
            return new PageResult(false, "");
        }
    }

    public void Dispose()
    {
        if (ownsHttp) http.Dispose();
    }

    private sealed record PageResult(bool Success, string Body, string? FinalUrl = null, int? StatusCode = null);
    private abstract record ParsedPage(bool Success, int? StatusCode);
    private sealed record VideoPage(bool Success, int? StatusCode, bool HasInitialData,
        IReadOnlyList<VideoCandidate> Videos, YouTubePageParser.ChannelMetadata? Metadata)
        : ParsedPage(Success, StatusCode);
    private sealed record PostsPage(bool Success, int? StatusCode,
        IReadOnlyList<YouTubePageParser.CommunityPost> Posts) : ParsedPage(Success, StatusCode);
    private sealed record FeedPage(bool Success, int? StatusCode,
        IReadOnlyList<VideoCandidate> Videos) : ParsedPage(Success, StatusCode);
    private sealed record LivePage(bool Success, int? StatusCode, Broadcast? Player) : ParsedPage(Success, StatusCode);
}
