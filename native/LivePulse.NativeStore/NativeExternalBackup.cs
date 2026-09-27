using System.Globalization;
using System.IO.Compression;

namespace LivePulse.NativeStore;

// Daily off-disk copy: zips the newest validated backup generation (.bak.1) into a folder the user
// chose, typically a Google Drive for desktop folder that syncs it. Only files named
// live-pulse-YYYYMMDD.sqlite.zip are created or pruned; nothing else in the folder is touched.
public static class NativeExternalBackup
{
    public const int KeepDays = 3;
    private const string Prefix = "live-pulse-";
    private const string Suffix = ".sqlite.zip";

    public sealed record Result(bool Created, string? Path);

    public static Result RunIfDue(string databasePath, string folder, DateTime localNow)
    {
        if (!System.IO.Path.IsPathFullyQualified(folder))
            throw new InvalidDataException("외부 백업 폴더는 전체 경로여야 합니다.");
        if (!Directory.Exists(folder))
            throw new DirectoryNotFoundException($"외부 백업 폴더가 없습니다: {folder}");
        var source = System.IO.Path.GetFullPath(databasePath) + ".bak.1";
        if (!File.Exists(source)) return new Result(false, null);
        var target = System.IO.Path.Combine(folder, $"{Prefix}{localNow:yyyyMMdd}{Suffix}");
        if (File.Exists(target)) return new Result(false, target);

        // Snapshot the generation first: hourly rotation may rename .bak.1 while zipping.
        var snapshot = System.IO.Path.Combine(System.IO.Path.GetTempPath(), $"livepulse-external-{Guid.NewGuid():N}.sqlite");
        var partial = target + ".partial";
        try
        {
            File.Copy(source, snapshot);
            NativeStoreRecovery.Validate(snapshot, quick: true);
            if (File.Exists(partial)) File.Delete(partial);
            using (var zip = ZipFile.Open(partial, ZipArchiveMode.Create))
                zip.CreateEntryFromFile(snapshot, "live-pulse.sqlite", CompressionLevel.Optimal);
            using (var check = ZipFile.OpenRead(partial))
                if (check.Entries is not [{ } entry] || entry.Length != new FileInfo(snapshot).Length)
                    throw new InvalidDataException("외부 백업 압축 검증에 실패했습니다.");
            File.Move(partial, target);
        }
        finally
        {
            File.Delete(snapshot);
            if (File.Exists(partial)) File.Delete(partial);
        }

        foreach (var old in Directory.GetFiles(folder, $"{Prefix}*{Suffix}")
                     .Where(path => IsOwnName(System.IO.Path.GetFileName(path)))
                     .OrderByDescending(path => path, StringComparer.Ordinal).Skip(KeepDays))
            File.Delete(old);
        return new Result(true, target);
    }

    private static bool IsOwnName(string name)
        => name.Length == Prefix.Length + 8 + Suffix.Length && name.StartsWith(Prefix, StringComparison.Ordinal)
            && name.EndsWith(Suffix, StringComparison.Ordinal)
            && DateTime.TryParseExact(name.Substring(Prefix.Length, 8), "yyyyMMdd", CultureInfo.InvariantCulture,
                DateTimeStyles.None, out _);
}
