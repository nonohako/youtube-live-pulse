using System.Text.Json;

namespace LivePulse.Core;

internal static class YouTubeJson
{
    internal static JsonElement? At(JsonElement? value, params string[] path)
    {
        foreach (var key in path)
        {
            if (value is not { ValueKind: JsonValueKind.Object } obj || !obj.TryGetProperty(key, out var child)) return null;
            value = child;
        }
        return value;
    }

    internal static string? String(JsonElement? value)
        => value is { ValueKind: JsonValueKind.String } text ? text.GetString() : null;

    internal static bool Bool(JsonElement? value)
        => value is { ValueKind: JsonValueKind.True };

    internal static string Text(JsonElement? value)
    {
        if (String(value) is { } direct) return direct;
        if (String(At(value, "simpleText")) is { } simple) return simple;
        if (At(value, "runs") is { ValueKind: JsonValueKind.Array } runs)
            return string.Concat(runs.EnumerateArray().Select(run => String(At(run, "text")) ?? ""));
        return String(At(value, "content")) ?? "";
    }

    internal static string BestThumbnail(JsonElement? thumbnails)
    {
        if (thumbnails is { ValueKind: JsonValueKind.Object } obj)
            return BestThumbnail(obj.EnumerateObject().Select(property => property.Value).ToArray());
        if (thumbnails is not { ValueKind: JsonValueKind.Array } array) return "";
        return BestThumbnail(array.EnumerateArray().ToArray());
    }

    private static string BestThumbnail(IEnumerable<JsonElement> candidates)
    {
        var bestUrl = "";
        long bestWidth = -1;
        foreach (var item in candidates)
        {
            var url = String(At(item, "url"));
            var width = Number(At(item, "width")) ?? 0;
            if (!string.IsNullOrEmpty(url) && width > bestWidth)
            {
                bestUrl = url;
                bestWidth = width;
            }
        }
        return bestUrl;
    }

    internal static long? Number(JsonElement? value)
    {
        if (value is { ValueKind: JsonValueKind.Number } number && number.TryGetInt64(out var integer)) return integer;
        return long.TryParse(String(value), out var textNumber) ? textNumber : null;
    }

    internal static void Walk(JsonElement? value, Action<string, JsonElement> visit)
    {
        if (value is { ValueKind: JsonValueKind.Object } obj)
        {
            foreach (var property in obj.EnumerateObject())
            {
                visit(property.Name, property.Value);
                Walk(property.Value, visit);
            }
        }
        else if (value is { ValueKind: JsonValueKind.Array } array)
            foreach (var item in array.EnumerateArray()) Walk(item, visit);
    }

    internal static IEnumerable<JsonElement> Items(JsonElement? value)
        => value is { ValueKind: JsonValueKind.Array } array ? array.EnumerateArray() : [];
}
