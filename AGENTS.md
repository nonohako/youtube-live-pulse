# Agent Guide

Last maintained: 2026-08-01 after the verified v1.6.1 Windows notification-activation repair release.

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
- `src/renderer/`: Korean dashboard and settings UI
- `src/renderer/chart-math.js`: local-date axes, completed-day growth analytics and selected-range summaries
- `test/`: parser and persistence regression tests

Renderer code must not receive Node.js access. Keep `contextIsolation: true`, `nodeIntegration: false`, URL validation, and the existing IPC boundary.

## YouTube invariants

- The default channel is `UCtKtCiaWRz-d3EZn2xd1mdA`.
- Core monitoring uses public YouTube pages and the official channel RSS feed.
- The optional YouTube Data API key only improves official channel metadata and subscriber statistics.
- Community-post detection is experimental because the official Data API does not expose community posts.
- A player item is upcoming only when a real future `startTimestamp` exists.
- A stream-list item with a timestamp is upcoming only when that timestamp is in the future.
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
- Subscriber-history imports are explicitly scoped to the channel whose detail dialog opened the file picker; never infer the target channel from a file name.
- Import `.xlsx` rows only from sheets containing `날짜` and `전체 구독자` headers. Ignore `합계` and `평균`; `신규 구독자` is not a source of truth.
- Store imported dates at local 00:00. If any sample already exists on that local date, keep the existing data and skip the imported row.
- Parse workbooks in the main process and expose only the narrow import action through preload; never give the renderer filesystem or Node.js access.

## Windows notification invariants

- Only an installed executable whose path matches the current user’s Start Menu shortcut may use the production AppUserModelID `kr.local.youtubelivepulse`.
- Development runs, unpacked builds and smoke tests must use `process.execPath` as their AppUserModelID so they cannot overwrite production toast activation with `node_modules\\electron\\dist\\electron.exe`.
- Production uses the stable ToastActivatorCLSID `{EAFF6767-89DB-4AC0-98A0-9F4FBE3AC3D7}` and repairs both notification properties on the existing Start Menu shortcut before creating notifications.
- A missing or unreadable Start Menu shortcut must fall back to the isolated development identity instead of claiming the production notification identity.

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
