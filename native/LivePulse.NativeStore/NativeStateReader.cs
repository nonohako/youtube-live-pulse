using System.Globalization;
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

    public int CountLiveChannels()
    {
        using var connection = new SqliteConnection(connectionString);
        connection.Open();
        using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT count(*) FROM runtime_snapshots
            WHERE json_type(payload_json,'$.live')='object'
              AND channel_id NOT IN (SELECT id FROM runtime_removed_channels)
            """;
        return Convert.ToInt32(command.ExecuteScalar());
    }

    public JsonObject Read(string? subscriberId = null,
        IReadOnlyList<(string ChannelId, string VideoId)>? selectedVideos = null,
        MonitorSweepResult? monitorSweep = null)
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
            // Electron refreshed the stored name/avatar on every check; new channels start as placeholders.
            using (var latest = connection.CreateCommand())
            {
                latest.CommandText = "SELECT title,avatar_url FROM runtime_tracking WHERE channel_id=$id";
                latest.Parameters.AddWithValue("$id", id);
                using var row = latest.ExecuteReader();
                if (row.Read())
                {
                    if (!string.IsNullOrEmpty(row.GetString(0))) channel["title"] = row.GetString(0);
                    if (!string.IsNullOrEmpty(row.GetString(1))) channel["avatarUrl"] = row.GetString(1);
                }
            }
            var snapshot = Scalar(connection,
                "SELECT payload_json FROM runtime_snapshots WHERE channel_id=$id", id);
            channel["snapshot"] = snapshot is null ? null : JsonNode.Parse(snapshot);
            channel["status"] = snapshot is null ? "waiting" : "online";
            channel["error"] = null;
            if (monitorSweep?.ChannelErrors.TryGetValue(id, out var failure) == true)
            {
                channel["status"] = "error";
                channel["error"] = failure;
                // Preserve the saved snapshot, but never present stale broadcasts as current.
                if (channel["snapshot"] is JsonObject stale)
                {
                    stale["live"] = null;
                    stale["upcoming"] = new JsonArray();
                    stale["warnings"] = new JsonArray(JsonValue.Create(failure));
                }
            }
            else if (monitorSweep?.Completed.FirstOrDefault(item => item.ChannelId == id) is { EffectErrors.Count: > 0 } run)
            {
                channel["status"] = "degraded";
                channel["error"] = string.Join(" · ", run.EffectErrors);
                if (channel["snapshot"] is JsonObject current)
                {
                    // The renderer adds an automatic-retry promise to snapshot warnings.
                    // Effects are deduplicated, so expose their errors without that promise.
                    var warnings = (current["warnings"] as JsonArray)?.Select(item => item!.GetValue<string>()) ?? [];
                    channel["error"] = string.Join(" · ", warnings.Concat(run.EffectErrors));
                    current["warnings"] = new JsonArray();
                }
            }
            channel["subscriberHistory"] = Samples(connection, id, "subscriber", "", full: subscriberId == id);
            channel["videoViewHistories"] = Videos(connection, id, selectedVideos);
            channels.Add(channel);
        }
        // Removed channels' events are hidden; the list is ordered by time below.
        var eventItems = new List<JsonObject>();
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
                if (ids.Contains((string?)item["channelId"] ?? "")) eventItems.Add(item);
            }
        }
        foreach (var item in JsonNode.Parse(Meta(connection, "events"))?.AsArray() ?? new JsonArray())
            if (item is JsonObject imported && ids.Contains((string?)imported["channelId"] ?? ""))
                eventItems.Add(imported.DeepClone().AsObject());
        foreach (var item in eventItems)
        {
            // A new-video event shows the cloud collector's official publish time (the user's reference
            // record); detection time is kept as detectedAt. Events stored before 2026-09-27 have no
            // time and fall back to locally recorded publish metadata. Never invent a time.
            if ((string?)item["type"] != "video" || (string?)item["sourceId"] is not { } videoId) continue;
            var channelId = (string)item["channelId"]!;
            if (PublishedAt(connection, channelId, videoId, cloudOnly: true) is { } cloudTime)
            {
                if (item["at"] is not null) item["detectedAt"] = item["at"]!.DeepClone();
                item["at"] = cloudTime;
            }
            else if (item["at"] is null) item["at"] = PublishedAt(connection, channelId, videoId, cloudOnly: false);
        }
        var events = new JsonArray(eventItems
            .OrderByDescending(item => DateTimeOffset.TryParse((string?)item["at"], out var at) ? at : DateTimeOffset.MinValue)
            .Take(100).ToArray<JsonNode>());
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
                    ["message"] = "포터블 빌드는 native/publish-portable.ps1로 다시 빌드해 업데이트합니다." } }
        };
    }

    private static string? PublishedAt(SqliteConnection connection, string channelId, string videoId, bool cloudOnly)
    {
        using var command = connection.CreateCommand();
        command.CommandText = cloudOnly
            ? "SELECT json_extract(metadata_json,'$.publishedAt') FROM runtime_cloud_videos WHERE channel_id=$channel AND video_id=$video"
            : """
            SELECT json_extract(metadata_json,'$.publishedAt') FROM runtime_cloud_videos WHERE channel_id=$channel AND video_id=$video
            UNION ALL SELECT json_extract(metadata_json,'$.publishedAt') FROM runtime_video_metadata WHERE channel_id=$channel AND video_id=$video
            UNION ALL SELECT json_extract(metadata_json,'$.publishedAt') FROM series WHERE channel_id=$channel AND kind='video' AND video_id=$video
            """;
        command.Parameters.AddWithValue("$channel", channelId);
        command.Parameters.AddWithValue("$video", videoId);
        using var reader = command.ExecuteReader();
        while (reader.Read())
            if (!reader.IsDBNull(0) && reader.GetValue(0) is string text && DateTimeOffset.TryParse(text, out _)) return text;
        return null;
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
                SELECT video_id FROM series_keys WHERE source='runtime-cloud' AND channel_id=$id AND kind='video'
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
        using var endpoints = new VideoEndpointReader(connection, channelId);
        foreach (var (videoId, video) in videos)
        {
            video["videoId"] = videoId;
            video["title"] ??= videoId;
            video["url"] ??= "https://www.youtube.com/watch?v=" + videoId;
            video["samples"] = selected.Any(item => item.ChannelId == channelId && item.VideoId == videoId)
                ? Samples(connection, channelId, "video", videoId, full: true)
                : endpoints.Read(videoId);
            output.Add(video);
        }
        return output;
    }

    // First/last observation of each video across its series (imported, cloud sync, local checks):
    // two prepared index seeks per series; the series list for the channel is loaded once.
    private sealed class VideoEndpointReader : IDisposable
    {
        private readonly Dictionary<string, List<(long Series, int Priority)>> series = new(StringComparer.Ordinal);
        private readonly SqliteCommand first;
        private readonly SqliteCommand last;

        public VideoEndpointReader(SqliteConnection connection, string channelId)
        {
            using (var command = connection.CreateCommand())
            {
                command.CommandText = "SELECT k.id,k.video_id," + NativeObservations.PrioritySql
                    + " FROM series_keys k WHERE k.channel_id=$id AND k.kind='video'";
                command.Parameters.AddWithValue("$id", channelId);
                using var reader = command.ExecuteReader();
                while (reader.Read())
                {
                    if (!series.TryGetValue(reader.GetString(1), out var list)) series[reader.GetString(1)] = list = [];
                    list.Add((reader.GetInt64(0), reader.GetInt32(2)));
                }
            }
            first = Prepare(connection, "ASC");
            last = Prepare(connection, "DESC");
        }

        private static SqliteCommand Prepare(SqliteConnection connection, string direction)
        {
            var command = connection.CreateCommand();
            command.CommandText = $"SELECT at,count FROM observations WHERE series=$series ORDER BY at {direction} LIMIT 1";
            command.Parameters.AddWithValue("$series", 0L);
            command.Prepare();
            return command;
        }

        public JsonArray Read(string videoId)
        {
            var candidates = new List<(long At, long Count, int Priority)>();
            foreach (var (id, priority) in series.GetValueOrDefault(videoId) ?? [])
                foreach (var command in new[] { first, last })
                {
                    command.Parameters["$series"].Value = id;
                    using var reader = command.ExecuteReader();
                    if (reader.Read()) candidates.Add((reader.GetInt64(0), reader.GetInt64(1), priority));
                }
            var output = new JsonArray();
            if (candidates.Count == 0) return output;
            var start = candidates.Min(item => item.At);
            var end = candidates.Max(item => item.At);
            foreach (var at in start == end ? new[] { start } : new[] { start, end })
            {
                var selected = candidates.Where(item => item.At == at).MaxBy(item => item.Priority);
                output.Add(new JsonObject { ["at"] = NativeObservations.ToIso(at), ["count"] = selected.Count });
            }
            return output;
        }

        public void Dispose()
        {
            first.Dispose();
            last.Dispose();
        }
    }

    private static JsonArray Samples(SqliteConnection connection, string channelId, string kind,
        string videoId, bool full)
    {
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT o.at,o.count," + NativeObservations.PrioritySql + """
             AS priority
            FROM series_keys k JOIN observations o ON o.series=k.id
            WHERE k.channel_id=$id AND k.kind=$kind AND k.video_id=$video
            ORDER BY o.at,priority
            """;
        command.Parameters.AddWithValue("$id", channelId);
        command.Parameters.AddWithValue("$kind", kind);
        command.Parameters.AddWithValue("$video", videoId);
        var all = full ? new List<KeyValuePair<long, long>>() : null;
        // The overview spans the whole history: the first observation, then each local day's last
        // real observation (the newest 119 days), ending with the latest one. Minute-level cloud
        // samples would otherwise make "the latest N samples" cover only the last hour.
        var tail = new Queue<KeyValuePair<long, long>>();
        KeyValuePair<long, long>? first = null;
        KeyValuePair<long, long>? dayLast = null;
        DateOnly? day = null;
        KeyValuePair<long, long>? pending = null;
        void Keep(KeyValuePair<long, long> sample)
        {
            if (full) { all!.Add(sample); return; }
            if (first is null) { first = sample; return; }
            DateOnly? sampleDay = DateOnly.FromDateTime(DateTimeOffset.FromUnixTimeMilliseconds(sample.Key).LocalDateTime);
            if (dayLast is { } closed && sampleDay != day)
            {
                tail.Enqueue(closed);
                if (tail.Count > 119) tail.Dequeue();
            }
            day = sampleDay;
            dayLast = sample;
        }
        using var reader = command.ExecuteReader();
        while (reader.Read())
        {
            var sample = new KeyValuePair<long, long>(reader.GetInt64(0), reader.GetInt64(1));
            if (pending is { } previous && previous.Key != sample.Key) Keep(previous);
            pending = sample;
        }
        if (pending is { } last) Keep(last);
        if (!full && dayLast is { } latest)
        {
            tail.Enqueue(latest);
            if (tail.Count > 119) tail.Dequeue();
        }
        IEnumerable<KeyValuePair<long, long>> observations = full ? all! : first is { } start
            ? new[] { start }.Concat(tail).ToArray() : [];
        var output = new JsonArray();
        foreach (var (at, count) in observations)
            output.Add(new JsonObject { ["at"] = NativeObservations.ToIso(at), ["count"] = count });
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
