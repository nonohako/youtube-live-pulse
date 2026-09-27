using System.Globalization;
using System.IO.Compression;
using System.Xml;
using System.Xml.Linq;

namespace LivePulse.NativeStore;

public sealed record ImportedSubscriberDay(DateOnly Date, long Count);
public sealed record SubscriberWorkbook(IReadOnlyList<ImportedSubscriberDay> Days,
    int SkippedInvalid, int SkippedDuplicate);

public static class SubscriberXlsxImport
{
    public static SubscriberWorkbook Read(string path)
    {
        var file = new FileInfo(path);
        if (!file.Exists || file.Length > 50_000_000) throw new InvalidDataException("XLSX 파일이 없거나 너무 큽니다.");
        using var archive = ZipFile.OpenRead(path);
        var shared = ReadSharedStrings(archive);
        var days = new Dictionary<DateOnly, long>();
        var skippedInvalid = 0;
        var skippedDuplicate = 0;
        foreach (var sheet in archive.Entries.Where(entry =>
                     entry.FullName.StartsWith("xl/worksheets/sheet", StringComparison.Ordinal)
                     && entry.FullName.EndsWith(".xml", StringComparison.OrdinalIgnoreCase)))
        {
            var document = LoadXml(sheet);
            XNamespace ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
            int? dateColumn = null, countColumn = null;
            foreach (var row in document.Descendants(ns + "row"))
            {
                var cells = row.Elements(ns + "c").Select(cell =>
                    (Column: ColumnIndex((string?)cell.Attribute("r")), Value: CellText(cell, ns, shared)))
                    .Where(cell => cell.Column > 0).ToArray();
                if (dateColumn is null || countColumn is null)
                {
                    dateColumn = cells.FirstOrDefault(cell => cell.Value.Trim() == "날짜").Column;
                    countColumn = cells.FirstOrDefault(cell => cell.Value.Trim() == "전체 구독자").Column;
                    if (dateColumn == 0 || countColumn == 0) { dateColumn = null; countColumn = null; }
                    continue;
                }
                var rawDate = cells.FirstOrDefault(cell => cell.Column == dateColumn).Value;
                var rawCount = cells.FirstOrDefault(cell => cell.Column == countColumn).Value;
                if (string.IsNullOrWhiteSpace(rawDate) && string.IsNullOrWhiteSpace(rawCount)) continue;
                if (rawDate.Trim() is "합계" or "평균") continue;
                if (!TryDate(rawDate, out var date) || !TryCount(rawCount, out var count))
                { skippedInvalid++; continue; }
                if (!days.TryAdd(date, count)) skippedDuplicate++;
            }
        }
        if (days.Count == 0) throw new InvalidDataException("날짜와 전체 구독자 열에서 기록을 찾지 못했습니다.");
        return new SubscriberWorkbook(days.OrderBy(item => item.Key)
            .Select(item => new ImportedSubscriberDay(item.Key, item.Value)).ToArray(),
            skippedInvalid, skippedDuplicate);
    }

    private static string[] ReadSharedStrings(ZipArchive archive)
    {
        var entry = archive.GetEntry("xl/sharedStrings.xml");
        if (entry is null) return [];
        var document = LoadXml(entry);
        XNamespace ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
        return document.Descendants(ns + "si")
            .Select(item => string.Concat(item.Descendants(ns + "t").Select(text => text.Value))).ToArray();
    }

    private static XDocument LoadXml(ZipArchiveEntry entry)
    {
        if (entry.Length > 20_000_000) throw new InvalidDataException("XLSX 시트가 너무 큽니다.");
        using var stream = entry.Open();
        using var reader = XmlReader.Create(stream, new XmlReaderSettings
        { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null, MaxCharactersInDocument = 20_000_000 });
        return XDocument.Load(reader);
    }

    private static int ColumnIndex(string? reference)
    {
        var index = 0;
        foreach (var letter in reference ?? "")
        {
            if (letter is not (>= 'A' and <= 'Z')) break;
            index = checked(index * 26 + letter - 'A' + 1);
        }
        return index;
    }

    private static string CellText(XElement cell, XNamespace ns, string[] shared)
    {
        var raw = (string?)cell.Element(ns + "v")
            ?? string.Concat(cell.Descendants(ns + "t").Select(text => text.Value));
        if ((string?)cell.Attribute("t") != "s") return raw;
        return int.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out var index)
            && index >= 0 && index < shared.Length ? shared[index] : "";
    }

    private static bool TryDate(string raw, out DateOnly date)
    {
        date = default;
        if (double.TryParse(raw, NumberStyles.Float, CultureInfo.InvariantCulture, out var serial)
            && serial >= 61 && serial < 3_000_000)
        {
            try { date = DateOnly.FromDateTime(DateTime.FromOADate(serial)); return true; }
            catch (ArgumentException) { return false; }
        }
        var text = raw.Trim().TrimEnd('.').Replace('년', '-').Replace('월', '-').Replace("일", "")
            .Replace('.', '-').Replace('/', '-').Replace(" ", "");
        return DateOnly.TryParse(text, CultureInfo.InvariantCulture, DateTimeStyles.None, out date);
    }

    private static bool TryCount(string raw, out long count)
    {
        count = 0;
        var text = raw.Trim().Replace(",", "").Replace(" ", "");
        return long.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out count)
            && count >= 0 && count <= 9_007_199_254_740_991;
    }
}
