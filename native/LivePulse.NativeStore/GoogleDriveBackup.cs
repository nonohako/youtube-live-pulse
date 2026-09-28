using System.Net;
using System.Net.Http.Headers;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace LivePulse.NativeStore;

// OAuth client from the user's own Google Cloud project ("Desktop app" type) plus the refresh token
// granted for the drive.file scope, which only reaches files this app created.
public sealed record GoogleDriveCredentials(string ClientId, string ClientSecret, string RefreshToken);

// Daily off-disk copy uploaded straight to Google Drive, so Google Drive for desktop is not needed.
// Same file names and three-day retention as NativeExternalBackup, inside the app's own
// "라이브 펄스 백업" folder; older copies go to the Drive trash rather than being deleted.
public sealed class GoogleDriveBackup(HttpClient http)
{
    public const string FolderName = "라이브 펄스 백업";
    public const string Scope = "https://www.googleapis.com/auth/drive.file";
    private const string AuthEndpoint = "https://accounts.google.com/o/oauth2/v2/auth";
    private const string TokenEndpoint = "https://oauth2.googleapis.com/token";
    private const string RevokeEndpoint = "https://oauth2.googleapis.com/revoke";
    private const string FilesEndpoint = "https://www.googleapis.com/drive/v3/files";
    private const string UploadEndpoint = "https://www.googleapis.com/upload/drive/v3/files";
    private const string FolderMime = "application/vnd.google-apps.folder";

    public sealed record Result(bool Created, string Name, DateTimeOffset? At);

    // Reads the client_secret_*.json downloaded from Google Cloud Console (Desktop app client).
    public static (string ClientId, string ClientSecret) ParseClientFile(string json)
    {
        using var document = JsonDocument.Parse(json);
        var root = document.RootElement;
        if (root.ValueKind == JsonValueKind.Object && root.TryGetProperty("web", out _))
            throw new InvalidDataException("웹 애플리케이션용 파일입니다. OAuth 클라이언트를 '데스크톱 앱' 유형으로 만들어 주세요.");
        if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("installed", out var installed)
            || installed.ValueKind != JsonValueKind.Object
            || !installed.TryGetProperty("client_id", out var id) || id.ValueKind != JsonValueKind.String
            || !installed.TryGetProperty("client_secret", out var secret) || secret.ValueKind != JsonValueKind.String)
            throw new InvalidDataException("Google OAuth 클라이언트 파일 형식이 올바르지 않습니다.");
        var clientId = id.GetString()!.Trim();
        var clientSecret = secret.GetString()!.Trim();
        if (!Regex.IsMatch(clientId, @"^[A-Za-z0-9._-]{1,200}\.apps\.googleusercontent\.com$")
            || !Regex.IsMatch(clientSecret, "^[A-Za-z0-9_-]{8,200}$"))
            throw new InvalidDataException("Google OAuth 클라이언트 ID 또는 비밀번호가 올바르지 않습니다.");
        return (clientId, clientSecret);
    }

    // Installed-app loopback flow with PKCE: openBrowser shows Google's consent page and the
    // redirect lands on a one-shot listener bound to 127.0.0.1.
    public async Task<GoogleDriveCredentials> AuthorizeAsync(string clientId, string clientSecret,
        Action<Uri> openBrowser, CancellationToken cancellation)
    {
        var verifier = Base64Url(RandomNumberGenerator.GetBytes(32));
        var challenge = Base64Url(SHA256.HashData(Encoding.ASCII.GetBytes(verifier)));
        var state = Base64Url(RandomNumberGenerator.GetBytes(16));
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var redirect = $"http://127.0.0.1:{((IPEndPoint)listener.LocalEndpoint).Port}";
        openBrowser(AuthorizationUri(clientId, redirect, challenge, state));
        var code = await ReceiveCodeAsync(listener, state, cancellation);
        using var response = await http.PostAsync(TokenEndpoint, new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["code"] = code, ["client_id"] = clientId, ["client_secret"] = clientSecret,
            ["redirect_uri"] = redirect, ["grant_type"] = "authorization_code", ["code_verifier"] = verifier
        }), cancellation);
        using var token = await ReadJsonAsync(response, "Google 로그인 토큰을 받지 못했습니다.", cancellation);
        if (!token.RootElement.TryGetProperty("refresh_token", out var refresh) || refresh.ValueKind != JsonValueKind.String)
            throw new InvalidDataException("Google이 오프라인 접근 토큰을 주지 않았습니다. 다시 연결해 주세요.");
        return new GoogleDriveCredentials(clientId, clientSecret, refresh.GetString()!);
    }

    public static Uri AuthorizationUri(string clientId, string redirect, string challenge, string state)
        => new($"{AuthEndpoint}?client_id={Uri.EscapeDataString(clientId)}&redirect_uri={Uri.EscapeDataString(redirect)}"
            + $"&response_type=code&scope={Uri.EscapeDataString(Scope)}&code_challenge={challenge}"
            + $"&code_challenge_method=S256&state={state}&access_type=offline&prompt=consent");

    private static async Task<string> ReceiveCodeAsync(TcpListener listener, string state, CancellationToken cancellation)
    {
        // Browsers may also ask for /favicon.ico; wait for the request that carries the result.
        while (true)
        {
            using var client = await listener.AcceptTcpClientAsync(cancellation);
            var stream = client.GetStream();
            // Browsers open speculative connections that never send a request; don't wait on those.
            string requestLine;
            using (var read = CancellationTokenSource.CreateLinkedTokenSource(cancellation))
            {
                read.CancelAfter(TimeSpan.FromSeconds(3));
                try { requestLine = await ReadRequestLineAsync(stream, read.Token); }
                catch (OperationCanceledException) when (!cancellation.IsCancellationRequested) { continue; }
            }
            var query = ParseCallback(requestLine);
            if (query is null)
            {
                await WriteResponseAsync(stream, "404 Not Found", "", cancellation);
                continue;
            }
            var ok = query.TryGetValue("state", out var returned) && returned == state
                && query.TryGetValue("code", out var code) && code.Length != 0;
            await WriteResponseAsync(stream, "200 OK", ok
                ? "라이브 펄스에 Google 드라이브를 연결했습니다. 이 창을 닫아도 됩니다."
                : "Google 드라이브 연결을 완료하지 못했습니다. 앱에서 다시 시도해 주세요.", cancellation);
            if (!ok)
                throw new InvalidDataException(query.ContainsKey("error")
                    ? "Google 드라이브 접근을 허용하지 않았습니다." : "Google 로그인 응답이 올바르지 않습니다.");
            return query["code"];
        }
    }

    // "GET /?code=..&state=.. HTTP/1.1" -> query values; null for any other path.
    public static Dictionary<string, string>? ParseCallback(string requestLine)
    {
        var parts = requestLine.Split(' ');
        if (parts.Length != 3 || parts[0] != "GET" || !parts[1].StartsWith("/?", StringComparison.Ordinal)) return null;
        var values = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var pair in parts[1][2..].Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var separator = pair.IndexOf('=');
            var key = Uri.UnescapeDataString((separator < 0 ? pair : pair[..separator]).Replace('+', ' '));
            values[key] = separator < 0 ? "" : Uri.UnescapeDataString(pair[(separator + 1)..].Replace('+', ' '));
        }
        return values;
    }

    private static async Task<string> ReadRequestLineAsync(NetworkStream stream, CancellationToken cancellation)
    {
        var buffer = new byte[8192];
        var length = 0;
        while (length < buffer.Length)
        {
            var read = await stream.ReadAsync(buffer.AsMemory(length), cancellation);
            if (read == 0) break;
            length += read;
            if (buffer.AsSpan(0, length).IndexOf("\r\n\r\n"u8) >= 0) break;
        }
        var text = Encoding.ASCII.GetString(buffer, 0, length);
        var end = text.IndexOf("\r\n", StringComparison.Ordinal);
        return end < 0 ? text : text[..end];
    }

    private static async Task WriteResponseAsync(NetworkStream stream, string status, string message, CancellationToken cancellation)
    {
        var body = Encoding.UTF8.GetBytes($"<!doctype html><meta charset=\"utf-8\"><title>라이브 펄스</title><p>{WebUtility.HtmlEncode(message)}</p>");
        var head = Encoding.ASCII.GetBytes($"HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\n"
            + $"Content-Length: {body.Length}\r\nConnection: close\r\n\r\n");
        await stream.WriteAsync(head, cancellation);
        await stream.WriteAsync(body, cancellation);
    }

    // Uploads today's zip unless the app's Drive folder already has it, then keeps the newest three.
    public async Task<Result> RunIfDueAsync(string databasePath, GoogleDriveCredentials credentials, DateTime localNow,
        CancellationToken cancellation = default)
    {
        var name = NativeExternalBackup.FileName(localNow);
        var access = await AccessTokenAsync(credentials, cancellation);
        var folderId = await FindOrCreateFolderAsync(access, cancellation);
        var existing = await ListBackupsAsync(access, folderId, cancellation);
        if (existing.FirstOrDefault(file => file.Name == name) is { } today)
            return new Result(false, name, today.At);

        var zip = Path.Combine(Path.GetTempPath(), $"livepulse-drive-{Guid.NewGuid():N}.zip");
        try
        {
            if (!NativeExternalBackup.WriteZip(databasePath, zip)) return new Result(false, name, null);
            await UploadAsync(access, folderId, name, zip, cancellation);
        }
        finally { File.Delete(zip); }

        var expired = existing.Select(file => file.Name).Append(name).Distinct(StringComparer.Ordinal)
            .OrderByDescending(file => file, StringComparer.Ordinal).Skip(NativeExternalBackup.KeepDays).ToHashSet();
        foreach (var file in existing.Where(file => expired.Contains(file.Name)))
            await TrashAsync(access, file.Id, cancellation);
        return new Result(true, name, DateTimeOffset.UtcNow);
    }

    // Best effort: the local credentials are removed whether or not Google answers.
    public async Task RevokeAsync(GoogleDriveCredentials credentials, CancellationToken cancellation = default)
    {
        using var response = await http.PostAsync(RevokeEndpoint, new FormUrlEncodedContent(
            new Dictionary<string, string> { ["token"] = credentials.RefreshToken }), cancellation);
    }

    private async Task<string> AccessTokenAsync(GoogleDriveCredentials credentials, CancellationToken cancellation)
    {
        using var response = await http.PostAsync(TokenEndpoint, new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["client_id"] = credentials.ClientId, ["client_secret"] = credentials.ClientSecret,
            ["refresh_token"] = credentials.RefreshToken, ["grant_type"] = "refresh_token"
        }), cancellation);
        if (response.StatusCode is HttpStatusCode.BadRequest or HttpStatusCode.Unauthorized)
        {
            var text = await response.Content.ReadAsStringAsync(cancellation);
            if (text.Contains("invalid_grant", StringComparison.Ordinal))
                throw new InvalidDataException("Google 드라이브 연결이 만료됐습니다. 설정에서 다시 연결해 주세요.");
        }
        using var token = await ReadJsonAsync(response, "Google 드라이브 접근 토큰을 받지 못했습니다.", cancellation);
        return token.RootElement.TryGetProperty("access_token", out var access) && access.ValueKind == JsonValueKind.String
            ? access.GetString()! : throw new InvalidDataException("Google 드라이브 접근 토큰이 없습니다.");
    }

    private async Task<string> FindOrCreateFolderAsync(string access, CancellationToken cancellation)
    {
        var query = $"name='{FolderName}' and mimeType='{FolderMime}' and trashed=false";
        using (var found = await SendJsonAsync(HttpMethod.Get,
                   $"{FilesEndpoint}?q={Uri.EscapeDataString(query)}&fields=files(id)&orderBy=createdTime&pageSize=1", access, null, cancellation))
            if (found.RootElement.GetProperty("files") is { ValueKind: JsonValueKind.Array } files && files.GetArrayLength() > 0)
                return files[0].GetProperty("id").GetString()!;
        using var created = await SendJsonAsync(HttpMethod.Post, $"{FilesEndpoint}?fields=id", access,
            JsonSerializer.Serialize(new { name = FolderName, mimeType = FolderMime }), cancellation);
        return created.RootElement.GetProperty("id").GetString()!;
    }

    private sealed record DriveFile(string Id, string Name, DateTimeOffset? At);

    private async Task<List<DriveFile>> ListBackupsAsync(string access, string folderId, CancellationToken cancellation)
    {
        var query = $"'{folderId}' in parents and trashed=false";
        using var listed = await SendJsonAsync(HttpMethod.Get,
            $"{FilesEndpoint}?q={Uri.EscapeDataString(query)}&fields=files(id,name,createdTime)&pageSize=100", access, null, cancellation);
        var result = new List<DriveFile>();
        foreach (var file in listed.RootElement.GetProperty("files").EnumerateArray())
        {
            var name = file.GetProperty("name").GetString() ?? "";
            if (!NativeExternalBackup.IsOwnName(name)) continue;
            result.Add(new DriveFile(file.GetProperty("id").GetString()!, name,
                file.TryGetProperty("createdTime", out var at) && at.TryGetDateTimeOffset(out var parsed) ? parsed : null));
        }
        return result;
    }

    // Resumable upload: the zip can exceed the 5 MB multipart limit. The returned size must match.
    private async Task UploadAsync(string access, string folderId, string name, string path, CancellationToken cancellation)
    {
        using var start = new HttpRequestMessage(HttpMethod.Post, $"{UploadEndpoint}?uploadType=resumable")
        {
            Content = new StringContent(JsonSerializer.Serialize(new { name, parents = new[] { folderId }, mimeType = "application/zip" }),
                Encoding.UTF8, "application/json")
        };
        start.Headers.Authorization = new AuthenticationHeaderValue("Bearer", access);
        start.Headers.Add("X-Upload-Content-Type", "application/zip");
        Uri session;
        using (var response = await http.SendAsync(start, cancellation))
        {
            if (!response.IsSuccessStatusCode || response.Headers.Location is not { } location)
                throw new HttpRequestException($"Google 드라이브 업로드를 시작하지 못했습니다 ({(int)response.StatusCode}).");
            session = location;
        }
        var length = new FileInfo(path).Length;
        await using var content = File.OpenRead(path);
        using var put = new HttpRequestMessage(HttpMethod.Put, session) { Content = new StreamContent(content) };
        put.Content.Headers.ContentType = new MediaTypeHeaderValue("application/zip");
        put.Headers.Authorization = new AuthenticationHeaderValue("Bearer", access);
        using var uploaded = await http.SendAsync(put, cancellation);
        using var file = await ReadJsonAsync(uploaded, "Google 드라이브 업로드에 실패했습니다.", cancellation);
        if (!file.RootElement.TryGetProperty("id", out _))
            throw new InvalidDataException("Google 드라이브 업로드 결과가 올바르지 않습니다.");
        // Verify with an explicit metadata read; the upload response only lists default fields.
        var id = file.RootElement.GetProperty("id").GetString()!;
        using var check = await SendJsonAsync(HttpMethod.Get, $"{FilesEndpoint}/{Uri.EscapeDataString(id)}?fields=size", access, null, cancellation);
        if (!check.RootElement.TryGetProperty("size", out var size) || size.GetString() != length.ToString(System.Globalization.CultureInfo.InvariantCulture))
            throw new InvalidDataException("Google 드라이브에 올라간 백업 크기가 다릅니다.");
    }

    private async Task TrashAsync(string access, string id, CancellationToken cancellation)
    {
        using var _ = await SendJsonAsync(HttpMethod.Patch, $"{FilesEndpoint}/{Uri.EscapeDataString(id)}?fields=id", access,
            """{"trashed":true}""", cancellation);
    }

    private async Task<JsonDocument> SendJsonAsync(HttpMethod method, string url, string access, string? body,
        CancellationToken cancellation)
    {
        using var request = new HttpRequestMessage(method, url);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", access);
        if (body is not null) request.Content = new StringContent(body, Encoding.UTF8, "application/json");
        using var response = await http.SendAsync(request, cancellation);
        return await ReadJsonAsync(response, "Google 드라이브 요청에 실패했습니다.", cancellation);
    }

    private static async Task<JsonDocument> ReadJsonAsync(HttpResponseMessage response, string failure, CancellationToken cancellation)
    {
        if (!response.IsSuccessStatusCode) throw new HttpRequestException($"{failure} ({(int)response.StatusCode})");
        return JsonDocument.Parse(await response.Content.ReadAsStringAsync(cancellation));
    }

    private static string Base64Url(byte[] bytes)
        => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
}
