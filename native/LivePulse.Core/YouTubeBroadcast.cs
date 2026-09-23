using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace LivePulse.Core;

public sealed record Broadcast(string Id, string Title, string Url, string ThumbnailUrl,
    string? ScheduledStart, bool IsLive, bool IsUpcoming);

public sealed record VideoCandidate(string Id, bool IsLive = false, bool IsUpcoming = false);

public static partial class YouTubeBroadcast
{
    private const string Origin = "https://www.youtube.com";

    [GeneratedRegex("^[A-Za-z0-9_-]{11}$", RegexOptions.CultureInvariant)]
    private static partial Regex VideoIdPattern();

    public static Broadcast? ParsePlayer(string html, string? finalUrl = null, DateTimeOffset? now = null)
    {
        var player = PlayerResponse(html);
        if (player is null) return null;
        var details = Property(player, "videoDetails");
        var videoId = String(Property(details, "videoId")) ?? VideoIdFromUrl(finalUrl);
        if (videoId is null || !VideoIdPattern().IsMatch(videoId)) return null;
        var liveDetails = Property(Property(Property(player, "microformat"), "playerMicroformatRenderer"), "liveBroadcastDetails");
        var scheduledStart = String(Property(liveDetails, "startTimestamp"));
        var live = Bool(Property(liveDetails, "isLiveNow")) || Bool(Property(details, "isLive"));
        var upcoming = !live && Bool(Property(details, "isLiveContent"))
            && scheduledStart is not null
            && DateTimeOffset.TryParse(scheduledStart, CultureInfo.InvariantCulture,
                DateTimeStyles.AssumeUniversal, out var start)
            && start > (now ?? DateTimeOffset.UtcNow);
        if (!live && !upcoming) return null;
        return new Broadcast(videoId, String(Property(details, "title")) ?? "YouTube 라이브",
            $"{Origin}/watch?v={videoId}", BestThumbnail(Property(Property(details, "thumbnail"), "thumbnails")),
            scheduledStart, live, upcoming);
    }

    public static Broadcast? SelectCurrentLive(Broadcast? player, Broadcast? list, bool livePageAvailable = true)
    {
        if (player?.IsLive == true)
        {
            if (list is null || list.Id != player.Id) return player;
            return player with
            {
                ThumbnailUrl = player.ThumbnailUrl.Length > 0 ? player.ThumbnailUrl : list.ThumbnailUrl,
                ScheduledStart = player.ScheduledStart ?? list.ScheduledStart
            };
        }
        return !livePageAvailable && list?.IsLive == true ? list : null;
    }

    public static IReadOnlyList<VideoCandidate> SelectRecentVideos(
        IReadOnlyList<VideoCandidate>? uploads, IReadOnlyList<VideoCandidate>? feed,
        IReadOnlyList<VideoCandidate>? streams, IReadOnlyList<VideoCandidate>? shorts, int limit = 32)
    {
        var sources = new[] { feed ?? [], shorts ?? [], uploads ?? [], streams ?? [] };
        var excluded = sources.SelectMany(x => x).Where(x => x.IsLive || x.IsUpcoming)
            .Select(x => x.Id).ToHashSet(StringComparer.Ordinal);
        var candidates = sources.Select(source => source.Where(x => !excluded.Contains(x.Id)).Take(8).ToArray()).ToArray();
        var result = new List<VideoCandidate>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        for (var index = 0; index < 8 && result.Count < limit; index++)
            foreach (var source in candidates)
                if (index < source.Length && source[index].Id.Length > 0 && seen.Add(source[index].Id))
                {
                    result.Add(source[index]);
                    if (result.Count == limit) break;
                }
        return result;
    }

    public static string? VideoIdFromUrl(string? value)
    {
        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttps ||
            uri.Host is not ("youtube.com" or "www.youtube.com" or "m.youtube.com")) return null;
        foreach (var part in uri.Query.TrimStart('?').Split('&'))
        {
            var pieces = part.Split('=', 2);
            if (pieces[0] != "v") continue;
            var id = Uri.UnescapeDataString(pieces.ElementAtOrDefault(1) ?? "");
            return VideoIdPattern().IsMatch(id) ? id : null;
        }
        return null;
    }

    private static JsonElement? PlayerResponse(string html)
    {
        foreach (var marker in new[] { "var ytInitialPlayerResponse =", "ytInitialPlayerResponse =" })
        {
            var markerStart = html.IndexOf(marker, StringComparison.Ordinal);
            if (markerStart < 0) continue;
            var objectStart = html.IndexOf('{', markerStart + marker.Length);
            var json = BalancedObject(html, objectStart);
            if (json is null) continue;
            try
            {
                using var document = JsonDocument.Parse(json);
                return document.RootElement.Clone();
            }
            catch (JsonException) { }
        }
        return null;
    }

    public static string? BalancedObject(string source, int start)
    {
        if (start < 0 || start >= source.Length || source[start] != '{') return null;
        var depth = 0;
        var inString = false;
        var escaped = false;
        for (var index = start; index < source.Length; index++)
        {
            var character = source[index];
            if (inString)
            {
                if (escaped) escaped = false;
                else if (character == '\\') escaped = true;
                else if (character == '"') inString = false;
                continue;
            }
            if (character == '"') inString = true;
            else if (character == '{') depth++;
            else if (character == '}' && --depth == 0) return source[start..(index + 1)];
        }
        return null;
    }

    private static JsonElement? Property(JsonElement? element, string name)
        => element is { ValueKind: JsonValueKind.Object } value && value.TryGetProperty(name, out var property)
            ? property : null;

    private static string? String(JsonElement? element)
        => element is { ValueKind: JsonValueKind.String } value ? value.GetString() : null;

    private static bool Bool(JsonElement? element)
        => element is { ValueKind: JsonValueKind.True };

    private static string BestThumbnail(JsonElement? thumbnails)
    {
        if (thumbnails is not { ValueKind: JsonValueKind.Array } array) return "";
        var bestUrl = "";
        var bestWidth = -1;
        foreach (var item in array.EnumerateArray())
        {
            var url = String(Property(item, "url"));
            var widthElement = Property(item, "width");
            var width = widthElement is { ValueKind: JsonValueKind.Number } value && value.TryGetInt32(out var number) ? number : 0;
            if (!string.IsNullOrEmpty(url) && width > bestWidth) { bestUrl = url; bestWidth = width; }
        }
        return bestUrl;
    }
}
