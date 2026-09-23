using System.Text.Json;
using System.Net;
using LivePulse.Core;

static void Require(bool condition, string message)
{
    if (!condition) throw new InvalidOperationException(message);
}

static string Player(string id, bool isLive, bool liveContent, string? timestamp = null)
{
    var payload = new
    {
        videoDetails = new { videoId = id, title = "테스트 {라이브}", isLive, isLiveContent = liveContent,
            thumbnail = new { thumbnails = new[] { new { url = "https://img/small.jpg", width = 120 }, new { url = "https://img/large.jpg", width = 320 } } } },
        microformat = new { playerMicroformatRenderer = new { liveBroadcastDetails = new { isLiveNow = isLive, startTimestamp = timestamp } } }
    };
    return $"var ytInitialPlayerResponse = {JsonSerializer.Serialize(payload)};";
}

var now = new DateTimeOffset(2026, 9, 23, 0, 0, 0, TimeSpan.Zero);
var live = YouTubeBroadcast.ParsePlayer(Player("abcdefghijk", true, true, "2020-01-01T00:00:00Z"), now: now);
Require(live is { IsLive: true, IsUpcoming: false, ThumbnailUrl: "https://img/large.jpg" }, "현재 라이브 판정 오류");
Require(YouTubeBroadcast.ParsePlayer(Player("hm6LLaIfMho", false, true), now: now) is null, "종료된 방송이 예약으로 분류됨");
Require(YouTubeBroadcast.ParsePlayer(Player("hm6LLaIfMho", false, true, "2020-01-01T00:00:00Z"), now: now) is null,
    "과거 시작 방송이 예약으로 분류됨");
var upcoming = YouTubeBroadcast.ParsePlayer(Player("abcdefghijk", false, true, "2100-01-01T00:00:00Z"), now: now);
Require(upcoming is { IsLive: false, IsUpcoming: true, ScheduledStart: "2100-01-01T00:00:00Z" }, "미래 방송 판정 오류");
Require(YouTubeBroadcast.ParsePlayer(Player("abcdefghijk", false, false, "2100-01-01T00:00:00Z"), now: now) is null,
    "일반 영상이 예약으로 분류됨");

var staleList = new Broadcast("abcdefghijk", "목록에만 남은 LIVE", "https://www.youtube.com/watch?v=abcdefghijk", "", null, true, false);
Require(YouTubeBroadcast.SelectCurrentLive(null, staleList, true) is null, "정상 live 응답의 목록 배지를 신뢰함");
Require(YouTubeBroadcast.SelectCurrentLive(null, staleList, false) == staleList, "네트워크 실패 대체 경로 오류");
Require(YouTubeBroadcast.SelectCurrentLive(live, staleList, true)?.Title == live!.Title, "재생기 판정 우선순위 오류");

var uploads = Enumerable.Range(0, 12).Select(i => new VideoCandidate($"A{i:0000000000}")).ToArray();
var shorts = new[] { new VideoCandidate("SH0RTS0001") };
var feed = new[] { new VideoCandidate("LIVEVIDEO01", IsLive: true), new VideoCandidate("FEEDVIDEO01") };
var streams = new[] { new VideoCandidate("LIVEVIDEO01"), new VideoCandidate("UPCOMING001", IsUpcoming: true) };
var recent = YouTubeBroadcast.SelectRecentVideos(uploads, feed, streams, shorts);
Require(recent.Select(x => x.Id).SequenceEqual(new[] { "FEEDVIDEO01", "SH0RTS0001", "A0000000000", "A0000000001",
    "A0000000002", "A0000000003", "A0000000004", "A0000000005", "A0000000006", "A0000000007" }),
    "라이브 제외 또는 네 소스 interleave 오류");
Require(YouTubeBroadcast.VideoIdFromUrl("https://www.youtube.com/watch?v=abcdefghijk") == "abcdefghijk", "YouTube URL 해석 오류");
Require(YouTubeBroadcast.VideoIdFromUrl("https://evil.example/watch?v=abcdefghijk") is null, "외부 URL 허용 오류");
Require(YouTubeBroadcast.BalancedObject("{\"text\":\"} escaped \\\" quote\"}", 0) is not null, "문자열 안 중괄호 해석 오류");

using var shortsFixture = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory,
    "fixtures", "shorts-lockup.json")));
var parsedShorts = YouTubePageParser.ParseVideos(shortsFixture.RootElement, now);
Require(parsedShorts is [{ Id: "mFM2hP5LEhM", IsLive: false, IsUpcoming: false, ViewCount: 300000 }],
    "공개 Shorts 카드 fixture 해석 오류");
Require(parsedShorts[0].Title.Length > 0 && parsedShorts[0].ThumbnailUrl.Contains("ytimg.com", StringComparison.Ordinal),
    "Shorts 제목 또는 썸네일 누락");

using var legacyFixture = JsonDocument.Parse("""
    {"contents":[
      {"videoRenderer":{"videoId":"abcdefghijk","title":{"runs":[{"text":"현재 라이브"}]},"thumbnailOverlays":[{"thumbnailOverlayTimeStatusRenderer":{"style":"LIVE"}}]}},
      {"gridVideoRenderer":{"videoId":"lmnopqrstuv","title":{"simpleText":"예약 방송"},"upcomingEventData":{"startTime":"4102444800"}}},
      {"compactVideoRenderer":{"videoId":"12345678901","title":{"simpleText":"시각 없는 카드"},"badges":[{"metadataBadgeRenderer":{"label":"UPCOMING"}}]}}
    ]}
    """);
var legacy = YouTubePageParser.ParseVideos(legacyFixture.RootElement, now);
Require(legacy.Count == 3 && legacy[0].IsLive && !legacy[0].IsUpcoming, "기존 LIVE 카드 판정 오류");
Require(legacy[1].IsUpcoming && legacy[1].ScheduledStart == "2100-01-01T00:00:00.000Z", "기존 미래 예약 카드 판정 오류");
Require(!legacy[2].IsUpcoming, "시각 없는 기존 예약 배지를 믿음");

using var lockupFixture = JsonDocument.Parse("""
    {"contents":[
      {"lockupViewModel":{"contentId":"abcdefghijk","contentType":"LOCKUP_CONTENT_TYPE_VIDEO","contentImage":{"thumbnailViewModel":{"image":{"sources":[{"url":"https://img/video.jpg","width":336}]},"overlays":[{"thumbnailBottomOverlayViewModel":{"badges":[{"thumbnailBadgeViewModel":{"text":"실시간","badgeStyle":"THUMBNAIL_OVERLAY_BADGE_STYLE_LIVE"}}]}}]}},"metadata":{"lockupMetadataViewModel":{"title":{"content":"새 라이브"},"metadata":{"contentMetadataViewModel":{"metadataRows":[{"metadataParts":[{"text":{"content":"조회수 15만회"}},{"text":{"content":"8분 전"}}]}]}}}}}},
      {"lockupViewModel":{"contentId":"lmnopqrstuv","contentType":"LOCKUP_CONTENT_TYPE_VIDEO","rendererContext":{"commandContext":{"onTap":{"innertubeCommand":{"watchEndpoint":{"startTimeSeconds":"4102444800"}}}}},"contentImage":{"thumbnailViewModel":{"overlays":[{"thumbnailBottomOverlayViewModel":{"badges":[{"thumbnailBadgeViewModel":{"text":"공개 예정","badgeStyle":"THUMBNAIL_OVERLAY_BADGE_STYLE_UPCOMING"}}]}}]}}}},
      {"lockupViewModel":{"contentId":"12345678901","contentType":"LOCKUP_CONTENT_TYPE_VIDEO","rendererContext":{"commandContext":{"onTap":{"innertubeCommand":{"watchEndpoint":{"startTimeSeconds":"1577836800"}}}}}}},
      {"lockupViewModel":{"contentId":"ZXCVBNMasdf","contentType":"LOCKUP_CONTENT_TYPE_VIDEO","contentImage":{"thumbnailViewModel":{"overlays":[{"thumbnailBottomOverlayViewModel":{"badges":[{"thumbnailBadgeViewModel":{"text":"공개 예정","badgeStyle":"THUMBNAIL_OVERLAY_BADGE_STYLE_UPCOMING"}}]}}]}}}}
    ]}
    """);
var lockups = YouTubePageParser.ParseVideos(lockupFixture.RootElement, now);
Require(lockups.Count == 4 && lockups[0] is { IsLive: true, ViewCount: 150000, PublishedText: "8분 전" },
    "새 lockup LIVE 카드 또는 조회수 해석 오류");
Require(lockups[1].IsUpcoming && lockups[1].ScheduledStart == "2100-01-01T00:00:00.000Z", "새 lockup 미래 예약 판정 오류");
Require(!lockups[2].IsUpcoming && !lockups[3].IsUpcoming, "과거 또는 시각 없는 lockup 예약 판정 오류");

using var postFixture = JsonDocument.Parse("""
    {"item":{"backstagePostRenderer":{"postId":"Ugkx-post","contentText":{"runs":[{"text":"새 소식입니다"}]},"publishedTimeText":{"simpleText":"2시간 전"}}}}
    """);
Require(YouTubePageParser.ParsePosts(postFixture.RootElement) is [{ Text: "새 소식입니다", PublishedText: "2시간 전" }],
    "게시물 카드 해석 오류");
var rss = YouTubePageParser.ParseVideoFeed("""
    <feed xmlns="http://www.w3.org/2005/Atom" xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/">
      <entry><yt:videoId>abcdefghijk</yt:videoId><title>Rock &amp; Roll</title><published>2026-07-28T10:00:00+00:00</published><media:thumbnail url="https://img.example/thumb.jpg"/></entry>
    </feed>
    """);
Require(rss is [{ Id: "abcdefghijk", Title: "Rock & Roll", PublishedAt: "2026-07-28T10:00:00+00:00" }],
    "RSS 영상 해석 오류");
Require(YouTubePageParser.ParseVideoFeed("<!DOCTYPE feed [<!ENTITY x SYSTEM 'file:///secret'>]><feed>&x;</feed>").Count == 0,
    "RSS 외부 엔터티 차단 오류");
using var metadataFixture = JsonDocument.Parse("""
    {"header":{"pageHeaderViewModel":{"metadata":[{"text":{"content":"동영상 1.6천개"}},{"text":{"content":"구독자 85.5만명"}}]}}}
    """);
var metadata = YouTubePageParser.ParseChannelMetadata(metadataFixture.RootElement);
Require(metadata is { SubscriberText: "구독자 85.5만명", SubscriberCount: 855000 }, "신규 채널 헤더 구독자 수 해석 오류");
Require(YouTubePageParser.ParseLocalizedCount("1.5M subscribers") == 1500000, "영문 구독자 수 해석 오류");
Require(YouTubePageParser.ParseLocalizedCount("비공개") is null, "비공개 구독자 수 판정 오류");

Require(YouTubeChannelInput.Normalize("UCtKtCiaWRz-d3EZn2xd1mdA").Url
    == "https://www.youtube.com/channel/UCtKtCiaWRz-d3EZn2xd1mdA", "채널 ID 정규화 오류");
Require(YouTubeChannelInput.DirectId("https://www.youtube.com/channel/UCtKtCiaWRz-d3EZn2xd1mdA")
    == "UCtKtCiaWRz-d3EZn2xd1mdA", "채널 URL 해석 오류");
Require(YouTubeChannelInput.DirectId("https://www.youtube.com/channel/UCtKtCiaWRz-d3EZn2xd1mdA/videos")
    == "UCtKtCiaWRz-d3EZn2xd1mdA", "채널 동영상 탭 URL 해석 오류");
Require(YouTubeChannelInput.DirectId("https://evil.example/channel/UCtKtCiaWRz-d3EZn2xd1mdA") is null,
    "외부 사이트 채널 URL을 허용함");
Require(YouTubeChannelInput.ExtractHandle("@sample.channel") == "@sample.channel"
    && YouTubeChannelInput.ExtractHandle("https://www.youtube.com/@sample.channel/videos") == "@sample.channel",
    "@핸들 입력 해석 오류");
Require(YouTubeChannelInput.ExtractHandle("https://evil.example/@sample.channel") is null,
    "외부 사이트 핸들을 허용함");
Require(YouTubeChannelInput.FindChannelId("<script>{\"externalId\":\"UCtKtCiaWRz-d3EZn2xd1mdA\"}</script>")
    == "UCtKtCiaWRz-d3EZn2xd1mdA", "채널 HTML ID 추출 오류");
Require(YouTubeChannelInput.FindChannelId("\"channelId\":\"UCaaaaaaaaaaaaaaaaaaaaaa\",\"externalId\":\"UCtKtCiaWRz-d3EZn2xd1mdA\"")
    == "UCtKtCiaWRz-d3EZn2xd1mdA", "HTML에서 외부 채널 ID 우선순위 오류");

var channelId = "UCtKtCiaWRz-d3EZn2xd1mdA";
var liveFailure = false;
using var handler = new FixtureHandler(request =>
{
    var path = request.RequestUri!.AbsolutePath;
    if (Uri.UnescapeDataString(path) == "/@sample.channel")
        return new HttpResponseMessage(HttpStatusCode.OK)
        { Content = new StringContent($"<script>{{\"externalId\":\"{channelId}\"}}</script>") };
    if (path.EndsWith("/live", StringComparison.Ordinal))
        return liveFailure ? new HttpResponseMessage(HttpStatusCode.ServiceUnavailable)
            : new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(Player("abcdefghijk", false, true)) };
    var body = path.EndsWith("/streams", StringComparison.Ordinal) ? $"var ytInitialData = {legacyFixture.RootElement.GetRawText()};"
        : path.EndsWith("/shorts", StringComparison.Ordinal) ? $"var ytInitialData = {shortsFixture.RootElement.GetRawText()};"
        : path.EndsWith("/videos", StringComparison.Ordinal)
            ? "var ytInitialData = {\"videoRenderer\":{\"videoId\":\"12345678901\",\"title\":{\"simpleText\":\"일반 영상\"}}};"
        : path.EndsWith("/posts", StringComparison.Ordinal) ? $"var ytInitialData = {postFixture.RootElement.GetRawText()};"
        : path.EndsWith("/feeds/videos.xml", StringComparison.Ordinal)
            ? "<feed xmlns='http://www.w3.org/2005/Atom' xmlns:yt='http://www.youtube.com/xml/schemas/2015'><entry><yt:videoId>12345678901</yt:videoId><title>피드 영상</title></entry></feed>"
        : "";
    return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(body) };
});
using var http = new HttpClient(handler);
using var client = new YouTubeSnapshotClient(http);
Require((await client.ResolveChannelInputAsync("@sample.channel")).Id == channelId,
    "공개 핸들 페이지의 채널 ID 해석 오류");
Require((await client.ResolveChannelInputAsync(channelId)).Id == channelId,
    "직접 입력한 채널 ID 해석 오류");
var snapshot = await client.FetchChannelSnapshotAsync(channelId);
Require(snapshot.Live is null, "정상 응답한 비라이브 재생기보다 목록 배지를 신뢰함");
Require(snapshot.Upcoming is [{ Id: "lmnopqrstuv" }], "스냅샷 미래 예약 목록 오류");
Require(snapshot.RecentVideos.Select(item => item.Id).SequenceEqual(new[] { "12345678901", "mFM2hP5LEhM" }),
    "스냅샷 RSS/Shorts interleave 또는 라이브 제외 오류");
Require(snapshot.LatestPost?.Id == "Ugkx-post" && snapshot.Warnings.Count == 0, "게시물 또는 성공 경고 오류");
liveFailure = true;
var fallback = await client.FetchChannelSnapshotAsync(channelId);
Require(fallback.Live?.Id == "abcdefghijk" && fallback.Warnings.Contains("현재 라이브 확인 실패 (HTTP 503)"),
    "live 네트워크 실패 시 목록 대체 경로 오류");
try
{
    await client.FetchChannelSnapshotAsync("invalid");
    throw new InvalidOperationException("잘못된 채널 ID가 허용됨");
}
catch (ArgumentException) { }

var tracking = new ChannelTrackingState(null, null, []);
var settings = new MonitorSettings(false, false, true, true);
var plannerSnapshot = snapshot with { Metadata = snapshot.Metadata with { SubscriberCount = 1210000 } };
var baseline = MonitorChangePlanner.Plan(channelId, tracking, null, settings, plannerSnapshot);
Require(baseline.Events.Count == 0 && baseline.Notifications.Count == 0 && baseline.UrlsToOpen.Count == 0,
    "첫 조회가 기존 영상/게시물을 알림으로 처리함");
Require(baseline.NextTrackingState.SeenVideoIds?.Count == plannerSnapshot.RecentVideos.Count
    && baseline.NextTrackingState.SeenPostIds?.Count == plannerSnapshot.RecentPosts.Count,
    "첫 조회 기준선 저장 오류");
Require(baseline.SubscriberSampleToAppend is { Count: 1210000 }, "첫 구독자 관측 기록 누락");

var newVideo = new VideoCandidate("NEWVIDEO001", Title: "새 영상", Url: "https://www.youtube.com/watch?v=NEWVIDEO001");
var newPost = new YouTubePageParser.CommunityPost("new-post", "새 글", "지금", "https://www.youtube.com/post/new-post", "");
var changed = plannerSnapshot with
{
    RecentVideos = new[] { newVideo }.Concat(plannerSnapshot.RecentVideos).ToArray(),
    LatestVideo = newVideo,
    RecentPosts = new[] { newPost }.Concat(plannerSnapshot.RecentPosts).ToArray(),
    LatestPost = newPost,
    CheckedAt = plannerSnapshot.CheckedAt.AddMinutes(1)
};
var newContent = MonitorChangePlanner.Plan(channelId, baseline.NextTrackingState,
    baseline.SubscriberSampleToAppend, settings, changed);
Require(newContent.Events.Select(item => item.SourceId).SequenceEqual(new[] { "NEWVIDEO001", "new-post" })
    && newContent.Notifications.Count == 2, "신규 영상/게시물 감지 오류");
Require(newContent.SubscriberSampleToAppend is null, "변화 없는 구독자 수를 매 회 기록함");
var reordered = changed with { RecentVideos = changed.RecentVideos.Reverse().ToArray() };
var repeatContent = MonitorChangePlanner.Plan(channelId, newContent.NextTrackingState,
    baseline.SubscriberSampleToAppend, settings, reordered);
Require(repeatContent.Events.Count == 0 && repeatContent.Notifications.Count == 0,
    "목록 재정렬 또는 재확인에서 중복 알림 발생");

var broadcastSnapshot = plannerSnapshot with
{
    Live = new Broadcast("abcdefghijk", "현재 라이브", "https://www.youtube.com/watch?v=abcdefghijk", "", null, true, false),
    Upcoming = [new Broadcast("lmnopqrstuv", "예약 방송", "https://www.youtube.com/watch?v=lmnopqrstuv",
        "", "2100-01-01T00:00:00Z", false, true)]
};
var broadcastSettings = new MonitorSettings(true, true, false, false);
var broadcastPlan = MonitorChangePlanner.Plan(channelId, baseline.NextTrackingState,
    baseline.SubscriberSampleToAppend, broadcastSettings, broadcastSnapshot);
Require(broadcastPlan.UrlsToOpen.Count == 2 && broadcastPlan.Notifications.Count == 2
    && broadcastPlan.NextTrackingState.OpenedBroadcastIds.SequenceEqual(new[] { "live:abcdefghijk", "upcoming:lmnopqrstuv" }),
    "라이브/예약 방송 일회성 열기 계획 오류");
var broadcastReplay = MonitorChangePlanner.Plan(channelId, broadcastPlan.NextTrackingState,
    baseline.SubscriberSampleToAppend, broadcastSettings, broadcastSnapshot);
Require(broadcastReplay.UrlsToOpen.Count == 0 && broadcastReplay.Events.Count == 0,
    "이미 연 방송을 반복해서 열도록 계획함");
var heartbeat = MonitorChangePlanner.Plan(channelId, broadcastPlan.NextTrackingState,
    baseline.SubscriberSampleToAppend, broadcastSettings, broadcastSnapshot with
    { CheckedAt = plannerSnapshot.CheckedAt.AddHours(6) });
Require(heartbeat.SubscriberSampleToAppend is { Count: 1210000 }, "6시간 구독자 heartbeat 누락");
Console.WriteLine("CORE_TESTS_PASSED");

sealed class FixtureHandler(Func<HttpRequestMessage, HttpResponseMessage> handle) : HttpMessageHandler
{
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        => Task.FromResult(handle(request));
}
