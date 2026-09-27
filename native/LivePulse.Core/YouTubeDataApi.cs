using System.Globalization;
using System.Net.Http.Json;
using System.Text.Json;

namespace LivePulse.Core;

// Optional YouTube Data API v3 enrichment. A key grants no account access; it only improves
// public channel metadata (subscriber counts are rounded by the API) and batches view counts.
// Error messages never contain the request URL, so the key cannot leak into UI state or logs.
public static class YouTubeDataApi
{
    private const string Endpoint = "https://www.googleapis.com/youtube/v3/";

    public static async Task<string?> ResolveHandleAsync(HttpClient http, string handle, string apiKey,
        CancellationToken cancellationToken)
    {
        using var payload = await GetAsync(http, "channels", new() { ["part"] = "id", ["forHandle"] = handle.TrimStart('@') },
            apiKey, cancellationToken);
        return FirstItem(payload.RootElement) is { } item ? YouTubeJson.String(YouTubeJson.At(item, "id")) : null;
    }

    public static async Task<YouTubePageParser.ChannelMetadata> FetchChannelAsync(HttpClient http, string channelId,
        string apiKey, CancellationToken cancellationToken)
    {
        using var payload = await GetAsync(http, "channels",
            new() { ["part"] = "snippet,statistics", ["id"] = channelId }, apiKey, cancellationToken);
        var item = FirstItem(payload.RootElement) ?? throw new InvalidDataException("API에서 채널을 찾지 못했습니다.");
        var statistics = YouTubeJson.At(item, "statistics");
        var hidden = YouTubeJson.At(statistics, "hiddenSubscriberCount") is { ValueKind: JsonValueKind.True };
        var count = hidden ? null : YouTubeJson.Number(YouTubeJson.At(statistics, "subscriberCount"));
        return new YouTubePageParser.ChannelMetadata(
            YouTubeJson.String(YouTubeJson.At(item, "snippet", "title")) ?? "",
            YouTubeJson.BestThumbnail(YouTubeJson.At(item, "snippet", "thumbnails")),
            hidden ? "비공개" : count is { } value ? FormatCompact(value) : "확인 중", count, "api");
    }

    public static async Task<IReadOnlyList<VideoCandidate>> FetchVideosAsync(HttpClient http,
        IReadOnlyList<string> videoIds, string apiKey, CancellationToken cancellationToken)
    {
        using var payload = await GetAsync(http, "videos",
            new() { ["part"] = "snippet,statistics", ["id"] = string.Join(',', videoIds) }, apiKey, cancellationToken);
        if (YouTubeJson.At(payload.RootElement, "items") is not { ValueKind: JsonValueKind.Array } items) return [];
        var result = new List<VideoCandidate>();
        foreach (var item in items.EnumerateArray())
        {
            var id = YouTubeJson.String(YouTubeJson.At(item, "id"));
            var views = YouTubeJson.Number(YouTubeJson.At(item, "statistics", "viewCount"));
            if (id is null || !videoIds.Contains(id) || views is null or < 0) continue;
            result.Add(new VideoCandidate(id,
                Title: YouTubeJson.String(YouTubeJson.At(item, "snippet", "title")) ?? "제목 없음",
                Url: $"https://www.youtube.com/watch?v={id}",
                ThumbnailUrl: YouTubeJson.BestThumbnail(YouTubeJson.At(item, "snippet", "thumbnails")),
                ViewCount: views,
                PublishedAt: YouTubeJson.String(YouTubeJson.At(item, "snippet", "publishedAt")),
                Source: "api"));
        }
        return result;
    }

    // Matches Intl.NumberFormat('ko-KR', { notation: 'compact', maximumFractionDigits: 2 }).
    public static string FormatCompact(long value)
    {
        var (divisor, unit) = Math.Abs(value) switch
        {
            >= 100_000_000 => (100_000_000d, "억"),
            >= 10_000 => (10_000d, "만"),
            >= 1_000 => (1_000d, "천"),
            _ => (1d, "")
        };
        return Math.Round(value / divisor, 2).ToString("0.##", CultureInfo.InvariantCulture) + unit;
    }

    private static JsonElement? FirstItem(JsonElement root)
        => YouTubeJson.At(root, "items") is { ValueKind: JsonValueKind.Array } items && items.GetArrayLength() > 0
            ? items[0] : null;

    private static async Task<JsonDocument> GetAsync(HttpClient http, string resource,
        Dictionary<string, string> query, string apiKey, CancellationToken cancellationToken)
    {
        query["key"] = apiKey;
        var url = Endpoint + resource + "?" + string.Join('&',
            query.Select(pair => $"{pair.Key}={Uri.EscapeDataString(pair.Value)}"));
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(15));
        HttpResponseMessage response;
        try { response = await http.GetAsync(url, timeout.Token); }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        { throw new HttpRequestException("API 응답 시간이 초과되었습니다."); }
        catch (HttpRequestException) { throw new HttpRequestException("API에 연결하지 못했습니다."); }
        using (response)
        {
            JsonDocument? document = null;
            try { document = await response.Content.ReadFromJsonAsync<JsonDocument>(timeout.Token); }
            catch (Exception error) when (error is JsonException or NotSupportedException) { }
            if (response.IsSuccessStatusCode && document is not null) return document;
            var detail = document is null ? null : YouTubeJson.String(YouTubeJson.At(document.RootElement, "error", "message"));
            document?.Dispose();
            throw new HttpRequestException(detail ?? $"API 요청 실패: {(int)response.StatusCode}", null, response.StatusCode);
        }
    }
}
