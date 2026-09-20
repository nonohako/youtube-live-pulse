# Agent Guide

Last maintained: 2026-09-20 after verified v1.12.0 release; comparison calculation invariance, paged records, compact UI and published installer hashes recorded.

## Project mission

Build and maintain **Live Pulse (라이브 펄스)**, a Windows Electron tray application that monitors creator channels in the background and opens Chrome when a live stream or scheduled broadcast is detected.

The current production provider is YouTube. A CHZZK (치지직) live popup provider is planned and must be added without weakening the existing YouTube behavior.

## User-facing principles

- Keep the application and documentation understandable to a Korean-speaking non-developer.
- The installed app must keep working without an API key for its core monitoring features.
- Closing the main window must keep the tray monitor running.
- Never open the same live or scheduled broadcast repeatedly.
- Prefer a missed notification over opening a finished or ambiguous broadcast as an upcoming stream.
- Preserve user settings and channel history across upgrades.

## Repository and releases

- Public repository: `https://github.com/nonohako/youtube-live-pulse`
- Default branch: `main`
- Windows releases: `https://github.com/nonohako/youtube-live-pulse/releases`
- Release workflow: `.github/workflows/release.yml`
- Build target: x64 NSIS
- App ID: `kr.local.youtubelivepulse`

The installed app uses public GitHub Releases through `electron-updater`. It checks shortly after startup, then every four hours. Do not change the repository owner, repository name, app ID, product name, or update provider without planning a migration for already installed users.

## Important commands

```powershell
npm ci
npm test
npm run build
```

The current workstation may have a broken npm shim. The known fallback is:

```powershell
node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" <npm arguments>
```

Useful live-data diagnostics:

```powershell
node scripts/check-channel.js
node scripts/check-channel.js --video VIDEO_ID
```

Useful packaged-app smoke test:

```powershell
.\dist\win-unpacked\라이브 펄스.exe --smoke-test
.\dist\win-unpacked\라이브 펄스.exe --smoke-growth-chart
.\dist\win-unpacked\라이브 펄스.exe --smoke-chart-zoom
.\dist\win-unpacked\라이브 펄스.exe --smoke-video-views
.\dist\win-unpacked\라이브 펄스.exe --smoke-settings
```

## Architecture

- `src/main.js`: Electron lifecycle, tray, IPC, Chrome launch, login startup
- `src/preload.js`: narrow renderer IPC bridge
- `src/lib/monitor.js`: polling, deduplication, notifications, event and subscriber history
- `src/lib/youtube.js`: YouTube input resolution, fetching, parsing and normalization
- `src/lib/updater.js`: GitHub Release update checks, download state and installation
- `src/lib/store.js`: atomic local JSON persistence and settings normalization
- `src/lib/windows-notifications.js`: installed-shortcut validation, production/development AppUserModelID isolation and stable toast activation
- `src/lib/subscriber-import.js`: `.xlsx` parsing, local-date normalization and non-destructive subscriber-history merging
- `src/lib/video-history.js`: bounded per-video view-count history normalization, compaction and merging
- `src/renderer/`: Korean dashboard and settings UI
- `src/renderer/chart-math.js`: local-date axes, completed-day growth analytics and selected-range summaries
- `test/`: parser and persistence regression tests

Renderer code must not receive Node.js access. Keep `contextIsolation: true`, `nodeIntegration: false`, URL validation, and the existing IPC boundary.

## YouTube invariants

- The default channel is `UCtKtCiaWRz-d3EZn2xd1mdA`.
- Core monitoring uses public YouTube pages and the official channel RSS feed.
- The optional YouTube Data API key only improves public channel metadata and batches public video statistics. It is not OAuth, grants no account access and does not reveal exact subscriber totals for another channel; the official API rounds public subscriber counts down to three significant figures.
- Fetch both `/videos` and `/streams`. Parse both legacy video renderers and the current `lockupViewModel` structure; do not rely on RSS publication delay as the only new-video signal.
- Also fetch `/shorts` every polling cycle and parse `shortsLockupViewModel` and legacy `reelItemRenderer`. Interleave up to eight candidates per source (32 total) so long video lists cannot starve Shorts or RSS. Exclude IDs classified as live/upcoming by any source before merging. Regression coverage includes `mFM2hP5LEhM` with RSS unavailable.
- Regular-video notification candidates must exclude every item currently classified as live or upcoming, even when the same ID appears in RSS, `/videos` and `/streams`.
- When `/live` responds successfully, require its player response to confirm the current live before opening; do not trust a possibly stale list badge over a successful non-live player result. A list live item is only a network-failure fallback when `/live` itself could not be fetched.
- Community-post detection is experimental because the official Data API does not expose community posts.
- A player item is upcoming only when a real future `startTimestamp` exists.
- A stream-list item is upcoming only when a real start timestamp exists and that timestamp is in the future. An upcoming-looking badge without a time is ambiguous and must not auto-open.
- Missing or past timestamps must never be treated as `Number.MAX_SAFE_INTEGER` or otherwise coerced into the future.
- Keep a regression test for finished live video `hm6LLaIfMho`.

## Subscriber analytics invariants

- Keep current-day samples on the raw subscriber chart, but exclude the current local calendar day from every daily growth, momentum, slope-change and selected-range calculation because that day is incomplete.
- Daily analytics use the last stored sample from each completed local date.
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
- Parse workbooks in the main process and expose only the narrow import action through preload; never give the renderer filesystem or Node.js access.

## Video view analytics invariants

- Collect public view statistics for up to the eight current regular-video candidates every five minutes. With an API key, prefer one official `videos.list` batch and fill any missing items from public watch pages; without a key, use public watch pages directly.
- Store view history per channel and video. Record a sample when the count changes, or once every six hours as an unchanged heartbeat.
- Preserve the first and last sample when compacting a history to its bounded sample limit so long-range charts do not silently become recent-only charts.
- Never fabricate or backfill pre-installation view history. YouTube exposes the current public view count, not historical point-in-time counts.
- The view chart supports 7-day, 30-day, 90-day, 1-year and all-history ranges. Mouse-wheel zoom is cursor-centered, cannot exceed the selected preset and stops at a one-day minimum or the full available span when shorter.
- Keep all view-history parsing and persistence in the main process/store. The renderer receives only normalized state through the existing isolated preload boundary.

## Analytics interface invariants

- Keep modal scrolling on the inner detail surface only; lock background page scrolling while any dialog is open. Verify 900x660 and normal window sizes.
- The separate video analytics navigation shows channel-filtered/searchable thumbnail cards. Card activation opens that video directly. Compare 2-4 selected channel/video pairs on a common calendar axis, with total views or change from each series first observed sample in the selected period. Never fabricate missing points or imply aligned publication ages.
- Subscriber, single-video and comparison charts expose samples/daily selectors inline; daily uses each local date final observation without rewriting stored histories. Existing completed-day subscriber growth rules remain unchanged.
- Persist validated chart period/mode preferences per chart type in renderer localStorage, including across window/app restarts; it contains presentation preferences only, never credentials. Zoom/selection reset on period or mode changes.
- `scripts/analytics-smoke.cjs` runs real isolated Electron renderer interactions against fixture data; add `--packaged` to validate the built ASAR. Keep contextIsolation, sandbox and no Node access.

- Coalesce chart hover events to one animation frame and binary-search actual samples; tooltips must not wait for native SVG title delays. Preserve chart DOM on status-only updates and avoid rebuilding background lists while a dialog is open. Cache cloud chart projections without mutating or truncating the stored archive; omit unchanged histories from IPC only when the renderer can reuse its previous full state.

- Analysis workspaces share four summary metrics, period/mode controls and total/change chart switches. Video summary rates use actual raw observation intervals regardless of daily display; subscriber growth uses completed local dates only. Missing baselines render as insufficient data, never zero. Daily tables show actual closes and elapsed gaps; library velocity is the full recorded interval average, not a recent forecast. Cache per-video summary calculations outside hover handlers.

- Analytics separates trend, daily records and subscriber growth into keyboard-operable sections. Keep the hover readout above the plot, preserve arrow/Home/End record navigation, and verify the full plot fits the compact 900x660 overview.

- Normal UI state carries bounded subscriber sparklines and only video endpoints. The validated analytics subscription exposes full chart projections only for the selected subscriber channel and at most four videos. Closing analytics releases detail data. Hidden/minimized windows receive no background state broadcasts and pause renderer countdowns; show/restore sends a fresh complete state. Core polling and cloud collection must continue while hidden.

- Sample-time axes show hourly minor ticks within seven days, with density-aware hour labels and stronger local-midnight date lines. Daily/long-range views retain calendar ticks. Zoom plots include adjacent real points outside the viewport under an SVG clip, while hover/summary samples stay in-range. Keep the preset Y domain and change baseline stable during zoom; never store or expose interpolated boundary values as observations.

- Comparison change baselines, interval rates and first/last observations always use raw in-range records, independent of samples/daily presentation. Daily comparison points retain their real observation timestamp for the readout; midnight is only a plot position. Exclude future records before collapsing days. Account for SVG screen transforms when mapping comparison pointer coordinates.
- Daily record tables page through all actual completed dates in the selected range (ten per page); reset paging on channel/video, range, mode or viewport changes and release page data on dialog close. Keep hidden-by-filter comparison selections visible with individual removal. Comparison readout rows stay outside the plot, including four long titles at 900x660; compact single-chart views keep their date caption visible.

## Windows shell identity invariants

- Give each window explicit taskbar relaunch details: the current AppUserModelID, executable-plus-app relaunch command, product display name and product icon.
- Packaged installs use the product executable as the relaunch command and icon; development runs include the application path and packaged `assets/pulse.ico` so a newly pinned item does not relaunch Electron without Live Pulse or fall back to Electron's icon.
- At startup, an installed copy may repair the exact `라이브 펄스.lnk` Start Menu shortcut to its current executable only when the shortcut already targets the product executable name and the running executable is in the default NSIS install location. Never rewrite an unrelated shortcut.
- Never delete or rewrite an arbitrary user-pinned taskbar item. An installed copy may update an `Electron.lnk` in place only when it both targets `electron.exe` and carries Live Pulse’s exact production AppUserModelID; migrate its target, working directory, empty arguments, icon and toast identity to the current product executable.

## Windows notification invariants

- Only an installed executable whose path matches the current user’s Start Menu shortcut, or the default NSIS install executable repairing a stale same-product shortcut, may use the production AppUserModelID `kr.local.youtubelivepulse`.
- Development runs, unpacked builds and smoke tests must use `process.execPath` as their AppUserModelID so they cannot overwrite production toast activation with `node_modules\\electron\\dist\\electron.exe`.
- Production uses the stable ToastActivatorCLSID `{EAFF6767-89DB-4AC0-98A0-9F4FBE3AC3D7}` and repairs both notification properties on the existing Start Menu shortcut before creating notifications.
- A missing or unreadable Start Menu shortcut must fall back to the isolated development identity instead of claiming the production notification identity.

## Cloud statistics invariants

- `cloud/` is a separate Node-only Fly.io service; never deploy Electron or personal local data. Keep one 512MB shared machine with autostop disabled and `--ha=false`.
- Collect channel statistics every minute and track up to 100 eligible videos per channel. Refresh up to three 50-item uploads pages every five minutes. Poll the newest 10 plus 15 highest smoothed-growth videos every minute; remaining recent/rising videos every five minutes and quiet older videos hourly. Exclude active live/upcoming videos. Cloud collection does not replace desktop notification detection.
- Keep YouTube and Upstash credentials only in Fly secrets. Desktop sync uses a separate read-only service token, hidden from renderer state; never embed user credentials in the public installer or repository.
- Upstash writes only the `live-pulse:v1:*` namespace. Server statistics expire after 30 days. At the explicit user request, downloaded desktop archives no longer expire or compact stored samples; this technical setting does not waive YouTube API retention terms. Preserve unrelated local/imported histories separately.
- Sync incrementally with validated cursors and bounded pages; resume after restart, deduplicate replayed times, and never fabricate missing samples or replace inaccessible counts with zero.
- Health checks prove process availability only. Verify authentication rejection and at least two real persisted samples one minute apart before claiming live collection works.
- Downloaded subscriber/video archives preserve actual samples and rotated-out video histories without automatic age or count deletion. Only the renderer video chart projection compacts to 2,000 points. Archive version 2 replays the server window once on upgrade to recover rows older clients truncated to eight videos. Connection files import only validated Fly HTTPS URL and read token through the main process, including `--cloud-config` onboarding.
- See `cloud/README.md` for deployment, quotas, local cache compaction, configured-channel scope and recovery.

## Planned CHZZK provider

CHZZK support is not implemented yet. Add it as a separate provider instead of inserting CHZZK conditions throughout `youtube.js`.

Recommended provider contract:

```js
{
  resolveChannelInput(input),
  fetchChannelSnapshot(channel, options)
}
```

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
4. Add `provider` to persisted channels and migrate existing records to `provider: "youtube"`.
5. Use `provider:id` as the deduplication key.
6. Add `chzzk.naver.com` to the external URL allowlist without making it unrestricted.
7. Add provider-specific fixtures and regression tests.
8. Add a provider badge to the existing channel card rather than creating a separate dashboard.

Do not store NAVER login cookies or credentials. If authenticated access becomes necessary, stop and discuss the security and product tradeoffs before implementing it.

## Change and release checklist

For every completed repository task, including documentation-only tasks:

1. Update `AGENTS.md` in the same task. At minimum, refresh the `Last maintained` checkpoint and preserve any new invariant or workflow rule introduced by the work.
2. Update `handoff.md` with the resulting source/release state, verification result, limitation or next step.

Do not defer either file to a later task or release.

For runtime changes:

1. Inspect the working tree and preserve unrelated user changes.
2. Add or update regression tests.
3. Run `npm test` and syntax checks.
4. Test relevant real public channel/video data when safe.
5. Bump the semantic version in both `package.json` and `package-lock.json`.
6. Run `npm run build`.
7. Verify `dist/latest.yml` and packaged `resources/app-update.yml`.
8. Run the packaged smoke test.
9. Commit and push the source.
10. Push a matching tag such as `v1.2.0`.
11. Wait for GitHub Actions and verify the non-draft Release assets.
12. Download the published installer and verify its SHA-512 against `latest.yml`.

For documentation-only changes, commit and push them but do not bump the application version or publish a new installer.

## Safety and repository hygiene

- Never commit API keys, GitHub tokens, cookies, local user data or subscriber-history files.
- Never commit `node_modules/`, `dist/`, `artifacts/` or `.smoke-user-data/`.
- Keep release publishing explicit through version tags; ordinary `main` pushes must not publish installers.
- The release workflow builds with `npm run build`, creates or reuses the tagged Release, then uploads the installer, block map and `latest.yml` with `gh` so a partial asset upload fails the job.
- The Windows installer is currently unsigned. Do not claim it is code-signed.
- Avoid destructive Git commands and preserve existing user changes.
- Update `handoff.md` whenever architecture, release behavior, known limitations or the next milestone changes materially.
