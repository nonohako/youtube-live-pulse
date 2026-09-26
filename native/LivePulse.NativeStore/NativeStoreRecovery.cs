using Microsoft.Data.Sqlite;

namespace LivePulse.NativeStore;

// Explicit-path recovery experiment. The caller must stop every writer before restoring a DB.
public static class NativeStoreRecovery
{
    public sealed record RecoveryResult(bool Restored, string? Source, string? PreservedPrimary);

    public static void CreateBackup(string databasePath)
    {
        var primary = Path.GetFullPath(databasePath);
        Validate(primary);
        var temporary = primary + ".backup.tmp";
        var newest = primary + ".bak.1";
        var older = primary + ".bak.2";
        if (File.Exists(temporary))
            throw new IOException("미처리 임시 백업이 있어 덮어쓸 수 없습니다.");
        if (File.Exists(newest)) Validate(newest);
        if (File.Exists(older)) Validate(older);

        using (var source = Open(primary, SqliteOpenMode.ReadOnly))
        using (var destination = Open(temporary, SqliteOpenMode.ReadWriteCreate))
            source.BackupDatabase(destination);
        FlushFile(temporary);
        Validate(temporary);

        // Same-directory renames leave the validated temporary snapshot available after a failed rotation.
        if (File.Exists(newest)) File.Move(newest, older, overwrite: true);
        File.Move(temporary, newest);
    }

    public static RecoveryResult Recover(string databasePath)
    {
        var primary = Path.GetFullPath(databasePath);
        if (File.Exists(primary))
        {
            try { Validate(primary); return new RecoveryResult(false, null, null); }
            catch (Exception error) when (error is SqliteException or InvalidDataException) { }
        }

        // Replaying an unknown journal during restore could mix corrupt and recovered states.
        foreach (var suffix in new[] { "-wal", "-shm", "-journal" })
            if (File.Exists(primary + suffix))
                throw new InvalidDataException("SQLite 저널 파일이 있어 자동 복구를 중단했습니다.");

        string? selected = null;
        foreach (var candidate in new[] { primary + ".backup.tmp", primary + ".bak.1", primary + ".bak.2" })
        {
            if (!File.Exists(candidate)) continue;
            try { Validate(candidate); selected = candidate; break; }
            catch (Exception error) when (error is SqliteException or InvalidDataException) { }
        }
        if (selected is null) throw new InvalidDataException("검증된 SQLite 백업이 없어 복구를 중단했습니다.");

        var staging = primary + ".restore.tmp";
        if (File.Exists(staging)) throw new IOException("미처리 복구 임시 파일이 있어 덮어쓸 수 없습니다.");
        File.Copy(selected, staging);
        FlushFile(staging);
        Validate(staging);

        string? preserved = null;
        if (File.Exists(primary))
        {
            preserved = primary + ".corrupt." + DateTime.UtcNow.ToString("yyyyMMddHHmmss")
                + "." + Guid.NewGuid().ToString("N");
            File.Move(primary, preserved);
        }
        try { File.Move(staging, primary); }
        catch
        {
            if (preserved is not null && !File.Exists(primary)) File.Move(preserved, primary);
            throw;
        }
        Validate(primary);
        return new RecoveryResult(true, selected, preserved);
    }

    public static void Validate(string databasePath)
    {
        if (!File.Exists(databasePath)) throw new FileNotFoundException("SQLite DB가 없습니다.", databasePath);
        using var connection = Open(databasePath, SqliteOpenMode.ReadOnly);
        using var check = connection.CreateCommand();
        check.CommandText = "PRAGMA integrity_check";
        if (check.ExecuteScalar() as string != "ok")
            throw new InvalidDataException("SQLite 무결성 검사가 실패했습니다.");
        using var marker = connection.CreateCommand();
        marker.CommandText = "SELECT value FROM meta WHERE key='migration_complete'";
        if (marker.ExecuteScalar() as string != "1")
            throw new InvalidDataException("완료된 이전 DB가 아닙니다.");
        marker.CommandText = "SELECT value FROM meta WHERE key='source_sha256'";
        if (marker.ExecuteScalar() is not string hash || hash.Length != 64
            || hash.Any(character => !Uri.IsHexDigit(character)))
            throw new InvalidDataException("원본 SHA-256 표시가 없습니다.");
        foreach (var table in new[] { "channels", "series", "samples", "runtime_tracking", "runtime_events", "runtime_subscriber_samples" })
        {
            using var present = connection.CreateCommand();
            present.CommandText = "SELECT 1 FROM sqlite_master WHERE type='table' AND name=$name";
            present.Parameters.AddWithValue("$name", table);
            if (present.ExecuteScalar() is null)
                throw new InvalidDataException($"필수 SQLite 테이블이 없습니다: {table}");
        }
    }

    private static SqliteConnection Open(string path, SqliteOpenMode mode)
    {
        var connection = new SqliteConnection(new SqliteConnectionStringBuilder
        { DataSource = path, Mode = mode, Pooling = false }.ToString());
        connection.Open();
        return connection;
    }

    private static void FlushFile(string path)
    {
        using var file = new FileStream(path, FileMode.Open, FileAccess.ReadWrite, FileShare.None);
        file.Flush(flushToDisk: true);
    }
}
