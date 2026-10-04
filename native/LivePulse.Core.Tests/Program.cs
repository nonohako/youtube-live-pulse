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
var watchStats = "var ytInitialPlayerResponse = " + JsonSerializer.Serialize(new
{
    playabilityStatus = new { status = "OK" },
    videoDetails = new { videoId = "abcdefghijk", title = "영상", viewCount = "1234",
        thumbnail = new { thumbnails = new[] { new { url = "https://img/large.jpg", width = 320 } } } },
    microformat = new { playerMicroformatRenderer = new { publishDate = "2026-09-01" } }
}) + ";";
Require(YouTubeBroadcast.ParseVideoStatistics(watchStats) is
    { Id: "abcdefghijk", ViewCount: 1234, PublishedAt: "2026-09-01" },
    "공개 시청 페이지 조회수 또는 게시일 파싱 오류");
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
var allFailure = false;
var feedFailure = false;
var premiereLive = false;
using var handler = new FixtureHandler(request =>
{
    if (allFailure) return new HttpResponseMessage(HttpStatusCode.ServiceUnavailable);
    var path = request.RequestUri!.AbsolutePath;
    if (feedFailure && path.EndsWith("/feeds/videos.xml", StringComparison.Ordinal))
        return new HttpResponseMessage(HttpStatusCode.NotFound);
    if (Uri.UnescapeDataString(path) == "/@sample.channel")
        return new HttpResponseMessage(HttpStatusCode.OK)
        { Content = new StringContent($"<script>{{\"externalId\":\"{channelId}\"}}</script>") };
    if (premiereLive && path == "/watch" && request.RequestUri.Query == "?v=abcdefghijk")
        return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(Player("abcdefghijk", true, false)) };
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
premiereLive = true;
var premiere = await client.FetchChannelSnapshotAsync(channelId);
Require(premiere.Live?.Id == "abcdefghijk", "/live에 없는 진행 중 최초공개를 놓침");
premiereLive = false;
feedFailure = true;
var feedDown = await client.FetchChannelSnapshotAsync(channelId);
Require(feedDown.Warnings.Count == 0 && feedDown.RecentVideos.Any(item => item.Id == "mFM2hP5LEhM"),
    "영상 목록이 정상인데 RSS 404를 경고로 표시함");
feedFailure = false;
liveFailure = true;
var fallback = await client.FetchChannelSnapshotAsync(channelId);
Require(fallback.Live?.Id == "abcdefghijk" && fallback.Warnings.Contains("현재 라이브 확인 실패 (HTTP 503)"),
    "live 네트워크 실패 시 목록 대체 경로 오류");
allFailure = true;
var unavailable = await client.FetchChannelSnapshotAsync(channelId);
Require(unavailable.SuccessfulSourceCount == 0 && unavailable.Warnings.Count == 6,
    "모든 공개 소스 실패를 사용 가능한 스냅샷으로 취급함");
allFailure = false;
try
{
    await client.FetchChannelSnapshotAsync("invalid");
    throw new InvalidOperationException("잘못된 채널 ID가 허용됨");
}
catch (ArgumentException) { }

var tracking = new ChannelTrackingState(null, null, []);
var settings = new MonitorSettings(false, false, true, true);
var emptySnapshot = snapshot with { RecentVideos = [], RecentPosts = [], LatestVideo = null, LatestPost = null };
var emptyBaseline = MonitorChangePlanner.Plan(channelId, tracking, null, settings, emptySnapshot);
Require(emptyBaseline.NextTrackingState.SeenVideoIds is null && emptyBaseline.NextTrackingState.SeenPostIds is null,
    "빈 첫 조회에서 콘텐츠 기준선을 초기화함");
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

// Optional YouTube Data API enrichment (Electron parity). The key must never reach messages.
const string apiKey = "TEST-API-KEY-0123456789";
var apiRequests = new List<string>();
var apiFails = false;
using var apiHandler = new FixtureHandler(request =>
{
    var uri = request.RequestUri!;
    if (uri.Host == "www.googleapis.com")
    {
        apiRequests.Add(uri.AbsolutePath + uri.Query);
        if (apiFails) return new HttpResponseMessage(HttpStatusCode.Forbidden)
        { Content = new StringContent("{\"error\":{\"message\":\"quota exceeded\"}}") };
        var json = uri.AbsolutePath.EndsWith("/channels") && uri.Query.Contains("forHandle")
            ? $"{{\"items\":[{{\"id\":\"{channelId}\"}}]}}"
            : uri.AbsolutePath.EndsWith("/channels")
            ? "{\"items\":[{\"snippet\":{\"title\":\"공식 채널\",\"thumbnails\":{\"high\":{\"url\":\"https://img/api.jpg\",\"width\":800}}},\"statistics\":{\"subscriberCount\":\"1220000\"}}]}"
            : "{\"items\":[{\"id\":\"12345678901\",\"snippet\":{\"title\":\"API 영상\",\"publishedAt\":\"2026-09-01T00:00:00Z\"},\"statistics\":{\"viewCount\":\"4321\"}}]}";
        return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(json) };
    }
    if (uri.AbsolutePath == "/watch")
    {
        var id = uri.Query[3..];
        var player = new { playabilityStatus = new { status = "OK" }, videoDetails = new { videoId = id, title = "페이지 영상", viewCount = "77" } };
        return new HttpResponseMessage(HttpStatusCode.OK)
        { Content = new StringContent($"var ytInitialPlayerResponse = {JsonSerializer.Serialize(player)};") };
    }
    return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("") };
});
using var apiHttp = new HttpClient(apiHandler);
using var apiClient = new YouTubeSnapshotClient(apiHttp) { ApiKey = apiKey };
Require((await apiClient.ResolveChannelInputAsync("@api.handle")).Id == channelId && apiRequests.Count == 1,
    "API 핸들 해석 오류");
var apiSnapshot = await apiClient.FetchChannelSnapshotAsync(channelId);
Require(apiSnapshot.Metadata is { Title: "공식 채널", SubscriberCount: 1220000, SubscriberText: "122만", Source: "api",
    AvatarUrl: "https://img/api.jpg" }, "공식 채널 통계 병합 오류");
var cachedRequests = apiRequests.Count;
Require((await apiClient.FetchChannelSnapshotAsync(channelId)).Metadata.Source == "api" && apiRequests.Count == cachedRequests,
    "10분 안에 공식 채널 통계를 다시 요청하거나 캐시를 버림");
apiClient.ExpireOfficialMetadata();
await apiClient.FetchChannelSnapshotAsync(channelId);
Require(apiRequests.Count == cachedRequests + 1, "수동 새로고침이 공식 통계를 다시 요청하지 않음");
var apiVideos = await apiClient.FetchVideoStatisticsAsync(["12345678901", "abcdefghijk"]);
Require(apiVideos.Count == 2 && apiVideos.Single(item => item.Id == "12345678901") is { ViewCount: 4321, Source: "api" }
    && apiVideos.Single(item => item.Id == "abcdefghijk") is { ViewCount: 77, Source: "page" },
    "공식 영상 통계 또는 누락 영상의 공개 페이지 대체 오류");
apiFails = true;
apiClient.ExpireOfficialMetadata();
var degraded = await apiClient.FetchChannelSnapshotAsync(channelId);
Require(degraded.Warnings.Any(item => item.Contains("quota exceeded")) && degraded.Metadata.Title == "공식 채널"
    && degraded.Warnings.All(item => !item.Contains(apiKey)), "API 실패 경고 또는 이전 공식 정보 유지 오류");
Require((await apiClient.FetchVideoStatisticsAsync(["12345678901"])) is [{ ViewCount: 77, Source: "page" }],
    "API 실패 시 공개 페이지 조회수로 대체하지 않음");
apiClient.ApiKey = "";
var withoutKey = apiRequests.Count;
Require((await apiClient.FetchChannelSnapshotAsync(channelId)).Metadata.Source == "page" && apiRequests.Count == withoutKey,
    "API 키 삭제 후에도 API를 사용함");
Require(YouTubeDataApi.FormatCompact(999) == "999" && YouTubeDataApi.FormatCompact(1234) == "1.23천"
    && YouTubeDataApi.FormatCompact(123456789) == "1.23억", "한국어 축약 숫자 오류");

// Old items resurfacing in a list are marked seen without a "new" alert.
Require(MonitorChangePlanner.IsOldContent(now.AddDays(-3), null, now)
    && !MonitorChangePlanner.IsOldContent(now.AddDays(-1), "3개월 전", now)
    && MonitorChangePlanner.IsOldContent(null, "3개월 전", now)
    && MonitorChangePlanner.IsOldContent(null, "스트리밍 시간: 2주 전", now)
    && MonitorChangePlanner.IsOldContent(null, "5 days ago", now)
    && !MonitorChangePlanner.IsOldContent(null, "2일 전", now)
    && !MonitorChangePlanner.IsOldContent(null, "3시간 전", now)
    && !MonitorChangePlanner.IsOldContent(null, "", now), "옛 콘텐츠 판별 규칙 오류");
var resurfaced = new VideoCandidate("OLDVIDEO001", Title: "옛 영상", PublishedText: "3개월 전");
var cloudOld = new VideoCandidate("CLOUDOLD001", Title: "클라우드 기록상 옛 영상");
var fresh = new VideoCandidate("FRESHVIDEO1", Title: "새 영상", PublishedAt: plannerSnapshot.CheckedAt.AddMinutes(-3).ToString("O"));
var staleCheck = MonitorChangePlanner.Plan(channelId, baseline.NextTrackingState, baseline.SubscriberSampleToAppend, settings,
    plannerSnapshot with { RecentVideos = new[] { fresh, resurfaced, cloudOld }.Concat(plannerSnapshot.RecentVideos).ToArray() },
    new Dictionary<string, DateTimeOffset> { ["CLOUDOLD001"] = plannerSnapshot.CheckedAt.AddDays(-80) });
Require(staleCheck.Events.Select(item => item.SourceId).SequenceEqual(new[] { "FRESHVIDEO1" })
    && staleCheck.NextTrackingState.SeenVideoIds!.Contains("OLDVIDEO001")
    && staleCheck.NextTrackingState.SeenVideoIds!.Contains("CLOUDOLD001"),
    "옛 영상을 새 영상으로 알리거나 확인한 목록에서 빠뜨림");
var oldPost = new YouTubePageParser.CommunityPost("old-post", "옛 글", "1개월 전", "https://www.youtube.com/post/old-post", "");
Require(MonitorChangePlanner.Plan(channelId, baseline.NextTrackingState, baseline.SubscriberSampleToAppend, settings,
    plannerSnapshot with { RecentPosts = new[] { oldPost }.Concat(plannerSnapshot.RecentPosts).ToArray() }).Events.Count == 0,
    "옛 게시물을 새 게시물로 알림");
Console.WriteLine("CORE_TESTS_PASSED");

sealed class FixtureHandler(Func<HttpRequestMessage, HttpResponseMessage> handle) : HttpMessageHandler
{
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        => Task.FromResult(handle(request));
}
