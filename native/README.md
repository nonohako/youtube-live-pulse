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

`LivePulse.Core` has started the offline YouTube port with player-confirmed live/upcoming classification and four-source recent-video interleaving. Its regression harness uses the same key inputs as `test/youtube.test.js`:

```powershell
dotnet build native/LivePulse.Core.Tests/LivePulse.Core.Tests.csproj -c Release
dotnet native/LivePulse.Core.Tests/bin/Release/net10.0/LivePulse.Core.Tests.dll
```

The core library is not connected to HTTP fetching, polling, notifications, deduplication, persistence or the WPF host yet.
