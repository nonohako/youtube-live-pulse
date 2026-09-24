namespace LivePulse.NativeStore;

// Coordinates current opt-in native writers for one isolated DB path only.
public sealed class NativeStoreLease : IDisposable
{
    private readonly FileStream stream;
    private bool disposed;

    private NativeStoreLease(FileStream stream) => this.stream = stream;

    public static NativeStoreLease Acquire(string databasePath)
    {
        var lockPath = Path.GetFullPath(databasePath) + ".native-lock";
        if (File.Exists(lockPath) && File.GetAttributes(lockPath).HasFlag(FileAttributes.ReparsePoint))
            throw new InvalidDataException("연결된 격리 DB 잠금 파일은 사용할 수 없습니다.");
        try
        {
            return new NativeStoreLease(new FileStream(lockPath, FileMode.OpenOrCreate,
                FileAccess.ReadWrite, FileShare.None));
        }
        catch (IOException error)
        {
            throw new IOException("이 격리 DB를 사용하는 다른 네이티브 감시 작업이 있거나 잠금 파일에 접근할 수 없습니다.", error);
        }
    }

    public void Dispose()
    {
        if (disposed) return;
        disposed = true;
        stream.Dispose();
    }
}
