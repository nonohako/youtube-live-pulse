# Live Pulse native migration checkpoint

`LivePulse.Windows` is a **lifecycle prototype**, not a replacement for the installed Electron app. It reuses `src/renderer/` and `assets/` at build time, starts a tray without a WebView for `--hidden`, creates the WebView on opening, and disposes it when closing to tray. The native bridge serves an isolated fixture and rejects methods that are not connected yet. It never reads or writes the production `live-pulse.json`.

Build with the .NET 10 SDK and the pinned WebView2 package:

```powershell
dotnet build native/LivePulse.Windows/LivePulse.Windows.csproj -c Release
```

Run `LivePulse.NativePrototype.exe --lifecycle-smoke` from the build output for three open/close cycles, bridge fixture checks and browser-process exit checks. `--lifecycle-stress` also closes during initialization, reopens immediately and runs 20 cycles with tray memory samples after each browser exit. `--hidden` starts tray-only. The test uses a separate WebView2 profile under the Windows temp directory. The installed app and its Electron updater remain the production path.

Next stages: establish a controlled Electron tray baseline with an isolated copy of real data; port monitoring, storage and cloud sync to native services; migrate and verify records; connect the full renderer contract; then validate Windows integration and the installed-client upgrade path. No native installer is published from this prototype.

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

`YouTubeChannelInput` accepts UC IDs, allowlisted YouTube channel URLs and `@handles`; a handle page is fetched without an API key to discover its channel ID. Foreign hosts are rejected. The public default channel's canonical handle resolved to its existing UC ID in a live read-only check on 2026-09-24. `MonitorChangePlanner` is a pure next-step decision layer: it sets first-seen video/post baselines, filters reordered or repeated items, plans live/upcoming opens once per saved key, and requests a subscriber sample only on count change or after six hours. The test harness checks these cases. A future runner must commit the returned tracking state before delivering notifications or launching Chrome. Optional API metadata/video-statistics, actual polling, durable deduplication, notifications, persistence, cloud sync and WPF integration remain unimplemented.

If a moved Windows environment leaves `obj/project.assets.json` pointing to a missing NuGet fallback folder, restore the affected native project with `dotnet restore PROJECT.csproj --ignore-failed-sources -p:RestoreFallbackFolders=''` before using `--no-restore` builds. This regenerates ignored build metadata; it does not change source or user data.
