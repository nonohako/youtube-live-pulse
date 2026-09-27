using System.Globalization;
using System.Net;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Xml;
using System.Xml.Linq;

namespace LivePulse.Core;

public static partial class YouTubePageParser
{
    private const string Origin = "https://www.youtube.com";

    [GeneratedRegex("^[A-Za-z0-9_-]{11}$", RegexOptions.CultureInvariant)]
    private static partial Regex VideoIdPattern();
    [GeneratedRegex(@"\bLIVE NOW\b|실시간|생방송", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex LiveLabelPattern();
    [GeneratedRegex(@"(?:^|_)LIVE(?:_|$)", RegexOptions.CultureInvariant)]
    private static partial Regex LiveStylePattern();
    [GeneratedRegex(@"([\d.]+)\s*(억|만|천|[KMB])?", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex CountPattern();
    [GeneratedRegex(@"^구독자\s*[\d.,]+\s*(?:천|만|억)?명?$|^[\d.,]+\s*[KMB]?\s+subscribers?$",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex SubscriberPattern();

    public sealed record CommunityPost(string Id, string Text, string PublishedText, string Url, string ImageUrl);
    public sealed record ChannelMetadata(string Title, string AvatarUrl, string SubscriberText, long? SubscriberCount,
        string Source = "page");

    public static JsonElement? ParseInitialData(string html)
    {
        foreach (var marker in new[] { "var ytInitialData =", "window[\"ytInitialData\"] =", "window['ytInitialData'] =", "ytInitialData =" })
        {
            var markerStart = html.IndexOf(marker, StringComparison.Ordinal);
            if (markerStart < 0) continue;
            var objectStart = html.IndexOf('{', markerStart + marker.Length);
            var json = YouTubeBroadcast.BalancedObject(html, objectStart);
            if (json is null) continue;
            try
            {
                using var document = JsonDocument.Parse(json, new JsonDocumentOptions { MaxDepth = 256 });
                return document.RootElement.Clone();
            }
            catch (JsonException) { }
        }
        return null;
    }

    public static IReadOnlyList<VideoCandidate> ParseVideos(JsonElement? data, DateTimeOffset? now = null)
    {
        var videos = new List<VideoCandidate>();
        YouTubeJson.Walk(data, (key, renderer) =>
        {
            VideoCandidate? video = key switch
            {
                "shortsLockupViewModel" or "reelItemRenderer" => ParseShort(renderer),
                "lockupViewModel" => ParseLockup(renderer, now),
                "videoRenderer" or "gridVideoRenderer" or "compactVideoRenderer" => ParseLegacy(renderer, now),
                _ => null
            };
            if (video is not null) videos.Add(video);
        });
        return videos.GroupBy(video => video.Id, StringComparer.Ordinal).Select(group => group.First()).ToArray();
    }

    public static IReadOnlyList<CommunityPost> ParsePosts(JsonElement? data)
    {
        var posts = new List<CommunityPost>();
        YouTubeJson.Walk(data, (key, renderer) =>
        {
            if (key != "backstagePostRenderer") return;
            var id = YouTubeJson.String(YouTubeJson.At(renderer, "postId"))
                ?? YouTubeJson.String(YouTubeJson.At(renderer, "entityKey"));
            if (string.IsNullOrEmpty(id)) return;
            var endpoint = YouTubeJson.String(YouTubeJson.At(renderer, "navigationEndpoint", "commandMetadata",
                "webCommandMetadata", "url"));
            var url = endpoint is not null && Uri.TryCreate(new Uri(Origin), endpoint, out var absolute)
                && absolute.Scheme == Uri.UriSchemeHttps && absolute.Host is "youtube.com" or "www.youtube.com"
                ? absolute.ToString() : $"{Origin}/post/{Uri.EscapeDataString(id)}";
            posts.Add(new CommunityPost(id,
                FirstText("새 게시물", YouTubeJson.At(renderer, "contentText"), YouTubeJson.At(renderer, "content")),
                YouTubeJson.Text(YouTubeJson.At(renderer, "publishedTimeText")), url,
                YouTubeJson.BestThumbnail(YouTubeJson.At(renderer, "backstageAttachment", "backstageImageRenderer",
                    "image", "thumbnails"))));
        });
        return posts.DistinctBy(post => post.Id, StringComparer.Ordinal).ToArray();
    }

    public static IReadOnlyList<VideoCandidate> ParseVideoFeed(string xml)
    {
        if (string.IsNullOrWhiteSpace(xml)) return [];
        try
        {
            using var text = new StringReader(xml);
            using var reader = XmlReader.Create(text, new XmlReaderSettings
            {
                DtdProcessing = DtdProcessing.Prohibit,
                XmlResolver = null
            });
            var document = XDocument.Load(reader);
            XNamespace yt = "http://www.youtube.com/xml/schemas/2015";
            XNamespace media = "http://search.yahoo.com/mrss/";
            return document.Descendants().Where(element => element.Name.LocalName == "entry")
                .Select(entry =>
                {
                    var id = (string?)entry.Element(yt + "videoId");
                    if (id is null || !VideoIdPattern().IsMatch(id)) return null;
                    return new VideoCandidate(id, Title: (string?)entry.Element(entry.Name.Namespace + "title") ?? "제목 없음",
                        Url: $"{Origin}/watch?v={id}",
                        ThumbnailUrl: (string?)entry.Descendants(media + "thumbnail").FirstOrDefault()?.Attribute("url") ?? "",
                        PublishedAt: (string?)entry.Element(entry.Name.Namespace + "published"),
                        UpdatedAt: (string?)entry.Element(entry.Name.Namespace + "updated"));
                })
                .Where(item => item is not null).Cast<VideoCandidate>().ToArray();
        }
        catch (XmlException) { return []; }
    }

    public static ChannelMetadata ParseChannelMetadata(JsonElement? data, string html = "")
    {
        JsonElement? metadataRenderer = null;
        JsonElement? subscriberNode = null;
        var subscriberFallback = "";
        YouTubeJson.Walk(data, (key, value) =>
        {
            if (metadataRenderer is null && key == "channelMetadataRenderer") metadataRenderer = value;
            if (subscriberNode is null && key.EndsWith("subscriberCountText", StringComparison.OrdinalIgnoreCase))
                subscriberNode = value;
            if (subscriberFallback.Length == 0 && YouTubeJson.String(value) is { } raw)
            {
                var normalized = raw.Replace("\u2066", "", StringComparison.Ordinal)
                    .Replace("\u2067", "", StringComparison.Ordinal).Replace("\u2068", "", StringComparison.Ordinal)
                    .Replace("\u2069", "", StringComparison.Ordinal).Trim();
                if (SubscriberPattern().IsMatch(normalized)) subscriberFallback = normalized;
            }
        });
        var title = YouTubeJson.String(YouTubeJson.At(metadataRenderer, "title"))
            ?? MetaContent(html, "og:title") ?? "YouTube 채널";
        var avatar = YouTubeJson.BestThumbnail(YouTubeJson.At(metadataRenderer, "avatar", "thumbnails"));
        if (avatar.Length == 0) avatar = MetaContent(html, "og:image") ?? "";
        var subscriberText = YouTubeJson.Text(subscriberNode);
        if (subscriberText.Length == 0) subscriberText = subscriberFallback;
        return new ChannelMetadata(WebUtility.HtmlDecode(title), avatar,
            subscriberText.Length > 0 ? subscriberText : "확인 중", ParseLocalizedCount(subscriberText));
    }

    private static string? MetaContent(string html, string property)
    {
        if (html.Length == 0) return null;
        var escaped = Regex.Escape(property);
        foreach (var pattern in new[]
        {
            $"<meta[^>]+property=[\"']{escaped}[\"'][^>]+content=[\"']([^\"']*)[\"']",
            $"<meta[^>]+content=[\"']([^\"']*)[\"'][^>]+property=[\"']{escaped}[\"']"
        })
        {
            var match = Regex.Match(html, pattern, RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
            if (match.Success) return WebUtility.HtmlDecode(match.Groups[1].Value);
        }
        return null;
    }

    private static VideoCandidate? ParseShort(JsonElement renderer)
    {
        var id = YouTubeJson.String(YouTubeJson.At(renderer, "onTap", "innertubeCommand", "reelWatchEndpoint", "videoId"))
            ?? YouTubeJson.String(YouTubeJson.At(renderer, "navigationEndpoint", "reelWatchEndpoint", "videoId"))
            ?? YouTubeJson.String(YouTubeJson.At(renderer, "videoId"));
        if (id is null || !VideoIdPattern().IsMatch(id)) return null;
        return new VideoCandidate(id, Title: FirstText("제목 없음",
                YouTubeJson.At(renderer, "overlayMetadata", "primaryText"), YouTubeJson.At(renderer, "headline")),
            Url: $"{Origin}/watch?v={id}",
            ThumbnailUrl: YouTubeJson.BestThumbnail(YouTubeJson.At(renderer, "thumbnailViewModel", "thumbnailViewModel", "image", "sources")
                ?? YouTubeJson.At(renderer, "thumbnail", "thumbnails")),
            PublishedText: YouTubeJson.Text(YouTubeJson.At(renderer, "publishedTimeText")),
            ViewCount: ParseLocalizedCount(FirstText("", YouTubeJson.At(renderer, "overlayMetadata", "secondaryText"),
                YouTubeJson.At(renderer, "viewCountText"))));
    }

    private static VideoCandidate? ParseLegacy(JsonElement renderer, DateTimeOffset? now)
    {
        var id = YouTubeJson.String(YouTubeJson.At(renderer, "videoId"));
        if (id is null || !VideoIdPattern().IsMatch(id)) return null;
        var labels = new List<string>();
        var overlayStyles = new List<string>();
        foreach (var badge in YouTubeJson.Items(YouTubeJson.At(renderer, "badges")))
        {
            var item = YouTubeJson.At(badge, "metadataBadgeRenderer") ?? YouTubeJson.At(badge, "liveBroadcastingBadgeRenderer");
            AddText(labels, YouTubeJson.At(item, "label"));
            AddText(labels, YouTubeJson.At(item, "tooltip"));
            AddText(labels, YouTubeJson.At(item, "style"));
        }
        foreach (var overlay in YouTubeJson.Items(YouTubeJson.At(renderer, "thumbnailOverlays")))
        {
            var item = YouTubeJson.At(overlay, "thumbnailOverlayTimeStatusRenderer");
            var text = YouTubeJson.Text(YouTubeJson.At(item, "text"));
            if (text.Length > 0) labels.Add(text);
            AddText(labels, YouTubeJson.At(item, "style"));
            AddText(overlayStyles, YouTubeJson.At(item, "style"));
        }
        var start = StartTimestamp(YouTubeJson.At(renderer, "upcomingEventData", "startTime"));
        var isLive = overlayStyles.Contains("LIVE", StringComparer.Ordinal)
            || LiveLabelPattern().IsMatch(string.Join(' ', labels));
        return CreateVideo(id, YouTubeJson.Text(YouTubeJson.At(renderer, "title")),
            YouTubeJson.BestThumbnail(YouTubeJson.At(renderer, "thumbnail", "thumbnails")),
            YouTubeJson.Text(YouTubeJson.At(renderer, "publishedTimeText")),
            ParseLocalizedCount(YouTubeJson.Text(YouTubeJson.At(renderer, "viewCountText"))), start, isLive, now);
    }

    private static VideoCandidate? ParseLockup(JsonElement lockup, DateTimeOffset? now)
    {
        if (YouTubeJson.String(YouTubeJson.At(lockup, "contentType")) != "LOCKUP_CONTENT_TYPE_VIDEO") return null;
        var id = YouTubeJson.String(YouTubeJson.At(lockup, "contentId"))
            ?? YouTubeJson.String(YouTubeJson.At(lockup, "rendererContext", "commandContext", "onTap", "innertubeCommand", "watchEndpoint", "videoId"));
        if (id is null || !VideoIdPattern().IsMatch(id)) return null;
        var metadata = YouTubeJson.At(lockup, "metadata", "lockupMetadataViewModel");
        var metadataTexts = new List<string>();
        foreach (var row in YouTubeJson.Items(YouTubeJson.At(metadata, "metadata", "contentMetadataViewModel", "metadataRows")))
            foreach (var part in YouTubeJson.Items(YouTubeJson.At(row, "metadataParts")))
            {
                var text = YouTubeJson.Text(YouTubeJson.At(part, "text"));
                if (text.Length > 0) metadataTexts.Add(text);
            }
        var viewText = metadataTexts.FirstOrDefault(text => text.Contains("조회수", StringComparison.Ordinal)
            || text.Contains("view", StringComparison.OrdinalIgnoreCase)) ?? "";
        var published = metadataTexts.FirstOrDefault(text => text != viewText) ?? "";
        var labels = new List<string>();
        var styles = new List<string>();
        YouTubeJson.Walk(YouTubeJson.At(lockup, "contentImage"), (key, badge) =>
        {
            if (key != "thumbnailBadgeViewModel") return;
            AddText(labels, YouTubeJson.At(badge, "text"));
            AddText(labels, YouTubeJson.At(badge, "rendererContext", "accessibilityContext", "label"));
            AddText(styles, YouTubeJson.At(badge, "badgeStyle"));
        });
        var isLive = LiveStylePattern().IsMatch(string.Join(' ', styles))
            || LiveLabelPattern().IsMatch(string.Join(' ', labels));
        var start = StartTimestamp(YouTubeJson.At(lockup, "rendererContext", "commandContext", "onTap", "innertubeCommand", "watchEndpoint", "startTimeSeconds"));
        return CreateVideo(id, YouTubeJson.Text(YouTubeJson.At(metadata, "title")),
            YouTubeJson.BestThumbnail(YouTubeJson.At(lockup, "contentImage", "thumbnailViewModel", "image", "sources")),
            published, ParseLocalizedCount(viewText), start, isLive, now);
    }

    private static VideoCandidate CreateVideo(string id, string title, string thumbnail, string published,
        long? viewCount, DateTimeOffset? start, bool live, DateTimeOffset? now)
        => new(id, live, !live && start > (now ?? DateTimeOffset.UtcNow), title.Length > 0 ? title : "제목 없음",
            $"{Origin}/watch?v={id}", thumbnail, published, viewCount,
            start?.UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ss.fffZ", CultureInfo.InvariantCulture));

    private static DateTimeOffset? StartTimestamp(JsonElement? seconds)
    {
        var value = YouTubeJson.Number(seconds);
        if (value is null or <= 0) return null;
        try { return DateTimeOffset.FromUnixTimeSeconds(value.Value); }
        catch (ArgumentOutOfRangeException) { return null; }
    }

    public static long? ParseLocalizedCount(string? text)
    {
        if (string.IsNullOrWhiteSpace(text)) return null;
        var match = CountPattern().Match(text.Replace(",", "", StringComparison.Ordinal));
        if (!match.Success || !double.TryParse(match.Groups[1].Value, NumberStyles.Float,
            CultureInfo.InvariantCulture, out var number)) return null;
        var multiplier = match.Groups[2].Value.ToUpperInvariant() switch
        {
            "천" or "K" => 1_000d,
            "만" => 10_000d,
            "억" => 100_000_000d,
            "M" => 1_000_000d,
            "B" => 1_000_000_000d,
            _ => 1d
        };
        var value = Math.Round(number * multiplier, MidpointRounding.AwayFromZero);
        return value is >= 0 and <= long.MaxValue ? (long)value : null;
    }

    private static string FirstText(string fallback, params JsonElement?[] values)
        => values.Select(YouTubeJson.Text).FirstOrDefault(text => text.Length > 0) ?? fallback;

    private static void AddText(List<string> target, JsonElement? value)
    {
        var text = YouTubeJson.String(value);
        if (!string.IsNullOrEmpty(text)) target.Add(text);
    }
}
