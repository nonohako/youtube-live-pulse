namespace LivePulse.NativeStore;

public interface IMonitorCommitCheckpoint
{
    void AfterCommit(bool externalEffectsPending);
}

public sealed class NativeBackupException(string message, Exception innerException)
    : IOException(message, innerException);

// One-runner, explicit-path proof. Production still needs process-wide writer coordination.
public sealed class NativeBackupCheckpoint(string databasePath, Func<DateTimeOffset>? clock = null)
    : IMonitorCommitCheckpoint
{
    private static readonly TimeSpan BackupInterval = TimeSpan.FromMinutes(5);
    private readonly string database = Path.GetFullPath(databasePath);
    private readonly Func<DateTimeOffset> utcNow = clock ?? (() => DateTimeOffset.UtcNow);
    private readonly object gate = new();
    private DateTimeOffset? lastBackupAt;
    private int backupCount;

    public int BackupCount => Volatile.Read(ref backupCount);

    public void AfterCommit(bool externalEffectsPending)
    {
        lock (gate)
        {
            var now = utcNow();
            if (!externalEffectsPending && lastBackupAt is { } previous
                && now >= previous && now - previous < BackupInterval)
                return;
            try { NativeStoreRecovery.CreateBackup(database); }
            catch (Exception error) when (error is not OutOfMemoryException)
            {
                throw new NativeBackupException("감시 기록을 저장했지만 SQLite 백업에 실패해 감시를 중단했습니다.", error);
            }
            lastBackupAt = now;
            Interlocked.Increment(ref backupCount);
        }
    }
}
