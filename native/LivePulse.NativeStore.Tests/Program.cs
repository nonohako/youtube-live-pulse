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

static long Count(SqliteConnection connection, string table)
{
    using var command = connection.CreateCommand();
    command.CommandText = $"SELECT COUNT(*) FROM {table}";
    return (long)command.ExecuteScalar()!;
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
    foreach (var id in ids) probe.Load(id);
    Console.WriteLine($"NATIVE_STORE_PROBE_PASSED channels={ids.Count}");
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
Require(StoreImporter.Verify(source, importedDb).Samples == 1,
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
Require(StoreImporter.Verify(source, runnerDb).Samples == 1,
    "감시 실행이 이전 원본 표본을 변경함");

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
Require(StoreImporter.Verify(source, runnerDb).Samples == 1, "복구 후 이전 표본이 바뀜");

SqliteConnection.ClearAllPools();
File.WriteAllBytes(runnerDb + ".bak.1", [9, 8, 7]);
File.WriteAllBytes(runnerDb, [5, 6, 7]);
var fallback = NativeStoreRecovery.Recover(runnerDb);
Require(fallback.Source == runnerDb + ".bak.2"
    && new NativeMonitorStore(runnerDb).Load(channelId).Revision == 2,
    "최신 백업 손상 시 이전 세대로 복구하지 못함");

File.Copy(runnerDb, runnerDb + ".backup.tmp");
ExpectFailure(() => NativeStoreRecovery.CreateBackup(runnerDb), "미처리 임시 백업을 덮어씀");
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
var tempRoot = Path.GetFullPath(Path.GetTempPath());
if (!Path.GetFullPath(folder).StartsWith(tempRoot, StringComparison.OrdinalIgnoreCase))
    throw new InvalidOperationException("테스트 임시 경로가 안전하지 않습니다.");
SqliteConnection.ClearAllPools();
Directory.Delete(folder, recursive: true);
Console.WriteLine("NATIVE_STORE_TESTS_PASSED");

sealed class FixtureSnapshotSource(YouTubeSnapshot snapshot) : IYouTubeSnapshotSource
{
    public Task<YouTubeSnapshot> FetchChannelSnapshotAsync(string channelId, CancellationToken cancellationToken = default)
        => Task.FromResult(snapshot);
}

sealed class RecordingEffects(Func<long> revision) : IMonitorEffectSink
{
    public bool FailNotifications { get; set; }
    public List<long> RevisionsObserved { get; } = [];
    public List<string> OpenedUrls { get; } = [];

    public Task NotifyAsync(MonitorNotification notification, CancellationToken cancellationToken)
    {
        RevisionsObserved.Add(revision());
        if (FailNotifications) throw new InvalidOperationException("fixture notification failure");
        return Task.CompletedTask;
    }

    public Task OpenUrlAsync(string url, CancellationToken cancellationToken)
    {
        RevisionsObserved.Add(revision());
        OpenedUrls.Add(url);
        return Task.CompletedTask;
    }
}
