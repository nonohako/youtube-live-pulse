# Live Pulse handoff

Last updated: 2026-09-27

Rules and invariants live in `AGENTS.md`; user-facing setup is in `README.md` and `native/README.md`. Earlier history (Electron releases v1.x, the 2026-09-22 data recovery, the staged C# migration, the Codex MSIX incident) is in Git history up to commit 94d53df.

## Current state

- **Branch:** all work happens on `main`. The C# migration (`codex/csharp-webview2-migration`, 26 commits) was merged by PR #12 on 2026-09-27 (merge commit `1782103`). The old branch is kept on GitHub but is no longer used.
- **App:** the personal app is the C# tray app, running portably from this folder (`app/LivePulse.exe` + `data/`). It starts from the desktop shortcut **라이브 펄스**; the Windows `라이브 펄스` Run value points to `app\LivePulse.exe --hidden`. Rebuild with `native/publish-portable.ps1` after runtime changes.
- **Electron:** fully retired. The installed copy was uninstalled; its source, scripts, Electron-only tests, `package-lock.json`, the release workflow and `docs/migration-csharp-webview2.md` were removed. `package.json` only runs `node --test` (renderer math and the cloud collector).
- **Cloud:** the Fly collector writes subscriber/view statistics to Upstash every minute; the app syncs them and treats them as the primary history (see "Cloud-first records" below).
- **Agent tooling:** Claude Code CLI 2.1.283 is installed at `%USERPROFILE%\.local\bin\claude.exe` (added to the user PATH). The `upstash-redis` MCP server in `.mcp.json` is connected with the read-only token and returned the `live-pulse:v1:metadata` and `live-pulse:v1:samples` keys. `.git` is owned by the Codex sandbox account, so this folder was added to the user's global git `safe.directory`.

## What was done on 2026-09-27

1. **Backup stop fix.** Interrupted-backup residue made every backup fail and stopped monitoring. Residue is now discarded after validation; failed backups are warnings retried after 5 minutes; routine backups are hourly; startup rolls back crash journals and restores from backups if needed. `monitor.running` now means an active sweep.
2. **Portable layout.** `native/publish-portable.ps1` builds `app/`, keeps `data/`, creates the desktop shortcut, removes `bin/obj`, and stops a running app gracefully via `LivePulse.exe --quit`. The app repairs its Run value and shortcut after the folder moves.
3. **Electron features ported:** optional YouTube Data API (channel stats every 10 min or on refresh, batched view counts with watch-page fallback, handle resolution; the key never appears in messages); channel-failure `error` events; event `id`/`at` with newest-first order and removed-channel filtering; channel name/avatar from the latest check; immediate re-check after adding a channel or changing interval/API key; per-channel `checking` status; tray menu (refresh now, login toggle, left-click open) and live-count tooltip; API key settings in the UI.
   Not ported on purpose: Electron auto-update (rebuild with the script), `--cloud-config` command-line onboarding (use the settings dialog import), Electron toast/AppUserModelID handling (tray balloons are used). The update button is hidden.
4. **Data merge.** Electron ran 2026-09-26 13:13 to 2026-09-27 10:09 KST while the native app was stopped. Its observations were merged into `data/live-pulse.sqlite` with exact-instant deduplication (11 subscriber samples, 2,321 video view samples, 1 video metadata row; `integrity_check` ok before/after). The final Electron JSON is archived as `data/legacy/electron-live-pulse-20260927.json.zip` (SHA-256 verified).
5. **Cleanup.** Sent to the Recycle Bin (restorable until emptied): Electron AppData (`%APPDATA%\youtube-live-pulse`), old native data (`%LOCALAPPDATA%\LivePulseNative`), the Codex MSIX cache copy, the old native install (`%LOCALAPPDATA%\Programs\LivePulseNative`) and `artifacts/`. Hard-deleted regenerable output only (`dist/`, `node_modules/`, `native/*/bin|obj`, the Electron updater cache). Folder size went from about 10 GB to 1.5 GB.
6. **Cloud-first records (user request).** New-video events show the cloud's official publish time, and the event list is time-ordered. Unseen videos/posts older than 2 days are no longer alerted as new. The PC records subscriber/view history only while a channel has no cloud samples newer than 10 minutes, or always if the settings switch "구독자·조회수를 이 PC에서도 기록" is on (off by default). RSS 404/500 warnings (YouTube feed flakiness) are hidden while `/videos` works.
7. **Upstash check.** The whole Fly/Upstash window (13,786 minutes since 2026-09-17 13:00 UTC, 217 videos) was compared with the app DB: nothing was missing, so no manual migration is needed.
8. **Merge to `main`.** PR #12 was marked ready and merged with a merge commit; the tag-only release workflow did not run and is now removed.

8. **Card chart fix.** Channel-card sparklines were flat because the overview kept the latest 119 samples, which minute-level cloud data turns into the last ~2 hours (the card drew the last hour). The overview now keeps the first observation plus each local day's last observation (newest 119 days) and the latest one. Cards also showed "조회수 0회" when the page gave no count (`null` became 0); they now prefer the latest recorded (cloud) count.

9. **Subscriber gap filled (user request).** Both channels had no subscriber records for 2026-08-02..09-16 (46 days, lost in the September incident, before cloud collection began on 09-17). The public Data API cannot return past counts, so the Playboard daily totals the user pointed to (read 2026-09-27) were inserted like the app's xlsx import: local 00:00 rows in `runtime_subscriber_samples`, only for dates without any sample, 46 rows per channel, `integrity_check` ok, app stopped with `--quit` during the write. Playboard's 09-20 value for the second channel (2,050,000, a dip) was outside the range and not imported. Values are rounded to Playboard's precision.

10. **Startup, close and tray memory (user report).** Closing already kept the app in the tray, but new tray icons sit in the overflow area, so the first close per session now shows a "still running in the tray" balloon. Startup went from 5.2 s to 1.7 s to the window: four components each ran `quick_check` over the 290 MB DB (now once per process), startup used `integrity_check` (now `quick_check`), the login-entry check read the full UI state (now one setting), shell repair ran before the first paint (now deferred), and each start copied the DB for a backup (now skipped when `.bak.1` is under an hour old). Quit took about 0.2 s; it now also hides the tray icon/window immediately. Hidden-mode private memory dropped from 85-130 MB to about 50-58 MB (working set about 50-75 MB) with non-concurrent GC, ConserveMemory and an aggressive GC plus working-set trim when hidden.

11. **X button crash (user report).** Pressing the window's X button terminated the whole app: the `Closing` handler called `CloseToTray`, whose `DisposeSession` calls `Close()` while WPF is still closing (InvalidOperationException, Windows Application Error events at 13:50). This predates the portable work; the tests had called `CloseToTray` directly. Closing now defers disposal to the next dispatcher turn, smokes close via `window.Close()`, and unhandled UI exceptions are logged instead of ending the app. Verified on the personal app with WM_CLOSE: the process stayed alive in the tray, reopened its window, no crash events.

## Verification (last runtime change)

CORE_TESTS_PASSED, NATIVE_STORE_TESTS_PASSED, DataMigration SELF_TEST_PASSED, NATIVE_STARTUP_TESTS_PASSED, Node 34/34, isolated WebView smoke (actions, refresh, minimize/restore, close); Release build with 0 warnings. The published app started on real data, backed up within seconds, stopped gracefully with `--quit`, relaunched, swept both channels and synced cloud data without errors. After the cloud-first change no local subscriber/view rows were written while cloud samples were current, and Fly logs showed a collection every minute with `error: null`.

## Open items

- A real live-broadcast Chrome open and balloon click on the native app has not been observed yet.
- The Data API path is covered by fixtures only (no key is configured).
- Five events created before 2026-09-27 have no stored time; the UI shows the cloud (or local) publish time for them. Three of them were false "new video" alerts for June/July videos; the 2-day rule prevents new ones.
- The cloud collector excludes live/upcoming items and community posts, and its `seenAt` is a last-seen, not first-seen, time.
- The .NET 10 SDK lives in `%TEMP%\livepulse-dotnet10`; reinstall it if a temp cleaner removes it.
- CHZZK support is still only planned (see `AGENTS.md`).
