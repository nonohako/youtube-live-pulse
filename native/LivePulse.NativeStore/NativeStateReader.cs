using System.Text.Json.Nodes;
using Microsoft.Data.Sqlite;

namespace LivePulse.NativeStore;

// Reads only when a window requests state. The tray loop never materializes chart archives.
public sealed class NativeStateReader
{
    private readonly string connectionString;

    public NativeStateReader(string databasePath)
    {
        _ = new NativeCloudArchive(databasePath);
        connectionString = new SqliteConnectionStringBuilder
        {
            DataSource = Path.GetFullPath(databasePath), Mode = SqliteOpenMode.ReadOnly, Pooling = false
        }.ToString();
    }

    public JsonObject Read(string? subscriberId = null,
        IReadOnlyList<(string ChannelId, string VideoId)>? selectedVideos = null)
    {
        selectedVideos ??= [];
        if (selectedVideos.Count > 4) throw new InvalidDataException("분석 영상은 최대 네 개입니다.");
        using var connection = new SqliteConnection(connectionString);
        connection.Open();
        var settings = JsonNode.Parse(Meta(connection, "settings"))?.AsObject()
            ?? throw new InvalidDataException("저장된 설정을 읽을 수 없습니다.");
        var hasApiKey = !string.IsNullOrEmpty((string?)settings["apiKey"]);
        var hasCloudToken = !string.IsNullOrEmpty((string?)settings["cloudToken"]);
        settings.Remove("apiKey");
        settings.Remove("cloudToken");
        settings["hasApiKey"] = hasApiKey;
        settings["hasCloudToken"] = hasCloudToken;
        var channels = new JsonArray();
        var savedChannels = new List<(string Id, string Json)>();
        using (var command = connection.CreateCommand())
        {
            command.CommandText = """
                SELECT id,metadata_json FROM (
                  SELECT id,metadata_json,rowid AS position,0 AS section FROM channels
                  UNION ALL SELECT id,metadata_json,rowid AS position,1 AS section FROM runtime_channels)
                WHERE id NOT IN (SELECT id FROM runtime_removed_channels)
                ORDER BY section,position
                """;
            using var reader = command.ExecuteReader();
            while (reader.Read()) savedChannels.Add((reader.GetString(0), reader.GetString(1)));
        }
        var ids = savedChannels.Select(item => item.Id).ToHashSet(StringComparer.Ordinal);
        if (subscriberId is not null && !ids.Contains(subscriberId))
            throw new InvalidDataException("분석 채널을 찾을 수 없습니다.");
        if (selectedVideos.Any(item => !ids.Contains(item.ChannelId)
            || item.VideoId.Length != 11 || item.VideoId.Any(c => !char.IsAsciiLetterOrDigit(c) && c is not '_' and not '-')))
            throw new InvalidDataException("분석 영상을 찾을 수 없습니다.");
        foreach (var (id, json) in savedChannels)
        {
            var channel = JsonNode.Parse(json)?.AsObject()
                ?? throw new InvalidDataException("저장된 채널을 읽을 수 없습니다.");
            channel["id"] = id;
            var snapshot = Scalar(connection,
                "SELECT payload_json FROM runtime_snapshots WHERE channel_id=$id", id);
            channel["snapshot"] = snapshot is null ? null : JsonNode.Parse(snapshot);
            channel["status"] = snapshot is null ? "waiting" : "online";
            channel["error"] = null;
            channel["subscriberHistory"] = Samples(connection, id, "subscriber", "", full: subscriberId == id);
            channel["videoViewHistories"] = Videos(connection, id, selectedVideos);
            channels.Add(channel);
        }
        var events = JsonNode.Parse(Meta(connection, "events"))?.AsArray() ?? new JsonArray();
        using (var command = connection.CreateCommand())
        {
            command.CommandText = "SELECT payload_json FROM runtime_events ORDER BY id DESC LIMIT 100";
            using var reader = command.ExecuteReader();
            while (reader.Read())
            {
                var item = JsonNode.Parse(reader.GetString(0))?.AsObject();
                if (item is null) continue;
                foreach (var key in item.Select(pair => pair.Key).ToArray())
                    if (key.Length > 0 && char.IsUpper(key[0]))
                    {
                        item[char.ToLowerInvariant(key[0]) + key[1..]] = item[key]?.DeepClone();
                        item.Remove(key);
                    }
                events.Add(item);
            }
        }
        var cloud = new JsonObject { ["lastSyncAt"] = null, ["lastCollectionAt"] = null, ["error"] = null };
        using (var command = connection.CreateCommand())
        {
            command.CommandText = "SELECT last_sync_at,last_collection_at,error FROM runtime_cloud_state WHERE id=1";
            using var reader = command.ExecuteReader();
            if (reader.Read())
            {
                cloud["lastSyncAt"] = reader.GetString(0);
                cloud["lastCollectionAt"] = reader.IsDBNull(1) ? null : reader.GetString(1);
                cloud["error"] = reader.IsDBNull(2) ? null : reader.GetString(2);
            }
        }
        return new JsonObject
        {
            ["settings"] = settings,
            ["channels"] = channels,
            ["events"] = events,
            ["cloud"] = cloud,
            ["monitor"] = new JsonObject { ["running"] = true,
                ["nextCheckAt"] = null, ["pollIntervalSeconds"] = settings["pollIntervalSeconds"]?.DeepClone() ?? 30 },
            ["analyticsLazy"] = true,
            ["app"] = new JsonObject { ["windowActive"] = true, ["isPackaged"] = false,
                ["loginSettingApplied"] = false, ["version"] = "prototype",
                ["update"] = new JsonObject { ["status"] = "development", ["currentVersion"] = "prototype",
                    ["message"] = "개인용 시제품에서는 업데이트를 확인하지 않습니다." } }
        };
    }

    private static JsonArray Videos(SqliteConnection connection, string channelId,
        IReadOnlyList<(string ChannelId, string VideoId)> selected)
    {
        var videos = new Dictionary<string, JsonObject>(StringComparer.Ordinal);
        using (var command = connection.CreateCommand())
        {
            command.CommandText = """
                SELECT video_id,metadata_json FROM series
                WHERE channel_id=$id AND kind='video' ORDER BY CASE source WHEN 'cloud' THEN 0 ELSE 1 END
                """;
            command.Parameters.AddWithValue("$id", channelId);
            using var reader = command.ExecuteReader();
            while (reader.Read())
                videos[reader.GetString(0)] = JsonNode.Parse(reader.GetString(1))?.AsObject() ?? new JsonObject();
        }
        using (var command = connection.CreateCommand())
        {
            command.CommandText = "SELECT video_id,metadata_json FROM runtime_cloud_videos WHERE channel_id=$id";
            command.Parameters.AddWithValue("$id", channelId);
            using var reader = command.ExecuteReader();
            while (reader.Read())
            {
                var videoId = reader.GetString(0);
                if (!videos.ContainsKey(videoId))
                    videos[videoId] = JsonNode.Parse(reader.GetString(1))?.AsObject() ?? new JsonObject();
            }
        }
        using (var command = connection.CreateCommand())
        {
            command.CommandText = """
                SELECT DISTINCT video_id FROM runtime_cloud_samples
                WHERE channel_id=$id AND kind='video'
                """;
            command.Parameters.AddWithValue("$id", channelId);
            using var reader = command.ExecuteReader();
            while (reader.Read()) videos.TryAdd(reader.GetString(0), new JsonObject());
        }
        using (var command = connection.CreateCommand())
        {
            command.CommandText = "SELECT video_id,metadata_json FROM runtime_video_metadata WHERE channel_id=$id";
            command.Parameters.AddWithValue("$id", channelId);
            using var reader = command.ExecuteReader();
            while (reader.Read())
                videos[reader.GetString(0)] = JsonNode.Parse(reader.GetString(1))?.AsObject() ?? new JsonObject();
        }
        var output = new JsonArray();
        foreach (var (videoId, video) in videos)
        {
            video["videoId"] = videoId;
            video["title"] ??= videoId;
            video["url"] ??= "https://www.youtube.com/watch?v=" + videoId;
            video["samples"] = selected.Any(item => item.ChannelId == channelId && item.VideoId == videoId)
                ? Samples(connection, channelId, "video", videoId, full: true)
                : VideoEndpoints(connection, channelId, videoId);
            output.Add(video);
        }
        return output;
    }

    private static JsonArray VideoEndpoints(SqliteConnection connection, string channelId, string videoId)
    {
        var candidates = new List<(string At, long Count, int Priority)>();
        foreach (var (table, source, priority) in new[]
        {
            ("samples", "local", 2), ("samples", "cloud", 1),
            ("runtime_cloud_samples", "", 1), ("runtime_video_samples", "", 3)
        })
        {
            foreach (var direction in new[] { "ASC", "DESC" })
            {
                using var command = connection.CreateCommand();
                command.CommandText = table == "samples"
                    ? $"SELECT at,count FROM samples WHERE source=$source AND channel_id=$id AND kind='video' AND video_id=$video ORDER BY at {direction} LIMIT 1"
                    : table == "runtime_cloud_samples"
                    ? $"SELECT at,count FROM runtime_cloud_samples WHERE channel_id=$id AND kind='video' AND video_id=$video ORDER BY at {direction} LIMIT 1"
                    : $"SELECT at,count FROM runtime_video_samples WHERE channel_id=$id AND video_id=$video ORDER BY at {direction} LIMIT 1";
                if (table == "samples") command.Parameters.AddWithValue("$source", source);
                command.Parameters.AddWithValue("$id", channelId);
                command.Parameters.AddWithValue("$video", videoId);
                using var reader = command.ExecuteReader();
                if (reader.Read()) candidates.Add((reader.GetString(0), reader.GetInt64(1), priority));
            }
        }
        var output = new JsonArray();
        foreach (var at in candidates.Select(item => item.At).Distinct(StringComparer.Ordinal)
            .OrderBy(at => at, StringComparer.Ordinal).Take(1)
            .Concat(candidates.Select(item => item.At).Distinct(StringComparer.Ordinal)
                .OrderByDescending(at => at, StringComparer.Ordinal).Take(1))
            .Distinct(StringComparer.Ordinal))
        {
            var selected = candidates.Where(item => item.At == at).MaxBy(item => item.Priority);
            output.Add(new JsonObject { ["at"] = at, ["count"] = selected.Count });
        }
        return output;
    }

    private static JsonArray Samples(SqliteConnection connection, string channelId, string kind,
        string videoId, bool full)
    {
        using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT at,count,CASE source WHEN 'local' THEN 2 ELSE 1 END AS priority
              FROM samples WHERE channel_id=$id AND kind=$kind AND video_id=$video
            UNION ALL SELECT at,count,1 FROM runtime_cloud_samples
              WHERE channel_id=$id AND kind=$kind AND video_id=$video
            UNION ALL SELECT at,count,3 FROM runtime_subscriber_samples
              WHERE $kind='subscriber' AND $video='' AND channel_id=$id
            UNION ALL SELECT at,count,3 FROM runtime_video_samples
              WHERE $kind='video' AND channel_id=$id AND video_id=$video
            ORDER BY at,priority
            """;
        command.Parameters.AddWithValue("$id", channelId);
        command.Parameters.AddWithValue("$kind", kind);
        command.Parameters.AddWithValue("$video", videoId);
        var all = full ? new List<KeyValuePair<string, long>>() : null;
        var tail = new Queue<KeyValuePair<string, long>>();
        KeyValuePair<string, long>? first = null;
        KeyValuePair<string, long>? pending = null;
        void Keep(KeyValuePair<string, long> sample)
        {
            if (full) { all!.Add(sample); return; }
            if (first is null) { first = sample; return; }
            tail.Enqueue(sample);
            if (tail.Count > 119) tail.Dequeue();
        }
        using var reader = command.ExecuteReader();
        while (reader.Read())
        {
            var sample = new KeyValuePair<string, long>(reader.GetString(0), reader.GetInt64(1));
            if (pending is { } previous && previous.Key != sample.Key) Keep(previous);
            pending = sample;
        }
        if (pending is { } last) Keep(last);
        IEnumerable<KeyValuePair<string, long>> observations = full ? all! : first is { } start
            ? new[] { start }.Concat(tail).ToArray() : [];
        var output = new JsonArray();
        foreach (var (at, count) in observations)
            output.Add(new JsonObject { ["at"] = at, ["count"] = count });
        return output;
    }

    private static string Meta(SqliteConnection connection, string key)
    {
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT value FROM meta WHERE key=$key";
        command.Parameters.AddWithValue("$key", key);
        return command.ExecuteScalar() as string ?? throw new InvalidDataException($"{key} 기록을 읽을 수 없습니다.");
    }

    private static string? Scalar(SqliteConnection connection, string sql, string id)
    {
        using var command = connection.CreateCommand();
        command.CommandText = sql;
        command.Parameters.AddWithValue("$id", id);
        return command.ExecuteScalar() as string;
    }
}
