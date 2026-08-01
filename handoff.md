# Live Pulse handoff

Last updated: 2026-08-01

## Current production state

- Application version: `1.3.0`
- Public repository: `https://github.com/nonohako/youtube-live-pulse`
- Production release: `https://github.com/nonohako/youtube-live-pulse/releases/tag/v1.3.0`
- Default branch: `main`
- Platform: Windows x64
- Packaging: Electron + NSIS
- License: MIT

The v1.3.0 GitHub Actions build, all 26 tests and Release publication completed successfully. The published non-draft Release contains the installer, block map and `latest.yml`; the public installer was downloaded again and its SHA-512 matched the published update metadata. This release adds daily subscriber growth, growth-rate trend, day-over-day acceleration/deceleration, a recent-three-versus-previous-three momentum comparison, selected-period first-half-versus-second-half slope change, and a secondary daily-change bar chart with a growth-rate line. Daily closes use the last measurement on each local date, and gaps are normalized by elapsed calendar days.

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
- Tracks recently seen video and post IDs so feed reordering cannot create repeated notifications.
- Removes already-stored duplicate recent notifications during the v2 store migration.
- Uses an optional YouTube Data API key to improve official channel statistics.
- Stores configuration, deduplication state, events and history in local Electron user data.
- Checks and installs updates from public GitHub Releases.

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
- Subscriber history starts when the app first runs; historical YouTube data is not backfilled.
- Growth analytics use local-date closing samples, normalize missing-day gaps by elapsed calendar days and treat the current day as partial.
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
6. `src/lib/updater.js`
7. `src/main.js`
8. `.github/workflows/release.yml`

Update this handoff after the CHZZK provider contract is decided or any new production release is published.
