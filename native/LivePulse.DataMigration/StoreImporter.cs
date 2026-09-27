using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace LivePulse.DataMigration;

internal static class StoreImporter
{
    internal record Summary(string SourceSha256, int Channels, int Series, long Samples, bool Reused);

    internal static Summary Import(string sourcePath, string databasePath)
    {
        var sourceHash = HashFile(sourcePath);
        if (File.Exists(databasePath)) return Verify(sourcePath, databasePath) with { Reused = true };
        using var input = File.OpenRead(sourcePath);
        using var document = JsonDocument.Parse(input);
        var root = document.RootElement;
        if (root.ValueKind != JsonValueKind.Object || root.GetProperty("version").GetInt32() != 3 ||
            root.GetProperty("channels").ValueKind != JsonValueKind.Array ||
            root.GetProperty("settings").ValueKind != JsonValueKind.Object ||
            root.GetProperty("events").ValueKind != JsonValueKind.Array)
            throw new InvalidDataException("JSON v3 구조가 올바르지 않습니다.");

        Directory.CreateDirectory(Path.GetDirectoryName(databasePath)!);
        using var connection = Open(databasePath, SqliteOpenMode.ReadWriteCreate);
        using var transaction = connection.BeginTransaction();
        CreateSchema(connection, transaction);
        PutMeta(connection, transaction, "version", root.GetProperty("version").GetRawText());
        PutMeta(connection, transaction, "settings", root.GetProperty("settings").GetRawText());
        PutMeta(connection, transaction, "events", root.GetProperty("events").GetRawText());
        PutMeta(connection, transaction, "cloud", root.TryGetProperty("cloud", out var cloud)
            ? WithoutProperties(cloud, "channels") : "null");

        foreach (var channel in root.GetProperty("channels").EnumerateArray())
        {
            var channelId = RequiredString(channel, "id");
            using var command = connection.CreateCommand();
            command.Transaction = transaction;
            command.CommandText = "INSERT INTO channels(id, metadata_json) VALUES ($id, $metadata)";
            command.Parameters.AddWithValue("$id", channelId);
            command.Parameters.AddWithValue("$metadata", WithoutProperties(channel, "subscriberHistory", "videoViewHistories"));
            command.ExecuteNonQuery();
            WriteChannelSeries(connection, transaction, "local", channelId, channel);
        }
        if (cloud.ValueKind == JsonValueKind.Object && cloud.TryGetProperty("channels", out var cloudChannels))
        {
            if (cloudChannels.ValueKind != JsonValueKind.Object)
                throw new InvalidDataException("클라우드 채널 구조가 올바르지 않습니다.");
            foreach (var entry in cloudChannels.EnumerateObject())
            {
                PutCloudChannel(connection, transaction, entry.Name, entry.Value);
                WriteChannelSeries(connection, transaction, "cloud", entry.Name, entry.Value);
            }
        }
        PutMeta(connection, transaction, "source_sha256", sourceHash);
        PutMeta(connection, transaction, "migration_complete", "1");
        transaction.Commit();
        connection.Close();
        document.Dispose();
        input.Dispose();
        return Verify(sourcePath, databasePath);
    }

    internal static Summary Verify(string sourcePath, string databasePath)
    {
        if (!File.Exists(databasePath)) throw new FileNotFoundException("이전 DB가 없습니다.", databasePath);
        var sourceHash = HashFile(sourcePath);
        using var connection = Open(databasePath, SqliteOpenMode.ReadOnly);
        if (GetMeta(connection, "migration_complete") != "1" || GetMeta(connection, "source_sha256") != sourceHash)
            throw new InvalidDataException("이전 완료 표시 또는 원본 SHA-256이 일치하지 않습니다.");
        using var integrity = connection.CreateCommand();
        integrity.CommandText = "PRAGMA integrity_check";
        if ((string?)integrity.ExecuteScalar() != "ok") throw new InvalidDataException("SQLite 무결성 검사가 실패했습니다.");

        var series = new List<(string Source, string Channel, string Kind, string Video, long Count, string Hash)>();
        using (var command = connection.CreateCommand())
        {
            command.CommandText = "SELECT source, channel_id, kind, video_id, sample_count, sample_sha256 FROM series";
            using var reader = command.ExecuteReader();
            while (reader.Read())
                series.Add((reader.GetString(0), reader.GetString(1), reader.GetString(2), reader.GetString(3), reader.GetInt64(4), reader.GetString(5)));
        }
        long totalSamples = 0;
        foreach (var item in series)
        {
            using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            using var command = connection.CreateCommand();
            command.CommandText = "SELECT ordinal,at,count,payload_json FROM samples WHERE source=$source AND channel_id=$channel AND kind=$kind AND video_id=$video ORDER BY ordinal";
            command.Parameters.AddWithValue("$source", item.Source);
            command.Parameters.AddWithValue("$channel", item.Channel);
            command.Parameters.AddWithValue("$kind", item.Kind);
            command.Parameters.AddWithValue("$video", item.Video);
            using var reader = command.ExecuteReader();
            long count = 0;
            while (reader.Read())
            {
                var payload = reader.GetString(3);
                using var original = JsonDocument.Parse(payload);
                if (reader.GetInt64(0) != count ||
                    reader.GetString(1) != RequiredString(original.RootElement, "at") ||
                    reader.GetInt64(2) != original.RootElement.GetProperty("count").GetInt64())
                    throw new InvalidDataException("표본의 순서 또는 시각/값 열이 원문과 다릅니다.");
                AddHash(hash, payload);
                count++;
            }
            if (count != item.Count || Convert.ToHexString(hash.GetHashAndReset()) != item.Hash)
                throw new InvalidDataException("이전한 표본 수 또는 원문 해시가 일치하지 않습니다.");
            totalSamples += count;
        }
        using var channelCount = connection.CreateCommand();
        channelCount.CommandText = "SELECT COUNT(*) FROM channels";
        return new Summary(sourceHash, Convert.ToInt32(channelCount.ExecuteScalar()), series.Count, totalSamples, false);
    }

    private static void WriteChannelSeries(SqliteConnection connection, SqliteTransaction transaction, string source, string channelId, JsonElement channel)
    {
        if (channel.TryGetProperty("subscriberHistory", out var subscribers))
            WriteSeries(connection, transaction, source, channelId, "subscriber", "", "{}", subscribers);
        if (!channel.TryGetProperty("videoViewHistories", out var videos)) return;
        if (videos.ValueKind != JsonValueKind.Array) throw new InvalidDataException("영상 기록 목록이 올바르지 않습니다.");
        foreach (var video in videos.EnumerateArray())
            WriteSeries(connection, transaction, source, channelId, "video", RequiredString(video, "videoId"),
                WithoutProperties(video, "samples"), video.GetProperty("samples"));
    }

    private static void WriteSeries(SqliteConnection connection, SqliteTransaction transaction, string source, string channelId,
        string kind, string videoId, string metadata, JsonElement samples)
    {
        if (samples.ValueKind != JsonValueKind.Array) throw new InvalidDataException("표본 목록이 올바르지 않습니다.");
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        using var sampleInsert = connection.CreateCommand();
        sampleInsert.Transaction = transaction;
        sampleInsert.CommandText = "INSERT INTO samples(source, channel_id, kind, video_id, ordinal, at, count, payload_json) VALUES ($source,$channel,$kind,$video,$ordinal,$at,$count,$payload)";
        foreach (var name in new[] { "$source", "$channel", "$kind", "$video", "$ordinal", "$at", "$count", "$payload" })
            sampleInsert.Parameters.Add(new SqliteParameter(name, DBNull.Value));
        sampleInsert.Parameters["$source"].Value = source;
        sampleInsert.Parameters["$channel"].Value = channelId;
        sampleInsert.Parameters["$kind"].Value = kind;
        sampleInsert.Parameters["$video"].Value = videoId;
        long ordinal = 0;
        foreach (var sample in samples.EnumerateArray())
        {
            var at = RequiredString(sample, "at");
            var count = sample.GetProperty("count").GetInt64();
            var payload = sample.GetRawText();
            sampleInsert.Parameters["$ordinal"].Value = ordinal++;
            sampleInsert.Parameters["$at"].Value = at;
            sampleInsert.Parameters["$count"].Value = count;
            sampleInsert.Parameters["$payload"].Value = payload;
            sampleInsert.ExecuteNonQuery();
            AddHash(hash, payload);
        }
        using var seriesInsert = connection.CreateCommand();
        seriesInsert.Transaction = transaction;
        seriesInsert.CommandText = "INSERT INTO series(source,channel_id,kind,video_id,metadata_json,sample_count,sample_sha256) VALUES ($source,$channel,$kind,$video,$metadata,$count,$hash)";
        seriesInsert.Parameters.AddWithValue("$source", source);
        seriesInsert.Parameters.AddWithValue("$channel", channelId);
        seriesInsert.Parameters.AddWithValue("$kind", kind);
        seriesInsert.Parameters.AddWithValue("$video", videoId);
        seriesInsert.Parameters.AddWithValue("$metadata", metadata);
        seriesInsert.Parameters.AddWithValue("$count", ordinal);
        seriesInsert.Parameters.AddWithValue("$hash", Convert.ToHexString(hash.GetHashAndReset()));
        seriesInsert.ExecuteNonQuery();
    }

    private static void PutCloudChannel(SqliteConnection connection, SqliteTransaction transaction, string id, JsonElement channel)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "INSERT INTO cloud_channels(id,metadata_json) VALUES ($id,$metadata)";
        command.Parameters.AddWithValue("$id", id);
        command.Parameters.AddWithValue("$metadata", WithoutProperties(channel, "subscriberHistory", "videoViewHistories"));
        command.ExecuteNonQuery();
    }

    private static void CreateSchema(SqliteConnection connection, SqliteTransaction transaction)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
            CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE channels(id TEXT PRIMARY KEY, metadata_json TEXT NOT NULL);
            CREATE TABLE cloud_channels(id TEXT PRIMARY KEY, metadata_json TEXT NOT NULL);
            CREATE TABLE series(source TEXT NOT NULL, channel_id TEXT NOT NULL, kind TEXT NOT NULL, video_id TEXT NOT NULL,
              metadata_json TEXT NOT NULL, sample_count INTEGER NOT NULL, sample_sha256 TEXT NOT NULL,
              PRIMARY KEY(source,channel_id,kind,video_id));
            CREATE TABLE samples(source TEXT NOT NULL, channel_id TEXT NOT NULL, kind TEXT NOT NULL, video_id TEXT NOT NULL,
              ordinal INTEGER NOT NULL, at TEXT NOT NULL, count INTEGER NOT NULL, payload_json TEXT NOT NULL,
              PRIMARY KEY(source,channel_id,kind,video_id,ordinal));
            CREATE INDEX samples_by_time ON samples(source,channel_id,kind,video_id,at);
            """;
        command.ExecuteNonQuery();
    }

    private static void PutMeta(SqliteConnection connection, SqliteTransaction transaction, string key, string value)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "INSERT INTO meta(key,value) VALUES ($key,$value)";
        command.Parameters.AddWithValue("$key", key);
        command.Parameters.AddWithValue("$value", value);
        command.ExecuteNonQuery();
    }

    private static string? GetMeta(SqliteConnection connection, string key)
    {
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT value FROM meta WHERE key=$key";
        command.Parameters.AddWithValue("$key", key);
        return command.ExecuteScalar() as string;
    }

    private static SqliteConnection Open(string path, SqliteOpenMode mode)
    {
        var connection = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = path, Mode = mode }.ToString());
        connection.Open();
        return connection;
    }

    private static string RequiredString(JsonElement element, string name)
        => element.GetProperty(name).GetString() ?? throw new InvalidDataException($"필수 문자열 {name}이 없습니다.");

    private static string WithoutProperties(JsonElement element, params string[] omit)
    {
        if (element.ValueKind != JsonValueKind.Object) throw new InvalidDataException("메타데이터 객체가 올바르지 않습니다.");
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream))
        {
            writer.WriteStartObject();
            foreach (var property in element.EnumerateObject())
            {
                if (omit.Contains(property.Name, StringComparer.Ordinal)) continue;
                property.WriteTo(writer);
            }
            writer.WriteEndObject();
        }
        return Encoding.UTF8.GetString(stream.ToArray());
    }

    private static void AddHash(IncrementalHash hash, string payload)
    {
        hash.AppendData(Encoding.UTF8.GetBytes(payload));
        hash.AppendData(new byte[] { 0 });
    }

    private static string HashFile(string path)
    {
        using var stream = File.OpenRead(path);
        return Convert.ToHexString(SHA256.HashData(stream));
    }
}
