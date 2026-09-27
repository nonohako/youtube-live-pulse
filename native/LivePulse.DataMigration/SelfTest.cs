using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace LivePulse.DataMigration;

internal static class SelfTest
{
    internal static void Run()
    {
        var directory = Path.Combine(Path.GetTempPath(), "LivePulseMigrationTest-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        var source = Path.Combine(directory, "source.json");
        var database = Path.Combine(directory, "output.sqlite");
        File.WriteAllText(source, """
            {
              "version": 3,
              "settings": {"pollIntervalSeconds": 30, "apiKey": "test-only"},
              "events": [{"id": "event-1"}],
              "channels": [{
                "id": "UCtest", "title": "Test", "openedBroadcastIds": ["broadcast-1"],
                "subscriberHistory": [
                  {"at": "2026-09-01T00:00:00.000Z", "count": 100},
                  {"at": "2026-09-01T00:00:00.000Z", "count": 101}
                ],
                "videoViewHistories": [{"videoId": "video-1", "title": "Video", "samples": [
                  {"at": "2026-09-02T00:00:00.000Z", "count": 200}
                ]}]
              }],
              "cloud": {"cursor": 7, "channels": {"UCtest": {
                "subscriberHistory": [{"at": "2026-09-03T00:00:00.000Z", "count": 300}],
                "videoViewHistories": [{"videoId": "video-1", "samples": [
                  {"at": "2026-09-04T00:00:00.000Z", "count": 400}
                ]}]
              }}}
            }
            """);
        var initial = StoreImporter.Import(source, database);
        Require(initial.Channels == 1 && initial.Series == 4 && initial.Samples == 5 && !initial.Reused,
            "초기 이전 표본 수가 다릅니다.");
        var repeated = StoreImporter.Import(source, database);
        Require(repeated.Reused && repeated.Samples == 5, "재실행이 idempotent하지 않습니다.");
        var verified = StoreImporter.Verify(source, database);
        Require(verified.Samples == 5, "재시작 검증 표본 수가 다릅니다.");
        using (var document = JsonDocument.Parse(File.ReadAllText(source)))
            Require(document.RootElement.GetProperty("channels")[0].GetProperty("subscriberHistory").GetArrayLength() == 2,
                "동일 시각 중복 표본이 원본에서 사라졌습니다.");

        var originalSource = File.ReadAllText(source);
        File.AppendAllText(source, " ");
        ExpectFailure(() => StoreImporter.Verify(source, database), "원본 변경을 감지하지 못했습니다.");
        File.WriteAllText(source, originalSource);
        using (var connection = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = database }.ToString()))
        {
            connection.Open();
            using var command = connection.CreateCommand();
            command.CommandText = "UPDATE samples SET count=count+1 WHERE source='local' AND kind='subscriber' AND ordinal=0";
            Require(command.ExecuteNonQuery() == 1, "손상 테스트 표본을 찾지 못했습니다.");
        }
        ExpectFailure(() => StoreImporter.Verify(source, database), "표본 열 손상을 감지하지 못했습니다.");
        var malformed = Path.Combine(directory, "malformed.json");
        File.WriteAllText(malformed, "{broken");
        var malformedOutput = Path.Combine(directory, "malformed.sqlite");
        ExpectFailure(() => StoreImporter.Import(malformed, malformedOutput), "손상된 JSON이 성공 처리됐습니다.");
        Require(!File.Exists(malformedOutput), "손상된 JSON에서 DB가 만들어졌습니다.");
        Console.WriteLine("SELF_TEST_PASSED");
    }

    private static void Require(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }

    private static void ExpectFailure(Action action, string message)
    {
        try { action(); }
        catch { return; }
        throw new InvalidOperationException(message);
    }
}
