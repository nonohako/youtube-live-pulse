# Agent Guide

Last maintained: 2026-09-27 after completing the C# migration: Electron parity items were ported, the Electron app/source/build outputs were removed, and the personal app runs portably from this folder.

## Current state

- **Live Pulse (라이브 펄스)** is a single-user personal Windows tray app written in C# (.NET 10, WPF host + WebView2). It monitors YouTube channels in the background, shows notifications and opens Chrome for a live or scheduled broadcast. The HTML/CSS/JS dashboard in `src/renderer` is hosted in WebView2 through `native/LivePulse.Windows/bridge.js` (`window.livePulse`).
- The Electron app is retired: its installed copy was uninstalled on 2026-09-27 and `src/main.js`, `src/lib`, Electron scripts/tests, `package-lock.json` and the release workflow were removed. Git history (up to commit 94d53df) keeps them. Public GitHub Releases up to v1.12.1 remain Electron builds; do not publish new tags/installers unless the user asks for public distribution.
- The user asked to reduce overengineering. Prefer focused fixes from real use; do not add speculative abstractions. After each completed task, commit and push the current branch without asking (no tags/releases).

## Portable layout

- `native/publish-portable.ps1` publishes a self-contained build to `<repo>/app` (with the `LivePulse.portable` marker), creates the desktop shortcut `라이브 펄스.lnk`, and removes intermediate `native/*/bin|obj`. It first asks a running app to quit with `app\LivePulse.exe --quit` (graceful: finishes the current write/backup). `-FromJson PATH` performs first setup from an Electron `live-pulse.json` (the final one is archived in `data/legacy/`).
- All personal data lives in `<repo>/data`: `live-pulse.sqlite`, `.bak.1/.bak.2`, the WebView2 profile, `startup-error.log`/`runtime-error.log`, and `legacy/` (compressed final Electron JSON, preserved Electron Run command). `app/` and `data/` are gitignored; rebuilds never overwrite `data/`.
- Paths are relative to the executable, so the folder can move (e.g. to D:). On launch the app rewrites its own `라이브 펄스` Run value and a desktop shortcut (`라이브 펄스.lnk` or legacy `라이브 펄스 (네이티브).lnk`) that targets a LivePulse executable. Never overwrite an unrelated Run value or shortcut.
- Only a marked build with no arguments or only `--hidden` opens personal data. Missing `data/` or an unrecoverable DB stops visibly; never fall back to fixture data. Unmarked development builds keep fixture/isolated behavior (`--isolated-monitor-db` needs an ignored `artifacts/migration-isolated-data/*.probe.sqlite`).
- A per-user mutex and events route repeated launches to the existing window and `--quit` to a graceful stop. The `.native-lock` DB lease is the writer guard.
- The .NET 10 SDK is currently at `%TEMP%\livepulse-dotnet10` (a temp cleaner may remove it; reinstall with `winget install Microsoft.DotNet.SDK.10` or pass `-Dotnet`).

## Storage, backup and recovery invariants

- SQLite primary with separate runtime tables; imported Electron series and their verification hashes stay unchanged. Commits are transactional; tracking/dedup keys are committed before any notification or URL effect.
- Backups (`NativeStoreRecovery.CreateBackup`) use SQLite's backup API, validate the snapshot with `integrity_check`, and rotate `.bak.1/.bak.2`. Routine backups run on the first commit and then hourly; a commit that plans effects forces a backup first. A failed backup is shown as `monitor.warning` and retried after 5 minutes; it never stops monitoring or suppresses an already committed/deduplicated effect.
- Interrupted-backup residue (`.backup.tmp` and its hot journal) is discarded only after the primary and every existing generation validate under the writer lease. Never remove or restore a partial backup without that validation.
- Personal startup calls `NativeStoreRecovery.OpenForStartup` under the lease: a read-write open rolls back a crash journal (read-only validation rejects such a valid DB), then the primary is validated or the newest valid backup is restored with the corrupt primary preserved. No valid copy stops startup visibly.
- Never initialize defaults over unreadable data. Recovery restores only real records; never fill gaps with estimated values or fixtures.
- Real observations recorded by another runtime may be merged only with exact-instant deduplication (done once for Electron's 2026-09-26/27 run: 11 subscriber and 2,321 video samples).

## Monitoring and UI state invariants

- `NativeMonitorScheduler` reads channel IDs/settings each sweep, starts after 250 ms, runs channels sequentially and contains channel failures (recorded once per distinct message as an `error` event, like Electron). `Wake()` ends the current wait after a channel add, interval change or API key change.
- `monitor.running` means a sweep is in progress; `monitor.nextCheckAt` comes from the scheduler; the channel being checked shows `checking`. Sweep start/finish pushes state and updates the tray tooltip (live count).
- Events carry `id`/`at`, are newest-first (runtime before imported), and removed channels' events are hidden. Channel name/avatar come from the latest check.
- Keep the validated analytics scope per WebView session; rejected requests preserve it; dialog release, channel removal and window disposal release it. Never replace open-chart histories with overview endpoints on a timer/cloud refresh.
- After a failed channel sweep keep saved snapshots/history but hide stale live/upcoming indications; expose effect failures without promising automatic retries of deduplicated notifications.
- Hidden startup creates no WebView. Closing disposes WebView; minimized/hidden windows skip broadcasts and pause countdowns; restore sends fresh scoped state. Monitoring and cloud sync continue while hidden.
- Tray menu: open, refresh now, Windows login toggle, quit; left click opens. Notifications are tray balloons whose click opens the validated YouTube URL in Chrome.

## User-facing principles

- Keep the application and documentation understandable to a Korean-speaking non-developer.
- The app must keep working without an API key for its core monitoring features.
- Closing the main window must keep the tray monitor running.
- Never open the same live or scheduled broadcast repeatedly.
- Prefer a missed notification over opening a finished or ambiguous broadcast as an upcoming stream.
- Preserve user settings and channel history across updates and folder moves.

## Repository

- Public repository: `https://github.com/nonohako/youtube-live-pulse` (default branch `main`; the native work is on `codex/csharp-webview2-migration`).
- `native/LivePulse.Core`: YouTube input resolution, public-page/RSS parsing, optional Data API, change planning.
- `native/LivePulse.NativeStore`: SQLite store, backups/recovery, scheduler, cloud sync, state projection, xlsx import.
- `native/LivePulse.Windows`: WPF tray host, WebView2 bridge, portable layout, Run/shortcut repair.
- `native/LivePulse.DataMigration`: Electron JSON v3 to SQLite importer/verifier (first setup only).
- `native/*Tests`, `native/LivePulse.Core.Diagnostic`: harnesses and a read-only live-channel diagnostic.
- `src/renderer`: dashboard UI; `test/`: Node tests for renderer math and the cloud service; `cloud/`: Fly.io collector.

## Checks

```powershell
$dn = "$env:TEMP\livepulse-dotnet10\dotnet.exe"
& $dn build native/LivePulse.Core.Tests/LivePulse.Core.Tests.csproj -c Release; & $dn native/LivePulse.Core.Tests/bin/Release/net10.0/LivePulse.Core.Tests.dll
& $dn build native/LivePulse.NativeStore.Tests/LivePulse.NativeStore.Tests.csproj -c Release; & $dn native/LivePulse.NativeStore.Tests/bin/Release/net10.0/LivePulse.NativeStore.Tests.dll
node --test
```

Also run `LivePulse.exe --startup-self-test` and, for UI changes, the isolated WebView smoke described in `native/README.md`.

## YouTube invariants

- The default channel is `UCtKtCiaWRz-d3EZn2xd1mdA`.
- Core monitoring uses public YouTube pages and the official channel RSS feed.
- The optional YouTube Data API key (`YouTubeDataApi`) only improves public channel metadata (refreshed at most every 10 minutes, or on manual refresh) and batches public video statistics; missing or failed API items fall back to public watch pages and the key never appears in messages or UI state. It is not OAuth, grants no account access and does not reveal exact subscriber totals for another channel; the official API rounds public subscriber counts down to three significant figures.
- Fetch both `/videos` and `/streams`. Parse both legacy video renderers and the current `lockupViewModel` structure; do not rely on RSS publication delay as the only new-video signal.
- Also fetch `/shorts` every polling cycle and parse `shortsLockupViewModel` and legacy `reelItemRenderer`. Interleave up to eight candidates per source (32 total) so long video lists cannot starve Shorts or RSS. Exclude IDs classified as live/upcoming by any source before merging. Regression coverage includes `mFM2hP5LEhM` with RSS unavailable.
- Regular-video notification candidates must exclude every item currently classified as live or upcoming, even when the same ID appears in RSS, `/videos` and `/streams`.
- When `/live` responds successfully, require its player response to confirm the current live before opening; do not trust a possibly stale list badge over a successful non-live player result. A list live item is only a network-failure fallback when `/live` itself could not be fetched.
- Community-post detection is experimental because the official Data API does not expose community posts.
- A player item is upcoming only when a real future `startTimestamp` exists.
- A stream-list item is upcoming only when a real start timestamp exists and that timestamp is in the future. An upcoming-looking badge without a time is ambiguous and must not auto-open.
- Missing or past timestamps must never be treated as `DateTimeOffset.MaxValue` or otherwise coerced into the future.
- Keep a regression test for finished live video `hm6LLaIfMho`.

## Subscriber analytics invariants

- Keep current-day samples on the raw subscriber chart, but exclude the current local calendar day from every daily growth, momentum, slope-change and selected-range calculation because that day is incomplete.
- Daily analytics use the last stored sample from each completed local date.
- Preserve raw local and imported subscriber histories during polling without age or sample-count deletion. Bound renderer projections instead; restoring old imported dates must not be undone by the next channel check.
- When recorded dates have gaps, divide change and growth by elapsed local calendar days; never invent or interpolate missing daily closes.
- Date clicks select one completed day. Pointer drags select the inclusive span of actual completed-day records and must work in either direction.
- A selected-day change includes that day’s change from the prior recorded close. If no prior close exists, show insufficient data instead of fabricating a baseline.
- Preset ranges are inclusive local-calendar windows. For example, a 7-day range on August 1 starts on July 26, and analytics may use the last close before July 26 only as a hidden baseline for July 26 changes.
- The growth-chart axis ends on the latest completed local date and must not reserve space or a tick for the incomplete current day.
- `subscriberChartMode` accepts only `samples` or `daily`. Daily mode changes presentation only: it plots each local date’s final sample at local 00:00 without discarding raw stored samples.
- Channel-card total change always compares the first and last valid samples in the full stored history; limiting sparkline points must not limit the reported total.
- Mouse-wheel zoom on either subscriber detail chart is cursor-centered, never exceeds the active preset range and stops at a one-day minimum span. The visible subscriber summary and completed-day growth analysis must follow the zoomed window; changing the preset or using `확대 초기화` restores the full preset range.
- Subscriber-history imports are explicitly scoped to the channel whose detail dialog opened the file picker; never infer the target channel from a file name.
- Import `.xlsx` rows only from sheets containing `날짜` and `전체 구독자` headers. Ignore `합계` and `평균`; `신규 구독자` is not a source of truth.
- Store imported dates at local 00:00. If any sample already exists on that local date, keep the existing data and skip the imported row.
- Parse workbooks in C# (`SubscriberXlsxImport`) and expose only the narrow import bridge action; never give the renderer filesystem access.

## Video view analytics invariants

- Collect public view statistics for up to the eight current regular-video candidates every five minutes. With an API key, prefer one official `videos.list` batch and fill any missing items from public watch pages; without a key, use public watch pages directly.
- Store view history per channel and video. Record a sample when the count changes, or once every six hours as an unchanged heartbeat.
- Preserve the first and last sample when compacting a history to its bounded sample limit so long-range charts do not silently become recent-only charts.
- Never fabricate or backfill pre-installation view history. YouTube exposes the current public view count, not historical point-in-time counts.
- The view chart supports 7-day, 30-day, 90-day, 1-year and all-history ranges. Mouse-wheel zoom is cursor-centered, cannot exceed the selected preset and stops at a one-day minimum or the full available span when shorter.
- Keep all view-history parsing and persistence in C#. The renderer receives only normalized state through the validated WebView bridge.

## Analytics interface invariants

- Keep modal scrolling on the inner detail surface only; lock background page scrolling while any dialog is open. Verify 900x660 and normal window sizes.
- The separate video analytics navigation shows channel-filtered/searchable thumbnail cards. Card activation opens that video directly. Compare 2-4 selected channel/video pairs on a common calendar axis, with total views or change from each series first observed sample in the selected period. Never fabricate missing points or imply aligned publication ages.
- Subscriber, single-video and comparison charts expose samples/daily selectors inline; daily uses each local date final observation without rewriting stored histories. Existing completed-day subscriber growth rules remain unchanged.
- Persist validated chart period/mode preferences per chart type in renderer localStorage, including across window/app restarts; it contains presentation preferences only, never credentials. Zoom/selection reset on period or mode changes.
- The native `--ui-smoke --ui-smoke-refresh --ui-smoke-actions` run drives real WebView interactions against fixture data. The renderer has no host objects or Node access.

- Coalesce chart hover events to one animation frame and binary-search actual samples; tooltips must not wait for native SVG title delays. Preserve chart DOM on status-only updates and avoid rebuilding background lists while a dialog is open. Cache cloud chart projections without mutating or truncating the stored archive; omit unchanged histories from IPC only when the renderer can reuse its previous full state.

- Analysis workspaces share four summary metrics, period/mode controls and total/change chart switches. Video summary rates use actual raw observation intervals regardless of daily display; subscriber growth uses completed local dates only. Missing baselines render as insufficient data, never zero. Daily tables show actual closes and elapsed gaps; library velocity is the full recorded interval average, not a recent forecast. Cache per-video summary calculations outside hover handlers.

- Analytics separates trend, daily records and subscriber growth into keyboard-operable sections. Keep the hover readout above the plot, preserve arrow/Home/End record navigation, and verify the full plot fits the compact 900x660 overview.

- Normal UI state carries bounded subscriber sparklines and only video endpoints. The validated analytics subscription exposes full chart projections only for the selected subscriber channel and at most four videos. Closing analytics releases detail data. Hidden/minimized windows receive no background state broadcasts and pause renderer countdowns; show/restore sends a fresh complete state. Core polling and cloud collection must continue while hidden.

- Sample-time axes show hourly minor ticks within seven days, with density-aware hour labels and stronger local-midnight date lines. Daily/long-range views retain calendar ticks. Zoom plots include adjacent real points outside the viewport under an SVG clip, while hover/summary samples stay in-range. Keep the preset Y domain and change baseline stable during zoom; never store or expose interpolated boundary values as observations.

- Comparison change baselines, interval rates and first/last observations always use raw in-range records, independent of samples/daily presentation. Daily comparison points retain their real observation timestamp for the readout; midnight is only a plot position. Exclude future records before collapsing days. Account for SVG screen transforms when mapping comparison pointer coordinates.
- Daily record tables page through all actual completed dates in the selected range (ten per page); reset paging on channel/video, range, mode or viewport changes and release page data on dialog close. Keep hidden-by-filter comparison selections visible with individual removal. Comparison readout rows stay outside the plot, including four long titles at 900x660; compact single-chart views keep their date caption visible.

## Cloud statistics invariants

- `cloud/` is a separate Node-only Fly.io service; never deploy the desktop app or personal local data. Keep one 512MB shared machine with autostop disabled and `--ha=false`.
- Collect channel statistics every minute and track up to 100 eligible videos per channel. Refresh up to three 50-item uploads pages every five minutes. Poll the newest 10 plus 15 highest smoothed-growth videos every minute; remaining recent/rising videos every five minutes and quiet older videos hourly. Exclude active live/upcoming videos. Cloud collection does not replace desktop notification detection.
- Keep YouTube and Upstash credentials only in Fly secrets. Desktop sync uses a separate read-only service token, hidden from renderer state; never embed user credentials in the public installer or repository.
- Upstash writes only the `live-pulse:v1:*` namespace. Server statistics expire after 30 days. At the explicit user request, downloaded desktop archives no longer expire or compact stored samples; this technical setting does not waive YouTube API retention terms. Preserve unrelated local/imported histories separately.
- Sync incrementally with validated cursors and bounded pages; resume after restart, deduplicate replayed times, and never fabricate missing samples or replace inaccessible counts with zero.
- Health checks prove process availability only. Verify authentication rejection and at least two real persisted samples one minute apart before claiming live collection works.
- Downloaded subscriber/video archives preserve actual samples and rotated-out video histories without automatic age or count deletion. Only the renderer video chart projection compacts to 2,000 points. Archive version 2 replays the server window once on upgrade to recover rows older clients truncated to eight videos. Connection files import only validated Fly HTTPS URL and read token through the C# host (settings dialog import).
- See `cloud/README.md` for deployment, quotas, local cache compaction, configured-channel scope and recovery.

## Planned CHZZK provider

CHZZK support is not implemented yet. Add it as a separate provider instead of inserting CHZZK conditions throughout the YouTube classes in `native/LivePulse.Core`.

Recommended provider contract:

`ResolveChannelInputAsync(input)` and `FetchChannelSnapshotAsync(channelId)` behind a provider interface (today `IYouTubeSnapshotSource`).

Recommended normalized channel identity and snapshot fields:

```js
{
  provider: "youtube" | "chzzk",
  id,
  title,
  avatarUrl,
  live,
  upcoming,
  latestVideo,
  latestPost,
  followerCount,
  checkedAt,
  warnings
}
```

Before implementing CHZZK:

1. Investigate documented or officially supported CHZZK endpoints first.
2. Confirm channel URL and channel ID resolution.
3. Confirm which of live status, scheduled broadcasts, VODs, posts and follower counts are actually available.
4. Add `provider` to persisted channels (SQLite) and treat existing records as `youtube`.
5. Use `provider:id` as the deduplication key.
6. Add `chzzk.naver.com` to the external URL allowlist without making it unrestricted.
7. Add provider-specific fixtures and regression tests.
8. Add a provider badge to the existing channel card rather than creating a separate dashboard.

Do not store NAVER login cookies or credentials. If authenticated access becomes necessary, stop and discuss the security and product tradeoffs before implementing it.

## Change checklist

1. Inspect the working tree and preserve unrelated user changes.
2. Add or update regression tests for runtime changes and run the checks above.
3. Test relevant real public channel/video data when safe (never with Windows effects from an isolated DB).
4. Rebuild the personal app with `native/publish-portable.ps1` when runtime code changed.
5. Update `AGENTS.md` (`Last maintained`) and `handoff.md` in the same task.
6. Commit and push the branch.

## Safety and repository hygiene

- Never commit API keys, tokens, cookies, local user data or subscriber-history files. `app/`, `data/`, `artifacts/` and `native/**/bin|obj` are ignored.
- Do not launch personal monitoring from a packaged (MSIX) tool shell; check `GetCurrentPackageFullName` if unsure. Claude Code shells here had no package identity; earlier Codex sessions redirected LocalAppData writes.
- Send personal data copies to the Recycle Bin rather than hard-deleting them; avoid destructive Git commands.
- The app is unsigned. Do not claim it is code-signed.
