using System.Net.Http.Headers;
using System.Text;

namespace LivePulse.NativeStore;

// One explicit sync attempt. A production host must add a controlled schedule and error state.
public sealed class NativeCloudSync : IDisposable
{
    private const int MaxPageBytes = 2_000_000;
    private readonly NativeCloudArchive archive;
    private readonly HttpClient client;
    private readonly IMonitorCommitCheckpoint? checkpoint;
    private readonly bool ownsClient;

    public NativeCloudSync(string databasePath, IMonitorCommitCheckpoint? checkpoint = null)
        : this(databasePath, new HttpClient(new SocketsHttpHandler { AllowAutoRedirect = false }),
            checkpoint, true) { }

    internal NativeCloudSync(string databasePath, HttpClient client,
        IMonitorCommitCheckpoint? checkpoint = null)
        : this(databasePath, client, checkpoint, false) { }

    private NativeCloudSync(string databasePath, HttpClient client,
        IMonitorCommitCheckpoint? checkpoint, bool ownsClient)
    {
        archive = new NativeCloudArchive(databasePath);
        this.client = client;
        this.checkpoint = checkpoint;
        this.ownsClient = ownsClient;
    }

    public void Dispose()
    {
        if (ownsClient) client.Dispose();
    }

    public void ReplayForNewChannel() => archive.ResetCursorForNewChannel();

    public async Task<NativeCloudSyncResult> SyncOnceAsync(CancellationToken cancellationToken = default)
    {
        var configuration = archive.ReadConfiguration();
        if (configuration is null) return new NativeCloudSyncResult(false, 0, 0, 0);
        var pages = 0;
        var observations = 0;
        for (var index = 0; index < 10; index++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var url = new Uri(configuration.Endpoint, $"/v1/sync?after={configuration.Cursor}");
            using var request = new HttpRequestMessage(HttpMethod.Get, url);
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", configuration.Token);
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(TimeSpan.FromSeconds(15));
            using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
            if (!response.IsSuccessStatusCode)
                throw new IOException("클라우드 읽기 요청에 실패했습니다.");
            if (response.Content.Headers.ContentLength > MaxPageBytes)
                throw new InvalidDataException("클라우드 응답이 너무 큽니다.");
            await using var body = await response.Content.ReadAsStreamAsync(timeout.Token);
            using var buffer = new MemoryStream();
            var chunk = new byte[16 * 1024];
            int read;
            while ((read = await body.ReadAsync(chunk, timeout.Token)) != 0)
            {
                if (buffer.Length + read > MaxPageBytes)
                    throw new InvalidDataException("클라우드 응답이 너무 큽니다.");
                buffer.Write(chunk, 0, read);
            }
            var json = new UTF8Encoding(false, true).GetString(buffer.GetBuffer(), 0, (int)buffer.Length);
            var current = archive.ReadConfiguration();
            if (current is null || current.Endpoint != configuration.Endpoint
                || current.Token != configuration.Token || current.Cursor != configuration.Cursor
                || !current.ChannelIds.SetEquals(configuration.ChannelIds))
                return new NativeCloudSyncResult(true, pages, observations, configuration.Cursor);
            var result = archive.ApplyPage(configuration, json, DateTimeOffset.UtcNow);
            checkpoint?.AfterCommit(false);
            pages++;
            observations += result.Observations;
            configuration = new NativeCloudConfiguration(configuration.Endpoint, configuration.Token,
                result.Cursor, configuration.ChannelIds);
            if (!result.HasMore || !result.HadSamples) break;
        }
        return new NativeCloudSyncResult(true, pages, observations, configuration.Cursor);
    }
}
