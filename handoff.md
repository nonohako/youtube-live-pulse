# Live Pulse handoff

Last updated: 2026-08-01

## Current production state

- Application version: `1.6.1`
- Public repository: `https://github.com/nonohako/youtube-live-pulse`
- Production release: `https://github.com/nonohako/youtube-live-pulse/releases/tag/v1.6.1`
- Default branch: `main`
- Platform: Windows x64
- Packaging: Electron + NSIS
- License: MIT

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
- Shows live/offline/checking indicators.
- Records local subscriber-count history and renders a clickable detail chart with 7-day, 30-day, 90-day, 1-year and all-history ranges.
- Shows actual subscriber values, a linear trendline, range change, high, low, daily trend and point tooltips.
- Calculates daily change and growth rate, day-over-day acceleration/deceleration, three-period momentum change and first-half-versus-second-half slope change, with a secondary bar-and-line chart.
- Excludes the incomplete current local day from analytics and supports click/drag completed-date selection with cumulative, average and slope summaries.
- Uses an earlier close as a hidden range baseline so the first visible completed day can be selected and included in momentum, while keeping the incomplete current day off the growth-chart axis.
- Lets users plot all collection timestamps or one final value per local date without mutating stored history.
- Reports channel-card total subscriber change over the full stored history independently from the bounded sparkline.
- Imports channel-specific historical subscriber totals from `.xlsx` without overwriting dates already stored by the app.
- Tracks recently seen video and post IDs so feed reordering cannot create repeated notifications.
- Removes already-stored duplicate recent notifications during the v2 store migration.
- Uses an optional YouTube Data API key to improve official channel statistics.
- Stores configuration, deduplication state, events and history in local Electron user data.
- Checks and installs updates from public GitHub Releases.
- Keeps development and unpacked Electron runs isolated from the installed app’s Windows notification activation identity.

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
- Only an explicit future timestamp, or an explicit upcoming badge when no timestamp exists in a stream-list renderer, can be upcoming.

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
- `/channel/{id}/live` player response
- Official YouTube channel RSS
- Optional YouTube Data API channel statistics

Known limitations:

- Monitoring is polling, not push-based.
- Public YouTube page structures can change.
- Community-post detection is experimental.
- Public subscriber numbers are rounded and may differ briefly between YouTube endpoints.
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
