# Live Pulse handoff

Last updated: 2026-09-27

Earlier history (Electron releases v1.x, the 2026-09-22 data recovery, the staged C# migration and the Codex MSIX incident) is in Git history up to commit 94d53df.

## Current state

- The personal app is the C# tray app, running portably from this repository folder: `app/LivePulse.exe` + `data/` (see `README.md`, `native/README.md`, `AGENTS.md`). It was launched from the desktop shortcut **라이브 펄스** and left running; the Windows `라이브 펄스` Run value points to `app\LivePulse.exe --hidden`.
- The Electron app is gone: the installed copy was uninstalled silently (its desktop/Start Menu shortcuts went with it), and its source, scripts, Electron-only tests, `package-lock.json`, the release workflow and `docs/migration-csharp-webview2.md` were removed from the branch. `package.json` now only runs `node --test` for renderer math and the cloud collector.

## 2026-09-27 work

1. **Backup stop fix.** Interrupted-backup residue made every backup fail and stopped monitoring. Residue is now discarded after validation; failed backups are warnings retried after 5 minutes; routine backups are hourly; startup rolls back crash journals and restores from backups if needed. `monitor.running` now means an active sweep.
2. **Portable layout.** `native/publish-portable.ps1` builds `app/`, keeps `data/`, creates the desktop shortcut, removes `bin/obj`, and stops a running app gracefully via `LivePulse.exe --quit`. The app repairs its Run value and shortcut after the folder moves.
3. **Electron parity items ported:** optional YouTube Data API (official channel stats every 10 min or on refresh, batched view counts with watch-page fallback, handle resolution; key never in messages); channel-failure `error` events; event `id`/`at` with newest-first order and removed-channel filtering; channel name/avatar from the latest check; immediate re-check after adding a channel or changing interval/API key (`NativeMonitorScheduler.Wake`); per-channel `checking` status; tray menu (refresh now, login toggle, left-click open) and live-count tooltip; API key settings enabled in the UI; the non-functional update button is hidden in the native app.
   Not ported on purpose: Electron auto-update (rebuild with the script instead), `--cloud-config` command-line onboarding (use the settings dialog import), Electron toast/AppUserModelID shortcut handling (tray balloons are used).
4. **Data merge.** Electron had run 2026-09-26 13:13 to 2026-09-27 10:09 KST while the native app was stopped. Its local observations were merged into `data/live-pulse.sqlite` with exact-instant deduplication: 11 subscriber samples, 2,321 video view samples, 1 video metadata row; `integrity_check` ok before/after. The final Electron JSON (100 MB) is archived as `data/legacy/electron-live-pulse-20260927.json.zip` (3.4 MB, SHA-256 verified).
5. **Cleanup.** Sent to the Recycle Bin (restorable until emptied): Electron AppData (`%APPDATA%\youtube-live-pulse`), old native data (`%LOCALAPPDATA%\LivePulseNative`), the Codex MSIX cache copy, the old native install (`%LOCALAPPDATA%\Programs\LivePulseNative`) and `artifacts/` (old installers, build copies, probe/recovery DB copies). Hard-deleted regenerable output: `dist/`, `node_modules/`, `native/*/bin|obj`, the Electron updater cache. Repository folder: about 10 GB to 1.5 GB.

6. **Cloud-first records (user request).** New-video events show the cloud's official publish time and the event list is time-ordered. Unseen videos/posts older than 2 days (recorded publish time or clear relative text) are no longer alerted as new. Subscriber/view history is left to the Fly collector; the PC records it only while a channel has no cloud samples newer than 10 minutes, or always if the new settings switch "구독자·조회수를 이 PC에서도 기록" is on (off by default). Real-data check after publishing: no local subscriber/view rows while cloud samples were current. RSS 404/500 warnings (YouTube feed flakiness, not the app or Fly) are hidden while `/videos` works; Fly logs showed a collection every minute with `error: null`.

## Verification

CORE_TESTS_PASSED (new Data API fixture cases), NATIVE_STORE_TESTS_PASSED (failure events, event order/time, removed-channel filtering, backup residue/crash-journal cases), DataMigration SELF_TEST_PASSED, NATIVE_STARTUP_TESTS_PASSED, Node 34/34, isolated WebView smoke (actions, refresh, minimize/restore, close) passed; Release build 0 warnings. The published app started on real data, backed up within seconds, stopped gracefully with `--quit`, relaunched, swept both channels and synced cloud data without errors.

## Limitations / next steps

- A natural live-event Chrome open and balloon click on the native app has not been observed yet.
- The Data API path is covered by fixtures only (no key is configured).
- Five runtime events created before 2026-09-27 have no stored time; the UI now shows the video's official publish time recorded by the cloud (or local metadata) for them.
- Three of those five "new video" events were false alerts for videos published in June/July; with time ordering they now sit at their publish dates, and the 2-day rule prevents new ones.
- The cloud collector already tracks new uploads (uploads playlist every 5 minutes, newest 10 videos every minute, title + publishedAt); it excludes live/upcoming items and community posts, and its `seenAt` is a last-seen, not first-seen, time.
- The .NET 10 SDK lives in `%TEMP%\livepulse-dotnet10`; reinstall it if a temp cleaner removes it.
- CHZZK support remains planned (see `AGENTS.md`).
