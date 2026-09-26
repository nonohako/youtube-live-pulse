using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Data.Sqlite;

namespace LivePulse.NativeStore;

public sealed record NativeCloudSyncResult(bool Configured, int Pages, int Observations, long Cursor);

internal sealed class NativeCloudConfiguration(Uri endpoint, string token, long cursor,
    IReadOnlySet<string> channelIds)
{
    internal Uri Endpoint { get; } = endpoint;
    internal string Token { get; } = token;
    internal long Cursor { get; } = cursor;
    internal IReadOnlySet<string> ChannelIds { get; } = channelIds;
}

internal sealed record NativeCloudPageResult(long Cursor, bool HasMore, bool HadSamples, int Observations);

// A bounded runtime overlay; imported local/cloud series are never rewritten or compacted.
internal sealed class NativeCloudArchive
{
    private static readonly Regex FlyHost = new("^[a-z0-9-]+\\.fly\\.dev$", RegexOptions.Compiled);
    private static readonly Regex VideoId = new("^[A-Za-z0-9_-]{11}$", RegexOptions.Compiled);
    private readonly string connectionString;

    internal NativeCloudArchive(string databasePath)
    {
        _ = new NativeMonitorStore(databasePath);
        connectionString = new SqliteConnectionStringBuilder
        {
            DataSource = Path.GetFullPath(databasePath), Mode = SqliteOpenMode.ReadWrite, Pooling = false
        }.ToString();
        using var connection = Open();
        using var schema = connection.CreateCommand();
        schema.CommandText = """
            CREATE TABLE IF NOT EXISTS runtime_cloud_state(
              id INTEGER PRIMARY KEY CHECK(id=1), endpoint TEXT NOT NULL, cursor INTEGER NOT NULL,
              archive_version INTEGER NOT NULL, last_sync_at TEXT NOT NULL,
              last_collection_at TEXT, error TEXT);
            CREATE TABLE IF NOT EXISTS runtime_cloud_samples(
              channel_id TEXT NOT NULL, kind TEXT NOT NULL, video_id TEXT NOT NULL,
              at TEXT NOT NULL, count INTEGER NOT NULL,
              PRIMARY KEY(channel_id,kind,video_id,at));
            CREATE INDEX IF NOT EXISTS runtime_cloud_samples_by_time
              ON runtime_cloud_samples(channel_id,kind,video_id,at);
            CREATE TABLE IF NOT EXISTS runtime_cloud_videos(
              channel_id TEXT NOT NULL, video_id TEXT NOT NULL, metadata_json TEXT NOT NULL,
              PRIMARY KEY(channel_id,video_id));
            """;
        schema.ExecuteNonQuery();
    }

    internal NativeCloudConfiguration? ReadConfiguration()
    {
        using var connection = Open();
        using var settings = connection.CreateCommand();
        settings.CommandText = "SELECT value FROM meta WHERE key='settings'";
        if (settings.ExecuteScalar() is not string settingsJson)
            throw new InvalidDataException("클라우드 설정을 읽을 수 없습니다.");
        using var settingsDocument = JsonDocument.Parse(settingsJson);
        var settingsRoot = settingsDocument.RootElement;
        if (settingsRoot.ValueKind != JsonValueKind.Object)
            throw new InvalidDataException("클라우드 설정 구조가 올바르지 않습니다.");
        var rawUrl = OptionalString(settingsRoot, "cloudUrl") ?? "";
        var token = OptionalString(settingsRoot, "cloudToken") ?? "";
        if (rawUrl.Length == 0 || token.Length == 0) return null;
        rawUrl = rawUrl.Trim();
        if (!Regex.IsMatch(rawUrl, "^https://[a-z0-9-]+\\.fly\\.dev/?$", RegexOptions.IgnoreCase)
            || !Uri.TryCreate(rawUrl, UriKind.Absolute, out var endpoint)
            || endpoint.Scheme != Uri.UriSchemeHttps || !FlyHost.IsMatch(endpoint.Host)
            || endpoint.UserInfo.Length != 0 || !endpoint.IsDefaultPort
            || endpoint.AbsolutePath != "/" || endpoint.Query.Length != 0 || endpoint.Fragment.Length != 0
            || token.Length is < 32 or > 256 || token.Any(c => !char.IsAsciiLetterOrDigit(c) && c is not '_' and not '-'))
            throw new InvalidDataException("클라우드 연결 주소 또는 읽기 키가 올바르지 않습니다.");

        var ids = new HashSet<string>(StringComparer.Ordinal);
        using (var channels = connection.CreateCommand())
        {
            channels.CommandText = """
                SELECT id FROM (SELECT id FROM channels UNION ALL SELECT id FROM runtime_channels)
                WHERE id NOT IN (SELECT id FROM runtime_removed_channels)
                """;
            using var reader = channels.ExecuteReader();
            while (reader.Read()) ids.Add(reader.GetString(0));
        }
        return new NativeCloudConfiguration(endpoint, token, ReadCursor(connection, endpoint.GetLeftPart(UriPartial.Authority)), ids);
    }

    internal void ResetCursorForNewChannel()
    {
        var configuration = ReadConfiguration();
        if (configuration is null) return;
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = """
            INSERT INTO runtime_cloud_state(id,endpoint,cursor,archive_version,last_sync_at,last_collection_at,error)
            VALUES(1,$endpoint,0,2,$now,NULL,NULL)
            ON CONFLICT(id) DO UPDATE SET endpoint=excluded.endpoint,cursor=0,
              archive_version=2,last_sync_at=excluded.last_sync_at,error=NULL
            """;
        command.Parameters.AddWithValue("$endpoint", configuration.Endpoint.GetLeftPart(UriPartial.Authority));
        command.Parameters.AddWithValue("$now", DateTimeOffset.UtcNow.ToString("O", CultureInfo.InvariantCulture));
        command.ExecuteNonQuery();
    }

    internal NativeCloudPageResult ApplyPage(NativeCloudConfiguration configuration, string pageJson,
        DateTimeOffset now)
    {
        using var document = JsonDocument.Parse(pageJson);
        var root = document.RootElement;
        if (root.ValueKind != JsonValueKind.Object || RequiredInt(root, "version") != 1
            || !root.TryGetProperty("samples", out var samples) || samples.ValueKind != JsonValueKind.Array
            || samples.GetArrayLength() > 240 || !root.TryGetProperty("hasMore", out var hasMore)
            || hasMore.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
            throw new InvalidDataException("클라우드 응답 형식이 올바르지 않습니다.");
        var next = RequiredInt(root, "next");
        var expected = configuration.Cursor;
        var observations = new List<(string Channel, string Kind, string Video, string At, long Count)>();
        foreach (var sample in samples.EnumerateArray())
        {
            var timestamp = RequiredInt(sample, "at");
            if (timestamp <= expected || timestamp > now.ToUnixTimeMilliseconds())
                throw new InvalidDataException("클라우드 표본 시각 또는 순서가 올바르지 않습니다.");
            expected = timestamp;
            if (!sample.TryGetProperty("channels", out var channels) || channels.ValueKind != JsonValueKind.Array)
                throw new InvalidDataException("클라우드 채널 목록이 올바르지 않습니다.");
            var at = DateTimeOffset.FromUnixTimeMilliseconds(timestamp).UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ss.fffZ", CultureInfo.InvariantCulture);
            foreach (var channel in channels.EnumerateArray())
            {
                if (channel.ValueKind != JsonValueKind.Object || OptionalString(channel, "id") is not { } id
                    || !configuration.ChannelIds.Contains(id)) continue;
                if (channel.TryGetProperty("subscriberCount", out var subscriber)
                    && subscriber.ValueKind == JsonValueKind.Number && subscriber.TryGetInt64(out var count)
                    && count >= 0 && count <= 9_007_199_254_740_991)
                    observations.Add((id, "subscriber", "", at, count));
                if (!channel.TryGetProperty("views", out var views) || views.ValueKind != JsonValueKind.Object) continue;
                foreach (var view in views.EnumerateObject().Take(100))
                    if (VideoId.IsMatch(view.Name) && view.Value.ValueKind == JsonValueKind.Number
                        && view.Value.TryGetInt64(out var viewCount) && viewCount >= 0
                        && viewCount <= 9_007_199_254_740_991)
                        observations.Add((id, "video", view.Name, at, viewCount));
            }
        }
        if (next != expected) throw new InvalidDataException("클라우드 커서가 표본과 일치하지 않습니다.");
        var collectionAt = root.TryGetProperty("status", out var status) && status.ValueKind == JsonValueKind.Object
            ? OptionalString(status, "lastSuccessAt") : null;
        var error = root.TryGetProperty("status", out status) && status.ValueKind == JsonValueKind.Object
            && status.TryGetProperty("error", out var statusError) && statusError.ValueKind != JsonValueKind.Null
            && statusError.ToString().Length > 0 ? "서버 수집 오류" : null;

        using var connection = Open();
        using var transaction = connection.BeginTransaction();
        if (ReadCursor(connection, configuration.Endpoint.GetLeftPart(UriPartial.Authority), transaction) != configuration.Cursor)
            throw new InvalidOperationException("클라우드 커서가 다른 작업에서 변경됐습니다.");
        using (var insert = connection.CreateCommand())
        {
            insert.Transaction = transaction;
            insert.CommandText = """
                INSERT INTO runtime_cloud_samples(channel_id,kind,video_id,at,count)
                VALUES($channel,$kind,$video,$at,$count)
                ON CONFLICT(channel_id,kind,video_id,at) DO UPDATE SET count=excluded.count
                """;
            foreach (var name in new[] { "$channel", "$kind", "$video", "$at", "$count" })
                insert.Parameters.Add(new SqliteParameter(name, DBNull.Value));
            foreach (var item in observations)
            {
                insert.Parameters["$channel"].Value = item.Channel;
                insert.Parameters["$kind"].Value = item.Kind;
                insert.Parameters["$video"].Value = item.Video;
                insert.Parameters["$at"].Value = item.At;
                insert.Parameters["$count"].Value = item.Count;
                insert.ExecuteNonQuery();
            }
        }
        if (root.TryGetProperty("metadata", out var metadata) && metadata.ValueKind == JsonValueKind.Object)
            foreach (var channel in metadata.EnumerateObject())
            {
                if (!configuration.ChannelIds.Contains(channel.Name) || channel.Value.ValueKind != JsonValueKind.Object
                    || !channel.Value.TryGetProperty("videos", out var videos) || videos.ValueKind != JsonValueKind.Object) continue;
                foreach (var video in videos.EnumerateObject())
                {
                    if (!VideoId.IsMatch(video.Name) || video.Value.ValueKind != JsonValueKind.Object) continue;
                    using var save = connection.CreateCommand();
                    save.Transaction = transaction;
                    save.CommandText = """
                        INSERT INTO runtime_cloud_videos(channel_id,video_id,metadata_json)
                        VALUES($channel,$video,$json)
                        ON CONFLICT(channel_id,video_id) DO UPDATE SET metadata_json=excluded.metadata_json
                        """;
                    save.Parameters.AddWithValue("$channel", channel.Name);
                    save.Parameters.AddWithValue("$video", video.Name);
                    save.Parameters.AddWithValue("$json", video.Value.GetRawText());
                    save.ExecuteNonQuery();
                }
            }
        using (var save = connection.CreateCommand())
        {
            save.Transaction = transaction;
            save.CommandText = """
                INSERT INTO runtime_cloud_state(id,endpoint,cursor,archive_version,last_sync_at,last_collection_at,error)
                VALUES(1,$endpoint,$cursor,2,$sync,$collection,$error)
                ON CONFLICT(id) DO UPDATE SET endpoint=excluded.endpoint,cursor=excluded.cursor,
                  archive_version=2,last_sync_at=excluded.last_sync_at,
                  last_collection_at=excluded.last_collection_at,error=excluded.error
                """;
            save.Parameters.AddWithValue("$endpoint", configuration.Endpoint.GetLeftPart(UriPartial.Authority));
            save.Parameters.AddWithValue("$cursor", next);
            save.Parameters.AddWithValue("$sync", now.UtcDateTime.ToString("O", CultureInfo.InvariantCulture));
            save.Parameters.AddWithValue("$collection", (object?)collectionAt ?? DBNull.Value);
            save.Parameters.AddWithValue("$error", (object?)error ?? DBNull.Value);
            save.ExecuteNonQuery();
        }
        transaction.Commit();
        return new NativeCloudPageResult(next, hasMore.GetBoolean(), samples.GetArrayLength() != 0, observations.Count);
    }

    private static long ReadCursor(SqliteConnection connection, string endpoint, SqliteTransaction? transaction = null)
    {
        using (var runtime = connection.CreateCommand())
        {
            runtime.Transaction = transaction;
            runtime.CommandText = "SELECT endpoint,cursor,archive_version FROM runtime_cloud_state WHERE id=1";
            using var reader = runtime.ExecuteReader();
            if (reader.Read())
            {
                if (reader.GetString(0) != endpoint || reader.GetInt64(2) != 2) return 0;
                var runtimeCursor = reader.GetInt64(1);
                if (runtimeCursor < 0) throw new InvalidDataException("클라우드 커서가 올바르지 않습니다.");
                return runtimeCursor;
            }
        }
        using var imported = connection.CreateCommand();
        imported.Transaction = transaction;
        imported.CommandText = "SELECT value FROM meta WHERE key='cloud'";
        if (imported.ExecuteScalar() is not string cloudJson) return 0;
        using var document = JsonDocument.Parse(cloudJson);
        var cloud = document.RootElement;
        if (cloud.ValueKind != JsonValueKind.Object || OptionalString(cloud, "endpoint") != endpoint
            || !cloud.TryGetProperty("archiveVersion", out var version) || version.ValueKind != JsonValueKind.Number
            || version.GetInt32() != 2 || !cloud.TryGetProperty("cursor", out var cursor)
            || cursor.ValueKind != JsonValueKind.Number || !cursor.TryGetInt64(out var value) || value < 0)
            return 0;
        return value;
    }

    private static string? OptionalString(JsonElement root, string name)
        => root.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;

    private static long RequiredInt(JsonElement root, string name)
        => root.ValueKind == JsonValueKind.Object && root.TryGetProperty(name, out var value)
            && value.ValueKind == JsonValueKind.Number && value.TryGetInt64(out var number)
            && number >= 0 && number <= 9_007_199_254_740_991
            ? number : throw new InvalidDataException($"클라우드 응답의 {name} 값이 올바르지 않습니다.");

    private SqliteConnection Open()
    {
        var connection = new SqliteConnection(connectionString);
        connection.Open();
        return connection;
    }
}
