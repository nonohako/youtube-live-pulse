using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
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
            CREATE TABLE IF NOT EXISTS runtime_snapshots(
              channel_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS runtime_channels(
              id TEXT PRIMARY KEY, metadata_json TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS runtime_removed_channels(id TEXT PRIMARY KEY);
            CREATE TABLE IF NOT EXISTS runtime_video_samples(
              channel_id TEXT NOT NULL, video_id TEXT NOT NULL, at TEXT NOT NULL, count INTEGER NOT NULL,
              PRIMARY KEY(channel_id,video_id,at));
            CREATE TABLE IF NOT EXISTS runtime_video_metadata(
              channel_id TEXT NOT NULL, video_id TEXT NOT NULL, metadata_json TEXT NOT NULL,
              PRIMARY KEY(channel_id,video_id));
            CREATE TABLE IF NOT EXISTS runtime_video_stats_state(
              channel_id TEXT PRIMARY KEY, checked_at TEXT NOT NULL);
            """;
        schema.ExecuteNonQuery();
    }

    public StoredTracking Load(string channelId)
    {
        using var connection = Open();
        using var channel = connection.CreateCommand();
        channel.CommandText = """
            SELECT metadata_json FROM (
              SELECT id,metadata_json FROM channels UNION ALL SELECT id,metadata_json FROM runtime_channels)
            WHERE id=$id AND id NOT IN (SELECT id FROM runtime_removed_channels)
            """;
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

    public MonitorPollConfiguration ReadPollConfiguration()
    {
        using var connection = Open();
        using var settingsCommand = connection.CreateCommand();
        settingsCommand.CommandText = "SELECT value FROM meta WHERE key='settings'";
        if (settingsCommand.ExecuteScalar() is not string json)
            throw new InvalidDataException("감시 설정이 없습니다.");
        using var document = JsonDocument.Parse(json);
        var settings = document.RootElement;
        if (settings.ValueKind != JsonValueKind.Object)
            throw new InvalidDataException("감시 설정이 올바르지 않습니다.");
        var interval = ReadPollInterval(settings);
        var monitorSettings = new MonitorSettings(
            ReadBoolean(settings, "autoOpenLive"), ReadBoolean(settings, "autoOpenUpcoming"),
            ReadBoolean(settings, "notifyNewVideos"), ReadBoolean(settings, "notifyNewPosts"));
        var ids = new List<string>();
        using var channels = connection.CreateCommand();
        channels.CommandText = """
            SELECT id FROM (
              SELECT id,rowid AS position,0 AS section FROM channels
              UNION ALL SELECT id,rowid AS position,1 AS section FROM runtime_channels)
            WHERE id NOT IN (SELECT id FROM runtime_removed_channels)
            ORDER BY section,position
            """;
        using var reader = channels.ExecuteReader();
        while (reader.Read()) ids.Add(reader.GetString(0));
        return new MonitorPollConfiguration(TimeSpan.FromSeconds(interval), ids, monitorSettings);
    }

    public bool NeedsVideoStatistics(string channelId, DateTimeOffset now)
    {
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT checked_at FROM runtime_video_stats_state WHERE channel_id=$id";
        command.Parameters.AddWithValue("$id", channelId);
        return command.ExecuteScalar() is not string text
            || !DateTimeOffset.TryParse(text, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var last)
            || now - last >= TimeSpan.FromMinutes(5);
    }

    public long Commit(string channelId, long expectedRevision, YouTubeSnapshot snapshot, MonitorChangePlan plan,
        IReadOnlyList<VideoCandidate>? videoStatistics = null, DateTimeOffset? videoCheckedAt = null)
    {
        using var connection = Open();
        using var transaction = connection.BeginTransaction();
        using (var exists = connection.CreateCommand())
        {
            exists.Transaction = transaction;
            exists.CommandText = """
                SELECT 1 FROM (
                  SELECT id FROM channels UNION ALL SELECT id FROM runtime_channels)
                WHERE id=$id AND id NOT IN (SELECT id FROM runtime_removed_channels)
                """;
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
        using (var savedSnapshot = connection.CreateCommand())
        {
            savedSnapshot.Transaction = transaction;
            savedSnapshot.CommandText = """
                INSERT INTO runtime_snapshots(channel_id,payload_json) VALUES($id,$json)
                ON CONFLICT(channel_id) DO UPDATE SET payload_json=excluded.payload_json
                """;
            savedSnapshot.Parameters.AddWithValue("$id", channelId);
            savedSnapshot.Parameters.AddWithValue("$json", JsonSerializer.Serialize(snapshot,
                new JsonSerializerOptions(JsonSerializerDefaults.Web)));
            savedSnapshot.ExecuteNonQuery();
        }
        if (videoCheckedAt is { } checkedAt)
        {
            foreach (var video in videoStatistics ?? [])
            {
                if (video.ViewCount is not { } count || count < 0 || count > 9_007_199_254_740_991)
                    continue;
                using (var metadata = connection.CreateCommand())
                {
                    metadata.Transaction = transaction;
                    metadata.CommandText = """
                        INSERT INTO runtime_video_metadata(channel_id,video_id,metadata_json)
                        VALUES($channel,$video,$json)
                        ON CONFLICT(channel_id,video_id) DO UPDATE SET metadata_json=excluded.metadata_json
                        """;
                    metadata.Parameters.AddWithValue("$channel", channelId);
                    metadata.Parameters.AddWithValue("$video", video.Id);
                    metadata.Parameters.AddWithValue("$json", JsonSerializer.Serialize(new
                    { videoId = video.Id, title = video.Title, url = video.Url,
                        thumbnailUrl = video.ThumbnailUrl, publishedAt = video.PublishedAt, source = "page" }));
                    metadata.ExecuteNonQuery();
                }
                using var previousVideo = connection.CreateCommand();
                previousVideo.Transaction = transaction;
                previousVideo.CommandText = """
                    SELECT at,count FROM (
                      SELECT at,count FROM samples WHERE source='local' AND kind='video'
                        AND channel_id=$channel AND video_id=$video
                      UNION ALL SELECT at,count FROM runtime_video_samples
                        WHERE channel_id=$channel AND video_id=$video)
                    ORDER BY julianday(at) DESC LIMIT 1
                    """;
                previousVideo.Parameters.AddWithValue("$channel", channelId);
                previousVideo.Parameters.AddWithValue("$video", video.Id);
                using var previousReader = previousVideo.ExecuteReader();
                var append = !previousReader.Read() || previousReader.GetInt64(1) != count
                    || !DateTimeOffset.TryParse(previousReader.GetString(0), CultureInfo.InvariantCulture,
                        DateTimeStyles.AssumeUniversal, out var previousAt)
                    || checkedAt - previousAt >= TimeSpan.FromHours(6);
                previousReader.Close();
                if (!append) continue;
                using var sampleInsert = connection.CreateCommand();
                sampleInsert.Transaction = transaction;
                sampleInsert.CommandText = """
                    INSERT OR IGNORE INTO runtime_video_samples(channel_id,video_id,at,count)
                    VALUES($channel,$video,$at,$count)
                    """;
                sampleInsert.Parameters.AddWithValue("$channel", channelId);
                sampleInsert.Parameters.AddWithValue("$video", video.Id);
                sampleInsert.Parameters.AddWithValue("$at", checkedAt.ToString("O", CultureInfo.InvariantCulture));
                sampleInsert.Parameters.AddWithValue("$count", count);
                sampleInsert.ExecuteNonQuery();
            }
            using var state = connection.CreateCommand();
            state.Transaction = transaction;
            state.CommandText = """
                INSERT INTO runtime_video_stats_state(channel_id,checked_at) VALUES($id,$at)
                ON CONFLICT(channel_id) DO UPDATE SET checked_at=excluded.checked_at
                """;
            state.Parameters.AddWithValue("$id", channelId);
            state.Parameters.AddWithValue("$at", checkedAt.ToString("O", CultureInfo.InvariantCulture));
            state.ExecuteNonQuery();
        }
        transaction.Commit();
        return revision + 1;
    }

    public void AddChannel(ResolvedYouTubeChannel channel)
    {
        _ = YouTubeChannelInput.Normalize(channel.Id);
        using var connection = Open();
        using var transaction = connection.BeginTransaction();
        using var check = connection.CreateCommand();
        check.Transaction = transaction;
        check.CommandText = "SELECT 1 FROM channels WHERE id=$id UNION ALL SELECT 1 FROM runtime_channels WHERE id=$id";
        check.Parameters.AddWithValue("$id", channel.Id);
        var exists = check.ExecuteScalar() is not null;
        using var removed = connection.CreateCommand();
        removed.Transaction = transaction;
        removed.CommandText = "DELETE FROM runtime_removed_channels WHERE id=$id";
        removed.Parameters.AddWithValue("$id", channel.Id);
        var wasRemoved = removed.ExecuteNonQuery() != 0;
        if (exists && !wasRemoved) throw new InvalidOperationException("이미 등록된 채널입니다.");
        if (!exists)
        {
            using var insert = connection.CreateCommand();
            insert.Transaction = transaction;
            insert.CommandText = "INSERT INTO runtime_channels(id,metadata_json) VALUES($id,$json)";
            insert.Parameters.AddWithValue("$id", channel.Id);
            insert.Parameters.AddWithValue("$json", JsonSerializer.Serialize(new
            {
                id = channel.Id, inputUrl = channel.Url, title = "채널 정보 불러오는 중",
                avatarUrl = "", addedAt = DateTimeOffset.UtcNow.ToString("O", CultureInfo.InvariantCulture)
            }));
            insert.ExecuteNonQuery();
        }
        transaction.Commit();
    }

    public void RemoveChannel(string channelId)
    {
        _ = YouTubeChannelInput.Normalize(channelId);
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = """
            INSERT OR IGNORE INTO runtime_removed_channels(id)
            SELECT id FROM (SELECT id FROM channels UNION ALL SELECT id FROM runtime_channels) WHERE id=$id
            """;
        command.Parameters.AddWithValue("$id", channelId);
        if (command.ExecuteNonQuery() == 0)
            throw new KeyNotFoundException("등록된 채널을 찾지 못했습니다.");
    }

    public void UpdateSettings(JsonElement partial)
    {
        if (partial.ValueKind != JsonValueKind.Object)
            throw new InvalidDataException("설정 값이 올바르지 않습니다.");
        using var connection = Open();
        using var read = connection.CreateCommand();
        read.CommandText = "SELECT value FROM meta WHERE key='settings'";
        var settings = JsonNode.Parse(read.ExecuteScalar() as string
            ?? throw new InvalidDataException("저장된 설정이 없습니다."))?.AsObject()
            ?? throw new InvalidDataException("설정 구조가 올바르지 않습니다.");
        foreach (var property in partial.EnumerateObject())
        {
            var value = property.Value;
            switch (property.Name)
            {
                case "startAtLogin":
                case "autoOpenLive":
                case "autoOpenUpcoming":
                case "notifyNewVideos":
                case "notifyNewPosts":
                    if (value.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
                        throw new InvalidDataException($"{property.Name} 설정이 올바르지 않습니다.");
                    settings[property.Name] = value.GetBoolean();
                    break;
                case "pollIntervalSeconds":
                    if (value.ValueKind != JsonValueKind.Number || !value.TryGetDouble(out var seconds)
                        || !double.IsFinite(seconds))
                        throw new InvalidDataException("감시 간격이 올바르지 않습니다.");
                    settings[property.Name] = (int)Math.Clamp(Math.Round(seconds), 15, 300);
                    break;
                case "subscriberChartMode":
                    if (value.ValueKind != JsonValueKind.String || value.GetString() is not ("samples" or "daily"))
                        throw new InvalidDataException("차트 표시 기준이 올바르지 않습니다.");
                    settings[property.Name] = value.GetString();
                    break;
                case "apiKey":
                    if (value.ValueKind != JsonValueKind.String || value.GetString() is not { Length: <= 256 })
                        throw new InvalidDataException("API 키가 올바르지 않습니다.");
                    settings[property.Name] = value.GetString()!.Trim();
                    break;
                case "cloudUrl":
                    if (value.ValueKind != JsonValueKind.String) throw new InvalidDataException("클라우드 주소가 올바르지 않습니다.");
                    var url = value.GetString()!.Trim();
                    if (url.Length != 0 && !Regex.IsMatch(url, "^https://[a-z0-9-]+\\.fly\\.dev/?$", RegexOptions.IgnoreCase))
                        throw new InvalidDataException("클라우드 주소는 Fly HTTPS 주소여야 합니다.");
                    settings[property.Name] = url.TrimEnd('/');
                    if (url.Length == 0) settings["cloudToken"] = "";
                    break;
                case "cloudToken":
                    if (value.ValueKind != JsonValueKind.String) throw new InvalidDataException("클라우드 읽기 키가 올바르지 않습니다.");
                    var token = value.GetString()!.Trim();
                    if (token.Length != 0 && !Regex.IsMatch(token, "^[A-Za-z0-9_-]{32,256}$"))
                        throw new InvalidDataException("클라우드 읽기 키가 올바르지 않습니다.");
                    settings[property.Name] = token;
                    break;
                default:
                    throw new InvalidDataException("지원하지 않는 설정 값입니다.");
            }
        }
        if ((string?)settings["cloudUrl"] == "") settings["cloudToken"] = "";
        using var update = connection.CreateCommand();
        update.CommandText = "UPDATE meta SET value=$json WHERE key='settings'";
        update.Parameters.AddWithValue("$json", settings.ToJsonString());
        if (update.ExecuteNonQuery() != 1) throw new InvalidDataException("설정을 저장하지 못했습니다.");
    }

    public (int Added, int SkippedExisting) ImportSubscriberDays(string channelId,
        IReadOnlyList<ImportedSubscriberDay> days)
    {
        _ = Load(channelId);
        using var connection = Open();
        var existing = new HashSet<DateOnly>();
        using (var command = connection.CreateCommand())
        {
            command.CommandText = """
                SELECT at FROM samples WHERE source='local' AND kind='subscriber'
                  AND video_id='' AND channel_id=$id
                UNION ALL SELECT at FROM runtime_subscriber_samples WHERE channel_id=$id
                """;
            command.Parameters.AddWithValue("$id", channelId);
            using var reader = command.ExecuteReader();
            while (reader.Read())
            {
                if (!DateTimeOffset.TryParse(reader.GetString(0), CultureInfo.InvariantCulture,
                        DateTimeStyles.AssumeUniversal, out var at))
                    throw new InvalidDataException("기존 구독자 표본 시각이 올바르지 않습니다.");
                existing.Add(DateOnly.FromDateTime(at.ToLocalTime().DateTime));
            }
        }
        var added = 0;
        var skipped = 0;
        using var transaction = connection.BeginTransaction();
        using var insert = connection.CreateCommand();
        insert.Transaction = transaction;
        insert.CommandText = "INSERT INTO runtime_subscriber_samples(channel_id,at,count) VALUES($id,$at,$count)";
        insert.Parameters.AddWithValue("$id", channelId);
        insert.Parameters.Add(new SqliteParameter("$at", ""));
        insert.Parameters.Add(new SqliteParameter("$count", 0L));
        foreach (var day in days)
        {
            if (day.Count < 0 || day.Count > 9_007_199_254_740_991)
                throw new InvalidDataException("구독자 수가 올바르지 않습니다.");
            if (!existing.Add(day.Date)) { skipped++; continue; }
            var local = day.Date.ToDateTime(TimeOnly.MinValue);
            var at = new DateTimeOffset(local, TimeZoneInfo.Local.GetUtcOffset(local)).ToUniversalTime();
            insert.Parameters["$at"].Value = at.ToString("yyyy-MM-ddTHH:mm:ss.fffZ", CultureInfo.InvariantCulture);
            insert.Parameters["$count"].Value = day.Count;
            insert.ExecuteNonQuery();
            added++;
        }
        transaction.Commit();
        return (added, skipped);
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

    private static bool ReadBoolean(JsonElement root, string property)
    {
        if (!root.TryGetProperty(property, out var value)) return true;
        return value.ValueKind switch
        {
            JsonValueKind.True => true,
            JsonValueKind.False => false,
            _ => throw new InvalidDataException($"감시 설정 {property}이 올바르지 않습니다.")
        };
    }

    private static int ReadPollInterval(JsonElement root)
    {
        if (!root.TryGetProperty("pollIntervalSeconds", out var value)) return 30;
        double seconds;
        if (value.ValueKind == JsonValueKind.Number && value.TryGetDouble(out var number)) seconds = number;
        else if (value.ValueKind == JsonValueKind.String && double.TryParse(value.GetString(),
                     NumberStyles.Float, CultureInfo.InvariantCulture, out var parsed)) seconds = parsed;
        else return 30;
        return double.IsFinite(seconds) ? (int)Math.Clamp(Math.Floor(seconds + 0.5), 15, 300) : 30;
    }

    private static SubscriberObservation? ReadLastSubscriber(SqliteConnection connection, string channelId)
    {
        using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT at,count FROM (
              SELECT at,count,ordinal AS sequence FROM samples
                WHERE source='local' AND kind='subscriber' AND video_id='' AND channel_id=$id
              UNION ALL SELECT at,count,id AS sequence FROM runtime_subscriber_samples WHERE channel_id=$id)
            ORDER BY julianday(at) DESC,sequence DESC LIMIT 1
            """;
        command.Parameters.AddWithValue("$id", channelId);
        using var reader = command.ExecuteReader();
        if (!reader.Read()) return null;
        if (!DateTimeOffset.TryParse(reader.GetString(0), CultureInfo.InvariantCulture,
                DateTimeStyles.AssumeUniversal, out var at))
            throw new InvalidDataException("구독자 표본 시각이 올바르지 않습니다.");
        return new SubscriberObservation(at, reader.GetInt64(1));
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
