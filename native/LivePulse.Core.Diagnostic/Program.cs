using System.Text.Json;
using LivePulse.Core;

var channelId = args.Length == 0 ? "UCtKtCiaWRz-d3EZn2xd1mdA" : args[0];
if (args.Length > 1)
{
    Console.Error.WriteLine("사용법: LivePulse.Core.Diagnostic [UC로 시작하는 채널 ID]");
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
