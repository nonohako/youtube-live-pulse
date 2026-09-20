# Live Pulse handoff

Last updated: 2026-09-20

## v1.12.0 analytics improvements

Implemented the five accepted audit items: comparison statistics and change baseline now use raw in-range observations in both display modes; daily hover labels retain actual observation times. Comparison has reserved, color-marked readout rows above the plot and pointer mapping respects SVG transforms. Subscriber/video daily tables page through every completed record in the selected range, reset with analysis context and release data on close. Compact charts keep the date caption and increase the single-chart wrapper from 175px to 210px. Selected comparison videos remain visible in removable chips across search/channel filters.

Validation: all 100 unit tests and changed JavaScript syntax checks passed. Expanded isolated source and packaged-ASAR Electron lazy-mode suites passed mode-invariant summaries/baselines, all video record pages, subscriber paging/reset, filtered selection removal, four long comparison titles, compact plot fit and exact SVG hover coordinates. Reviewed 900x660 comparison/records/chart captures. Live RESCENE fetch returned current public video data with no warnings. Initial restricted GPU/network execution failed; normal approved execution succeeded. x64 NSIS build, packaged product/chart-zoom/video smoke, local installer SHA-512 and updater repository metadata all passed. Installer remains unsigned. Public release verification is pending; installed-app native interaction remains unverified and the installed copy has not been replaced. No collection policy, user histories or IPC security settings changed.

## Analytics UX audit (2026-09-20)

User requested improvement discovery only. No runtime changes, version bump or installer release. Source at audit start: cbf6447 (v1.11.1). Findings below are candidates, not implemented fixes.

- Highest priority: comparison summary and change baseline depend on display mode. analytics-math.js collapses dates before choosing the baseline, and analytics-ui.js calculates average speed from the displayed samples. Reproduced with September 17 12:00=100, September 17 23:00=200 and September 18 12:00=300 (local time): samples mode reports +200 and +200/day; daily mode reports +100 and +100/day. Keep raw interval summary/baseline independent of display projection, as single-video analytics already does. Daily midnight positions must not be presented as actual observation times.
- Comparison hover: the current tooltip overlays the upper-right plot and interleaves titles, values and timestamps in one wrapping flex container. The fresh two-video screenshot confirms this. Reserve space outside the plot and group each video into a color-marked row; verify four long titles and compact windows.
- Daily records: analysisDailyTable unconditionally limits output to the last ten completed dates. Add paging or a load-more action within the selected period so 30/90-day and all-history selections can be inspected fully without inventing missing dates.
- Compact layout: at 900x660 the plot fits, but upper controls and KPI cards dominate its height. CSS fixes the chart wrapper to 175px including the hover strip and hides the exact date caption below 740px window height. Consider collapsible secondary KPI notes, more plot height and an always-visible compact date range.
- Comparison selection: the library retains selections across filters but only shows their count in the toolbar. Add a selected-video strip with titles and individual removal so hidden selections remain understandable when switching channels or searches. This is a code-based UX candidate, not a reproduced data-loss defect.

Verification: source Electron scripts/analytics-smoke.cjs --lazy passed with exit 0 and no captured renderer errors, using isolated fixture data. Fresh normal/900x660 screenshots reviewed in artifacts/analytics-comparison.png and artifacts/analytics-small.png. Initial restricted execution failed to start GPU subprocesses; normal execution succeeded. Existing smoke coverage does not check comparison raw/daily KPI invariance or browsing records older than ten days. Installed-window manual interaction, actual-user-data review and new packaged checks were not performed in this audit. Next implementation should first repair comparison calculations with regressions, then improve comparison readout and record navigation.

## Current handoff checkpoint (2026-09-20)

- User accepted the v1.11.1 chart changes and requested this handoff refresh. Keep Electron; migration was discussed and explicitly set aside. Continue prioritizing Korean UI/UX, readable charts and measured performance improvements.
- Current release: v1.11.1, runtime source commit e8da935, release verification recorded in 2d59427. The installer was verified and installed as 1.11.1.0 in the preceding task. No new runtime change or installer is part of this documentation update.
- Completed: analysis tabs and fixed hover readout; keyboard record navigation; on-demand detail loading and hidden-window UI pause; hourly minor ticks, bold midnight boundaries and continuous clipped zoom lines. Existing settings, local/cloud statistics and notification collection are preserved.
- Key implementation entry points: src/lib/analytics-projection.js (summary/detail scope validation), src/main.js and src/preload.js (analytics subscription and visibility IPC), src/renderer/analytics-workspace.js (analysis layout/navigation), src/renderer/chart-math.js (hour ticks and adjacent plot samples), src/renderer/renderer.js (chart drawing/zoom), src/renderer/analytics-ui.js (video library/comparison).
- Do not calculate detailed chart analytics from overview endpoints. Load the selected history through analytics:watch first. Plot-only boundary neighbors must never become extra stored samples or enter visible-window summaries.
- Reverification: npm test (last run: 98 passing); Electron scripts/analytics-smoke.cjs --packaged --lazy after building. This includes scoped loading, visibility pause, hourly axes and zoom continuity. Product smoke, chart zoom and video smoke also passed for v1.11.1.
- Remaining verification limits: native installed-window mouse interaction and sustained whole-app CPU/memory use were not measured. The recorded performance improvement is state preparation/transfer, not a total-memory reduction claim. Long-range axes intentionally thin labels; hourly minor ticks apply to sample-time windows up to seven days.
- No requested implementation is left pending. Future work should follow new user feedback; CHZZK remains planned, not implemented.

## v1.11.1 hourly axes and zoom continuity

Sample-time charts (subscriber/video/comparison) now show hourly tick marks for windows up to seven days, with label thinning to prevent overlap; local midnight uses a longer, stronger line and a bold date on a second row. Daily and long-range axes retain calendar labels. Single-chart zoom draws the neighboring real points beyond both boundaries inside an SVG clip, keeping the line continuous without adding fabricated observations to hover, summaries or storage. The selected-preset Y domain and change baseline remain stable through zoom. Wheel scale uses a smaller delta-proportional step. Removed unused trend-path calculation.

98 tests passed. Source lazy Electron suite passed hourly/midnight tick checks, stable Y labels/change baseline and clipped outside-neighbor lines; reviewed the 900x660 hourly zoom screenshot. Packaged lazy-mode UI suite and product/chart-zoom/video smoke passed. Installer SHA-512 and updater metadata passed. Source e8da935 and tag v1.11.1 published. Actions 35502661111 succeeded; public non-draft/non-prerelease release has three assets. Fresh installer download matched published SHA-512. Silent install exited 0; installed version 1.11.1.0 verified and history counts preserved. Native installed-window interaction remains separate from isolated packaged Electron visual checks.

## v1.11.0 scoped analytics and background work

Normal renderer state now carries 120-point subscriber sparklines and two endpoints per video. A validated IPC subscription loads only one selected subscriber history and up to four selected video projections (existing 2,000-point video bound); range/mode/zoom calculations still use full selected projections so completed-day baselines stay intact. Closing chart dialogs releases those detailed arrays. Hidden/minimized windows stop state broadcasts and renderer countdowns; show/restore sends fresh state. Background detection and cloud sync continue. Raw archives are not truncated or changed.

On the same installed archive (210 videos), initial state was 10,542,439 bytes / 584.6 ms before; overview is 128,925 bytes / 1.5 ms and one-video state 174,842 bytes / 5.5 ms after. These measure state projection/serialization, not total application CPU or memory savings. 96 unit tests pass, and lazy-mode Electron interaction checks cover selected loading, multi-video comparison, close/release, hidden countdown pause and restoration. Packaged lazy-mode UI suite and product/chart-zoom/video smoke passed. Installer SHA-512 and updater metadata passed. Source 83a46a4 and tag v1.11.0 published. Actions 35493690034 succeeded; public non-draft/non-prerelease release has three assets. Fresh installer download matched published SHA-512. Silent install exited 0, installed version 1.11.0.0 verified, and history counts preserved. A packaged isolated renderer also passed against the actual stored archive. Overall long-running memory/CPU reduction was not claimed from the projection benchmark.

## v1.10.1 UI/UX refinement

Split trend, daily records and subscriber growth into sections to avoid a long stacked screen. Added arrow/Home/End chart record navigation and keyboard section navigation. Hover values sit in a reserved strip above the chart instead of following/covering the line. Adjusted small-window plot height and typography, and kept one inner scroll surface. Source Electron checks passed section switching, keyboard value navigation and previous chart interactions. 93 tests passed. Packaged Electron interaction checks passed, including the full plot fitting inside the 900x660 dialog. Product smoke exited 0; installer SHA-512 and updater metadata passed. Source fb33fd0 and tag v1.10.1 published. Actions 35448900747 succeeded; public non-draft/non-prerelease release has three assets. Fresh installer download matched published SHA-512. Silent install exited 0 and installed version 1.10.1.0 was verified. Local and cloud history counts were preserved. Native installed-window interactions remain separate from isolated packaged Electron checks.

## v1.10.0 analysis workspace

Redesigned subscriber/video analytics for analysis-first use: unified four-KPI summaries (last observation, change, average speed, percentage), wide chart canvas, inline total/change switches with persisted preferences, completed-day history tables and clearer coverage/baseline labels. Subscriber growth excludes today and preserves existing gap/baseline rules. Video summary uses raw timestamps even in daily display; daily change charts use the same original observed baseline. Missing baselines show insufficient data. Video picker and collection help are collapsible; header remains accessible during one-surface scrolling. Video library adds recorded-period velocity and sorting by latest observation, count or average velocity; comparison shows average speed and single observations as visible dots. Summaries are cached to preserve hover responsiveness.

93 unit tests and the source Electron interaction suite passed, including chart metric switching, baseline handling, unchanged KPI totals, day tables and preference persistence. Reviewed normal and 900x660 screenshots. Final packaged ASAR passed the interaction suite; product, chart zoom and video smoke exited 0. Installer SHA-512 and updater repository metadata passed. A read-only isolated renderer displayed 208 real stored videos and subscriber records without console errors. Source b3988d9 and tag v1.10.0 published. Actions 35436383421 succeeded; public non-draft/non-prerelease release has three assets, and a fresh installer download matched published SHA-512. Silent install exited 0; installed version 1.10.0.0 verified and existing local/cloud history counts preserved. Native installed-window click-through remains separate from the isolated Electron UI verification. No collection or storage policy changed.

## v1.9.1 chart hover performance

Coalesces mouse moves per animation frame, binary-searches actual observations and caches Intl formatters. Comparison now has an immediate custom crosshair/tooltip. Status-only updates preserve open chart DOM, skip background list rebuilding, reuse cloud projections and omit unchanged history arrays from IPC. Raw local archives remain unchanged. Close handlers ignore stale close events when a dialog was already reopened.

Measured on the installed archive: repeated publicState projection fell from 533-567 ms to below 0.1 ms after cache warmup (cold projection about 287 ms); renderer status refresh with an open chart fell from 48-67 ms to 0.1-0.3 ms. These are isolated measurements, not a guarantee of every frame on the installed app. 92 unit tests and source Electron UI hover assertions passed, including next-frame tooltip, 100 moves coalesced, pointer leave cancellation, status delta preservation and reopen. Packaged ASAR passed the same Electron hover/UI suite and the product smoke exited 0. Local installer SHA-512 and updater repository metadata passed. Source a388080 and tag v1.9.1 published. Actions 35434309773 succeeded; non-draft/non-prerelease release has three assets and a fresh installer download matched published SHA-512. Silent installer exited 0 and installed product version is 1.9.1.0. Local histories and cloud archive counts were preserved. Packaged zoom and video smoke also exited 0. Native installed-window mouse interaction remains unmeasured; hover checks used the actual isolated Electron renderer.

## v1.9.0 analytics interface

Added a dedicated video library tab with channel filter, title search, thumbnails and direct video chart opening. Up to four videos can be compared on one calendar/count axis with total or period-change presentation. Inline sample/daily selectors on subscriber, video and comparison charts update immediately; chart type preferences and periods persist in localStorage. Daily presentation preserves raw histories and existing completed-day growth rules. Modal parent/background overflow is locked; only detail content scrolls. Replaced a CSP-blocked SVG inline fill style with a presentation attribute.

Real Electron UI automation passed library/search/direct open/comparison/mode switching/reopen/reload persistence and one-scroll checks (outer excess 0, inner content scrollable), including 900x660 layout. All 88 tests and renderer syntax checks pass. The packaged ASAR passed the same real Electron interaction suite; the product --smoke-test exited 0. Local installer SHA-512 and repository updater metadata passed. The lockfile electron/fuses version was corrected to match its existing 1.8.0 tarball. Source 49d9715 and tag v1.9.0 were published. Actions 35343545105 succeeded; the non-draft/non-prerelease release includes all three assets and a fresh installer download matched published SHA-512 and GitHub SHA-256. An isolated packaged renderer also displayed 205 actual stored video cards and two real history series without console errors. Installed version 1.9.0.0 was verified after the silent installer exited 0; local subscriber/video records were preserved and cloud error remained null. This is fixture/isolated-renderer visual verification plus installed process/data checks; no native installed-window click-through was performed.

## v1.8.1 adaptive collection and local archives

User requested 100 videos per channel and no automatic local cleanup. Collector discovers up to 150 candidates to select 100 eligible videos, schedules 25 per channel at one minute with remaining videos at 5/60 minutes, and smooths observed views/minute to promote rising videos. Sparse samples keep Redis command counts independent of video count (about 232,128/month at 31 days with metadata caching for one desktop). Server expiry stays 30 days; desktop archive samples and rotated videos no longer expire or compact. Chart projection alone compacts points. This user-requested retention behavior does not waive API policy obligations. v1.8.1 replays the server window once to recover expanded rows truncated by older desktop clients. All 85 tests pass, including paginated 100-video scheduling, rate promotion, Redis metadata cache command budget, and retaining 500-day-old/2,100-sample/105-video archives. Packaged settings smoke and update metadata/hash verification passed. Live server returned 100 stored video metadata entries for each channel. The scheduler aligns due times to minute boundaries so response latency does not skip alternating fast polls. Source 65e868d and tag v1.8.1 were published; Actions 35228879510 succeeded. The public non-draft/non-prerelease release has three assets, and a fresh installer download matched published SHA-512 and GitHub SHA-256. Installed version 1.8.1.0 synced archiveVersion 2 at 13:47:40 UTC with no error, 100 cloud video histories and 48 subscriber samples per channel. Local subscriber counts stayed 466/283 and local video history counts stayed 60/22. Consecutive live minute rows at 13:43 and 13:44 UTC contained 25 video samples per channel; unauthenticated sync returned 401. A conservative 80-video-per-minute JSON model with maximum safe integer counts projects 115 MB for 30 days before Redis overhead; command tests project 232,128 commands per 31 days for one always-on desktop, plus cold starts/new metadata/catch-up. Free-tier headroom is an estimate, not a measured full-month guarantee.

## v1.8.0 cloud statistics work

Added a separate Node-only Fly collector with Upstash REST storage, one-minute official channel/video statistics, five-minute uploads discovery, bounded authenticated sync and 30-day cloud retention. Desktop keeps local data separate and combines histories only in its public chart state; existing notification collection remains unchanged. Settings expose a Fly URL and a dedicated read token, never the Redis writer or server API key. Cloud cache compacts video charts to 2,000 points and preserves 30 days of subscriber minute samples for daily-close analytics; the server retains minute samples for 30 days. Server channel scope is configured explicitly, currently the two monitored channels. See `cloud/README.md`.

Cloud deployed to `live-pulse-stats-nonohako` in `nrt`, one 512MB shared CPU machine (`d8d5620b4d0928`). User explicitly approved key registration. Server API/Redis credentials are in Fly secrets; the local temporary credential file and bootstrap process were removed after verification. Two actual persisted samples at 13:00 and 13:01 UTC on September 17 were exactly 60 seconds apart, each covering both channels and 8 videos each. Health returned 200 and unauthenticated sync 401. Desktop sync into an isolated JsonStore, reload/resume and renderer credential masking passed. All 82 tests, syntax checks and packaged connection-file import passed. Settings screenshot review caught an unstyled URL field; it now shares the standard input styling. Source commit `1ad8843` and tag `v1.8.0` were published. GitHub Actions run `35225305477` succeeded; the non-draft, non-prerelease Release has the installer, block map and latest.yml. The downloaded public installer matched published SHA-512 and GitHub SHA-256. The public installer remains unsigned. The installed app was upgraded to 1.8.0.0 and connected via --cloud-config. At 13:23:48 UTC, its real user store confirmed successful sync with no error, 23 subscriber minute samples and 8 cloud video histories per channel. Existing local subscriber sample counts stayed 466 and 283, and local video history counts stayed 60 and 22. A real future-upload-to-toast test remains separate from cloud statistics verification.

## v1.7.1 Shorts detection repair

The reported `mFM2hP5LEhM` public player timestamp is September 15 at 18:00:21 KST; the installed app recorded detection at 20:17:14 KST (about 137 minutes later), despite a 15-second polling interval. The old code never fetched `/shorts`, and its parser returned zero items from the actual Shorts tab. RSS arrival history is not retained, so the exact past feed arrival time cannot be proved.

The fix polls `/shorts`, parses current Shorts lockups and legacy reel cards, and interleaves up to eight items from each source into a bounded 32-item detection list. Public view statistics remain limited to eight items. Live/upcoming IDs are excluded across sources. A reduced public-card fixture and RSS-failure snapshot regression were added. All 72 tests and changed-file syntax checks pass. Both monitored public channels returned warning-free snapshots and the reported video was detected. Local build, packaged smoke and public release verification passed as recorded below; the currently installed application is not modified by source edits.

Local v1.7.1 validation: x64 NSIS build succeeded, packaged dashboard smoke exited with code 0 and produced a reviewed capture, updater metadata targets the existing repository, and installer SHA-512 matches `dist/latest.yml`. The installer remains unsigned. After explicit user approval, source commit `c173d90` and tag `v1.7.1` were pushed. GitHub Actions run `34963259758` completed successfully. The public non-draft, non-prerelease Release contains the installer, block map and `latest.yml`. A fresh public installer download matched SHA-512 in the published metadata and SHA-256 in the GitHub asset digest. The installed app has not been updated and a real future-upload-to-Windows-toast check is still pending.

## Current production state

- Application version: `1.11.1`
- Public repository: `https://github.com/nonohako/youtube-live-pulse`
- Production release: `https://github.com/nonohako/youtube-live-pulse/releases/tag/v1.11.1`
- Default branch: `main`
- Platform: Windows x64
- Packaging: Electron + NSIS
- License: MIT

The v1.7.0 source fixes delayed regular-video detection caused by YouTube's newer `richItemRenderer -> lockupViewModel` cards. Monitoring now reads both `/videos` and `/streams`, supports both current lockups and legacy video renderers, and uses RSS as an additional rather than sole regular-video signal. Live and genuinely future upcoming items are removed from regular-video notification candidates. Stream-list upcoming items now require a real future start timestamp; an ambiguous upcoming badge without a time is not auto-opened. When `/live` responds normally, its player must confirm the current live; a possibly stale list badge is used only if the `/live` request itself fails.

v1.7.0 also records exact public view-count samples for up to eight current regular videos every five minutes. An API key batches official `videos.list` statistics and public watch pages fill missing results; without a key, public watch pages provide the same core feature. The store migrates to version 3 and retains channel-scoped histories with change-based samples, six-hour unchanged heartbeats, 365-day retention, 100-video and 2,000-sample bounds, and whole-span compaction that preserves endpoints. The latest-video row opens a video selector and 7-day, 30-day, 90-day, 1-year or all-history chart with change, growth percentage, high, daily trend, tooltips and cursor-centered wheel zoom. Historical point-in-time views before v1.7.0 cannot be backfilled.

The settings and documentation now state the API boundary explicitly: an API key grants no account access and does not make another channel's subscriber total exact. YouTube's official channel API still rounds the public subscriber count down to three significant figures. Its practical v1.7.0 benefit is batching public video statistics and using official public metadata; the app continues to detect videos, live broadcasts and view counts without a key.

Verification covers all 69 tests locally and in GitHub Actions, syntax checks, a warning-free live snapshot of the affected `안녕하세요원이입니다잘부탁드립니다` channel whose `WTdyA5N4K0k` lockup was detected first with exact public-page views, and a warning-free currently-live Lofi Girl snapshot whose live item stayed out of regular videos. The x64 NSIS build succeeded, packaged version is `1.7.0`, both update metadata files target the public GitHub repository, the local installer SHA-512 matches `dist/latest.yml`, and Authenticode remains intentionally `NotSigned`. Packaged dashboard and zoomed video-view smoke captures passed. GitHub Actions run `31493226230` completed successfully; the public non-draft, non-prerelease v1.7.0 Release contains the installer, block map and `latest.yml`. A fresh public installer download matched both the SHA-512 in its published update metadata and the SHA-256 reported for the GitHub Release asset, and the downloaded installer was confirmed unsigned as documented.

The v1.6.4 source adds mouse-wheel zoom to both subscriber detail charts. Scrolling up zooms around the time under the pointer, scrolling down zooms out, and the active preset remains the maximum extent. Zoom stops at a one-day span. The visible subscriber summary, trendline and completed-day growth analysis all recalculate for the zoomed window, while the first visible growth day still uses the prior daily close as its hidden baseline. Changing a preset or clicking `확대 초기화` restores the full range; wheel zoom clears an existing click/drag date selection so the two interactions cannot leave conflicting ranges.

Verification covers all 58 tests locally and in GitHub Actions, syntax checks, a warning-free live RESCENE diagnostic, the x64 NSIS build, update metadata and installer SHA-512, plus packaged dashboard and wheel-zoom smoke captures. The packaged executable reports version `1.6.4`, `dist/latest.yml` and packaged `resources/app-update.yml` are correct, and the local installer SHA-512 matches its generated update metadata. GitHub Actions run `30807160135` completed successfully; the public non-draft, non-prerelease v1.6.4 Release contains the installer, block map and `latest.yml`. A fresh public installer download matched both the SHA-512 in its published update metadata and the SHA-256 reported for the GitHub Release asset.

The v1.6.3 source fixes the remaining taskbar activation regression found after v1.6.2. The user’s existing pinned `Electron.lnk` still targeted the project’s bare `node_modules\\electron\\dist\\electron.exe` and had no application arguments, while its hidden AppUserModelID was Live Pulse’s production ID. Windows therefore kept grouping the installed window into that old pin and relaunched Electron’s default-app screen. On installed startup, v1.6.3 checks only the old Start Menu and pinned-taskbar `Electron.lnk` locations and updates a link in place only when it both launches `electron.exe` and owns the exact Live Pulse production AppUserModelID. The target, working directory, arguments, product icon and toast identity are then migrated to the installed Live Pulse executable; unrelated Electron links remain untouched.

The migration was integration-tested against a byte-for-byte copy of the affected taskbar link using Electron’s real `readShortcutLink`/`writeShortcutLink` APIs. The copied link changed from bare project Electron to the packaged Live Pulse executable with empty arguments, the product working directory and icon, while retaining `kr.local.youtubelivepulse`.

Verification covers all 55 tests, syntax checks, a warning-free live RESCENE diagnostic, the x64 NSIS build and packaged smoke test. The affected-link integration test was repeated after the final build using the migration code directly from the packaged ASAR and targeting the packaged v1.6.3 executable. The packaged executable reports version `1.6.3`, contains the migration module and icon, and both `dist/latest.yml` and packaged `resources/app-update.yml` are correct. The local installer SHA-512 matches its generated update metadata. GitHub Actions run `30700612022` completed successfully; the public non-draft Release contains the installer, block map and `latest.yml`. A fresh public installer download matched both the SHA-512 in its published update metadata and the SHA-256 reported for the GitHub Release asset.

The v1.6.2 release added explicit taskbar relaunch details: AppUserModelID, executable-plus-app command, product name and product icon. A default-location installed copy also repairs an existing `라이브 펄스.lnk` Start Menu shortcut whose target still has the product executable name but points at a stale user path; unrelated shortcuts remain untouched.

Verification covers all 50 tests, syntax checks, a warning-free live RESCENE diagnostic, a valid nine-size `pulse.ico`, the x64 NSIS build and packaged smoke test. The packaged executable reports version `1.6.2`, contains the new taskbar/shortcut module and ICO, and exposes the expected Live Pulse waveform icon. `dist/latest.yml`, packaged `resources/app-update.yml` and the local installer SHA-512 were verified. GitHub Actions run `30698262186` completed successfully; the public non-draft Release contains the installer, block map and `latest.yml`. A fresh public installer download matched both the SHA-512 in its published update metadata and the SHA-256 reported for the GitHub Release asset.

The verified v1.6.1 release fixes Windows native-notification activation opening Electron’s default-app screen instead of the YouTube video. Development and unpacked runs previously reused the production AppUserModelID, allowing Windows toast activation to point at the project’s `node_modules\\electron\\dist\\electron.exe` without the app path. The new startup logic grants the production identity only when the running executable matches the installed Start Menu shortcut, uses `process.execPath` for development and smoke isolation, sets a stable ToastActivatorCLSID, and repairs both notification properties on the installed shortcut. The repair applies automatically on the first v1.6.1 launch; old notifications already stored in Windows may still reference the previous activation registration and should be dismissed.

Verification covers all 44 tests, syntax checks, a warning-free live RESCENE diagnostic, a successful development smoke launch with the isolated identity, and a real copy of the installed Start Menu shortcut updated and re-read with both Windows notification properties before app readiness. The x64 NSIS build and packaged smoke passed; packaged version `1.6.1`, inclusion of the repair module, `latest.yml`, `resources/app-update.yml` and the local installer SHA-512 were verified. GitHub Actions run `30697446645` completed successfully; the public non-draft Release contains the installer, block map and `latest.yml`, and the downloaded public installer SHA-512 matches its published update metadata.

The verified v1.6.0 release fixes preset ranges to use inclusive local-calendar dates and carries one hidden prior close into analytics so the first displayed day has a valid change baseline. The growth chart ends at the latest completed day instead of reserving a blank current-day slot. Channel cards calculate total subscriber change from the complete stored history even though their sparkline remains bounded. Settings offer `수집 시각 기준` and `날짜 기준`; the latter plots only each date’s last value without modifying stored raw history. Growth wording explains momentum as the recent three completed intervals’ average versus the preceding three, and presents acceleration as a difference between daily rates instead of the opaque `명/일²` label.

Local verification covers all 38 tests, syntax checks, a warning-free live RESCENE public-channel diagnostic, the x64 NSIS build, and packaged dashboard, growth-chart, date-mode and settings-dialog smoke captures. `dist/latest.yml`, packaged `resources/app-update.yml`, packaged version `1.6.0` and the local installer SHA-512 were verified. GitHub Actions run `30696633468` completed successfully; the public non-draft Release contains the installer, block map and `latest.yml`, and the downloaded public installer SHA-512 matches its published update metadata.

The v1.5.0 GitHub Actions build, all 33 tests and Release publication completed successfully. The published non-draft Release contains the installer, block map and `latest.yml`; the public installer was downloaded again and its SHA-512 matched the published update metadata. That release added channel-scoped `.xlsx` subscriber-history import from the subscriber detail dialog. It reads sheets containing `날짜` and `전체 구독자`, ignores summary rows and the derived `신규 구독자` column, stores new dates at local 00:00, and never overwrites a local date that already has an app sample. Duplicate dates inside one workbook resolve to the last valid row, and the result reports added, preserved, invalid and duplicate counts. Workbook parsing stays in the main process behind a narrow preload IPC method.

Local verification also covered both provided workbooks (365 valid RESCENE dates and 176 valid 안원잘부 dates), a live RESCENE public-channel diagnostic without warnings, `npm audit` with zero vulnerabilities, the x64 NSIS build, packaged dashboard smoke test and a packaged-ASAR import of the 365-row workbook. `dist/latest.yml`, packaged `resources/app-update.yml` and the local installer SHA-512 were verified before tagging.

Version 1.4.0 excluded the incomplete current local day from every growth and selected-range calculation while keeping current samples visible on the raw chart. Clicking a completed date selects that day; dragging in either direction selects an inclusive completed-day range and shows cumulative change, average daily change, average daily growth, total range growth and trend slope. Missing dates are not interpolated and remain normalized by elapsed local calendar days.

The first v1.2.0 workflow attempt exposed an Electron Builder publication race: it reported success after only the block map became visible. Rerunning with the Release already created uploaded all assets. The workflow was then hardened to build with `npm run build` and publish the three assets explicitly with `gh release upload`; a partial upload now fails the job.

Existing v1.0.x installations do not contain the updater and require one manual v1.1.0 installation. Starting with v1.1.0, the app checks public GitHub Releases after startup and every four hours, downloads a newer release in the background, then offers restart installation.

## Shipped functionality

- Starts in the Windows login session and stays in the system tray.
- Polls registered YouTube channels at a configurable 15–300 second interval.
- Opens Chrome once when a live stream starts.
- Opens Chrome once when a genuinely future scheduled broadcast is discovered.
- Supports YouTube channel URLs, handles and channel IDs.
- Displays recent videos and experimental community posts.
- Reads both `/videos` and `/streams`, including current `lockupViewModel` cards, so RSS delay is not the only new-video signal.
- Shows live/offline/checking indicators.
- Records local subscriber-count history and renders a clickable detail chart with 7-day, 30-day, 90-day, 1-year and all-history ranges.
- Shows actual subscriber values, a linear trendline, range change, high, low, daily trend and point tooltips.
- Supports cursor-centered mouse-wheel zoom on the subscriber and growth charts, with a one-day minimum and an explicit zoom reset.
- Calculates daily change and growth rate, day-over-day acceleration/deceleration, three-period momentum change and first-half-versus-second-half slope change, with a secondary bar-and-line chart.
- Excludes the incomplete current local day from analytics and supports click/drag completed-date selection with cumulative, average and slope summaries.
- Uses an earlier close as a hidden range baseline so the first visible completed day can be selected and included in momentum, while keeping the incomplete current day off the growth-chart axis.
- Lets users plot all collection timestamps or one final value per local date without mutating stored history.
- Reports channel-card total subscriber change over the full stored history independently from the bounded sparkline.
- Imports channel-specific historical subscriber totals from `.xlsx` without overwriting dates already stored by the app.
- Tracks recently seen video and post IDs so feed reordering cannot create repeated notifications.
- Removes already-stored duplicate recent notifications during the v2 store migration.
- Uses an optional YouTube Data API key to improve official channel statistics.
- Records recent per-video view-count histories and renders selectable detail charts with cursor-centered wheel zoom.
- Stores configuration, deduplication state, events and history in local Electron user data.
- Checks and installs updates from public GitHub Releases.
- Keeps development and unpacked Electron runs isolated from the installed app’s Windows notification activation identity.
- Publishes explicit Windows taskbar relaunch identity and repairs a stale default-install Start Menu shortcut without touching unrelated shortcuts.

The default monitored channel is:

`https://www.youtube.com/channel/UCtKtCiaWRz-d3EZn2xd1mdA`

## Important fixed regression

Finished live video `hm6LLaIfMho` was previously shown as an upcoming broadcast.

Root cause:

- YouTube returned `isLiveContent: true` and `isLiveNow: false`.
- It omitted `startTimestamp`.
- The parser converted the missing time into an effective far-future value.

Current invariant:

- Missing timestamps are not upcoming.
- Past timestamps are not upcoming.
- Only an explicit future timestamp can be upcoming; a badge without a real start time is treated as ambiguous.

Regression coverage is in `test/youtube.test.js`.

## Recent-notification deduplication

Older versions stored only the single latest video/post ID. When YouTube returned recent feed entries in a different order, an already-seen item could alternate back into the first position and be recorded again.

Version 1.2.0 now:

- Persists up to 100 recently seen video IDs and post IDs per channel.
- Baselines existing channels on migration without emitting historical alerts.
- Adds a semantic event key based on channel, event type and content identity.
- Deduplicates existing locally stored events on startup while keeping the newest row.

Regression coverage is in `test/events.test.js` and `test/store.test.js`.

## Current data sources and limitations

YouTube monitoring currently combines:

- Channel and stream public pages
- Channel video public pages and public video watch pages
- `/channel/{id}/live` player response
- Official YouTube channel RSS
- Optional YouTube Data API channel and batched video statistics

Known limitations:

- Monitoring is polling, not push-based.
- Public YouTube page structures can change.
- Community-post detection is experimental.
- Public subscriber numbers are rounded and may differ briefly between YouTube endpoints.
- The optional API key is not OAuth and does not reveal private or exact subscriber totals for another channel; official public subscriber totals remain rounded to three significant figures.
- View-history charts start when v1.7.0 first observes a video. YouTube is not used to fabricate historical point-in-time views.
- Subscriber history starts when the app first runs unless the user imports a matching channel history `.xlsx`; YouTube itself is not used to backfill historical data.
- Growth analytics use completed local-date closing samples, normalize missing-day gaps by elapsed calendar days and exclude the current partial day from calculations while leaving it visible on the raw chart.
- The Windows installer is not code-signed and can trigger SmartScreen on first installation.

## Automatic release pipeline

The release workflow runs only for tags matching `v*`.

Expected process:

1. Implement and test an app change.
2. Update `package.json` and `package-lock.json` to the same semantic version.
3. Commit and push `main`.
4. Push a matching version tag.
5. GitHub Actions runs `npm ci`, `npm test` and `npm run build`.
6. The workflow creates or reuses the tagged Release, then explicitly uploads the NSIS installer, block map and `latest.yml`.
7. Verify the workflow, Release visibility and asset hashes before handoff.

Ordinary documentation-only pushes to `main` do not produce a Release.

## Next milestone: CHZZK live popup

The user intends to add CHZZK (치지직) live popup monitoring next. No CHZZK code or API assumptions have been added yet.

Suggested first implementation slice:

1. Research current officially supported CHZZK public data access.
2. Define a provider abstraction shared by YouTube and CHZZK.
3. Add a store migration that assigns existing channels `provider: "youtube"`.
4. Resolve CHZZK channel URLs to stable channel IDs.
5. Fetch and normalize current live status.
6. Open `https://chzzk.naver.com/...` in Chrome through a narrowly expanded URL allowlist.
7. Add provider-specific deduplication and tests.
8. Display a YouTube/CHZZK provider badge on each existing channel card.

Do not assume that CHZZK scheduled streams, posts, VOD feeds or follower history are available until verified. The first safe release can support only channel addition, live/offline status and one-time Chrome opening.

## Verification commands

```powershell
npm ci
npm test
npm run build
node scripts/check-channel.js
.\dist\win-unpacked\라이브 펄스.exe --smoke-test
.\dist\win-unpacked\라이브 펄스.exe --smoke-video-views
```

On this workstation, use the full npm CLI path documented in `AGENTS.md` if the npm shim fails.

## Files to read first

1. `AGENTS.md`
2. `README.md`
3. `src/lib/monitor.js`
4. `src/lib/youtube.js`
5. `src/lib/store.js`
6. `src/lib/subscriber-import.js`
7. `src/lib/updater.js`
8. `src/main.js`
9. `.github/workflows/release.yml`

Update this handoff after the CHZZK provider contract is decided or any new production release is published.
