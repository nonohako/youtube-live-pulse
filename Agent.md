# Agent Guide

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
```

## Architecture

- `src/main.js`: Electron lifecycle, tray, IPC, Chrome launch, login startup
- `src/preload.js`: narrow renderer IPC bridge
- `src/lib/monitor.js`: polling, deduplication, notifications, event and subscriber history
- `src/lib/youtube.js`: YouTube input resolution, fetching, parsing and normalization
- `src/lib/updater.js`: GitHub Release update checks, download state and installation
- `src/lib/store.js`: atomic local JSON persistence and settings normalization
- `src/renderer/`: Korean dashboard and settings UI
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
- The Windows installer is currently unsigned. Do not claim it is code-signed.
- Avoid destructive Git commands and preserve existing user changes.
- Update `handoff.md` whenever architecture, release behavior, known limitations or the next milestone changes materially.
