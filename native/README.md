# Live Pulse native app

C# (.NET 10) tray app: WPF host + WebView2 for the dashboard in `../src/renderer`, with monitoring, storage and cloud sync in C#. Hidden startup creates no WebView; closing the window disposes it while monitoring continues.

## Portable personal app

```
<repo>/app/LivePulse.exe   self-contained build + LivePulse.portable marker (rebuilt freely)
<repo>/data/               live-pulse.sqlite, .bak.1/.bak.2, WebView2 profile, logs, legacy/ (never overwritten)
```

Build or update (Windows PowerShell). A running app is asked to quit gracefully first:

```powershell
.\native\publish-portable.ps1
.\native\publish-portable.ps1 -FromJson PATH\live-pulse.json   # first setup from an Electron data file
```

The script also creates the desktop shortcut **라이브 펄스** and removes intermediate `bin/obj` folders. `app\LivePulse.exe` with no arguments (or `--hidden`) opens the personal data; a second launch shows the existing window; `--quit` stops the running app gracefully. After the folder moves, launching once from the new place updates the Windows login entry and the desktop shortcut.

Startup rolls back a crash journal and restores the newest valid backup if the DB is damaged. Backups run on the first write and hourly (and before opening a broadcast); a failed backup is shown as a warning and retried after 5 minutes.

## Projects

| Project | Purpose |
| --- | --- |
| `LivePulse.Core` | Channel input resolution, public `/streams` `/videos` `/shorts` `/posts` `/live` + RSS parsing, optional YouTube Data API (`YouTubeDataApi`), `MonitorChangePlanner` |
| `LivePulse.NativeStore` | SQLite store and runtime tables, `NativeMonitorRunner`/`Scheduler`, backup/recovery, writer lease, Fly cloud sync, state projection, `.xlsx` subscriber import |
| `LivePulse.Windows` | Tray, WebView2 bridge (`bridge.js`), portable layout, Run/shortcut repair, smoke modes |
| `LivePulse.DataMigration` | Electron JSON v3 to SQLite importer with sample-level verification |
| `LivePulse.Core.Tests`, `LivePulse.NativeStore.Tests` | Regression harnesses (fixtures, fake HTTP handlers, crash/backup cases) |
| `LivePulse.Core.Diagnostic` | Read-only live check of one channel (no effects, no user data) |

## Checks

```powershell
$dn = "$env:TEMP\livepulse-dotnet10\dotnet.exe"   # or any .NET 10 SDK
& $dn build native/LivePulse.Core.Tests/LivePulse.Core.Tests.csproj -c Release
& $dn native/LivePulse.Core.Tests/bin/Release/net10.0/LivePulse.Core.Tests.dll
& $dn build native/LivePulse.NativeStore.Tests/LivePulse.NativeStore.Tests.csproj -c Release
& $dn native/LivePulse.NativeStore.Tests/bin/Release/net10.0/LivePulse.NativeStore.Tests.dll
& $dn build native/LivePulse.Windows/LivePulse.Windows.csproj -c Release
native/LivePulse.Windows/bin/Release/net10.0-windows/LivePulse.exe --startup-self-test | Out-String
```

Isolated WebView smoke (Windows effects suppressed, fixture data only):

```powershell
New-Item -ItemType Directory -Force artifacts/migration-isolated-data | Out-Null
$fixture = (Resolve-Path artifacts/migration-isolated-data).Path + '\ui.probe.sqlite'
& $dn native/LivePulse.NativeStore.Tests/bin/Release/net10.0/LivePulse.NativeStore.Tests.dll --ui-fixture $fixture
native/LivePulse.Windows/bin/Release/net10.0-windows/LivePulse.exe --hidden --isolated-monitor-db $fixture --ui-smoke --ui-smoke-refresh --ui-smoke-actions | Out-String
```

Other modes: `--lifecycle-smoke` / `--lifecycle-stress` (open/close cycles and WebView exit), `--monitor-smoke` (one isolated sweep). Live parser check: `dotnet LivePulse.Core.Diagnostic.dll [CHANNEL_ID]` or `--resolve @HANDLE`.

If a moved environment leaves `obj/project.assets.json` pointing to a missing NuGet fallback folder, run `dotnet restore PROJECT.csproj --ignore-failed-sources -p:RestoreFallbackFolders=''`.
