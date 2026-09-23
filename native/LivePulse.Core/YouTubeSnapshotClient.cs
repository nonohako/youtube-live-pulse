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
        var streamsTask = FetchAsync($"{channelUrl}/streams", cancellationToken);
        var videosTask = FetchAsync($"{channelUrl}/videos", cancellationToken);
        var shortsTask = FetchAsync($"{channelUrl}/shorts", cancellationToken);
        var postsTask = FetchAsync($"{channelUrl}/posts", cancellationToken);
        var feedTask = FetchAsync($"{Origin}/feeds/videos.xml?channel_id={channelId}", cancellationToken);
        var liveTask = FetchAsync($"{channelUrl}/live", cancellationToken);
        await Task.WhenAll(streamsTask, videosTask, shortsTask, postsTask, feedTask, liveTask);
        return Compose(await streamsTask, await videosTask, await shortsTask, await postsTask,
            await feedTask, await liveTask);
    }

    private static YouTubeSnapshot Compose(PageResult streams, PageResult videos, PageResult shorts,
        PageResult posts, PageResult feed, PageResult live)
    {
        var now = DateTimeOffset.UtcNow;
        var streamsData = streams.Success ? YouTubePageParser.ParseInitialData(streams.Body) : null;
        var videosData = videos.Success ? YouTubePageParser.ParseInitialData(videos.Body) : null;
        var shortData = shorts.Success ? YouTubePageParser.ParseInitialData(shorts.Body) : null;
        var postsData = posts.Success ? YouTubePageParser.ParseInitialData(posts.Body) : null;
        var streamVideos = YouTubePageParser.ParseVideos(streamsData, now);
        var uploadedVideos = YouTubePageParser.ParseVideos(videosData, now);
        var shortVideos = YouTubePageParser.ParseVideos(shortData, now);
        var recentPosts = YouTubePageParser.ParsePosts(postsData).Take(8).ToArray();
        var feedVideos = feed.Success ? YouTubePageParser.ParseVideoFeed(feed.Body) : [];
        var player = live.Success ? YouTubeBroadcast.ParsePlayer(live.Body, live.FinalUrl, now) : null;

        var metadata = YouTubePageParser.ParseChannelMetadata(streamsData ?? videosData,
            streams.Success ? streams.Body : videos.Success ? videos.Body : "");
        var listedVideos = streamVideos.Concat(uploadedVideos).DistinctBy(item => item.Id, StringComparer.Ordinal).ToArray();
        var pageLive = listedVideos.FirstOrDefault(item => item.IsLive);
        var currentLive = YouTubeBroadcast.SelectCurrentLive(player,
            pageLive is null ? null : AsBroadcast(pageLive), live.Success);
        var upcoming = listedVideos.Where(item => item.IsUpcoming && item.Id != currentLive?.Id)
            .Select(AsBroadcast).ToList();
        if (player?.IsUpcoming == true && player.Id != currentLive?.Id) upcoming.Add(player);
        var sortedUpcoming = upcoming.OrderBy(item => DateTimeOffset.TryParse(item.ScheduledStart,
                out var start) ? start : DateTimeOffset.MaxValue)
            .DistinctBy(item => item.Id, StringComparer.Ordinal).Take(5).ToArray();
        var recentVideos = YouTubeBroadcast.SelectRecentVideos(uploadedVideos, feedVideos, streamVideos, shortVideos);
        var warnings = new List<string>();
        Warn(warnings, "방송 목록", streams);
        Warn(warnings, "동영상 목록", videos);
        Warn(warnings, "쇼츠 목록", shorts);
        Warn(warnings, "게시물", posts);
        Warn(warnings, "새 영상", feed);
        Warn(warnings, "현재 라이브", live);
        return new YouTubeSnapshot(now, metadata, currentLive, sortedUpcoming,
            recentVideos.FirstOrDefault(), recentPosts.FirstOrDefault(), recentVideos, recentPosts, warnings);
    }

    private static Broadcast AsBroadcast(VideoCandidate item)
        => new(item.Id, item.Title, item.Url, item.ThumbnailUrl, item.ScheduledStart, item.IsLive, item.IsUpcoming);

    private static void Warn(List<string> warnings, string label, PageResult result)
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
            return new PageResult(true, Encoding.UTF8.GetString(buffer.ToArray()),
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
}
