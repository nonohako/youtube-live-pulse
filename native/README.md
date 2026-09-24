# Live Pulse native migration checkpoint

`LivePulse.Windows` is a **lifecycle prototype**, not a replacement for the installed Electron app. It reuses `src/renderer/` and `assets/` at build time, starts a tray without a WebView for `--hidden`, creates the WebView on opening, and disposes it when closing to tray. The native bridge serves an isolated fixture and rejects methods that are not connected yet. It never reads or writes the production `live-pulse.json`.

Build with the .NET 10 SDK and the pinned WebView2 package:

```powershell
dotnet build native/LivePulse.Windows/LivePulse.Windows.csproj -c Release
```

Run `LivePulse.NativePrototype.exe --lifecycle-smoke` from the build output for three open/close cycles, bridge fixture checks and browser-process exit checks. `--lifecycle-stress` also closes during initialization, reopens immediately and runs 20 cycles with tray memory samples after each browser exit. `--hidden` starts tray-only. The test uses a separate WebView2 profile under the Windows temp directory. The installed app and its Electron updater remain the production path.

Next stages: establish a controlled production tray baseline with an isolated copy of real data; complete native monitoring, storage recovery and cloud sync; connect the full renderer contract; then validate Windows integration and the installed-client upgrade path. No native installer is published from this prototype.

`LivePulse.DataMigration` is a separate **explicit-path import experiment**. It reads a JSON v3 source without changing it and writes a new SQLite file. Local and cloud histories remain separate; every sample keeps its original array order and raw JSON. A completion marker and source SHA-256 make a repeated import verify and reuse the same DB. The verification reopens the DB, runs SQLite integrity check, and compares each sample's sequence, timestamp, count and raw payload hash. Existing incomplete or mismatched output is rejected instead of overwritten.

```powershell
dotnet build native/LivePulse.DataMigration/LivePulse.DataMigration.csproj -c Release
dotnet native/LivePulse.DataMigration/bin/Release/net10.0/LivePulse.DataMigration.dll --self-test
dotnet native/LivePulse.DataMigration/bin/Release/net10.0/LivePulse.DataMigration.dll --import SOURCE_COPY.json OUTPUT.sqlite
dotnet native/LivePulse.DataMigration/bin/Release/net10.0/LivePulse.DataMigration.dll --verify SOURCE_COPY.json OUTPUT.sqlite
```

Use an isolated copy for `SOURCE_COPY.json` and an output under ignored `artifacts/`. This experiment has no production database opening, backup rotation, ongoing write path or rollback conversion. It is not connected to the tray prototype.

`LivePulse.Core` has a read-only public YouTube snapshot path. It parses `/streams`, `/videos`, `/shorts`, `/posts`, RSS and `/live`, including player-confirmed live/upcoming classification and four-source recent-video interleaving. Its regression harness uses the same key inputs and reduced Shorts fixture as `test/youtube.test.js`:

```powershell
dotnet build native/LivePulse.Core.Tests/LivePulse.Core.Tests.csproj -c Release
dotnet native/LivePulse.Core.Tests/bin/Release/net10.0/LivePulse.Core.Tests.dll
dotnet build native/LivePulse.Core.Diagnostic/LivePulse.Core.Diagnostic.csproj -c Release
dotnet native/LivePulse.Core.Diagnostic/bin/Release/net10.0/LivePulse.Core.Diagnostic.dll [CHANNEL_ID]
dotnet native/LivePulse.Core.Diagnostic/bin/Release/net10.0/LivePulse.Core.Diagnostic.dll --resolve @HANDLE
```

The diagnostic makes six bounded public HTTP requests with 15-second per-request timeouts and prints summary IDs and warnings. Each response is parsed in its own task, so the six full page bodies are not held together until composition. It never opens Chrome, sends notifications or accesses user data. A live comparison on 2026-09-23 against `node scripts/check-channel.js` matched the default channel's title, subscriber count, live/upcoming state, latest video/post and all 24 recent-video IDs in order, with no warnings. This is a point-in-time read-only parser check, not evidence of future broadcast detection or measured tray memory savings.

`YouTubeChannelInput` accepts UC IDs, allowlisted YouTube channel URLs and `@handles`; a handle page is fetched without an API key to discover its channel ID. Foreign hosts are rejected. The public default channel's canonical handle resolved to its existing UC ID in a live read-only check on 2026-09-24. `MonitorChangePlanner` is a pure next-step decision layer: it sets first-seen video/post baselines, filters reordered or repeated items, plans live/upcoming opens once per saved key, and requests a subscriber sample only on count change or after six hours. The test harness checks these cases. A future runner must commit the returned tracking state before delivering notifications or launching Chrome. Optional API metadata/video-statistics, actual polling, production-grade durable deduplication, notifications, cloud sync and WPF integration remain unimplemented.

`LivePulse.NativeStore` is an explicit-path SQLite write proof for the planner. It refuses missing or incomplete imports, reads only small channel state and the last local subscriber sample, and transactionally commits tracking keys, bounded events and new subscriber observations with revision checks. New rows live in separate runtime tables so the imported series and their verification hashes remain unchanged. `NativeMonitorRunner` performs one manual fetch/plan/commit cycle and calls injected notification/URL effects only after the commit. Complete public-source failure aborts without writing, and an empty first result does not initialize seen-content IDs. Run its isolated tests with:

```powershell
dotnet build native/LivePulse.NativeStore.Tests/LivePulse.NativeStore.Tests.csproj -c Release
dotnet native/LivePulse.NativeStore.Tests/bin/Release/net10.0/LivePulse.NativeStore.Tests.dll
```

The tests include a DB created by the actual JSON importer, restart/replay, stale-revision and rollback cases, and proof that a simulated notification failure cannot trigger a repeat URL open after restart. An ignored 192 MB copy of the prior isolated import opened two channels, and source verification still passed for all 544,142 imported samples after adding runtime tables. The isolated runner now checkpoints commits as described below. It still does not compare the original JSON hash at runtime, write cloud archives, query full charts, convert rows for Electron rollback, exclude another instance or perform real Windows effects. Never point it at installed user data.

`NativeStoreRecovery` operates on an explicit isolated DB path. `CreateBackup` uses SQLite's backup API, flushes the result, checks integrity/schema/markers and rotates `.bak.1`/`.bak.2` only after validating the new snapshot. `Recover` first checks the primary; when it is corrupt or missing, it checks the temporary snapshot and both generations, stages a validated copy, preserves a corrupt primary with a unique suffix and restores the newest usable copy. Unknown WAL/SHM/journal sidecars stop recovery. The harness covers two generations, primary corruption, newest-backup corruption, simulated interrupted rotation and sidecar refusal. An ignored temporary copy of the real-data import was backed up, and the importer verified all 544,142 samples against the isolated source JSON; that earlier probe copy and snapshot were removed.

`NativeBackupCheckpoint` now connects the isolated runner's successful writes to backup rotation: it backs up after the first commit of a process run and after later commits at least five minutes apart. A commit that plans a notification or URL always gets a fresh validated backup before the effect sink runs, even within five minutes, so the backup contains its deduplication key. A backup failure leaves the commit in the primary, suppresses its effects, and faults the isolated scheduler visibly. Fixture tests cover the timing, generation rotation, effect ordering, failed backup and fatal scheduler path. A fresh ignored 192 MB DB copy completed two actual 30-second public sweeps in hidden tray mode with `backups=1`; the primary and `.bak.1` both matched the isolated JSON source's 2 channels, 243 series and 544,142 samples. No live/upcoming effect was planned in that public probe, so forced-effect backup has fixture coverage only. The short process private/working-set samples were 67.5/121.7 MiB and 73.9/134.4 MiB; these lack cloud sync and full UI and do not establish equivalent-data savings. Automatic startup restore, process-wide writer exclusion, original JSON hash checks during routine validation, complete row-level archive verification and Electron rollback conversion remain open. Never use this path on installed user data.

`NativeMonitorScheduler` adds a cancellation-controlled polling loop around the isolated runner. It reads channel IDs and validated monitor settings from SQLite for each sweep, begins after 250 ms, serializes channels, records per-channel failures and stops with a recorded error and faulted task when settings cannot be read. The harness uses a controlled delay to test changed intervals, explicit restart after fixing invalid settings, channel failure isolation, replay suppression and double-start rejection. The new configuration reader also read two channels and a 30-second interval from an ignored copy of the actual-data import; that probe copy was removed. Only the explicit WPF opt-in below starts the loop; no production database, cloud sync or Windows effect sink is connected. The controlled clock is not evidence of long-running public monitoring or tray memory use.

The WPF prototype now hosts that scheduler only when launched with `--hidden --isolated-monitor-db ABSOLUTE_PATH`. The path must be an existing disposable `artifacts/migration-isolated-data/*.probe.sqlite` file inside this checkout; linked paths are refused. Add `--monitor-smoke` to quit after one sweep, or add `--monitor-smoke-twice` as well to wait for two real clock-driven sweeps. The sink suppresses actual toast/Chrome effects, and the renderer remains fixture-backed. A fresh ignored 192 MB import copy completed two sweeps about 30 seconds apart for two public channels while no window existed; both channel revisions reached 2, and the original 544,142 samples still passed source verification afterward. The disposable copy was removed. This does not enable normal installed-app monitoring, cloud sync or release packaging.

If a moved Windows environment leaves `obj/project.assets.json` pointing to a missing NuGet fallback folder, restore the affected native project with `dotnet restore PROJECT.csproj --ignore-failed-sources -p:RestoreFallbackFolders=''` before using `--no-restore` builds. This regenerates ignored build metadata; it does not change source or user data.
