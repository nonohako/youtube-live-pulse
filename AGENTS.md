# Agent Guide

Last maintained: 2026-09-26 after enabling normal personal launches, duplicate activation and the desktop shortcut. The public production release remains Electron v1.12.1.

## Personal launch checkpoint (2026-09-26)

- The fixed-path EXE and the desktop `라이브 펄스 (네이티브).lnk` now open real personal data without command-line arguments. Missing/invalid personal data stops visibly; never fall back to fixture/default data at that path. Explicit diagnostic/isolated arguments retain their existing behavior.
- A per-user local mutex and activation event route repeated personal launches to the existing window before creating a second tray/store. Hidden duplicate startup does not open the UI. The DB lease remains the separate writer guard.
- Published EXE startup self-tests and isolated WebView smoke passed. Actual no-argument launch logged personal=True, created the 라이브 펄스 window, and a second launch exited with the original PID/window intact. The previous binary tree is preserved in ignored artifacts/native-before-default-launch-20260926. The app was left running.

## Native review checkpoint (2026-09-26)

- The three reviewed issues are fixed. Keep the validated analytics scope per WebView session for broadcasts and state-returning actions; rejected requests must preserve it, and dialog release, channel removal and window disposal must release the relevant scope. Never replace open-chart histories with overview endpoints on a timer/cloud refresh.
- Project the latest scheduler channel failure/recovery into UI state. Keep saved snapshots/history intact, hide stale live/upcoming indications after a failed sweep, and expose effect failures without promising automatic retries of deduplicated notifications.
- Minimized/hidden windows skip background projection/broadcast and receive an inactive event to stop countdowns. Restore sends active plus fresh scoped state; tray-open restores a minimized window. Closing still disposes WebView while monitoring/cloud loops continue.
- Core/store harnesses and the self-contained EXE WebView smoke passed. `--ui-smoke-refresh` covers full subscriber/video histories across broadcasts, rejected scopes, dialog release, minimized suppression/countdown pause and restore. Its fixture is generated with NativeStore.Tests `--ui-fixture ABSOLUTE_OUTPUT` and must identify its multi-sample video by ID, not mutable library ordering. The fixed-path personal binaries were backed up and replaced; DB and login settings were untouched. See handoff for remaining live-event/memory limits.

## Current execution priority (2026-09-25)

- The user clarified this is a single-user personal app and asked to reduce overengineering. Prioritize one usable native app with the existing features; do not add speculative abstractions or split every helper into a separate checkpoint.
- Connected slices now run with personal data: background monitor/cloud sync with shared backup, existing WebView UI/actions, and a private fixed-path Windows execution. Continue with focused fixes from real use; do not re-run broad baseline suites without a concrete issue.
- Preserve data, secrets, broadcast deduplication, basic single-instance protection and close-to-tray WebView disposal. Keep the installed app intact during development and preserve a pre-switch backup for a manual return to Electron.
- Public installer publishing, automated Electron-to-native upgrade compatibility, subsequent native auto-updates, broad installer environment matrices and generalized rollback conversion are deferred until public distribution is requested. They do not block a personal native build. Do not publish tags/installers as routine prototype checkpoints.
- Reuse the existing SQLite/Core/WebView work. Run focused native checks for changed behavior and one end-to-end check for each connected slice; repeat JS/Electron suites only when shared UI/behavior changes or a concrete parity question requires them. Keep progress notes compact. Requested implementation model: GPT-6 Sol, high.

## Project mission

Build and maintain **Live Pulse (라이브 펄스)**, a Windows Electron tray application that monitors creator channels in the background and opens Chrome when a live stream or scheduled broadcast is detected.

The current production provider is YouTube. A CHZZK (치지직) live popup provider is planned and must be added without weakening the existing YouTube behavior.

## Accepted migration direction (2026-09-23)

- The user now prioritizes lower memory while in the tray. This supersedes the older handoff decision to retain Electron indefinitely.
- Target C# background monitoring with the existing HTML/CSS/JS UI hosted in WebView2. Do not rewrite the dashboard/charts in native WPF. A thin WPF window host is acceptable.
- Hidden startup must not create a WebView. Closing to tray disposes the WebView and releases UI data/references; no default 10-30 minute retention or eager WebView warm-up. Monitoring, notifications and cloud sync continue independently.
- Preserve the narrow `window.livePulse` contract through a validated native bridge, existing histories, deduplication, Windows identity and the upgrade path from installed Electron releases.
- Read `docs/migration-csharp-webview2.md` before implementation. Its staged plan, data migration and memory measurement gates supplement all existing invariants below. The original preparation was documentation only, and the current lifecycle prototype is still far from a completed migration or new release.
- `native/LivePulse.Windows` remains outside the public release. `--isolated-monitor-db` uses an ignored `*.probe.sqlite` copy and suppresses Windows effects. Explicit `--personal-db` requires a verified private DB plus `.bak.1` under `%LOCALAPPDATA%/LivePulseNative`, refuses a running Electron app and enables tray/Chrome effects. The fixed-path personal executable now runs from `%LOCALAPPDATA%/Programs/LivePulseNative` with the real copied data and authenticated Fly read sync; the original Electron JSON and installed executable remain unchanged. The Windows Run value for `라이브 펄스` now points to the native executable, and its original Electron command is preserved under `%LOCALAPPDATA%/LivePulseNative`. No-argument or --hidden-only startup at the fixed personal installation now selects the prepared personal DB automatically; development builds still default to the fixture. Do not publish through the Electron feed.
- `native/LivePulse.DataMigration` is an explicit-path import experiment. It must operate on a private, ignored copy of JSON v3; preserving sample order and local/cloud separation does not by itself authorize switching the installed app to SQLite. Production switching still requires recovery, backup, rollback, concurrent-instance and equivalent-data gates in the migration guide.
- `native/LivePulse.Core` now fetches and parses public `/streams`, `/videos`, `/shorts`, `/posts`, RSS and `/live` into a read-only snapshot. Keep the existing JS fixtures and live public-page comparison as parity gates while porting polling, deduplication and notifications. Its diagnostic must never open Chrome or write user data; passing parser checks do not prove background monitoring.
- Parse each fetched public page before waiting for all sources to finish so the snapshot composer retains only compact results. This reduces live body retention in source code; require measured equivalent-data tray memory before claiming actual savings.
- Native channel input resolution accepts a valid UC ID, an allowlisted YouTube `/channel/UC…` URL, or an `@handle` fetched from a public YouTube page. Never accept a foreign host as a channel input; the optional Data API handle path remains to be ported.
- `MonitorChangePlanner` computes first-seen baselines, new-content events, broadcast open keys and subscriber sample decisions without side effects. The manual native runner durably commits tracking/open keys before it invokes injected effects; this proof is not yet a scheduled production monitor.
- `native/LivePulse.NativeStore` writes tracking, events and new samples transactionally into separate runtime tables while preserving imported series. The private personal DB was imported from a SHA-checked copy of the stopped Electron JSON; the primary and `.bak.1` each passed full source verification for 2 channels, 245 series and 661,305 imported samples after live sync. Do not treat routine schema validation as a full source hash check. The public installed data file is never opened by native code.
- `NativeCloudSync` reads the existing Fly HTTPS URL/token and archive cursor without exposing the token, accepts only an allowlisted Fly host, bounds requests/pages, and writes cloud observations before advancing the cursor. Its HTTP client rejects redirects. The personal WPF tray now performs authenticated read-only Fly sync every minute on the private DB. At least 34,387 runtime observations were persisted, with distinct stored collection times at 03:20 and 03:21 UTC and no cloud error. This proves native personal sync, not full public release/rollback parity.
- `NativeStoreRecovery` snapshots an isolated SQLite DB with SQLite's backup API, flushes and structurally validates two backup generations, and can explicitly restore after preserving a corrupt primary. `NativeBackupCheckpoint` connects the isolated runner to a first-commit and five-minute-on-write schedule, and forces a validated backup after commits that plan notifications or URL opens, before those effects run. Backup failure suppresses effects and faults the isolated scheduler visibly. This is not production recovery: it has no automatic startup restore, coordination with older or non-native writers, source-record verification or Electron rollback conversion. Never restore while any writer is running, and stop rather than mixing unknown WAL/journal sidecars with a backup.
- The opt-in WPF monitor now holds a per-DB `.native-lock` file with exclusive Windows sharing from before it opens the isolated store until its monitor task stops. Another cooperative native prototype using that DB must fail before writing. This does not exclude older prototypes, manual native tools or installed Electron, and does not authorize automatic recovery or production switching.
- The manual `NativeMonitorRunner` must commit the plan before calling any notification or URL effect. If every public source fails, do not commit; an empty first content result must not initialize its seen-ID baseline. The isolated tray suppresses Windows effects; personal mode has a tray balloon/Chrome sink, which still needs an end-to-end live-event check.
- `NativeMonitorScheduler` reads only channel IDs and validated settings each sweep, starts after 250 ms, runs channels sequentially and contains channel failures. Isolated and explicit personal DB modes start it beside one-minute cloud polling. The private personal DB now runs the real two-channel workload; short tray readings and a different-era Electron baseline are not an equal-data memory comparison.
- On a real 661,305-sample copy, overview video projection initially stalled because it scanned every view sample for every video. The overview now queries indexed first/last endpoints only; a selected chart still loads its full series. The full-data isolated WebView smoke passed with two cards and browser exit on close.
- A forced stop during a large SQLite backup left `.backup.tmp` and its journal. The next run correctly stopped instead of overwriting them. After validating primary and `.bak.1` against the source, those incomplete files were preserved under the private `forensic/` folder. Avoid stopping a native process during backup; never remove or restore a partial backup without validating the closed primary and backup generations.
- The existing Node release commands describe the production Electron app. When replacing the runtime, update equivalent native build/test/package/update checks and documentation in the same task; do not publish a native installer through the old update feed until installed-client compatibility is verified.
- For Electron migration memory measurements, changing the Windows `APPDATA` environment variable does not redirect Electron's `app.getPath('userData')` on this workstation. Use a separately verified `--user-data-dir` under ignored artifacts and check the process command line and saved copy before measuring. A development Electron run skips packaged startup/update effects; a copy with external effects disabled is a limited baseline, not an equal-settings packaged comparison. Keep raw process samples and never report short native fixture measurements as achieved memory savings.

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

- JsonStore must flush temporary files before atomic replacement. Maintain two validated backup generations at five-minute intervals and after the first save of a session. On a missing/corrupt primary, try the temporary file and backup generations; preserve a corrupt primary before restoration. Never initialize defaults over existing unreadable data or after permission/normalization errors. Startup must stop visibly if recovery is unavailable.
- Recovery must preserve current records, keep forensic copies outside Git and restore only real cloud or user-confirmed imported records. Never fill unrecoverable local gaps with estimated values or smoke fixtures. Verify full archive sample counts after saving/reloading, and distinguish recovered dates from unrecoverable gaps.

- Never commit API keys, GitHub tokens, cookies, local user data or subscriber-history files.
- Never commit `node_modules/`, `dist/`, `artifacts/` or `.smoke-user-data/`.
- Keep release publishing explicit through version tags; ordinary `main` pushes must not publish installers.
- The release workflow builds with `npm run build`, creates or reuses the tagged Release, then uploads the installer, block map and `latest.yml` with `gh` so a partial asset upload fails the job.
- The Windows installer is currently unsigned. Do not claim it is code-signed.
- Avoid destructive Git commands and preserve existing user changes.
- Update `handoff.md` whenever architecture, release behavior, known limitations or the next milestone changes materially.
