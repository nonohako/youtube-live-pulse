using System.Diagnostics;
using System.Reflection;
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
    Require(configuration.ChannelIds.Count == ids.Count
        && configuration.ChannelIds.ToHashSet(StringComparer.Ordinal).SetEquals(ids)
        && configuration.Interval >= TimeSpan.FromSeconds(15)
        && configuration.Interval <= TimeSpan.FromSeconds(300),
        "격리 데이터의 감시 채널 또는 간격을 읽지 못함");
    Console.WriteLine($"NATIVE_STORE_PROBE_PASSED channels={ids.Count} intervalSeconds={configuration.Interval.TotalSeconds} "
        + $"minRevision={(revisions.Length == 0 ? 0 : revisions.Min())} "
        + $"maxRevision={(revisions.Length == 0 ? 0 : revisions.Max())}");
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
    "5분 전 저장에서 불필요한 백업을 생성함");
checkpointClock = checkedAt.AddMinutes(5);
Require((await checkpointRunner.RunChannelOnceAsync(channelId, settings)).SavedRevision == 3
    && checkpoint.BackupCount == 2
    && new NativeMonitorStore(checkpointDb + ".bak.1").Load(channelId).Revision == 3
    && new NativeMonitorStore(checkpointDb + ".bak.2").Load(channelId).Revision == 1,
    "5분 후 두 세대 백업 회전이 실패함");

var secondLive = live with { Id = "secondlive1", Url = "https://www.youtube.com/watch?v=secondlive1" };
var changedLiveSnapshot = snapshot with { Live = secondLive, CheckedAt = checkedAt.AddMinutes(11) };
File.WriteAllBytes(checkpointDb + ".backup.tmp", [1, 2, 3]);
checkpointClock = checkedAt.AddMinutes(11);
var failingCheckpointRunner = new NativeMonitorRunner(checkpointStore,
    new FixtureSnapshotSource(changedLiveSnapshot), checkpointEffects, checkpoint);
ExpectFailure(() => failingCheckpointRunner.RunChannelOnceAsync(channelId, settings).GetAwaiter().GetResult(),
    "백업 실패 후 알림 또는 URL 효과를 계속 실행함");
Require(checkpointStore.Load(channelId).Revision == 4 && checkpoint.BackupCount == 2
    && checkpointEffects.OpenedUrls.Count == 1,
    "백업 실패 뒤 커밋 상태 또는 효과 차단이 올바르지 않음");
var fatalScheduler = new NativeMonitorScheduler(checkpointStore, failingCheckpointRunner,
    (_, _) => Task.CompletedTask);
ExpectFailure(() => fatalScheduler.RunAsync(CancellationToken.None).GetAwaiter().GetResult(),
    "백업 실패 후 주기 감시가 계속됨");
Require(fatalScheduler.LastSweep is { Completed.Count: 0, Errors.Count: 1 }
    && checkpointStore.Load(channelId).Revision == 5 && checkpointEffects.OpenedUrls.Count == 1,
    "백업 실패를 감시 오류로 기록하지 않거나 효과를 반복함");
Require(StoreImporter.Verify(source, checkpointDb).Samples == 1,
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
File.WriteAllBytes(forcedDb + ".backup.tmp", [1]);
forcedClock = checkedAt.AddMinutes(3);
var thirdLive = live with { Id = "thirdlive11", Url = "https://www.youtube.com/watch?v=thirdlive11" };
var thirdForcedRunner = new NativeMonitorRunner(forcedStore,
    new FixtureSnapshotSource(snapshot with { Live = thirdLive, CheckedAt = forcedClock }),
    forcedEffects, forcedCheckpoint);
ExpectFailure(() => thirdForcedRunner.RunChannelOnceAsync(channelId, settings).GetAwaiter().GetResult(),
    "새 방송의 긴급 백업 실패 후 URL을 열었음");
Require(forcedStore.Load(channelId).Revision == 4 && forcedEffects.OpenedUrls.Count == 2,
    "긴급 백업 실패에서 이미 저장한 키 또는 효과 차단이 깨짐");

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
