using System.Text.Json;
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
Console.WriteLine("CORE_TESTS_PASSED");
