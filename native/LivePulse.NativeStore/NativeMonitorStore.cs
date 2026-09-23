using System.Globalization;
using System.Text.Json;
using LivePulse.Core;
using Microsoft.Data.Sqlite;

namespace LivePulse.NativeStore;

public sealed record StoredTracking(long Revision, ChannelTrackingState Tracking,
    SubscriberObservation? LastSubscriberSample);

// Explicit-path, isolated write proof. Production startup, backups and rollback are not connected.
public sealed class NativeMonitorStore
{
    private readonly string connectionString;

    public NativeMonitorStore(string databasePath)
    {
        if (!File.Exists(databasePath)) throw new FileNotFoundException("이전 DB가 없습니다.", databasePath);
        connectionString = new SqliteConnectionStringBuilder
        {
            DataSource = Path.GetFullPath(databasePath),
            Mode = SqliteOpenMode.ReadWrite,
            Pooling = false
        }.ToString();
        using var connection = Open();
        using (var marker = connection.CreateCommand())
        {
            marker.CommandText = "SELECT value FROM meta WHERE key='migration_complete'";
            if (marker.ExecuteScalar() as string != "1")
                throw new InvalidDataException("완료된 JSON 이전 DB만 열 수 있습니다.");
            marker.CommandText = "SELECT value FROM meta WHERE key='source_sha256'";
            if (marker.ExecuteScalar() is not string sourceHash || sourceHash.Length != 64
                || sourceHash.Any(character => !Uri.IsHexDigit(character)))
                throw new InvalidDataException("이전 원본의 SHA-256 표시가 없습니다.");
        }
        using (var check = connection.CreateCommand())
        {
            check.CommandText = "PRAGMA quick_check";
            if (check.ExecuteScalar() as string != "ok")
                throw new InvalidDataException("SQLite 무결성 검사가 실패했습니다.");
        }
        using var schema = connection.CreateCommand();
        schema.CommandText = """
            CREATE TABLE IF NOT EXISTS runtime_tracking(
              channel_id TEXT PRIMARY KEY,
              revision INTEGER NOT NULL,
              seen_video_ids_json TEXT NOT NULL,
              seen_post_ids_json TEXT NOT NULL,
              opened_broadcast_ids_json TEXT NOT NULL,
              last_video_id TEXT,
              last_post_id TEXT,
              title TEXT NOT NULL,
              avatar_url TEXT NOT NULL,
              last_checked_at TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS runtime_events(
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              event_key TEXT NOT NULL UNIQUE,
              payload_json TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS runtime_subscriber_samples(
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              channel_id TEXT NOT NULL,
              at TEXT NOT NULL,
              count INTEGER NOT NULL);
            CREATE INDEX IF NOT EXISTS runtime_subscribers_by_channel
              ON runtime_subscriber_samples(channel_id,id);
            """;
        schema.ExecuteNonQuery();
    }

    public StoredTracking Load(string channelId)
    {
        using var connection = Open();
        using var channel = connection.CreateCommand();
        channel.CommandText = "SELECT metadata_json FROM channels WHERE id=$id";
        channel.Parameters.AddWithValue("$id", channelId);
        if (channel.ExecuteScalar() is not string importedJson)
            throw new KeyNotFoundException("저장된 채널을 찾지 못했습니다.");

        ChannelTrackingState tracking;
        long revision;
        using (var overlay = connection.CreateCommand())
        {
            overlay.CommandText = """
                SELECT revision,seen_video_ids_json,seen_post_ids_json,opened_broadcast_ids_json,last_video_id,last_post_id
                FROM runtime_tracking WHERE channel_id=$id
                """;
            overlay.Parameters.AddWithValue("$id", channelId);
            using var reader = overlay.ExecuteReader();
            if (reader.Read())
            {
                revision = reader.GetInt64(0);
                tracking = new ChannelTrackingState(ParseArray(reader.GetString(1)), ParseArray(reader.GetString(2)),
                    ParseArray(reader.GetString(3)) ?? [], reader.IsDBNull(4) ? null : reader.GetString(4),
                    reader.IsDBNull(5) ? null : reader.GetString(5));
            }
            else
            {
                revision = 0;
                tracking = ReadImportedTracking(importedJson);
            }
        }
        return new StoredTracking(revision, tracking, ReadLastSubscriber(connection, channelId));
    }

    public long Commit(string channelId, long expectedRevision, YouTubeSnapshot snapshot, MonitorChangePlan plan)
    {
        using var connection = Open();
        using var transaction = connection.BeginTransaction();
        using (var exists = connection.CreateCommand())
        {
            exists.Transaction = transaction;
            exists.CommandText = "SELECT 1 FROM channels WHERE id=$id";
            exists.Parameters.AddWithValue("$id", channelId);
            if (exists.ExecuteScalar() is null) throw new KeyNotFoundException("저장된 채널을 찾지 못했습니다.");
        }
        long revision;
        using (var current = connection.CreateCommand())
        {
            current.Transaction = transaction;
            current.CommandText = "SELECT revision FROM runtime_tracking WHERE channel_id=$id";
            current.Parameters.AddWithValue("$id", channelId);
            revision = current.ExecuteScalar() is long value ? value : 0;
        }
        if (revision != expectedRevision) throw new InvalidOperationException("채널 상태가 다른 작업에서 변경됐습니다.");
        var next = plan.NextTrackingState;
        using (var update = connection.CreateCommand())
        {
            update.Transaction = transaction;
            update.CommandText = """
                INSERT INTO runtime_tracking(channel_id,revision,seen_video_ids_json,seen_post_ids_json,
                  opened_broadcast_ids_json,last_video_id,last_post_id,title,avatar_url,last_checked_at)
                VALUES($id,$revision,$videos,$posts,$opened,$lastVideo,$lastPost,$title,$avatar,$checked)
                ON CONFLICT(channel_id) DO UPDATE SET
                  revision=excluded.revision, seen_video_ids_json=excluded.seen_video_ids_json,
                  seen_post_ids_json=excluded.seen_post_ids_json,
                  opened_broadcast_ids_json=excluded.opened_broadcast_ids_json,
                  last_video_id=excluded.last_video_id,last_post_id=excluded.last_post_id,
                  title=excluded.title,avatar_url=excluded.avatar_url,last_checked_at=excluded.last_checked_at
                """;
            update.Parameters.AddWithValue("$id", channelId);
            update.Parameters.AddWithValue("$revision", revision + 1);
            update.Parameters.AddWithValue("$videos", JsonSerializer.Serialize(next.SeenVideoIds));
            update.Parameters.AddWithValue("$posts", JsonSerializer.Serialize(next.SeenPostIds));
            update.Parameters.AddWithValue("$opened", JsonSerializer.Serialize(next.OpenedBroadcastIds));
            update.Parameters.AddWithValue("$lastVideo", (object?)next.LastVideoId ?? DBNull.Value);
            update.Parameters.AddWithValue("$lastPost", (object?)next.LastPostId ?? DBNull.Value);
            update.Parameters.AddWithValue("$title", snapshot.Metadata.Title);
            update.Parameters.AddWithValue("$avatar", snapshot.Metadata.AvatarUrl);
            update.Parameters.AddWithValue("$checked", snapshot.CheckedAt.ToString("O", CultureInfo.InvariantCulture));
            update.ExecuteNonQuery();
        }

        var importedEventKeys = ReadImportedEventKeys(connection, transaction);
        foreach (var item in plan.Events)
        {
            if (item.ChannelId != channelId) throw new InvalidDataException("다른 채널 이벤트를 저장할 수 없습니다.");
            var key = $"{channelId}|{item.Type}|{item.SourceId}";
            if (importedEventKeys.Contains(key)) continue;
            using var insert = connection.CreateCommand();
            insert.Transaction = transaction;
            insert.CommandText = "INSERT OR IGNORE INTO runtime_events(event_key,payload_json) VALUES($key,$payload)";
            insert.Parameters.AddWithValue("$key", key);
            insert.Parameters.AddWithValue("$payload", JsonSerializer.Serialize(item));
            insert.ExecuteNonQuery();
        }
        using (var bound = connection.CreateCommand())
        {
            bound.Transaction = transaction;
            bound.CommandText = "DELETE FROM runtime_events WHERE id NOT IN (SELECT id FROM runtime_events ORDER BY id DESC LIMIT 100)";
            bound.ExecuteNonQuery();
        }
        if (plan.SubscriberSampleToAppend is { } sample)
        {
            using var insert = connection.CreateCommand();
            insert.Transaction = transaction;
            insert.CommandText = "INSERT INTO runtime_subscriber_samples(channel_id,at,count) VALUES($id,$at,$count)";
            insert.Parameters.AddWithValue("$id", channelId);
            insert.Parameters.AddWithValue("$at", sample.At.ToString("O", CultureInfo.InvariantCulture));
            insert.Parameters.AddWithValue("$count", sample.Count);
            insert.ExecuteNonQuery();
        }
        transaction.Commit();
        return revision + 1;
    }

    private SqliteConnection Open()
    {
        var connection = new SqliteConnection(connectionString);
        connection.Open();
        return connection;
    }

    private static ChannelTrackingState ReadImportedTracking(string json)
    {
        using var document = JsonDocument.Parse(json);
        var root = document.RootElement;
        if (root.ValueKind != JsonValueKind.Object) throw new InvalidDataException("채널 메타데이터가 올바르지 않습니다.");
        return new ChannelTrackingState(OptionalArray(root, "seenVideoIds"), OptionalArray(root, "seenPostIds"),
            OptionalArray(root, "openedBroadcastIds") ?? [], OptionalString(root, "lastVideoId"),
            OptionalString(root, "lastPostId"));
    }

    private static IReadOnlyList<string>? OptionalArray(JsonElement root, string property)
        => !root.TryGetProperty(property, out var value) || value.ValueKind == JsonValueKind.Null
            ? null : ParseArray(value.GetRawText());

    private static IReadOnlyList<string>? ParseArray(string json)
    {
        using var document = JsonDocument.Parse(json);
        if (document.RootElement.ValueKind == JsonValueKind.Null) return null;
        if (document.RootElement.ValueKind != JsonValueKind.Array)
            throw new InvalidDataException("추적 ID 배열이 올바르지 않습니다.");
        var ids = new List<string>();
        foreach (var item in document.RootElement.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.String || item.GetString() is not { } id)
                throw new InvalidDataException("추적 ID 배열이 올바르지 않습니다.");
            ids.Add(id);
        }
        return ids;
    }

    private static string? OptionalString(JsonElement root, string property)
    {
        if (!root.TryGetProperty(property, out var value) || value.ValueKind == JsonValueKind.Null) return null;
        return value.ValueKind == JsonValueKind.String ? value.GetString()
            : throw new InvalidDataException("채널 메타데이터 문자열이 올바르지 않습니다.");
    }

    private static SubscriberObservation? ReadLastSubscriber(SqliteConnection connection, string channelId)
    {
        foreach (var sql in new[]
        {
            "SELECT at,count FROM runtime_subscriber_samples WHERE channel_id=$id ORDER BY id DESC LIMIT 1",
            "SELECT at,count FROM samples WHERE source='local' AND kind='subscriber' AND video_id='' AND channel_id=$id ORDER BY ordinal DESC LIMIT 1"
        })
        {
            using var command = connection.CreateCommand();
            command.CommandText = sql;
            command.Parameters.AddWithValue("$id", channelId);
            using var reader = command.ExecuteReader();
            if (!reader.Read()) continue;
            if (!DateTimeOffset.TryParse(reader.GetString(0), CultureInfo.InvariantCulture,
                    DateTimeStyles.AssumeUniversal, out var at))
                throw new InvalidDataException("구독자 표본 시각이 올바르지 않습니다.");
            return new SubscriberObservation(at, reader.GetInt64(1));
        }
        return null;
    }

    private static HashSet<string> ReadImportedEventKeys(SqliteConnection connection, SqliteTransaction transaction)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "SELECT value FROM meta WHERE key='events'";
        if (command.ExecuteScalar() is not string json) throw new InvalidDataException("기존 이벤트가 없습니다.");
        using var document = JsonDocument.Parse(json);
        if (document.RootElement.ValueKind != JsonValueKind.Array)
            throw new InvalidDataException("기존 이벤트 목록이 올바르지 않습니다.");
        var keys = new HashSet<string>(StringComparer.Ordinal);
        foreach (var item in document.RootElement.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.Object) continue;
            var channel = OptionalString(item, "channelId");
            var type = OptionalString(item, "type");
            var subject = OptionalString(item, "sourceId") ?? OptionalString(item, "url") ?? OptionalString(item, "detail");
            if (channel is not null && type is not null && subject is not null)
                keys.Add($"{channel}|{type}|{subject}");
        }
        return keys;
    }
}
