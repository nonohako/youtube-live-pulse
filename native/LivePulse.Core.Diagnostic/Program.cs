using System.Text.Json;
using LivePulse.Core;

if (args.Length == 2 && args[0] == "--resolve")
{
    using var resolver = new YouTubeSnapshotClient();
    try
    {
        Console.WriteLine(JsonSerializer.Serialize(await resolver.ResolveChannelInputAsync(args[1])));
        return 0;
    }
    catch (Exception error) when (error is ArgumentException or InvalidDataException or HttpRequestException)
    {
        Console.Error.WriteLine(error.Message);
        return 1;
    }
}

var channelId = args.Length == 0 ? "UCtKtCiaWRz-d3EZn2xd1mdA" : args[0];
if (args.Length > 1)
{
    Console.Error.WriteLine("사용법: LivePulse.Core.Diagnostic [UC로 시작하는 채널 ID] | --resolve 채널주소또는@핸들");
    return 2;
}

try
{
    using var client = new YouTubeSnapshotClient();
    var snapshot = await client.FetchChannelSnapshotAsync(channelId);
    Console.WriteLine(JsonSerializer.Serialize(new
    {
        snapshot.CheckedAt,
        channelId,
        snapshot.Metadata.Title,
        snapshot.Metadata.SubscriberCount,
        liveId = snapshot.Live?.Id,
        upcomingIds = snapshot.Upcoming.Select(item => item.Id),
        latestVideoId = snapshot.LatestVideo?.Id,
        latestPostId = snapshot.LatestPost?.Id,
        recentVideoIds = snapshot.RecentVideos.Select(item => item.Id),
        snapshot.Warnings
    }, new JsonSerializerOptions { WriteIndented = true }));
    return snapshot.Warnings.Count == 6 ? 1 : 0;
}
catch (ArgumentException error)
{
    Console.Error.WriteLine(error.Message);
    return 2;
}
