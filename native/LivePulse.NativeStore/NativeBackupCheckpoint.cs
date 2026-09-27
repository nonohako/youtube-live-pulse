namespace LivePulse.NativeStore;

public interface IMonitorCommitCheckpoint
{
    void AfterCommit(bool externalEffectsPending);
}

// Rotates two validated generations after committed writes. The caller holds the DB writer lease.
// SQLite commits are already durable in the primary, so a failed backup is reported and retried
// instead of stopping monitoring or suppressing an already deduplicated effect.
public sealed class NativeBackupCheckpoint(string databasePath, Func<DateTimeOffset>? clock = null)
    : IMonitorCommitCheckpoint
{
    // Each generation copies the whole DB (hundreds of MB on real data), so keep routine copies sparse.
    public static readonly TimeSpan BackupInterval = TimeSpan.FromHours(1);
    public static readonly TimeSpan RetryInterval = TimeSpan.FromMinutes(5);
    private readonly string database = Path.GetFullPath(databasePath);
    private readonly Func<DateTimeOffset> utcNow = clock ?? (() => DateTimeOffset.UtcNow);
    private readonly object gate = new();
    private DateTimeOffset? lastBackupAt;
    private DateTimeOffset? lastFailureAt;
    private string? lastError;
    private int backupCount;

    public int BackupCount => Volatile.Read(ref backupCount);

    // A generation written by the previous run counts toward the hourly schedule, so a restart
    // does not copy the whole DB again right away.
    public void AssumeBackupAt(DateTimeOffset at)
    {
        lock (gate) lastBackupAt = at;
    }
    public string? LastError => Volatile.Read(ref lastError);

    public void AfterCommit(bool externalEffectsPending)
    {
        lock (gate)
        {
            var now = utcNow();
            // After a failure, retry sooner than the routine interval; effects always get a fresh attempt.
            var (since, wait) = lastFailureAt is { } failed ? (failed, RetryInterval)
                : lastBackupAt is { } previous ? (previous, BackupInterval) : (now, TimeSpan.Zero);
            if (!externalEffectsPending && now >= since && now - since < wait)
                return;
            try { NativeStoreRecovery.CreateBackup(database); }
            catch (Exception error) when (error is not OutOfMemoryException)
            {
                lastFailureAt = now;
                Volatile.Write(ref lastError, $"SQLite 백업 실패 ({now.ToLocalTime():HH:mm}): {error.Message}");
                Console.Error.WriteLine($"NATIVE_BACKUP_FAILED {error}");
                return;
            }
            lastBackupAt = now;
            lastFailureAt = null;
            Volatile.Write(ref lastError, null);
            Interlocked.Increment(ref backupCount);
        }
    }
}
