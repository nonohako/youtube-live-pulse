using System.Text.RegularExpressions;

namespace LivePulse.Core;

public sealed record ResolvedYouTubeChannel(string Id, string Url);

public static partial class YouTubeChannelInput
{
    private const string Origin = "https://www.youtube.com";

    [GeneratedRegex("^UC[A-Za-z0-9_-]{22}$", RegexOptions.CultureInvariant)]
    private static partial Regex ChannelIdPattern();
    [GeneratedRegex("^@[\\p{L}\\p{N}_.-]+$", RegexOptions.CultureInvariant)]
    private static partial Regex HandlePattern();
    [GeneratedRegex("\"externalId\"\\s*:\\s*\"(UC[A-Za-z0-9_-]{22})\"", RegexOptions.CultureInvariant)]
    private static partial Regex ExternalIdPattern();
    [GeneratedRegex("\"channelId\"\\s*:\\s*\"(UC[A-Za-z0-9_-]{22})\"", RegexOptions.CultureInvariant)]
    private static partial Regex EmbeddedChannelIdPattern();
    [GeneratedRegex("<meta\\s+itemprop=\"channelId\"\\s+content=\"(UC[A-Za-z0-9_-]{22})\"",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex MetaChannelIdPattern();
    [GeneratedRegex("youtube\\.com/channel/(UC[A-Za-z0-9_-]{22})", RegexOptions.CultureInvariant)]
    private static partial Regex ChannelUrlInHtmlPattern();

    public static ResolvedYouTubeChannel Normalize(string id)
    {
        if (!ChannelIdPattern().IsMatch(id)) throw new ArgumentException("올바르지 않은 YouTube 채널 ID입니다.", nameof(id));
        return new ResolvedYouTubeChannel(id, $"{Origin}/channel/{id}");
    }

    public static string? DirectId(string? input)
    {
        if (string.IsNullOrWhiteSpace(input)) return null;
        var trimmed = input.Trim();
        if (ChannelIdPattern().IsMatch(trimmed)) return trimmed;
        if (!Uri.TryCreate(trimmed, UriKind.Absolute, out var uri) || !IsYouTubeUri(uri)) return null;
        var parts = uri.AbsolutePath.Split('/', StringSplitOptions.RemoveEmptyEntries);
        return parts.Length == 2 && parts[0] == "channel" && ChannelIdPattern().IsMatch(parts[1]) ? parts[1] : null;
    }

    public static string? ExtractHandle(string? input)
    {
        if (string.IsNullOrWhiteSpace(input)) return null;
        var trimmed = input.Trim();
        if (HandlePattern().IsMatch(trimmed)) return trimmed;
        if (!Uri.TryCreate(trimmed, UriKind.Absolute, out var uri) || !IsYouTubeUri(uri)) return null;
        var first = uri.AbsolutePath.Split('/', StringSplitOptions.RemoveEmptyEntries).FirstOrDefault();
        if (first is null) return null;
        var decoded = Uri.UnescapeDataString(first);
        return HandlePattern().IsMatch(decoded) ? decoded : null;
    }

    public static string? FindChannelId(string? html)
    {
        if (string.IsNullOrEmpty(html)) return null;
        foreach (var pattern in new[] { ExternalIdPattern(), EmbeddedChannelIdPattern(),
            MetaChannelIdPattern(), ChannelUrlInHtmlPattern() })
        {
            var match = pattern.Match(html);
            if (match.Success && ChannelIdPattern().IsMatch(match.Groups[1].Value)) return match.Groups[1].Value;
        }
        return null;
    }

    private static bool IsYouTubeUri(Uri uri)
        => uri.Scheme == Uri.UriSchemeHttps && uri.Host is "youtube.com" or "www.youtube.com" or "m.youtube.com";
}
