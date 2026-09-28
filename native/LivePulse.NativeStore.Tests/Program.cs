using System.Diagnostics;
using System.IO.Compression;
using System.Net;
using System.Reflection;
using System.Text.Json;
using LivePulse.Core;
using LivePulse.DataMigration;
using LivePulse.NativeStore;
using Microsoft.Data.Sqlite;

static void Require(bool condition, string message)
{
    if (!condition) throw new InvalidOperationException(message);
}

static void ExpectFailure(Action action, string message)
{
    try { action(); }
    catch (Exception error) when (error is InvalidOperationException or InvalidDataException or KeyNotFoundException or SqliteException or IOException)
    {
        return;
    }
    throw new InvalidOperationException(message);
}

static void ExpectInvalidData(Action action, string message)
{
    try { action(); }
    catch (InvalidDataException) { return; }
    throw new InvalidOperationException(message);
}

// Storage version 2 keeps every observation in one table; map the version 1 table names.
static long ImportedCount(string database)
{
    using var connection = new SqliteConnection(new SqliteConnectionStringBuilder
        { DataSource = database, Mode = SqliteOpenMode.ReadOnly, Pooling = false }.ToString());
    connection.Open();
    return Count(connection, "samples");
}

static void AddCloudObservation(SqliteConnection connection, SqliteTransaction? transaction, string channel,
    string kind, string video, DateTimeOffset at, long count)
{
    using var command = connection.CreateCommand();
    command.Transaction = transaction;
    command.CommandText = """
        INSERT OR IGNORE INTO series_keys(source,channel_id,kind,video_id) VALUES('runtime-cloud',$channel,$kind,$video);
        INSERT OR REPLACE INTO observations(series,at,count) SELECT id,$at,$count FROM series_keys
        WHERE source='runtime-cloud' AND channel_id=$channel AND kind=$kind AND video_id=$video;
        """;
    command.Parameters.AddWithValue("$channel", channel);
    command.Parameters.AddWithValue("$kind", kind);
    command.Parameters.AddWithValue("$video", video);
    command.Parameters.AddWithValue("$at", at.ToUnixTimeMilliseconds());
    command.Parameters.AddWithValue("$count", count);
    command.ExecuteNonQuery();
}

static long Count(SqliteConnection connection, string table)
{
    using var command = connection.CreateCommand();
    using (var probe = connection.CreateCommand())
    {
        probe.CommandText = "SELECT 1 FROM sqlite_master WHERE name='observations'";
        var filter = probe.ExecuteScalar() is null ? null : table switch
        {
            "samples" => "k.source IN ('local','cloud')",
            "runtime_subscriber_samples" => "k.source='runtime-local' AND k.kind='subscriber'",
            "runtime_video_samples" => "k.source='runtime-local' AND k.kind='video'",
            "runtime_cloud_samples" => "k.source='runtime-cloud'",
            _ => null
        };
        if (filter is not null)
        {
            command.CommandText = $"SELECT COUNT(*) FROM observations o JOIN series_keys k ON k.id=o.series WHERE {filter}";
            return (long)command.ExecuteScalar()!;
        }
    }
    command.CommandText = $"SELECT COUNT(*) FROM {table}";
    return (long)command.ExecuteScalar()!;
}

if (args is ["--hold-lease", var leaseDatabase])
{
    using var lease = NativeStoreLease.Acquire(leaseDatabase);
    Console.WriteLine("NATIVE_LEASE_HELD");
    Console.ReadLine();
    return;
}

if (args is ["--probe", var explicitDatabase])
{
    var probe = new NativeMonitorStore(explicitDatabase);
    using var connection = new SqliteConnection(new SqliteConnectionStringBuilder
    { DataSource = Path.GetFullPath(explicitDatabase), Mode = SqliteOpenMode.ReadOnly }.ToString());
    connection.Open();
    using var channelIds = connection.CreateCommand();
    channelIds.CommandText = "SELECT id FROM channels";
    var ids = new List<string>();
    using (var reader = channelIds.ExecuteReader())
        while (reader.Read()) ids.Add(reader.GetString(0));
    var revisions = ids.Select(id => probe.Load(id).Revision).ToArray();
    var configuration = probe.ReadPollConfiguration();
    var videoRows = Count(connection, "runtime_video_samples");
    Require(configuration.ChannelIds.Count == ids.Count
        && configuration.ChannelIds.ToHashSet(StringComparer.Ordinal).SetEquals(ids)
        && configuration.Interval >= TimeSpan.FromSeconds(15)
        && configuration.Interval <= TimeSpan.FromSeconds(300),
        "격리 데이터의 감시 채널 또는 간격을 읽지 못함");
    Console.WriteLine($"NATIVE_STORE_PROBE_PASSED channels={ids.Count} intervalSeconds={configuration.Interval.TotalSeconds} "
        + $"minRevision={(revisions.Length == 0 ? 0 : revisions.Min())} "
        + $"maxRevision={(revisions.Length == 0 ? 0 : revisions.Max())} videoSamples={videoRows}");
    return;
}

if (args is ["--backup-probe", var explicitSource, var explicitDatabaseCopy])
{
    if (File.Exists(explicitDatabaseCopy + ".bak.1") || File.Exists(explicitDatabaseCopy + ".bak.2"))
        throw new InvalidOperationException("백업 증명 경로에 이미 백업이 있습니다.");
    _ = new NativeMonitorStore(explicitDatabaseCopy);
    NativeStoreRecovery.CreateBackup(explicitDatabaseCopy);
    var primarySummary = StoreImporter.Verify(explicitSource, explicitDatabaseCopy);
    var backupSummary = StoreImporter.Verify(explicitSource, explicitDatabaseCopy + ".bak.1");
    Require(primarySummary.Channels == backupSummary.Channels && primarySummary.Series == backupSummary.Series
        && primarySummary.Samples == backupSummary.Samples && primarySummary.SourceSha256 == backupSummary.SourceSha256,
        "대용량 백업의 원본 표본 검증 결과가 다름");
    Console.WriteLine($"NATIVE_BACKUP_PROBE_PASSED channels={backupSummary.Channels} series={backupSummary.Series} samples={backupSummary.Samples}");
    return;
}

var folder = Path.Combine(Path.GetTempPath(), "LivePulseNativeStoreTest-" + Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(folder);
var database = Path.Combine(folder, "isolated.sqlite");
const string channelId = "UCtKtCiaWRz-d3EZn2xd1mdA";
using (var connection = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = database }.ToString()))
{
    connection.Open();
    using var setup = connection.CreateCommand();
    setup.CommandText = """
        CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE channels(id TEXT PRIMARY KEY,metadata_json TEXT NOT NULL);
        CREATE TABLE series(source TEXT,channel_id TEXT,kind TEXT,video_id TEXT,sample_count INTEGER,sample_sha256 TEXT);
        CREATE TABLE samples(source TEXT,channel_id TEXT,kind TEXT,video_id TEXT,ordinal INTEGER,at TEXT,count INTEGER,payload_json TEXT);
        INSERT INTO meta VALUES('migration_complete','1');
        INSERT INTO meta VALUES('source_sha256',$hash);
        INSERT INTO meta VALUES('events','[{"channelId":"UCtKtCiaWRz-d3EZn2xd1mdA","type":"video","sourceId":"old-video"}]');
        INSERT INTO channels VALUES('UCtKtCiaWRz-d3EZn2xd1mdA',
          '{"id":"UCtKtCiaWRz-d3EZn2xd1mdA","openedBroadcastIds":["live:old-live"],"title":"Original"}');
        INSERT INTO series VALUES('local','UCtKtCiaWRz-d3EZn2xd1mdA','subscriber','',1,'ORIGINAL_SAMPLE_HASH');
        INSERT INTO samples VALUES('local','UCtKtCiaWRz-d3EZn2xd1mdA','subscriber','',0,
          '2026-09-01T00:00:00.000Z',100,'{"at":"2026-09-01T00:00:00.000Z","count":100}');
        """;
    setup.Parameters.AddWithValue("$hash", new string('A', 64));
    setup.ExecuteNonQuery();
}

var store = new NativeMonitorStore(database);
var initial = store.Load(channelId);
Require(initial.Revision == 0 && initial.Tracking.SeenVideoIds is null && initial.Tracking.SeenPostIds is null,
    "이전 채널의 첫 조회 기준선 상태 오류");
Require(initial.Tracking.OpenedBroadcastIds.SequenceEqual(new[] { "live:old-live" })
    && initial.LastSubscriberSample?.Count == 100, "기존 방송 키 또는 구독자 표본을 읽지 못함");

var firstVideo = new VideoCandidate("abcdefghijk", Title: "첫 영상", Url: "https://www.youtube.com/watch?v=abcdefghijk");
var live = new Broadcast("lmnopqrstuv", "라이브", "https://www.youtube.com/watch?v=lmnopqrstuv",
    "", null, true, false);
var checkedAt = new DateTimeOffset(2026, 9, 24, 1, 0, 0, TimeSpan.Zero);
var metadata = new YouTubePageParser.ChannelMetadata("Channel", "", "100", 100);
var snapshot = new YouTubeSnapshot(checkedAt, metadata, live, [], firstVideo, null,
    [firstVideo], [], []);
var settings = new MonitorSettings(true, true, true, true);
var firstPlan = MonitorChangePlanner.Plan(channelId, initial.Tracking, initial.LastSubscriberSample, settings, snapshot);
Require(firstPlan.Events is [{ Type: "live" }] && firstPlan.SubscriberSampleToAppend is { Count: 100 },
    "첫 조회 기준선 또는 6시간 구독자 heartbeat 판정 오류");
Require(store.Commit(channelId, initial.Revision, snapshot, firstPlan) == 1, "첫 저장 리비전 오류");

store = new NativeMonitorStore(database);
var afterRestart = store.Load(channelId);
Require(afterRestart.Revision == 1 && afterRestart.Tracking.SeenVideoIds?.SequenceEqual(new[] { "abcdefghijk" }) == true
    && afterRestart.Tracking.OpenedBroadcastIds.SequenceEqual(new[] { "live:old-live", "live:lmnopqrstuv" }),
    "재시작 후 기준선 또는 열린 방송 키가 사라짐");
var replay = MonitorChangePlanner.Plan(channelId, afterRestart.Tracking, afterRestart.LastSubscriberSample,
    settings, snapshot);
Require(replay.Events.Count == 0 && replay.UrlsToOpen.Count == 0, "재시작 후 라이브를 다시 열도록 계획함");

var nextVideo = new VideoCandidate("12345678901", Title: "새 영상", Url: "https://www.youtube.com/watch?v=12345678901");
var changed = snapshot with
{
    CheckedAt = checkedAt.AddMinutes(1),
    Metadata = metadata with { SubscriberCount = 101 },
    LatestVideo = nextVideo,
    RecentVideos = [nextVideo, firstVideo]
};
var secondPlan = MonitorChangePlanner.Plan(channelId, afterRestart.Tracking,
    afterRestart.LastSubscriberSample, settings, changed);
Require(secondPlan.Events is [{ Type: "video", SourceId: "12345678901" }]
    && secondPlan.SubscriberSampleToAppend is { Count: 101 }, "새 영상/구독자 표본 판정 오류");
Require(store.Commit(channelId, afterRestart.Revision, changed, secondPlan) == 2, "두 번째 저장 리비전 오류");

var afterSecond = store.Load(channelId);
Require(afterSecond.Revision == 2 && afterSecond.LastSubscriberSample is { Count: 101 },
    "런타임 구독자 표본 재조회 오류");
ExpectFailure(() => store.Commit(channelId, 1, changed, secondPlan), "낡은 리비전을 덮어씀");
var invalidPlan = secondPlan with
{
    Events = [new MonitorEvent("OTHER_CHANNEL", "video", "bad", "", "", "")]
};
ExpectFailure(() => store.Commit(channelId, 2, changed, invalidPlan), "잘못된 채널 이벤트를 저장함");
Require(store.Load(channelId).Revision == 2, "실패한 트랜잭션이 상태를 일부 저장함");

using (var connection = new SqliteConnection(new SqliteConnectionStringBuilder
{ DataSource = database, Mode = SqliteOpenMode.ReadOnly }.ToString()))
{
    connection.Open();
    Require(Count(connection, "samples") == 1 && Count(connection, "runtime_subscriber_samples") == 2,
        "이전 원본 표본을 수정하거나 새 표본을 중복 저장함");
    Require(Count(connection, "runtime_events") == 2, "런타임 이벤트 누락 또는 중복");
    using var original = connection.CreateCommand();
    original.CommandText = "SELECT sample_sha256 FROM series LIMIT 1";
    Require((string?)original.ExecuteScalar() == "ORIGINAL_SAMPLE_HASH", "이전 원본 시리즈 해시가 바뀜");
}

var invalidDb = Path.Combine(folder, "incomplete.sqlite");
using (var connection = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = invalidDb }.ToString()))
{
    connection.Open();
    using var command = connection.CreateCommand();
    command.CommandText = "CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); INSERT INTO meta VALUES('migration_complete','0')";
    command.ExecuteNonQuery();
}
ExpectFailure(() => new NativeMonitorStore(invalidDb), "미완료 이전 DB를 쓰기 가능으로 열었음");
using (var connection = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = invalidDb }.ToString()))
{
    connection.Open();
    using var command = connection.CreateCommand();
    command.CommandText = "UPDATE meta SET value='1' WHERE key='migration_complete'";
    command.ExecuteNonQuery();
}
ExpectFailure(() => new NativeMonitorStore(invalidDb), "원본 해시가 없는 DB를 쓰기 가능으로 열었음");

var source = Path.Combine(folder, "source.json");
var importedDb = Path.Combine(folder, "imported.sqlite");
File.WriteAllText(source, """
    {
      "version": 3,
      "settings": {"pollIntervalSeconds": 30},
      "events": [],
      "channels": [{
        "id": "UCtKtCiaWRz-d3EZn2xd1mdA", "title": "Imported",
        "openedBroadcastIds": ["live:old-live"],
        "subscriberHistory": [{"at":"2026-09-01T00:00:00.000Z","count":100}],
        "videoViewHistories": []
      }]
    }
    """);
Require(StoreImporter.Import(source, importedDb).Samples == 1, "실제 이전 도구 fixture 생성 오류");
var importedStore = new NativeMonitorStore(importedDb);
var importedState = importedStore.Load(channelId);
Require(importedState.Revision == 0 && importedState.LastSubscriberSample?.Count == 100,
    "실제 이전 도구 DB를 런타임 저장소가 읽지 못함");
var importedPlan = MonitorChangePlanner.Plan(channelId, importedState.Tracking,
    importedState.LastSubscriberSample, settings, snapshot);
Require(importedStore.Commit(channelId, 0, snapshot, importedPlan) == 1,
    "실제 이전 도구 DB에 런타임 상태를 기록하지 못함");
Require(ImportedCount(importedDb) == 1,
    "런타임 저장 후 원본 이전 표본 검증이 깨짐");
Require(new NativeMonitorStore(importedDb).Load(channelId).Revision == 1,
    "실제 이전 도구 DB의 런타임 상태가 재시작 후 사라짐");
var runnerDb = Path.Combine(folder, "runner.sqlite");
StoreImporter.Import(source, runnerDb);
var runnerStore = new NativeMonitorStore(runnerDb);
var fakeEffects = new RecordingEffects(() => runnerStore.Load(channelId).Revision) { FailNotifications = true };
var runner = new NativeMonitorRunner(runnerStore, new FixtureSnapshotSource(snapshot), fakeEffects);
var firstRun = await runner.RunChannelOnceAsync(channelId, settings);
Require(firstRun.SavedRevision == 1 && firstRun.EventsPlanned == 1 && firstRun.NotificationsPlanned == 1
    && firstRun.UrlsPlanned == 1 && firstRun.EffectErrors.Count == 1,
    "감시 실행의 저장·효과 계획 오류");
var effectState = new NativeStateReader(runnerDb).Read(monitorSweep:
    new MonitorSweepResult(checkedAt, [firstRun], []))["channels"]![0]!;
Require(effectState["status"]!.GetValue<string>() == "degraded"
    && effectState["error"]!.GetValue<string>().Contains("알림 실패")
    && effectState["snapshot"]!["live"] is not null
    && effectState["snapshot"]!["warnings"]!.AsArray().Count == 0,
    "알림 실패를 숨기거나 정상 수집된 LIVE를 제거하거나 자동 재시도를 약속함");
Require(fakeEffects.RevisionsObserved.SequenceEqual(new long[] { 1, 1 }) && fakeEffects.OpenedUrls.Count == 1,
    "SQLite 커밋 전에 알림 또는 URL 열기를 시도함");
var secondRun = await runner.RunChannelOnceAsync(channelId, settings);
Require(secondRun.SavedRevision == 2 && secondRun.EventsPlanned == 0 && secondRun.NotificationsPlanned == 0
    && secondRun.UrlsPlanned == 0 && fakeEffects.OpenedUrls.Count == 1,
    "알림 오류 이후 재확인에서 방송을 다시 열도록 계획함");
var allFailedRunner = new NativeMonitorRunner(runnerStore,
    new FixtureSnapshotSource(snapshot with { SuccessfulSourceCount = 0 }), fakeEffects);
ExpectFailure(() => allFailedRunner.RunChannelOnceAsync(channelId, settings).GetAwaiter().GetResult(),
    "모든 공개 소스 실패를 저장함");
Require(runnerStore.Load(channelId).Revision == 2 && fakeEffects.OpenedUrls.Count == 1,
    "모든 공개 소스 실패 후 저장 상태 또는 열기 효과가 바뀜");
Require(ImportedCount(runnerDb) == 1,
    "감시 실행이 이전 원본 표본을 변경함");

var videoStatsDb = Path.Combine(folder, "video-stats.sqlite");
StoreImporter.Import(source, videoStatsDb);
var videoStore = new NativeMonitorStore(videoStatsDb);
var videoInitial = videoStore.Load(channelId);
var videoPlan = MonitorChangePlanner.Plan(channelId, videoInitial.Tracking,
    videoInitial.LastSubscriberSample, settings, snapshot);
var recordedVideo = firstVideo with { ViewCount = 400 };
videoStore.Commit(channelId, videoInitial.Revision, snapshot, videoPlan, [recordedVideo], checkedAt);
Require(!videoStore.NeedsVideoStatistics(channelId, checkedAt.AddMinutes(4))
    && videoStore.NeedsVideoStatistics(channelId, checkedAt.AddMinutes(5))
    && new NativeStateReader(videoStatsDb).Read()["channels"]![0]!["videoViewHistories"]![0]!["samples"]!.AsArray().Count == 1,
    "영상 조회수 첫 기록 또는 5분 수집 간격 오류");
var videoNext = videoStore.Load(channelId);
var videoPlan2 = MonitorChangePlanner.Plan(channelId, videoNext.Tracking,
    videoNext.LastSubscriberSample, settings, snapshot with { CheckedAt = checkedAt.AddMinutes(5) });
videoStore.Commit(channelId, videoNext.Revision, snapshot with { CheckedAt = checkedAt.AddMinutes(5) },
    videoPlan2, [recordedVideo with { ViewCount = 401 }], checkedAt.AddMinutes(5));
var videoThird = videoStore.Load(channelId);
var thirdAt = checkedAt.AddMinutes(10);
var videoPlan3 = MonitorChangePlanner.Plan(channelId, videoThird.Tracking,
    videoThird.LastSubscriberSample, settings, snapshot with { CheckedAt = thirdAt });
videoStore.Commit(channelId, videoThird.Revision, snapshot with { CheckedAt = thirdAt },
    videoPlan3, [recordedVideo with { ViewCount = 402 }], thirdAt);
var overviewVideoSamples = new NativeStateReader(videoStatsDb).Read()
    ["channels"]![0]!["videoViewHistories"]![0]!["samples"]!.AsArray();
Require(overviewVideoSamples.Count == 2
    && overviewVideoSamples[0]!["count"]!.GetValue<long>() == 400
    && overviewVideoSamples[1]!["count"]!.GetValue<long>() == 402
    && new NativeStateReader(videoStatsDb).Read(channelId, [(channelId, firstVideo.Id)])
        ["channels"]![0]!["videoViewHistories"]![0]!["samples"]!.AsArray().Count == 3
    && ImportedCount(videoStatsDb) == 1,
    "영상 요약 양끝점·상세 전체 기록 또는 이전 원본 보존 오류");

var cloudSource = Path.Combine(folder, "cloud-source.json");
var cloudDb = Path.Combine(folder, "cloud.sqlite");
File.WriteAllText(cloudSource, """
    {
      "version": 3,
      "settings": {
        "pollIntervalSeconds": 30,
        "cloudUrl": "https://pulse-test.fly.dev",
        "cloudToken": "tttttttttttttttttttttttttttttttt"
      },
      "events": [],
      "channels": [{
        "id": "UCtKtCiaWRz-d3EZn2xd1mdA", "title": "Cloud fixture",
        "subscriberHistory": [{"at":"2026-09-01T00:00:00.000Z","count":100}],
        "videoViewHistories": []
      }],
      "cloud": {
        "endpoint": "https://pulse-test.fly.dev", "archiveVersion": 2, "cursor": 1,
        "channels": {
          "UCtKtCiaWRz-d3EZn2xd1mdA": {
            "subscriberHistory": [{"at":"2026-09-02T00:00:00.000Z","count":101}],
            "videoViewHistories": []
          }
        }
      }
    }
    """);
Require(StoreImporter.Import(cloudSource, cloudDb).Samples == 2,
    "클라우드 원본 fixture 이전 실패");
var cloudAt1 = DateTimeOffset.UtcNow.AddMinutes(-3).ToUnixTimeMilliseconds();
var cloudAt2 = cloudAt1 + 60_000;
string CloudPage(long at, bool hasMore) => JsonSerializer.Serialize(new
{
    version = 1, next = at, hasMore,
    samples = new[] { new { at, channels = new[] {
        new { id = channelId, subscriberCount = 150L,
            views = new Dictionary<string, long> { ["abcdefghijk"] = 400 } }
    } } },
    status = new { lastSuccessAt = DateTimeOffset.UtcNow.ToString("O"), error = (string?)null }
});
var cloudHandler = new CloudFixtureHandler([CloudPage(cloudAt1, true), CloudPage(cloudAt2, false)]);
using (var client = new HttpClient(cloudHandler))
{
    var cloudCheckpoint = new NativeBackupCheckpoint(cloudDb);
    var cloudSync = new NativeCloudSync(cloudDb, client, cloudCheckpoint);
    var cloudResult = await cloudSync.SyncOnceAsync();
    Require(cloudResult is { Configured: true, Pages: 2, Observations: 4 }
        && cloudResult.Cursor == cloudAt2 && cloudCheckpoint.BackupCount == 1
        && cloudHandler.Cursors.SequenceEqual(new long[] { 1, cloudAt1 }),
        "클라우드 두 페이지 다운로드·커서·백업 오류");
}
using (var connection = new SqliteConnection(new SqliteConnectionStringBuilder
{ DataSource = cloudDb, Mode = SqliteOpenMode.ReadOnly }.ToString()))
{
    connection.Open();
    Require(Count(connection, "samples") == 2 && Count(connection, "runtime_cloud_samples") == 4,
        "클라우드 페이지가 이전 원본을 변경했거나 표본을 누락함");
}
Require(ImportedCount(cloudDb) == 2
    && ImportedCount(cloudDb + ".bak.1") == 2,
    "클라우드 동기화 뒤 원본 또는 첫 백업 표본 검증 실패");
// A cursor replay must not copy observations the imported archive already holds.
var replayDb = Path.Combine(folder, "cloud-replay.sqlite");
var replayAt = DateTimeOffset.UtcNow.AddMinutes(-5).ToUnixTimeMilliseconds() / 60_000 * 60_000;
var replayIso = DateTimeOffset.FromUnixTimeMilliseconds(replayAt).UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ss.fffZ");
var replaySource = Path.Combine(folder, "cloud-replay.json");
File.WriteAllText(replaySource, File.ReadAllText(cloudSource)
    .Replace("\"subscriberHistory\": [{\"at\":\"2026-09-02T00:00:00.000Z\",\"count\":101}]",
        $"\"subscriberHistory\": [{{\"at\":\"{replayIso}\",\"count\":150}}]"));
Require(StoreImporter.Import(replaySource, replayDb).Samples == 2, "재수신 fixture 이전 실패");
using (var client = new HttpClient(new CloudFixtureHandler([CloudPage(replayAt, false)])))
    await new NativeCloudSync(replayDb, client).SyncOnceAsync();
using (var connection = new SqliteConnection(new SqliteConnectionStringBuilder
       { DataSource = replayDb, Mode = SqliteOpenMode.ReadOnly }.ToString()))
{
    connection.Open();
    using var kinds = connection.CreateCommand();
    kinds.CommandText = "SELECT group_concat(k.kind) FROM observations o JOIN series_keys k ON k.id=o.series WHERE k.source='runtime-cloud'";
    Require(kinds.ExecuteScalar() as string == "video", "재수신이 이미 가져온 클라우드 구독자 표본을 중복 저장함");
    using var index = connection.CreateCommand();
    index.CommandText = "SELECT count(*) FROM sqlite_master WHERE name='runtime_cloud_samples_by_time'";
    Require(Convert.ToInt32(index.ExecuteScalar()) == 0, "기본 키와 같은 중복 색인이 남음");
}

// Storage version 2: conversion of a version 1 DB, and the 30-day change-only rule for views.
static long SeriesRows(string database, string source, string video)
{
    using var connection = new SqliteConnection(new SqliteConnectionStringBuilder
        { DataSource = database, Mode = SqliteOpenMode.ReadOnly, Pooling = false }.ToString());
    connection.Open();
    using var command = connection.CreateCommand();
    command.CommandText = "SELECT count(*) FROM observations o JOIN series_keys k ON k.id=o.series WHERE k.source=$source AND k.video_id=$video";
    command.Parameters.AddWithValue("$source", source);
    command.Parameters.AddWithValue("$video", video);
    return (long)command.ExecuteScalar()!;
}
var sparseDb = Path.Combine(folder, "sparse.sqlite");
StoreImporter.Import(cloudSource, sparseDb);
var sparseNow = DateTimeOffset.UtcNow;
var oldPublished = sparseNow.AddDays(-60);
using (var raw = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = sparseDb, Pooling = false }.ToString()))
{
    // Version 1 tables as the earlier app wrote them, before the first store open converts them.
    raw.Open();
    using var legacy = raw.CreateCommand();
    legacy.CommandText = """
        CREATE TABLE runtime_cloud_samples(channel_id TEXT NOT NULL, kind TEXT NOT NULL, video_id TEXT NOT NULL,
          at TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(channel_id,kind,video_id,at));
        CREATE TABLE runtime_cloud_videos(channel_id TEXT NOT NULL, video_id TEXT NOT NULL, metadata_json TEXT NOT NULL,
          PRIMARY KEY(channel_id,video_id));
        """;
    legacy.ExecuteNonQuery();
    legacy.CommandText = "INSERT INTO runtime_cloud_videos VALUES($id,'oldsparse01',$meta)";
    legacy.Parameters.AddWithValue("$id", channelId);
    legacy.Parameters.AddWithValue("$meta", JsonSerializer.Serialize(new { publishedAt = oldPublished.ToString("O") }));
    legacy.ExecuteNonQuery();
    legacy.Parameters.Clear();
    legacy.CommandText = "INSERT INTO runtime_cloud_samples VALUES($id,'video','oldsparse01',$at,9)";
    legacy.Parameters.AddWithValue("$id", channelId);
    legacy.Parameters.Add(new SqliteParameter("$at", ""));
    // Three rows while young (kept), five unchanged rows after 30 days (first as heartbeat, last as latest).
    foreach (var at in new[] { 1, 2, 3 }.Select(day => oldPublished.AddDays(day))
                 .Concat(Enumerable.Range(0, 5).Select(minute => oldPublished.AddDays(31).AddMinutes(minute))))
    {
        legacy.Parameters["$at"].Value = at.UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ss.fffZ");
        legacy.ExecuteNonQuery();
    }
}
_ = new NativeMonitorStore(sparseDb);
using (var converted = new SqliteConnection(new SqliteConnectionStringBuilder
       { DataSource = sparseDb, Mode = SqliteOpenMode.ReadOnly, Pooling = false }.ToString()))
{
    converted.Open();
    using var tables = converted.CreateCommand();
    tables.CommandText = "SELECT count(*) FROM sqlite_master WHERE name IN ('samples','runtime_cloud_samples','runtime_subscriber_samples','runtime_video_samples')";
    using var version = converted.CreateCommand();
    version.CommandText = "SELECT value FROM meta WHERE key='storage_version'";
    Require((long)tables.ExecuteScalar()! == 0 && version.ExecuteScalar() as string == "2"
        && ImportedCount(sparseDb) == 2 && SeriesRows(sparseDb, "runtime-cloud", "oldsparse01") == 5,
        "버전 1 DB 변환 또는 30일 지난 영상의 변화 없는 기록 정리 오류");
}
Require(NativeObservations.TakeMigrated(sparseDb) && !NativeObservations.TakeMigrated(sparseDb),
    "변환 뒤 파일 정리 신호를 한 번만 주지 않음");
var sparseHistory = new NativeStateReader(sparseDb).Read(channelId, [(channelId, "oldsparse01")])["channels"]![0]!
    ["videoViewHistories"]!.AsArray().Single(item => (string?)item!["videoId"] == "oldsparse01")!["samples"]!.AsArray();
Require(sparseHistory.Count == 5 && (string?)sparseHistory[0]!["at"] == oldPublished.AddDays(1).UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ss.fffZ"),
    "변환한 기록의 시각이 화면에 그대로 나오지 않음");

// Sync-time rule: after 30 days only changed counts (and a daily heartbeat) are stored.
var syncStart = sparseNow.AddMinutes(-10).ToUnixTimeMilliseconds() / 60_000 * 60_000;
string SparsePage(long[] minutes, long[] oldCounts, long[] youngCounts) => JsonSerializer.Serialize(new
{
    version = 1, next = syncStart + minutes[^1] * 60_000, hasMore = false,
    samples = minutes.Select((minute, index) => new { at = syncStart + minute * 60_000, channels = new[] {
        new { id = channelId, subscriberCount = 150L, views = new Dictionary<string, long>
            { ["oldsync0001"] = oldCounts[index], ["youngsync01"] = youngCounts[index] } } } }).ToArray(),
    metadata = new Dictionary<string, object> { [channelId] = new { title = "fixture", videos = new Dictionary<string, object>
    {
        ["oldsync0001"] = new { title = "old", publishedAt = sparseNow.AddDays(-45).ToString("O") },
        ["youngsync01"] = new { title = "young", publishedAt = sparseNow.AddDays(-1).ToString("O") }
    } } },
    status = new { lastSuccessAt = sparseNow.ToString("O"), error = (string?)null }
});
using (var client = new HttpClient(new CloudFixtureHandler([
           SparsePage([0], [500], [7]), SparsePage([1, 2, 3], [500, 500, 501], [7, 7, 8])])))
{
    var sync = new NativeCloudSync(sparseDb, client);
    await sync.SyncOnceAsync();
    await sync.SyncOnceAsync();
}
Require(SeriesRows(sparseDb, "runtime-cloud", "oldsync0001") == 2 && SeriesRows(sparseDb, "runtime-cloud", "youngsync01") == 4,
    "30일 지난 영상의 변화 없는 조회수를 매분 저장하거나 새 영상 기록을 줄임");

var projected = new NativeStateReader(cloudDb).Read(channelId, [(channelId, "abcdefghijk")]);
var projectedChannel = projected["channels"]![0]!;
Require(projected["settings"]!["cloudToken"] is null
    && projected["settings"]!["hasCloudToken"]!.GetValue<bool>()
    && projectedChannel["subscriberHistory"]!.AsArray().Count == 4
    && projectedChannel["videoViewHistories"]![0]!["samples"]!.AsArray().Count == 2,
    "실제 상태 투영에서 토큰 노출 또는 이전/신규 클라우드 기록 누락");
var cloudExtraId = "UCbbbbbbbbbbbbbbbbbbbbbb";
var cloudStore = new NativeMonitorStore(cloudDb);
cloudStore.AddChannel(YouTubeChannelInput.Normalize(cloudExtraId));
Require(cloudStore.ReadPollConfiguration().ChannelIds.Count == 2
    && new NativeStateReader(cloudDb).Read()["channels"]!.AsArray().Count == 2,
    "추가 채널이 감시·화면에 반영되지 않음");
cloudStore.RemoveChannel(cloudExtraId);
Require(cloudStore.ReadPollConfiguration().ChannelIds.Count == 1
    && new NativeStateReader(cloudDb).Read()["channels"]!.AsArray().Count == 1
    && ImportedCount(cloudDb) == 2,
    "채널 제거가 화면·감시에서 빠지지 않거나 이전 기록을 변경함");
using (var backup = new SqliteConnection(new SqliteConnectionStringBuilder
{ DataSource = cloudDb + ".bak.1", Mode = SqliteOpenMode.ReadOnly }.ToString()))
{
    backup.Open();
    Require(Count(backup, "runtime_cloud_samples") == 2,
        "첫 동기화 체크포인트가 커밋된 클라우드 표본을 포함하지 않음");
}
var cloudReplay = new CloudFixtureHandler([JsonSerializer.Serialize(new
{ version = 1, next = cloudAt2, hasMore = false, samples = Array.Empty<object>() })]);
using (var client = new HttpClient(cloudReplay))
{
    var replayResult = await new NativeCloudSync(cloudDb, client).SyncOnceAsync();
    Require(replayResult is { Pages: 1, Observations: 0 }
        && cloudReplay.Cursors.SequenceEqual(new[] { cloudAt2 }),
        "재시작 후 클라우드 커서에서 이어받지 못함");
}
var invalidCloud = new CloudFixtureHandler([CloudPage(DateTimeOffset.UtcNow.AddMinutes(1).ToUnixTimeMilliseconds(), false)]);
using (var client = new HttpClient(invalidCloud))
    ExpectInvalidData(() => new NativeCloudSync(cloudDb, client).SyncOnceAsync().GetAwaiter().GetResult(),
        "미래 클라우드 표본을 저장함");
using (var connection = new SqliteConnection(new SqliteConnectionStringBuilder
{ DataSource = cloudDb, Mode = SqliteOpenMode.ReadOnly }.ToString()))
{
    connection.Open();
    Require(Count(connection, "runtime_cloud_samples") == 4,
        "잘못된 클라우드 페이지 뒤 런타임 표본이 바뀜");
}
var unorderedCloudPage = JsonSerializer.Serialize(new
{
    version = 1, next = cloudAt2 + 30_000, hasMore = false,
    samples = new[] { cloudAt2 + 60_000, cloudAt2 + 30_000 }
        .Select(at => new { at, channels = Array.Empty<object>() }).ToArray()
});
using (var client = new HttpClient(new CloudFixtureHandler([unorderedCloudPage])))
    ExpectInvalidData(() => new NativeCloudSync(cloudDb, client).SyncOnceAsync().GetAwaiter().GetResult(),
        "순서가 뒤집힌 클라우드 페이지를 저장함");
var changedSettings = new CloudFixtureHandler([CloudPage(cloudAt2 + 60_000, false)], () =>
{
    using var connection = new SqliteConnection(new SqliteConnectionStringBuilder
    { DataSource = cloudDb, Mode = SqliteOpenMode.ReadWrite }.ToString());
    connection.Open();
    using var update = connection.CreateCommand();
    update.CommandText = "UPDATE meta SET value=$value WHERE key='settings'";
    update.Parameters.AddWithValue("$value", """
        {"cloudUrl":"https://pulse-test.fly.dev","cloudToken":"ssssssssssssssssssssssssssssssss"}
        """);
    update.ExecuteNonQuery();
});
using (var client = new HttpClient(changedSettings))
    Require((await new NativeCloudSync(cloudDb, client).SyncOnceAsync()) is
        { Configured: true, Pages: 0, Observations: 0, Cursor: var unchanged }
        && unchanged == cloudAt2, "요청 중 클라우드 키 변경 뒤 받은 페이지를 저장함");
using (var connection = new SqliteConnection(new SqliteConnectionStringBuilder
{ DataSource = cloudDb, Mode = SqliteOpenMode.ReadWrite }.ToString()))
{
    connection.Open();
    Require(Count(connection, "runtime_cloud_samples") == 4,
        "잘못된 클라우드 페이지에서 일부 표본을 저장함");
    using var invalidSettings = connection.CreateCommand();
    invalidSettings.CommandText = "UPDATE meta SET value=$value WHERE key='settings'";
    invalidSettings.Parameters.AddWithValue("$value", """
        {"cloudUrl":"https://evil.example","cloudToken":"tttttttttttttttttttttttttttttttt"}
        """);
    invalidSettings.ExecuteNonQuery();
}
using (var client = new HttpClient(new CloudFixtureHandler([])))
    ExpectInvalidData(() => new NativeCloudSync(cloudDb, client).SyncOnceAsync().GetAwaiter().GetResult(),
        "외부 클라우드 호스트를 허용함");
using (var client = new HttpClient(new CloudFixtureHandler([])))
    Require((await new NativeCloudSync(importedDb, client).SyncOnceAsync()) is
        { Configured: false, Pages: 0 }, "연결 키가 없는 저장소에서 클라우드 요청을 시도함");

var legacyEventDb = Path.Combine(folder, "legacy-events.sqlite");
StoreImporter.Import(source, legacyEventDb);
_ = new NativeMonitorStore(legacyEventDb);
using (var raw = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = legacyEventDb, Pooling = false }.ToString()))
{
    raw.Open();
    using var insert = raw.CreateCommand();
    insert.CommandText = $$"""
        INSERT INTO runtime_events(event_key,payload_json) VALUES('{{channelId}}|video|legacyvid01',
          '{"ChannelId":"{{channelId}}","Type":"video","SourceId":"legacyvid01","Title":"새 동영상","Detail":"옛 알림","Url":""}');
        INSERT INTO runtime_video_metadata(channel_id,video_id,metadata_json)
          VALUES('{{channelId}}','legacyvid01','{"videoId":"legacyvid01","publishedAt":"2026-09-26T11:00:33Z"}');
        """;
    insert.ExecuteNonQuery();
}
var legacyEvent = new NativeStateReader(legacyEventDb).Read()["events"]!.AsArray()
    .Single(item => (string?)item!["sourceId"] == "legacyvid01")!;
Require((string?)legacyEvent["at"] == "2026-09-26T11:00:33Z",
    "시간이 없는 옛 새 동영상 알림에 기록된 게시 시각을 쓰지 않음");

// Subscriber/view history defaults to the cloud; the PC records only without recent cloud samples.
var cloudFirst = settings with { RecordLocalStatistics = false };
var fallbackDb = Path.Combine(folder, "stats-fallback.sqlite");
var cloudOnlyDb = Path.Combine(folder, "stats-cloud.sqlite");
foreach (var path in new[] { fallbackDb, cloudOnlyDb }) StoreImporter.Import(source, path);
var cloudOnlyStore = new NativeMonitorStore(cloudOnlyDb);
using (var raw = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = cloudOnlyDb, Pooling = false }.ToString()))
{
    raw.Open();
    AddCloudObservation(raw, null, channelId, "subscriber", "", checkedAt.AddMinutes(-2), 100);
}
var fallbackStore = new NativeMonitorStore(fallbackDb);
await new NativeMonitorRunner(fallbackStore, new FixtureSnapshotSource(snapshot), new RecordingEffects(() => 0))
    .RunChannelOnceAsync(channelId, cloudFirst);
await new NativeMonitorRunner(cloudOnlyStore, new FixtureSnapshotSource(snapshot), new RecordingEffects(() => 0))
    .RunChannelOnceAsync(channelId, cloudFirst);
using (var fallbackConnection = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = fallbackDb, Pooling = false }.ToString()))
using (var cloudConnection = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = cloudOnlyDb, Pooling = false }.ToString()))
{
    fallbackConnection.Open();
    cloudConnection.Open();
    Require(Count(fallbackConnection, "runtime_subscriber_samples") == 1 && Count(cloudConnection, "runtime_subscriber_samples") == 0,
        "클라우드가 정상일 때 로컬 구독자 기록을 멈추지 않거나 클라우드가 없을 때 대신 기록하지 않음");
}
Require(cloudOnlyStore.HasRecentCloudStatistics(channelId, checkedAt)
    && !cloudOnlyStore.HasRecentCloudStatistics(channelId, checkedAt + NativeMonitorStore.CloudStatisticsGrace + TimeSpan.FromMinutes(1)),
    "클라우드 수집 중단 판정 오류");

// New-video events show the cloud's recorded publish time and the list is ordered by time.
using (var raw = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = cloudOnlyDb, Pooling = false }.ToString()))
{
    raw.Open();
    using var insert = raw.CreateCommand();
    insert.CommandText = $$"""
        INSERT INTO runtime_events(event_key,payload_json) VALUES('{{channelId}}|video|cloudvideo1',
          '{"id":"x","at":"2026-09-24T05:00:00Z","channelId":"{{channelId}}","type":"video","sourceId":"cloudvideo1","title":"새 동영상","detail":"","url":""}');
        INSERT INTO runtime_events(event_key,payload_json) VALUES('{{channelId}}|live|laterlive01',
          '{"id":"y","at":"2026-09-24T03:00:00Z","channelId":"{{channelId}}","type":"live","sourceId":"laterlive01","title":"라이브 시작","detail":"","url":""}');
        INSERT INTO runtime_cloud_videos(channel_id,video_id,metadata_json)
          VALUES('{{channelId}}','cloudvideo1','{"title":"클라우드 영상","publishedAt":"2026-09-24T02:00:00Z"}');
        """;
    insert.ExecuteNonQuery();
}
var orderedEvents = new NativeStateReader(cloudOnlyDb).Read()["events"]!.AsArray();
var cloudEvent = orderedEvents.Single(item => (string?)item!["sourceId"] == "cloudvideo1")!;
var times = orderedEvents.Select(item => DateTimeOffset.TryParse((string?)item!["at"], out var at) ? at : DateTimeOffset.MinValue).ToArray();
Require((string?)cloudEvent["at"] == "2026-09-24T02:00:00Z" && (string?)cloudEvent["detectedAt"] == "2026-09-24T05:00:00Z"
    && times.SequenceEqual(times.OrderByDescending(at => at))
    && orderedEvents.IndexOf(orderedEvents.Single(item => (string?)item!["sourceId"] == "laterlive01"))
        < orderedEvents.IndexOf(cloudEvent),
    "새 동영상 알림이 클라우드 게시 시각을 쓰지 않거나 시간순이 아님");

// Minute-level cloud samples must not shrink the card overview to the last hour.
var overviewDb = Path.Combine(folder, "overview.sqlite");
StoreImporter.Import(source, overviewDb);
_ = new NativeMonitorStore(overviewDb);
var minuteStart = new DateTimeOffset(2026, 9, 20, 0, 0, 0, TimeSpan.Zero);
using (var raw = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = overviewDb, Pooling = false }.ToString()))
{
    raw.Open();
    using var transaction = raw.BeginTransaction();
    for (var minute = 0; minute < 3 * 24 * 60; minute++)
    {
        AddCloudObservation(raw, transaction, channelId, "subscriber", "", minuteStart.AddMinutes(minute), 1000 + minute);
    }
    transaction.Commit();
}
var overview = new NativeStateReader(overviewDb).Read()["channels"]![0]!["subscriberHistory"]!.AsArray();
Require(overview.Count is >= 4 and <= 6 && (long)overview[0]!["count"]! == 100
    && (long)overview[^1]!["count"]! == 1000 + 3 * 24 * 60 - 1
    && DateTimeOffset.Parse((string)overview[^1]!["at"]!) - DateTimeOffset.Parse((string)overview[1]!["at"]!) > TimeSpan.FromDays(1),
    "카드 요약 차트가 전체 기간의 하루 마지막 값 대신 최근 표본만 담음");

var settingsDb = Path.Combine(folder, "settings.sqlite");
StoreImporter.Import(source, settingsDb);
var settingsStore = new NativeMonitorStore(settingsDb);
using (var update = JsonDocument.Parse("""
    {"pollIntervalSeconds":45,"autoOpenLive":false,"subscriberChartMode":"daily","apiKey":"private-key"}
    """))
    settingsStore.UpdateSettings(update.RootElement);
Require(settingsStore.ReadPollConfiguration() is { Interval.TotalSeconds: 45, Settings.AutoOpenLive: false }
    && new NativeStateReader(settingsDb).Read()["settings"]!["apiKey"] is null
    && new NativeStateReader(settingsDb).Read()["settings"]!["hasApiKey"]!.GetValue<bool>()
    && ImportedCount(settingsDb) == 1 && settingsStore.ReadApiKey() == "private-key",
    "설정 저장·비밀값 제거 또는 이전 기록 보존 오류");
using (var invalidUpdate = JsonDocument.Parse("""{"autoOpenLive":"false"}"""))
    ExpectInvalidData(() => settingsStore.UpdateSettings(invalidUpdate.RootElement),
        "문자열을 감시 설정 불리언으로 허용함");
var workbookPath = Path.Combine(folder, "subscriber-fixture.xlsx");
using (var archive = ZipFile.Open(workbookPath, ZipArchiveMode.Create))
using (var writer = new StreamWriter(archive.CreateEntry("xl/worksheets/sheet1.xml").Open()))
{
    var existingLocal = DateTimeOffset.Parse("2026-09-01T00:00:00Z").ToLocalTime().Date;
    var oldDay = existingLocal.AddDays(-1).ToOADate().ToString(System.Globalization.CultureInfo.InvariantCulture);
    var existingDay = existingLocal.ToOADate().ToString(System.Globalization.CultureInfo.InvariantCulture);
    writer.Write($"""
        <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
        <row r="1"><c r="A1" t="inlineStr"><is><t>날짜</t></is></c><c r="B1" t="inlineStr"><is><t>전체 구독자</t></is></c></row>
        <row r="2"><c r="A2"><v>{oldDay}</v></c><c r="B2"><v>95</v></c></row>
        <row r="3"><c r="A3"><v>{existingDay}</v></c><c r="B3"><v>999</v></c></row>
        <row r="4"><c r="A4"><v>{oldDay}</v></c><c r="B4"><v>96</v></c></row>
        <row r="5"><c r="A5" t="inlineStr"><is><t>합계</t></is></c><c r="B5"><v>9999</v></c></row>
        <row r="6"><c r="A6" t="inlineStr"><is><t>bad</t></is></c><c r="B6"><v>1</v></c></row>
        </sheetData></worksheet>
        """);
}
var workbook = SubscriberXlsxImport.Read(workbookPath);
var importedDays = settingsStore.ImportSubscriberDays(channelId, workbook.Days);
Require(workbook.Days.Count == 2 && workbook.SkippedDuplicate == 1 && workbook.SkippedInvalid == 1
    && importedDays == (1, 1)
    && new NativeStateReader(settingsDb).Read(channelId)["channels"]![0]!["subscriberHistory"]!.AsArray().Count == 2
    && settingsStore.Load(channelId).LastSubscriberSample?.Count == 100
    && ImportedCount(settingsDb) == 1,
    "XLSX 날짜 병합에서 기존 값이나 최신 감시 표본을 변경함");

var checkpointDb = Path.Combine(folder, "checkpoint.sqlite");
StoreImporter.Import(source, checkpointDb);
using (var lease = NativeStoreLease.Acquire(checkpointDb))
{
    ExpectFailure(() => { using var duplicate = NativeStoreLease.Acquire(checkpointDb); },
        "동일 격리 DB에 두 번째 네이티브 감시 잠금을 허용함");
}
using (var reacquired = NativeStoreLease.Acquire(checkpointDb))
    Require(File.Exists(checkpointDb + ".native-lock"), "종료 후 격리 DB 잠금을 다시 얻지 못함");
var executable = Environment.ProcessPath ?? throw new InvalidOperationException("테스트 실행 파일 경로가 없습니다.");
var childStart = new ProcessStartInfo(executable)
{
    RedirectStandardInput = true,
    RedirectStandardOutput = true,
    UseShellExecute = false,
    CreateNoWindow = true
};
if (Path.GetFileNameWithoutExtension(executable).Equals("dotnet", StringComparison.OrdinalIgnoreCase))
    childStart.ArgumentList.Add(Assembly.GetExecutingAssembly().Location);
childStart.ArgumentList.Add("--hold-lease");
childStart.ArgumentList.Add(checkpointDb);
using (var child = Process.Start(childStart) ?? throw new InvalidOperationException("잠금 시험 프로세스를 시작하지 못함"))
{
    try
    {
        var ready = child.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(10))
            .GetAwaiter().GetResult();
        Require(ready == "NATIVE_LEASE_HELD", "별도 프로세스가 격리 DB 잠금을 얻지 못함");
        ExpectFailure(() => { using var duplicate = NativeStoreLease.Acquire(checkpointDb); },
            "다른 프로세스가 보유한 격리 DB 잠금을 동시에 허용함");
        child.StandardInput.WriteLine();
        Require(child.WaitForExit(5000) && child.ExitCode == 0,
            "잠금 시험 프로세스가 정상 종료하지 못함");
    }
    finally
    {
        if (!child.HasExited) child.Kill(entireProcessTree: true);
    }
}
using (var reacquired = NativeStoreLease.Acquire(checkpointDb))
    Require(File.Exists(checkpointDb + ".native-lock"), "별도 프로세스 종료 후 잠금을 다시 얻지 못함");
var checkpointStore = new NativeMonitorStore(checkpointDb);
var checkpointClock = checkedAt;
var checkpoint = new NativeBackupCheckpoint(checkpointDb, () => checkpointClock);
var checkpointEffects = new RecordingEffects(() => checkpointStore.Load(channelId).Revision);
var checkpointRunner = new NativeMonitorRunner(checkpointStore,
    new FixtureSnapshotSource(snapshot), checkpointEffects, checkpoint);
Require((await checkpointRunner.RunChannelOnceAsync(channelId, settings)).SavedRevision == 1
    && checkpoint.BackupCount == 1 && File.Exists(checkpointDb + ".bak.1")
    && checkpointEffects.OpenedUrls.Count == 1,
    "첫 저장 직후 백업을 만들지 않았거나 효과 순서가 틀림");
checkpointClock = checkedAt.AddMinutes(1);
Require((await checkpointRunner.RunChannelOnceAsync(channelId, settings)).SavedRevision == 2
    && checkpoint.BackupCount == 1 && !File.Exists(checkpointDb + ".bak.2"),
    "백업 간격 전 저장에서 불필요한 백업을 생성함");
checkpointClock = checkedAt + NativeBackupCheckpoint.BackupInterval;
Require((await checkpointRunner.RunChannelOnceAsync(channelId, settings)).SavedRevision == 3
    && checkpoint.BackupCount == 2
    && new NativeMonitorStore(checkpointDb + ".bak.1").Load(channelId).Revision == 3
    && new NativeMonitorStore(checkpointDb + ".bak.2").Load(channelId).Revision == 1,
    "백업 간격 후 두 세대 백업 회전이 실패함");

var secondLive = live with { Id = "secondlive1", Url = "https://www.youtube.com/watch?v=secondlive1" };
var changedLiveSnapshot = snapshot with { Live = secondLive, CheckedAt = checkedAt.AddMinutes(11) };
// A directory at the temporary path makes the SQLite backup itself fail.
Directory.CreateDirectory(checkpointDb + ".backup.tmp");
checkpointClock = checkpointClock.AddMinutes(1);
var failingCheckpointRunner = new NativeMonitorRunner(checkpointStore,
    new FixtureSnapshotSource(changedLiveSnapshot), checkpointEffects, checkpoint);
var failedBackupRun = await failingCheckpointRunner.RunChannelOnceAsync(channelId, settings);
Require(failedBackupRun.SavedRevision == 4 && checkpoint.BackupCount == 2
    && checkpoint.LastError is not null && checkpointEffects.OpenedUrls.Count == 2
    && checkpointStore.Load(channelId).Tracking.OpenedBroadcastIds.Contains("live:secondlive1"),
    "백업 실패가 이미 저장된 새 방송 효과를 막거나 오류를 기록하지 않음");
var continuingScheduler = new NativeMonitorScheduler(checkpointStore, failingCheckpointRunner,
    (_, _) => Task.CompletedTask);
Require((await continuingScheduler.RunNowAsync()).Errors.Count == 0
    && checkpointStore.Load(channelId).Revision == 5 && checkpointEffects.OpenedUrls.Count == 2
    && checkpoint.BackupCount == 2,
    "백업 실패 뒤 감시가 멈추거나 재시도 간격 전에 백업을 반복하거나 방송을 다시 엶");
Directory.Delete(checkpointDb + ".backup.tmp");
checkpointClock = checkpointClock + NativeBackupCheckpoint.RetryInterval;
await continuingScheduler.RunNowAsync();
Require(checkpoint.BackupCount == 3 && checkpoint.LastError is null
    && new NativeMonitorStore(checkpointDb + ".bak.1").Load(channelId).Revision == 6,
    "재시도 간격 후 백업을 복구하지 못함");
Require(ImportedCount(checkpointDb) == 1,
    "백업 실패 뒤 이전 원본 표본이 바뀜");

var forcedDb = Path.Combine(folder, "forced-checkpoint.sqlite");
StoreImporter.Import(source, forcedDb);
var forcedStore = new NativeMonitorStore(forcedDb);
var forcedClock = checkedAt;
var forcedCheckpoint = new NativeBackupCheckpoint(forcedDb, () => forcedClock);
var forcedEffects = new RecordingEffects(() => forcedStore.Load(channelId).Revision,
    () => new NativeMonitorStore(forcedDb + ".bak.1").Load(channelId).Revision);
var firstForcedRunner = new NativeMonitorRunner(forcedStore,
    new FixtureSnapshotSource(snapshot), forcedEffects, forcedCheckpoint);
await firstForcedRunner.RunChannelOnceAsync(channelId, settings);
forcedClock = checkedAt.AddMinutes(1);
var secondForcedRunner = new NativeMonitorRunner(forcedStore,
    new FixtureSnapshotSource(changedLiveSnapshot), forcedEffects, forcedCheckpoint);
await secondForcedRunner.RunChannelOnceAsync(channelId, settings);
Require(forcedCheckpoint.BackupCount == 2 && forcedEffects.OpenedUrls.Count == 2
    && forcedEffects.RevisionsObserved.Count == forcedEffects.BackupRevisionsObserved.Count
    && forcedEffects.RevisionsObserved.Zip(forcedEffects.BackupRevisionsObserved,
        (revision, backupRevision) => revision == backupRevision).All(matched => matched)
    && new NativeMonitorStore(forcedDb + ".bak.1").Load(channelId).Tracking.OpenedBroadcastIds
        .Contains("live:secondlive1")
    && new NativeMonitorStore(forcedDb + ".bak.2").Load(channelId).Revision == 1,
    "새 방송 효과 전에 5분 간격과 무관하게 중복 방지 키를 백업하지 못함");
forcedClock = checkedAt.AddMinutes(2);
await secondForcedRunner.RunChannelOnceAsync(channelId, settings);
Require(forcedCheckpoint.BackupCount == 2 && forcedEffects.OpenedUrls.Count == 2,
    "같은 방송을 다시 열거나 불필요한 백업을 만듦");
// Residue from a backup interrupted by shutdown: a partial snapshot and its hot journal.
File.WriteAllBytes(forcedDb + ".backup.tmp", [1]);
File.WriteAllBytes(forcedDb + ".backup.tmp-journal", [2]);
forcedClock = checkedAt.AddMinutes(3);
var thirdLive = live with { Id = "thirdlive11", Url = "https://www.youtube.com/watch?v=thirdlive11" };
var thirdForcedRunner = new NativeMonitorRunner(forcedStore,
    new FixtureSnapshotSource(snapshot with { Live = thirdLive, CheckedAt = forcedClock }),
    forcedEffects, forcedCheckpoint);
await thirdForcedRunner.RunChannelOnceAsync(channelId, settings);
Require(forcedStore.Load(channelId).Revision == 4 && forcedEffects.OpenedUrls.Count == 3
    && forcedCheckpoint.BackupCount == 3 && forcedCheckpoint.LastError is null
    && !File.Exists(forcedDb + ".backup.tmp") && !File.Exists(forcedDb + ".backup.tmp-journal")
    && new NativeMonitorStore(forcedDb + ".bak.1").Load(channelId).Tracking.OpenedBroadcastIds
        .Contains("live:thirdlive11"),
    "중단된 백업 잔여 파일을 정리하지 못하거나 새 방송 키를 백업하지 못함");
File.WriteAllBytes(forcedDb + ".backup.tmp", [1]);
File.WriteAllBytes(forcedDb + ".bak.2", [9]);
ExpectFailure(() => NativeStoreRecovery.CreateBackup(forcedDb),
    "손상된 백업 세대가 있는데 중단된 임시 백업을 지움");
Require(File.Exists(forcedDb + ".backup.tmp"), "검증 실패 후 임시 백업을 지움");

// Daily external copy into a user folder (Google Drive for desktop).
var externalFolder = Path.Combine(folder, "external");
Directory.CreateDirectory(externalFolder);
File.WriteAllText(Path.Combine(externalFolder, "unrelated.txt"), "keep");
foreach (var day in new[] { 20, 21, 22, 23 })
    File.WriteAllBytes(Path.Combine(externalFolder, $"live-pulse-202609{day}.sqlite.zip"), [1]);
var external = NativeExternalBackup.RunIfDue(forcedDb, externalFolder, new DateTime(2026, 9, 27, 9, 0, 0));
Require(external.Created && File.Exists(Path.Combine(externalFolder, "live-pulse-20260927.sqlite.zip"))
    && !NativeExternalBackup.RunIfDue(forcedDb, externalFolder, new DateTime(2026, 9, 27, 18, 0, 0)).Created
    && Directory.GetFiles(externalFolder, "live-pulse-*.sqlite.zip").Length == NativeExternalBackup.KeepDays
    && File.Exists(Path.Combine(externalFolder, "unrelated.txt"))
    && !File.Exists(Path.Combine(externalFolder, "live-pulse-20260921.sqlite.zip")),
    "외부 백업 생성·하루 1회·최근 3일 유지 또는 다른 파일 보호 오류");
using (var zip = System.IO.Compression.ZipFile.OpenRead(Path.Combine(externalFolder, "live-pulse-20260927.sqlite.zip")))
{
    var restoredCopy = Path.Combine(folder, "external-restored.sqlite");
    zip.Entries.Single().ExtractToFile(restoredCopy);
    NativeStoreRecovery.Validate(restoredCopy);
    Require(new NativeMonitorStore(restoredCopy).Load(channelId).Tracking.OpenedBroadcastIds.Contains("live:thirdlive11"),
        "외부 백업에서 복원한 DB가 최신 백업 세대와 다름");
}
ExpectFailure(() => NativeExternalBackup.RunIfDue(forcedDb, Path.Combine(folder, "missing"), DateTime.Now),
    "없는 외부 백업 폴더를 조용히 넘김");

// Direct Google Drive upload: desktop OAuth client file, loopback consent, daily upload and retention.
var driveClient = GoogleDriveBackup.ParseClientFile("""
    {"installed":{"client_id":"123-abc.apps.googleusercontent.com","client_secret":"GOCSPX-secret_1",
     "redirect_uris":["http://localhost"]}}
    """);
Require(driveClient == ("123-abc.apps.googleusercontent.com", "GOCSPX-secret_1"), "OAuth 클라이언트 파일 해석 오류");
ExpectInvalidData(() => GoogleDriveBackup.ParseClientFile("""{"web":{"client_id":"1.apps.googleusercontent.com","client_secret":"xxxxxxxx"}}"""),
    "웹용 OAuth 클라이언트를 받아들임");
ExpectInvalidData(() => GoogleDriveBackup.ParseClientFile("""{"installed":{"client_id":"evil.example.com","client_secret":"xxxxxxxx"}}"""),
    "잘못된 OAuth 클라이언트 ID를 받아들임");
Require(GoogleDriveBackup.ParseCallback("GET /?state=s%2F1&code=4%2F0abc HTTP/1.1") is { } callback
    && callback["state"] == "s/1" && callback["code"] == "4/0abc"
    && GoogleDriveBackup.ParseCallback("GET /favicon.ico HTTP/1.1") is null,
    "OAuth 리디렉션 해석 오류");
var driveHandler = new DriveFixtureHandler(["live-pulse-20260924.sqlite.zip", "live-pulse-20260925.sqlite.zip",
    "live-pulse-20260926.sqlite.zip", "notes.txt"]);
using (var driveHttp = new HttpClient(driveHandler))
{
    var drive = new GoogleDriveBackup(driveHttp);
    Uri? consent = null;
    using var callbackHttp = new HttpClient();
    var authorized = await drive.AuthorizeAsync(driveClient.ClientId, driveClient.ClientSecret, uri =>
    {
        consent = uri;
        var query = GoogleDriveBackup.ParseCallback($"GET /?{uri.Query.TrimStart('?')} HTTP/1.1")!;
        _ = callbackHttp.GetStringAsync($"{query["redirect_uri"]}/?state={Uri.EscapeDataString(query["state"])}&code=auth-code");
    }, new CancellationTokenSource(TimeSpan.FromSeconds(20)).Token);
    Require(authorized.RefreshToken == "refresh-1" && consent is { Host: "accounts.google.com" }
        && consent.Query.Contains("code_challenge_method=S256") && consent.Query.Contains("drive.file")
        && driveHandler.TokenForms[0].Contains("code=auth-code") && driveHandler.TokenForms[0].Contains("code_verifier="),
        "Google 드라이브 연결 흐름 오류");

    var first = await drive.RunIfDueAsync(forcedDb, authorized, new DateTime(2026, 9, 27, 9, 0, 0));
    Require(first.Created && driveHandler.Uploaded.Keys.SequenceEqual(["live-pulse-20260927.sqlite.zip"])
        && driveHandler.Trashed.SequenceEqual(["id-live-pulse-20260924.sqlite.zip"])
        && driveHandler.FoldersCreated == 1,
        "구글 드라이브 업로드·폴더 생성·최근 3일 유지 오류");
    using (var zip = new ZipArchive(new MemoryStream(driveHandler.Uploaded["live-pulse-20260927.sqlite.zip"])))
    {
        var restoredCopy = Path.Combine(folder, "drive-restored.sqlite");
        zip.Entries.Single().ExtractToFile(restoredCopy);
        NativeStoreRecovery.Validate(restoredCopy);
    }
    var again = await drive.RunIfDueAsync(forcedDb, authorized, new DateTime(2026, 9, 27, 18, 0, 0));
    Require(!again.Created && again.At is not null && driveHandler.Uploaded.Count == 1 && driveHandler.FoldersCreated == 1,
        "구글 드라이브에 같은 날 백업을 다시 올림");
    driveHandler.RevokedGrant = true;
    try
    {
        await drive.RunIfDueAsync(forcedDb, authorized, new DateTime(2026, 9, 28, 9, 0, 0));
        throw new InvalidOperationException("만료된 구글 드라이브 연결을 조용히 넘김");
    }
    catch (InvalidDataException) { }
}

var schedulerDb = Path.Combine(folder, "scheduler.sqlite");
StoreImporter.Import(source, schedulerDb);
var schedulerStore = new NativeMonitorStore(schedulerDb);
var initialConfiguration = schedulerStore.ReadPollConfiguration();
Require(initialConfiguration.Interval == TimeSpan.FromSeconds(30)
    && initialConfiguration.ChannelIds.SequenceEqual(new[] { channelId })
    && initialConfiguration.Settings is { AutoOpenLive: true, AutoOpenUpcoming: true,
        NotifyNewVideos: true, NotifyNewPosts: true },
    "이전 DB의 채널 목록 또는 기본 감시 설정을 읽지 못함");
var schedulerEffects = new RecordingEffects(() => schedulerStore.Load(channelId).Revision);
var scheduledRunner = new NativeMonitorRunner(schedulerStore, new FixtureSnapshotSource(snapshot), schedulerEffects);
var observedDelays = new List<TimeSpan>();
using (var cancellation = new CancellationTokenSource())
{
    NativeMonitorScheduler? scheduler = null;
    scheduler = new NativeMonitorScheduler(schedulerStore, scheduledRunner, (duration, token) =>
    {
        observedDelays.Add(duration);
        if (observedDelays.Count == 2)
        {
            Require(scheduler!.LastSweep is { Completed.Count: 1, Errors.Count: 0 },
                "첫 감시 주기가 완료되지 않음");
            using var connection = new SqliteConnection(new SqliteConnectionStringBuilder
            { DataSource = schedulerDb, Pooling = false }.ToString());
            connection.Open();
            using var update = connection.CreateCommand();
            update.CommandText = "UPDATE meta SET value=$settings WHERE key='settings'";
            update.Parameters.AddWithValue("$settings", """
                {"pollIntervalSeconds":15,"autoOpenLive":false,"autoOpenUpcoming":true,
                 "notifyNewVideos":true,"notifyNewPosts":true}
                """);
            update.ExecuteNonQuery();
        }
        if (observedDelays.Count == 3)
        {
            cancellation.Cancel();
            return Task.Delay(Timeout.InfiniteTimeSpan, token);
        }
        return Task.CompletedTask;
    });
    await scheduler.RunAsync(cancellation.Token);
    Require(observedDelays.SequenceEqual(new[] { TimeSpan.FromMilliseconds(250),
            TimeSpan.FromSeconds(30), TimeSpan.FromSeconds(15) })
        && scheduler.LastSweep is { Completed.Count: 1, Errors.Count: 0 }
        && schedulerStore.Load(channelId).Revision == 2 && schedulerEffects.OpenedUrls.Count == 1,
        "주기 간격 갱신, 직렬 실행 또는 중복 열기 방지 오류");
}
using (var connection = new SqliteConnection(new SqliteConnectionStringBuilder
{ DataSource = schedulerDb, Pooling = false }.ToString()))
{
    connection.Open();
    using var update = connection.CreateCommand();
    update.CommandText = "UPDATE meta SET value='{\"autoOpenLive\":\"false\"}' WHERE key='settings'";
    update.ExecuteNonQuery();
}
ExpectFailure(() => schedulerStore.ReadPollConfiguration(), "잘못된 감시 설정을 참으로 취급함");
var invalidScheduler = new NativeMonitorScheduler(schedulerStore, scheduledRunner,
    (_, _) => Task.CompletedTask);
ExpectFailure(() => invalidScheduler.RunAsync(CancellationToken.None).GetAwaiter().GetResult(),
    "잘못된 감시 설정에서 주기 실행을 계속함");
Require(invalidScheduler.LastSweep is { Completed.Count: 0, Errors.Count: 1 }
    && schedulerStore.Load(channelId).Revision == 2,
    "설정 오류를 기록하지 않았거나 상태를 변경함");
using (var connection = new SqliteConnection(new SqliteConnectionStringBuilder
{ DataSource = schedulerDb, Pooling = false }.ToString()))
{
    connection.Open();
    using var update = connection.CreateCommand();
    update.CommandText = "UPDATE meta SET value='{\"pollIntervalSeconds\":15}' WHERE key='settings'";
    update.ExecuteNonQuery();
}
using (var cancellation = new CancellationTokenSource())
{
    var waits = 0;
    var scheduler = new NativeMonitorScheduler(schedulerStore, scheduledRunner, (_, token) =>
    {
        if (++waits == 2)
        {
            cancellation.Cancel();
            return Task.Delay(Timeout.InfiniteTimeSpan, token);
        }
        return Task.CompletedTask;
    });
    await scheduler.RunAsync(cancellation.Token);
    Require(waits == 2 && scheduler.LastSweep is { Completed.Count: 1, Errors.Count: 0 }
        && schedulerStore.Load(channelId).Revision == 3,
        "설정 오류를 고친 뒤 새 실행기로 감시를 재개하지 못함");
}
using (var connection = new SqliteConnection(new SqliteConnectionStringBuilder
{ DataSource = schedulerDb, Pooling = false }.ToString()))
{
    connection.Open();
    using var update = connection.CreateCommand();
    update.CommandText = "UPDATE meta SET value='{\"pollIntervalSeconds\":400,\"autoOpenLive\":false}' WHERE key='settings'";
    update.ExecuteNonQuery();
}
Require(schedulerStore.ReadPollConfiguration() is { Interval: var clamped, Settings.AutoOpenLive: false }
    && clamped == TimeSpan.FromSeconds(300), "감시 간격 제한 또는 자동 열기 설정 오류");
const string secondChannelId = "UCaaaaaaaaaaaaaaaaaaaaaa";
using (var connection = new SqliteConnection(new SqliteConnectionStringBuilder
{ DataSource = schedulerDb, Pooling = false }.ToString()))
{
    connection.Open();
    using var addChannel = connection.CreateCommand();
    addChannel.CommandText = "INSERT INTO channels(id,metadata_json) VALUES($id,$metadata)";
    addChannel.Parameters.AddWithValue("$id", secondChannelId);
    addChannel.Parameters.AddWithValue("$metadata", """
        {"id":"UCaaaaaaaaaaaaaaaaaaaaaa","title":"Second"}
        """);
    addChannel.ExecuteNonQuery();
}
Require(schedulerStore.ReadPollConfiguration().ChannelIds.SequenceEqual(new[] { channelId, secondChannelId }),
    "두 채널의 순서가 기존 저장 순서와 다름");
using (var cancellation = new CancellationTokenSource())
{
    var waits = 0;
    var isolatedRunner = new NativeMonitorRunner(schedulerStore,
        new FailingFirstChannelSource(channelId, snapshot), schedulerEffects);
    var scheduler = new NativeMonitorScheduler(schedulerStore, isolatedRunner, (_, token) =>
    {
        if (++waits == 2)
        {
            cancellation.Cancel();
            return Task.Delay(Timeout.InfiniteTimeSpan, token);
        }
        return Task.CompletedTask;
    });
    await scheduler.RunAsync(cancellation.Token);
    Require(scheduler.LastSweep is { Completed.Count: 1, Errors.Count: 1 }
        && schedulerStore.Load(channelId).Revision == 3
        && schedulerStore.Load(secondChannelId).Revision == 1,
        "한 채널의 네트워크 오류가 다른 채널 확인을 막음");
    var failedState = new NativeStateReader(schedulerDb).Read(monitorSweep: scheduler.LastSweep);
    var failedChannel = failedState["channels"]!.AsArray().Single(item => (string?)item!["id"] == channelId)!;
    Require(failedChannel["status"]!.GetValue<string>() == "error"
        && failedChannel["error"]!.GetValue<string>().Contains("fixture network failure")
        && failedChannel["snapshot"]!["live"] is null
        && failedChannel["snapshot"]!["upcoming"]!.AsArray().Count == 0
        && failedChannel["subscriberHistory"]!.AsArray().Count > 0
        && failedState["channels"]!.AsArray().Single(item => (string?)item!["id"] == secondChannelId)!["error"] is null,
        "채널 오류 표시, 오래된 방송 숨김 또는 정상 채널 격리 실패");
    Require(new NativeStateReader(schedulerDb).Read()["channels"]![0]!["snapshot"]!["live"] is not null,
        "오류 투영이 저장된 성공 스냅샷을 변경함");
    var recovered = new NativeMonitorScheduler(schedulerStore,
        new NativeMonitorRunner(schedulerStore, new FixtureSnapshotSource(snapshot), schedulerEffects));
    await recovered.RunNowAsync();
    var recoveredChannel = new NativeStateReader(schedulerDb).Read(monitorSweep: recovered.LastSweep)["channels"]![0]!;
    Require(recoveredChannel["status"]!.GetValue<string>() == "online" && recoveredChannel["error"] is null
        && recoveredChannel["snapshot"]!["live"] is not null,
        "수집 성공 후 오류 또는 오래된 방송 숨김이 남음");
    var eventList = new NativeStateReader(schedulerDb).Read()["events"]!.AsArray();
    Require(eventList.Count(item => (string?)item!["type"] == "error") == 1
        && (string?)eventList[0]!["type"] == "error" && (string?)eventList[0]!["channelId"] == channelId
        && eventList[0]!["detail"]!.GetValue<string>().Contains("fixture network failure")
        && eventList.All(item => DateTimeOffset.TryParse((string?)item!["at"], out _)),
        "채널 확인 실패를 최근 알림에 한 번 기록하지 않거나 최신순·시간 정보가 없음");
    schedulerStore.RecordChannelFailure(channelId, "fixture network failure", DateTimeOffset.UtcNow);
    Require(new NativeStateReader(schedulerDb).Read()["events"]!.AsArray()
        .Count(item => (string?)item!["type"] == "error") == 1, "같은 오류 알림을 반복 기록함");
    Require(ChannelRows(schedulerDb, channelId) > 0, "삭제 전 채널 데이터가 없음");
    schedulerStore.RemoveChannel(channelId);
    Require(new NativeStateReader(schedulerDb).Read()["events"]!.AsArray()
        .All(item => (string?)item!["channelId"] != channelId), "삭제한 채널의 알림이 남음");
    Require(ChannelRows(schedulerDb, channelId) == 0, "삭제한 채널의 기록·추적·이벤트 데이터가 DB에 남음");
    schedulerStore.RecordChannelFailure(channelId, "late failure", DateTimeOffset.UtcNow);
    Require(ChannelRows(schedulerDb, channelId) == 0, "삭제 중이던 채널의 실패 알림이 고아 행으로 남음");
    // Re-adding starts fresh; a legacy removal marker (before removal deleted data) is purged.
    schedulerStore.AddChannel(YouTubeChannelInput.Normalize(channelId));
    Require(schedulerStore.ReadPollConfiguration().ChannelIds.Contains(channelId), "삭제 후 다시 추가한 채널이 감시되지 않음");
    using (var legacy = new SqliteConnection(new SqliteConnectionStringBuilder
        { DataSource = schedulerDb, Pooling = false }.ToString()))
    {
        legacy.Open();
        using var marker = legacy.CreateCommand();
        marker.CommandText = "INSERT INTO runtime_removed_channels(id) VALUES($id)";
        marker.Parameters.AddWithValue("$id", channelId);
        marker.ExecuteNonQuery();
    }
    Require(schedulerStore.PurgeRemovedChannels() == 1 && ChannelRows(schedulerDb, channelId) == 0
        && schedulerStore.PurgeRemovedChannels() == 0, "이전에 삭제한 채널의 남은 데이터를 정리하지 못함");
    schedulerStore.AddChannel(YouTubeChannelInput.Normalize(channelId));
}
using (var cancellation = new CancellationTokenSource())
{
    var gate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    var scheduler = new NativeMonitorScheduler(schedulerStore, scheduledRunner,
        (_, token) => gate.Task.WaitAsync(token));
    var runningTask = scheduler.RunAsync(cancellation.Token);
    ExpectFailure(() => scheduler.RunAsync(cancellation.Token).GetAwaiter().GetResult(),
        "두 개의 주기 루프를 동시에 시작함");
    cancellation.Cancel();
    await runningTask;
}

NativeStoreRecovery.CreateBackup(runnerDb);
NativeStoreRecovery.Validate(runnerDb + ".bak.1");
var tracked = runnerStore.Load(channelId);
var noChangePlan = MonitorChangePlanner.Plan(channelId, tracked.Tracking, tracked.LastSubscriberSample,
    settings, snapshot with { CheckedAt = checkedAt.AddMinutes(2) });
Require(runnerStore.Commit(channelId, tracked.Revision, snapshot, noChangePlan) == 3,
    "백업 순환 전 상태 변경 실패");
NativeStoreRecovery.CreateBackup(runnerDb);
Require(new NativeMonitorStore(runnerDb + ".bak.1").Load(channelId).Revision == 3
    && new NativeMonitorStore(runnerDb + ".bak.2").Load(channelId).Revision == 2,
    "두 세대 SQLite 백업의 순서가 올바르지 않음");

SqliteConnection.ClearAllPools();
File.WriteAllBytes(runnerDb, [0, 1, 2, 3, 4]);
var restored = NativeStoreRecovery.Recover(runnerDb);
Require(restored.Restored && restored.Source == runnerDb + ".bak.1"
    && restored.PreservedPrimary is { } forensic && File.ReadAllBytes(forensic).SequenceEqual(new byte[] { 0, 1, 2, 3, 4 })
    && new NativeMonitorStore(runnerDb).Load(channelId).Revision == 3,
    "손상 원본 보존 또는 최신 백업 복구 오류");
Require(ImportedCount(runnerDb) == 1, "복구 후 이전 표본이 바뀜");

SqliteConnection.ClearAllPools();
File.WriteAllBytes(runnerDb + ".bak.1", [9, 8, 7]);
File.WriteAllBytes(runnerDb, [5, 6, 7]);
var fallback = NativeStoreRecovery.Recover(runnerDb);
Require(fallback.Source == runnerDb + ".bak.2"
    && new NativeMonitorStore(runnerDb).Load(channelId).Revision == 2,
    "최신 백업 손상 시 이전 세대로 복구하지 못함");

File.Copy(runnerDb, runnerDb + ".backup.tmp");
File.WriteAllBytes(runnerDb, [6, 6, 6]);
var interrupted = NativeStoreRecovery.Recover(runnerDb);
Require(interrupted.Source == runnerDb + ".backup.tmp"
    && new NativeMonitorStore(runnerDb).Load(channelId).Revision == 2,
    "중단된 백업 회전의 검증된 임시 스냅샷을 복구하지 못함");
File.WriteAllBytes(runnerDb, [6, 6, 6]);
File.WriteAllBytes(runnerDb + "-wal", [1]);
ExpectFailure(() => NativeStoreRecovery.Recover(runnerDb), "알 수 없는 WAL을 둔 채 복구함");
Require(File.ReadAllBytes(runnerDb).SequenceEqual(new byte[] { 6, 6, 6 }),
    "저널이 있을 때 손상 원본을 바꿈");
File.Delete(runnerDb + "-wal");
ExpectFailure(() => NativeStoreRecovery.Recover(invalidDb), "검증된 백업 없이 복구함");

// A process killed mid-commit leaves a hot rollback journal beside a valid primary.
var startupDb = Path.Combine(folder, "startup.sqlite");
var crashedDb = Path.Combine(folder, "crashed.sqlite");
File.Copy(forcedDb, startupDb);
Require(!NativeStoreRecovery.OpenForStartup(startupDb).Restored, "정상 DB를 시작 시 복구함");
using (var writer = new SqliteConnection(new SqliteConnectionStringBuilder
       { DataSource = startupDb, Pooling = false }.ToString()))
{
    writer.Open();
    using var begin = writer.CreateCommand();
    // A tiny cache forces SQLite to write changed pages into the DB file before commit.
    begin.CommandText = """
        PRAGMA cache_size=1; BEGIN IMMEDIATE;
        UPDATE observations SET count=count+1;
        CREATE TABLE filler(x);
        WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM c WHERE i<200)
        INSERT INTO filler SELECT randomblob(4000) FROM c;
        """;
    begin.ExecuteNonQuery();
    Require(File.Exists(startupDb + "-journal"), "시험용 저널을 만들지 못함");
    File.Copy(startupDb, crashedDb);
    File.Copy(startupDb + "-journal", crashedDb + "-journal");
    begin.CommandText = "ROLLBACK";
    begin.ExecuteNonQuery();
}
ExpectFailure(() => NativeStoreRecovery.Validate(crashedDb), "읽기 전용 검증이 hot journal DB를 통과함");
static long ChannelRows(string database, string channelId)
{
    using var connection = new SqliteConnection(new SqliteConnectionStringBuilder
        { DataSource = database, Mode = SqliteOpenMode.ReadOnly, Pooling = false }.ToString());
    connection.Open();
    using var command = connection.CreateCommand();
    command.CommandText = """
        SELECT (SELECT count(*) FROM observations WHERE series IN (SELECT id FROM series_keys WHERE channel_id=$id))
          + (SELECT count(*) FROM series_keys WHERE channel_id=$id) + (SELECT count(*) FROM series WHERE channel_id=$id)
          + (SELECT count(*) FROM channels WHERE id=$id) + (SELECT count(*) FROM runtime_channels WHERE id=$id)
          + (SELECT count(*) FROM runtime_removed_channels WHERE id=$id)
          + (SELECT count(*) FROM runtime_tracking WHERE channel_id=$id) + (SELECT count(*) FROM runtime_snapshots WHERE channel_id=$id)
          + (SELECT count(*) FROM runtime_video_metadata WHERE channel_id=$id)
          + (SELECT count(*) FROM runtime_video_stats_state WHERE channel_id=$id)
          + (SELECT count(*) FROM runtime_cloud_videos WHERE channel_id=$id)
          + (SELECT count(*) FROM runtime_events WHERE payload_json LIKE '%' || $id || '%')
          + (SELECT count(*) FROM meta WHERE key='events' AND value LIKE '%' || $id || '%')
        """;
    command.Parameters.AddWithValue("$id", channelId);
    return (long)command.ExecuteScalar()!;
}

static long CountSum(string database)
{
    using var connection = new SqliteConnection(new SqliteConnectionStringBuilder
        { DataSource = database, Mode = SqliteOpenMode.ReadOnly, Pooling = false }.ToString());
    connection.Open();
    using var sum = connection.CreateCommand();
    sum.CommandText = "SELECT total(count) FROM observations";
    return Convert.ToInt64(sum.ExecuteScalar());
}
var crashed = NativeStoreRecovery.OpenForStartup(crashedDb);
Require(!crashed.Restored && !File.Exists(crashedDb + "-journal")
    && ImportedCount(crashedDb) == 1 && CountSum(crashedDb) == CountSum(startupDb),
    "강제 종료 저널이 남은 정상 DB를 시작하지 못하거나 원본 표본이 바뀜");
var tempRoot = Path.GetFullPath(Path.GetTempPath());
if (!Path.GetFullPath(folder).StartsWith(tempRoot, StringComparison.OrdinalIgnoreCase))
    throw new InvalidOperationException("테스트 임시 경로가 안전하지 않습니다.");
SqliteConnection.ClearAllPools();
if (args is ["--ui-fixture", var fixtureOutput])
{
    videoStore.ImportSubscriberDays(channelId, Enumerable.Range(0, 150)
        .Select(index => new ImportedSubscriberDay(new DateOnly(2025, 1, 1).AddDays(index), 100 + index)).ToArray());
    File.Copy(videoStatsDb, Path.GetFullPath(fixtureOutput), overwrite: false);
    Console.WriteLine("NATIVE_UI_FIXTURE_CREATED");
}
Directory.Delete(folder, recursive: true);
Console.WriteLine("NATIVE_STORE_TESTS_PASSED");

sealed class FixtureSnapshotSource(YouTubeSnapshot snapshot) : IYouTubeSnapshotSource
{
    public Task<YouTubeSnapshot> FetchChannelSnapshotAsync(string channelId, CancellationToken cancellationToken = default)
        => Task.FromResult(snapshot);
}

sealed class FailingFirstChannelSource(string failingId, YouTubeSnapshot snapshot) : IYouTubeSnapshotSource
{
    public Task<YouTubeSnapshot> FetchChannelSnapshotAsync(string channelId, CancellationToken cancellationToken = default)
        => channelId == failingId ? Task.FromException<YouTubeSnapshot>(new IOException("fixture network failure"))
            : Task.FromResult(snapshot);
}

sealed class RecordingEffects(Func<long> revision, Func<long>? backupRevision = null) : IMonitorEffectSink
{
    public bool FailNotifications { get; set; }
    public List<long> RevisionsObserved { get; } = [];
    public List<long> BackupRevisionsObserved { get; } = [];
    public List<string> OpenedUrls { get; } = [];

    public Task NotifyAsync(MonitorNotification notification, CancellationToken cancellationToken)
    {
        RevisionsObserved.Add(revision());
        if (backupRevision is not null) BackupRevisionsObserved.Add(backupRevision());
        if (FailNotifications) throw new InvalidOperationException("fixture notification failure");
        return Task.CompletedTask;
    }

    public Task OpenUrlAsync(string url, CancellationToken cancellationToken)
    {
        RevisionsObserved.Add(revision());
        if (backupRevision is not null) BackupRevisionsObserved.Add(backupRevision());
        OpenedUrls.Add(url);
        return Task.CompletedTask;
    }
}

sealed class CloudFixtureHandler(IEnumerable<string> pages, Action? onResponse = null) : HttpMessageHandler
{
    private readonly Queue<string> responses = new(pages);
    public List<long> Cursors { get; } = [];

    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,
        CancellationToken cancellationToken)
    {
        if (request.Method != HttpMethod.Get || request.RequestUri is not { Host: "pulse-test.fly.dev" } url
            || url.Scheme != "https" || url.AbsolutePath != "/v1/sync"
            || request.Headers.Authorization?.Scheme != "Bearer"
            || request.Headers.Authorization.Parameter != "tttttttttttttttttttttttttttttttt"
            || !long.TryParse(url.Query.TrimStart('?').Replace("after=", ""), out var cursor))
            throw new InvalidOperationException("네이티브 클라우드 요청의 주소·인증·커서 오류");
        Cursors.Add(cursor);
        if (!responses.TryDequeue(out var body))
            throw new InvalidOperationException("예상보다 많은 클라우드 요청");
        onResponse?.Invoke();
        return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
        { Content = new StringContent(body) });
    }
}

// Minimal Drive v3 / OAuth token fake: one folder, files keyed by name, trash recorded.
sealed class DriveFixtureHandler(IEnumerable<string> existing) : HttpMessageHandler
{
    private readonly List<string> files = [.. existing];
    private string? folderId;
    private string? pendingName;
    public List<string> TokenForms { get; } = [];
    public Dictionary<string, byte[]> Uploaded { get; } = [];
    public List<string> Trashed { get; } = [];
    public int FoldersCreated { get; private set; }
    public bool RevokedGrant { get; set; }

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var url = request.RequestUri!;
        var query = Uri.UnescapeDataString(url.Query);
        if (url.Host == "oauth2.googleapis.com" && url.AbsolutePath == "/token")
        {
            var form = await request.Content!.ReadAsStringAsync(cancellationToken);
            TokenForms.Add(form);
            if (RevokedGrant) return Json("""{"error":"invalid_grant"}""", HttpStatusCode.BadRequest);
            return Json(form.Contains("grant_type=authorization_code")
                ? """{"access_token":"a","refresh_token":"refresh-1"}""" : """{"access_token":"access-2"}""");
        }
        if (request.Headers.Authorization?.Parameter is not ("a" or "access-2"))
            throw new InvalidOperationException("구글 드라이브 요청에 접근 토큰이 없음");
        if (url.Host == "www.googleapis.com" && url.AbsolutePath == "/drive/v3/files" && request.Method == HttpMethod.Get)
        {
            if (query.Contains("mimeType='application/vnd.google-apps.folder'"))
                return Json(folderId is null ? """{"files":[]}""" : $$"""{"files":[{"id":"{{folderId}}"}]}""");
            if (folderId is null || !query.Contains($"'{folderId}' in parents")) throw new InvalidOperationException("다른 폴더 조회");
            return Json(JsonSerializer.Serialize(new { files = files.Select(name =>
                new { id = $"id-{name}", name, createdTime = "2026-09-27T00:00:00Z" }) }));
        }
        if (url.AbsolutePath == "/drive/v3/files" && request.Method == HttpMethod.Post)
        {
            FoldersCreated++;
            folderId = "folder-1";
            return Json("""{"id":"folder-1"}""");
        }
        if (url.AbsolutePath == "/upload/drive/v3/files" && request.Method == HttpMethod.Post)
        {
            using var metadata = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(cancellationToken));
            if (metadata.RootElement.GetProperty("parents")[0].GetString() != folderId) throw new InvalidOperationException("다른 폴더에 업로드");
            pendingName = metadata.RootElement.GetProperty("name").GetString();
            var response = new HttpResponseMessage(HttpStatusCode.OK);
            response.Headers.Location = new Uri("https://www.googleapis.com/upload/drive/v3/files?upload_id=u1");
            return response;
        }
        if (url.AbsolutePath == "/upload/drive/v3/files" && request.Method == HttpMethod.Put)
        {
            Uploaded[pendingName!] = await request.Content!.ReadAsByteArrayAsync(cancellationToken);
            files.Add(pendingName!);
            return Json($$"""{"id":"id-{{pendingName}}"}""");
        }
        var id = Uri.UnescapeDataString(url.AbsolutePath["/drive/v3/files/".Length..]);
        var name = id["id-".Length..];
        if (request.Method == HttpMethod.Get)
            return Json($$"""{"size":"{{Uploaded[name].Length}}"}""");
        if (request.Method == HttpMethod.Patch)
        {
            Trashed.Add(id);
            files.Remove(name);
            return Json($$"""{"id":"{{id}}"}""");
        }
        throw new InvalidOperationException($"예상하지 못한 구글 드라이브 요청 {request.Method} {url}");
    }

    private static HttpResponseMessage Json(string body, HttpStatusCode status = HttpStatusCode.OK)
        => new(status) { Content = new StringContent(body) };
}
