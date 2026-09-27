using System.Globalization;
using Microsoft.Data.Sqlite;

namespace LivePulse.NativeStore;

// Compact storage for every subscriber/view observation (storage version 2).
// One small dictionary row per series (source, channel, kind, video) and one 3-integer row per
// observation in a WITHOUT ROWID table: about 17 bytes per observation instead of about 280 when
// four text-keyed tables stored channel IDs, ISO strings, raw JSON copies and duplicate indexes.
// Sources: 'local'/'cloud' = imported Electron archive, 'runtime-cloud' = Fly sync,
// 'runtime-local' = this PC's subscriber/view checks and xlsx imports.
public static class NativeObservations
{
    public const string ImportedLocal = "local";
    public const string ImportedCloud = "cloud";
    public const string RuntimeCloud = "runtime-cloud";
    public const string RuntimeLocal = "runtime-local";
    // Views of videos older than this are stored only when the (rounded) public count changes,
    // plus a daily heartbeat so an unchanged day is distinguishable from missing collection.
    public static readonly TimeSpan DenseVideoAge = TimeSpan.FromDays(30);
    public static readonly TimeSpan SparseHeartbeat = TimeSpan.FromDays(1);

    // Reader priority when two sources observed the same instant.
    public const string PrioritySql = "CASE k.source WHEN 'runtime-local' THEN 3 WHEN 'local' THEN 2 ELSE 1 END";

    public static long ToMilliseconds(DateTimeOffset at) => at.ToUnixTimeMilliseconds();

    public static string ToIso(long milliseconds)
        => DateTimeOffset.FromUnixTimeMilliseconds(milliseconds).UtcDateTime
            .ToString("yyyy-MM-ddTHH:mm:ss.fffZ", CultureInfo.InvariantCulture);

    internal static void EnsureSchema(SqliteConnection connection)
    {
        if (TableExists(connection, "observations")) return;
        using var transaction = connection.BeginTransaction();
        Execute(connection, transaction, """
            CREATE TABLE series_keys(id INTEGER PRIMARY KEY, source TEXT NOT NULL, channel_id TEXT NOT NULL,
              kind TEXT NOT NULL, video_id TEXT NOT NULL, UNIQUE(source,channel_id,kind,video_id));
            CREATE TABLE observations(series INTEGER NOT NULL, at INTEGER NOT NULL, count INTEGER NOT NULL,
              PRIMARY KEY(series,at)) WITHOUT ROWID;
            """);
        // Storage version 1 -> 2, inside one transaction: copy every row, then drop the old tables.
        foreach (var (table, source, kind, video, order) in new[]
        {
            ("samples", "source", "kind", "video_id", "ordinal"),
            ("runtime_cloud_samples", $"'{RuntimeCloud}'", "kind", "video_id", "at"),
            ("runtime_subscriber_samples", $"'{RuntimeLocal}'", "'subscriber'", "''", "id"),
            ("runtime_video_samples", $"'{RuntimeLocal}'", "'video'", "video_id", "at")
        })
        {
            if (!TableExists(connection, table, transaction)) continue;
            Execute(connection, transaction, $"""
                INSERT OR IGNORE INTO series_keys(source,channel_id,kind,video_id)
                SELECT DISTINCT {source},channel_id,{kind},{video} FROM {table};
                """);
            var bad = Scalar(connection, transaction,
                $"SELECT count(*) FROM {table} WHERE unixepoch(at,'subsec') IS NULL");
            if (bad != 0) throw new InvalidDataException($"{table}에 해석할 수 없는 시각이 {bad}개 있어 변환을 중단했습니다.");
            // Same series and millisecond twice (a replayed or duplicated record) keeps the first row.
            Execute(connection, transaction, $"""
                INSERT OR IGNORE INTO observations(series,at,count)
                SELECT k.id, CAST(round(unixepoch(t.at,'subsec')*1000) AS INTEGER), t.count FROM {table} t
                JOIN series_keys k ON k.source={source.Replace("source", "t.source")} AND k.channel_id=t.channel_id
                  AND k.kind={(kind == "kind" ? "t.kind" : kind)} AND k.video_id={(video == "video_id" ? "t.video_id" : video)}
                ORDER BY t.{order};
                """);
        }
        foreach (var table in new[] { "samples", "runtime_cloud_samples", "runtime_subscriber_samples", "runtime_video_samples" })
            Execute(connection, transaction, $"DROP TABLE IF EXISTS {table};");
        Execute(connection, transaction, "INSERT OR REPLACE INTO meta(key,value) VALUES('storage_version','2');");
        ThinOldVideoViews(connection, transaction);
        transaction.Commit();
        MigratedPaths[connection.DataSource] = true;
    }

    // Remember migrations so the host can compact the file once afterwards.
    internal static readonly System.Collections.Concurrent.ConcurrentDictionary<string, bool> MigratedPaths =
        new(StringComparer.OrdinalIgnoreCase);

    public static bool TakeMigrated(string databasePath)
        => MigratedPaths.TryRemove(Path.GetFullPath(databasePath), out _);

    // Applies the 30-day rule to stored history once: after a video is 30 days old keep only rows
    // whose count differs from the previous row, plus one row per day as a heartbeat, plus the
    // latest row. Rows from the first 30 days stay dense.
    internal static void ThinOldVideoViews(SqliteConnection connection, SqliteTransaction transaction)
    {
        var published = PublishTimes(connection, transaction);
        var remove = new List<(long Series, long At)>();
        using (var command = connection.CreateCommand())
        {
            command.Transaction = transaction;
            command.CommandText = """
                SELECT o.series,k.channel_id,k.video_id,o.at,o.count FROM observations o
                JOIN series_keys k ON k.id=o.series WHERE k.kind='video' ORDER BY o.series,o.at
                """;
            using var reader = command.ExecuteReader();
            long? series = null;
            long lastKeptAt = 0, lastCount = 0;
            // A removable row is deleted only once a later row of the same series exists,
            // so every series keeps its latest observation.
            (long Series, long At)? removable = null;
            while (reader.Read())
            {
                var id = reader.GetInt64(0);
                var at = reader.GetInt64(3);
                var count = reader.GetInt64(4);
                if (series != id)
                {
                    series = id;
                    lastKeptAt = at;
                    lastCount = count;
                    removable = null;
                    continue;
                }
                if (removable is { } earlier) remove.Add(earlier);
                removable = null;
                var sparse = published.TryGetValue((reader.GetString(1), reader.GetString(2)), out var publishedAt)
                    && at >= publishedAt + (long)DenseVideoAge.TotalMilliseconds;
                if (sparse && count == lastCount && at - lastKeptAt < (long)SparseHeartbeat.TotalMilliseconds)
                {
                    removable = (id, at);
                    continue;
                }
                lastKeptAt = at;
                lastCount = count;
            }
        }
        using var delete = connection.CreateCommand();
        delete.Transaction = transaction;
        delete.CommandText = "DELETE FROM observations WHERE series=$series AND at=$at";
        delete.Parameters.Add(new SqliteParameter("$series", 0L));
        delete.Parameters.Add(new SqliteParameter("$at", 0L));
        foreach (var (series, at) in remove)
        {
            delete.Parameters["$series"].Value = series;
            delete.Parameters["$at"].Value = at;
            delete.ExecuteNonQuery();
        }
    }

    // Publish times recorded by the cloud collector, local watch-page checks or the imported archive.
    internal static Dictionary<(string Channel, string Video), long> PublishTimes(SqliteConnection connection,
        SqliteTransaction? transaction = null)
    {
        var result = new Dictionary<(string, string), long>();
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        var parts = new List<string>();
        foreach (var (table, filter) in new[] { ("series", " WHERE kind='video'"), ("runtime_video_metadata", ""),
                     ("runtime_cloud_videos", "") })
            if (HasColumn(connection, transaction, table, "metadata_json"))
                parts.Add($"SELECT channel_id,video_id,json_extract(metadata_json,'$.publishedAt') FROM {table}{filter}");
        if (parts.Count == 0) return result;
        command.CommandText = string.Join(" UNION ALL ", parts);
        using var reader = command.ExecuteReader();
        while (reader.Read())
            if (!reader.IsDBNull(2) && reader.GetValue(2) is string text
                && DateTimeOffset.TryParse(text, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var at))
                result[(reader.GetString(0), reader.GetString(1))] = at.ToUnixTimeMilliseconds();
        return result;
    }

    // Returns the series id, creating the dictionary row when requested.
    public static long? SeriesId(SqliteConnection connection, SqliteTransaction? transaction, string source,
        string channelId, string kind, string videoId, bool create)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.Parameters.AddWithValue("$source", source);
        command.Parameters.AddWithValue("$channel", channelId);
        command.Parameters.AddWithValue("$kind", kind);
        command.Parameters.AddWithValue("$video", videoId);
        if (create)
        {
            command.CommandText = """
                INSERT OR IGNORE INTO series_keys(source,channel_id,kind,video_id) VALUES($source,$channel,$kind,$video)
                """;
            command.ExecuteNonQuery();
        }
        command.CommandText = "SELECT id FROM series_keys WHERE source=$source AND channel_id=$channel AND kind=$kind AND video_id=$video";
        return command.ExecuteScalar() is long id ? id : null;
    }

    private static bool HasColumn(SqliteConnection connection, SqliteTransaction? transaction, string table, string column)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "SELECT 1 FROM pragma_table_info($table) WHERE name=$column";
        command.Parameters.AddWithValue("$table", table);
        command.Parameters.AddWithValue("$column", column);
        return command.ExecuteScalar() is not null;
    }

    private static bool TableExists(SqliteConnection connection, string name, SqliteTransaction? transaction = null)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "SELECT 1 FROM sqlite_master WHERE type='table' AND name=$name";
        command.Parameters.AddWithValue("$name", name);
        return command.ExecuteScalar() is not null;
    }

    private static long Scalar(SqliteConnection connection, SqliteTransaction transaction, string sql)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = sql;
        return Convert.ToInt64(command.ExecuteScalar());
    }

    private static void Execute(SqliteConnection connection, SqliteTransaction transaction, string sql)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = sql;
        command.ExecuteNonQuery();
    }
}
