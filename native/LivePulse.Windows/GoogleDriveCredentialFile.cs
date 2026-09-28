using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using LivePulse.NativeStore;

namespace LivePulse.Windows;

// data\google-drive.dat: the Drive OAuth client and refresh token, encrypted for this Windows user
// (DPAPI). It stays out of the SQLite DB so the daily backup zip never carries the Drive token.
internal static class GoogleDriveCredentialFile
{
    private static readonly byte[] Entropy = "LivePulse.GoogleDrive.v1"u8.ToArray();

    internal static GoogleDriveCredentials Read(string path)
    {
        var json = ProtectedData.Unprotect(File.ReadAllBytes(path), Entropy, DataProtectionScope.CurrentUser);
        return JsonSerializer.Deserialize<GoogleDriveCredentials>(json) is { ClientId.Length: > 0, ClientSecret.Length: > 0, RefreshToken.Length: > 0 } credentials
            ? credentials : throw new InvalidDataException("구글 드라이브 연결 정보가 올바르지 않습니다. 다시 연결해 주세요.");
    }

    internal static void Write(string path, GoogleDriveCredentials credentials)
    {
        var data = ProtectedData.Protect(JsonSerializer.SerializeToUtf8Bytes(credentials), Entropy, DataProtectionScope.CurrentUser);
        var partial = path + ".partial";
        File.WriteAllBytes(partial, data);
        File.Move(partial, path, overwrite: true);
    }
}
