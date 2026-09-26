# Live Pulse native migration checkpoint

`LivePulse.Windows` reuses the existing HTML/CSS/JS in WebView2 and keeps monitoring/cloud polling in C# while the window is closed. `--hidden` creates no WebView; closing the window disposes it. The personal app now runs from `%LOCALAPPDATA%/Programs/LivePulseNative` with a verified private SQLite DB, repeated authenticated Fly sync and a native Windows login entry. The old Electron executable and JSON remain available for manual return; no public native installer/update has been published.

Build with the .NET 10 SDK and the pinned WebView2 package:

2026-09-26: the personal build now preserves selected chart histories across timer/cloud refreshes, displays channel collection failures and recovery, and pauses state broadcasts/countdowns while minimized. The stopped fixed-path installation was backed up and updated; its next personal launch uses the fixes. To reproduce the regression smoke, use NativeStore.Tests `--ui-fixture ABSOLUTE_NEW_OUTPUT.probe.sqlite` under ignored `artifacts/migration-isolated-data`, then run the native executable with `--hidden --isolated-monitor-db ABSOLUTE_NEW_OUTPUT.probe.sqlite --ui-smoke --ui-smoke-refresh --ui-smoke-actions`. The fixture has more than 120 subscriber samples and a known multi-sample video. This verifies actual WebView interactions with suppressed Windows effects, not natural broadcast notification delivery.

```powershell
dotnet build native/LivePulse.Windows/LivePulse.Windows.csproj -c Release
```

Run `LivePulse.NativePrototype.exe --lifecycle-smoke` from the build output for three open/close cycles, bridge fixture checks and browser-process exit checks. `--lifecycle-stress` also closes during initialization, reopens immediately and runs 20 cycles with tray memory samples after each browser exit. `--hidden` starts tray-only. The test uses a separate WebView2 profile under the Windows temp directory. The installed app and its Electron updater remain the production path.

The personal app is already prepared on this workstation. To restart it after quitting, first ensure Electron is closed, then run:

```powershell
& "$env:LOCALAPPDATA\Programs\LivePulseNative\LivePulse.NativePrototype.exe" --personal-db "$env:LOCALAPPDATA\LivePulseNative\live-pulse.sqlite"
```

For a fresh private setup on another workstation, stop Electron first, build with .NET 10, run the preparation script once and copy the published files to a stable personal folder. The prepared DB path cannot be overwritten by a second run:

```powershell
$dotnet10 = Join-Path $env:TEMP 'livepulse-dotnet10/dotnet.exe'
& $dotnet10 build native/LivePulse.NativeStore.Tests/LivePulse.NativeStore.Tests.csproj -c Release
& $dotnet10 publish native/LivePulse.Windows/LivePulse.Windows.csproj -c Release -r win-x64 --self-contained true --output artifacts/native-personal-build
.\native\prepare-personal.ps1 -SourceJson "$env:APPDATA\youtube-live-pulse\live-pulse.json"
```

The preparation command refuses a running Electron/native app and an existing target DB. It leaves the installed JSON unchanged, retains a SHA-checked source copy and creates a verified SQLite backup. On this workstation, the private DB imported 2 channels, 245 series and 661,305 samples; repeated Fly sync persisted new minute-spaced observations. An actual-data WebView smoke rendered both channel cards and disposed the browser on close. An interrupted temporary backup and journal were preserved under the private `forensic/` folder after primary and `.bak.1` verification. Do not force-stop during backup. Real live-event notification/Chrome behavior and a controlled long-running memory comparison remain unverified. The optional Data API enhancement and automatic native updates are not connected. No native installer is published.

`LivePulse.DataMigration` is a separate **explicit-path import experiment**. It reads a JSON v3 source without changing it and writes a new SQLite file. Local and cloud histories remain separate; every sample keeps its original array order and raw JSON. A completion marker and source SHA-256 make a repeated import verify and reuse the same DB. The verification reopens the DB, runs SQLite integrity check, and compares each sample's sequence, timestamp, count and raw payload hash. Existing incomplete or mismatched output is rejected instead of overwritten.

```powershell
dotnet build native/LivePulse.DataMigration/LivePulse.DataMigration.csproj -c Release
dotnet native/LivePulse.DataMigration/bin/Release/net10.0/LivePulse.DataMigration.dll --self-test
dotnet native/LivePulse.DataMigration/bin/Release/net10.0/LivePulse.DataMigration.dll --import SOURCE_COPY.json OUTPUT.sqlite
dotnet native/LivePulse.DataMigration/bin/Release/net10.0/LivePulse.DataMigration.dll --verify SOURCE_COPY.json OUTPUT.sqlite
```

For experiments, use an isolated source copy and output under ignored `artifacts/`. The personal preparation command above uses the same importer, then verifies the DB and a first backup before placing it in the private app data folder. Electron rollback is manual from the preserved JSON; no automatic conversion exists.

`LivePulse.Core` has a read-only public YouTube snapshot path. It parses `/streams`, `/videos`, `/shorts`, `/posts`, RSS and `/live`, including player-confirmed live/upcoming classification and four-source recent-video interleaving. Its regression harness uses the same key inputs and reduced Shorts fixture as `test/youtube.test.js`:

```powershell
dotnet build native/LivePulse.Core.Tests/LivePulse.Core.Tests.csproj -c Release
dotnet native/LivePulse.Core.Tests/bin/Release/net10.0/LivePulse.Core.Tests.dll
dotnet build native/LivePulse.Core.Diagnostic/LivePulse.Core.Diagnostic.csproj -c Release
dotnet native/LivePulse.Core.Diagnostic/bin/Release/net10.0/LivePulse.Core.Diagnostic.dll [CHANNEL_ID]
dotnet native/LivePulse.Core.Diagnostic/bin/Release/net10.0/LivePulse.Core.Diagnostic.dll --resolve @HANDLE
```

The diagnostic makes six bounded public HTTP requests with 15-second per-request timeouts and prints summary IDs and warnings. Each response is parsed in its own task, so the six full page bodies are not held together until composition. It never opens Chrome, sends notifications or accesses user data. A live comparison on 2026-09-23 against `node scripts/check-channel.js` matched the default channel's title, subscriber count, live/upcoming state, latest video/post and all 24 recent-video IDs in order, with no warnings. This is a point-in-time read-only parser check, not evidence of future broadcast detection or measured tray memory savings.

`YouTubeChannelInput` accepts UC IDs, allowlisted YouTube channel URLs and `@handles`; a handle page is fetched without an API key to discover its channel ID. Foreign hosts are rejected. `MonitorChangePlanner` sets first-seen video/post baselines, filters repeated items, plans live/upcoming opens once per saved key, and requests a subscriber sample on change or after six hours. The runner commits tracking before injected effects. Public watch-page video statistics and personal-mode tray balloons/Chrome opening are connected; optional official Data API enrichment is pending.

`LivePulse.NativeStore` is an explicit-path SQLite write proof for the planner. It refuses missing or incomplete imports, reads only small channel state and the last local subscriber sample, and transactionally commits tracking keys, bounded events and new subscriber observations with revision checks. New rows live in separate runtime tables so the imported series and their verification hashes remain unchanged. `NativeMonitorRunner` performs one manual fetch/plan/commit cycle and calls injected notification/URL effects only after the commit. Complete public-source failure aborts without writing, and an empty first result does not initialize seen-content IDs. Run its isolated tests with:

```powershell
dotnet build native/LivePulse.NativeStore.Tests/LivePulse.NativeStore.Tests.csproj -c Release
dotnet native/LivePulse.NativeStore.Tests/bin/Release/net10.0/LivePulse.NativeStore.Tests.dll
```

The tests include an imported DB, restart/replay, stale-revision, backup and effect-order cases. An ignored 192 MB actual-data import still verifies all 544,142 original samples. The store reads selected full chart histories on demand and writes new runtime rows in separate tables. Source JSON hashing is performed by the importer/verifier, not on every polling cycle. The personal app refuses a running installed Electron process and requires a private verified DB; automatic Electron rollback conversion is not implemented.

`NativeCloudSync` reads the validated Fly HTTPS URL and read token from imported settings, resumes from the matching imported archive-v2 cursor or a runtime cursor, fetches at most ten pages of at most 2 MB each, and commits validated subscriber/video observations and cursor together. Downloaded samples stay separate from imported local/cloud rows and are not compacted. The production HTTP constructor rejects redirects; the token is never returned in a public result. A fake HTTP handler test covers two pages, imported-cursor resume, restart, backup after the first commit, original sample preservation, future/out-of-order pages, changed settings during a request, invalid hosts and unconfigured storage. The isolated WPF opt-in calls it each minute, shares the backup checkpoint, and shows a retryable cloud error in the tray text. No real Fly request was made by this native path. It is not safe to use on installed data until recovery, writer coordination and complete archive equivalence pass.

`NativeStoreRecovery` operates on an explicit isolated DB path. `CreateBackup` uses SQLite's backup API, flushes the result, checks integrity/schema/markers and rotates `.bak.1`/`.bak.2` only after validating the new snapshot. `Recover` first checks the primary; when it is corrupt or missing, it checks the temporary snapshot and both generations, stages a validated copy, preserves a corrupt primary with a unique suffix and restores the newest usable copy. Unknown WAL/SHM/journal sidecars stop recovery. The harness covers two generations, primary corruption, newest-backup corruption, simulated interrupted rotation and sidecar refusal. An ignored temporary copy of the real-data import was backed up, and the importer verified all 544,142 samples against the isolated source JSON; that earlier probe copy and snapshot were removed.

`NativeBackupCheckpoint` now connects the isolated runner's successful writes to backup rotation: it backs up after the first commit of a process run and after later commits at least five minutes apart. A commit that plans a notification or URL always gets a fresh validated backup before the effect sink runs, even within five minutes, so the backup contains its deduplication key. A backup failure leaves the commit in the primary, suppresses its effects, and faults the isolated scheduler visibly. Fixture tests cover the timing, generation rotation, effect ordering, failed backup and fatal scheduler path. A fresh ignored 192 MB DB copy completed two actual 30-second public sweeps in hidden tray mode with `backups=1`; the primary and `.bak.1` both matched the isolated JSON source's 2 channels, 243 series and 544,142 samples. No live/upcoming effect was planned in that public probe, so forced-effect backup has fixture coverage only. The short process private/working-set samples were 67.5/121.7 MiB and 73.9/134.4 MiB; these lack cloud sync and full UI and do not establish equivalent-data savings. Automatic startup restore, cross-runtime writer exclusion, original JSON hash checks during routine validation, complete row-level archive verification and Electron rollback conversion remain open. Never use this path on installed user data.

`NativeStoreLease` now holds an exclusive `.native-lock` file for the full lifetime of the opt-in WPF monitor, starting before it opens SQLite and releasing only after its monitor task exits. A separate-process test confirms another cooperative native process cannot acquire the same DB until the first exits. This does not coordinate older prototypes, manual tools or installed Electron; it is not permission to run automatic restore while another writer may exist. The lock file may remain after exit and can be acquired again; its presence alone does not mean a process is active.

`NativeMonitorScheduler` adds a cancellation-controlled polling loop around the isolated runner. It reads channel IDs and validated monitor settings from SQLite for each sweep, begins after 250 ms, serializes channels, records per-channel failures and stops with a recorded error and faulted task when settings cannot be read. The harness uses a controlled delay to test changed intervals, explicit restart after fixing invalid settings, channel failure isolation, replay suppression and double-start rejection. The new configuration reader also read two channels and a 30-second interval from an ignored copy of the actual-data import; that probe copy was removed. Only the explicit WPF opt-in below starts the loop; no production database, cloud sync or Windows effect sink is connected. The controlled clock is not evidence of long-running public monitoring or tray memory use.

The WPF app starts its monitor and cloud loops with either `--hidden --isolated-monitor-db ABSOLUTE_PATH` or explicit `--personal-db ABSOLUTE_PATH`. Isolated mode requires an existing disposable `artifacts/migration-isolated-data/*.probe.sqlite` and suppresses Windows effects. Add `--monitor-smoke` for one sweep or `--ui-smoke --ui-smoke-actions` for a rendered card, bridge actions and close-to-tray check. The published self-contained executable passed the latter with one channel; personal mode and installed data have not yet been run together. No native release installer exists.

If a moved Windows environment leaves `obj/project.assets.json` pointing to a missing NuGet fallback folder, restore the affected native project with `dotnet restore PROJECT.csproj --ignore-failed-sources -p:RestoreFallbackFolders=''` before using `--no-restore` builds. This regenerates ignored build metadata; it does not change source or user data.
