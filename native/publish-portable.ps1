# Builds the portable personal app into <repo>/app and prepares <repo>/data once.
#   .\native\publish-portable.ps1                     rebuild app/ (data/ is never overwritten)
#   .\native\publish-portable.ps1 -FromJson PATH      first setup from an Electron live-pulse.json
# Without -FromJson, a missing data/ is copied from the earlier %LOCALAPPDATA%\LivePulseNative
# prototype (left unchanged as a fallback). Move the whole repository folder freely afterwards;
# the app repairs its Windows login entry and desktop shortcut on the next launch.
# The script creates the desktop shortcut and removes intermediate native/*/bin and obj folders.
param(
    [string]$FromJson,
    [string]$Dotnet
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$appDir = Join-Path $root 'app'
$dataDir = Join-Path $root 'data'
$database = Join-Path $dataDir 'live-pulse.sqlite'
$marker = 'LivePulse.portable'

if (-not $Dotnet) {
    $candidates = @((Join-Path $env:TEMP 'livepulse-dotnet10/dotnet.exe'), 'dotnet')
    foreach ($candidate in $candidates) {
        $command = Get-Command $candidate -ErrorAction SilentlyContinue
        if ($command -and ((& $command.Source --list-sdks) -match '^10\.')) { $Dotnet = $command.Source; break }
    }
    if (-not $Dotnet) { throw '.NET 10 SDK를 찾지 못했습니다. -Dotnet 경로를 지정하세요.' }
}
$env:DOTNET_ROOT = Split-Path -Parent $Dotnet
$env:DOTNET_ROOT_X64 = $env:DOTNET_ROOT

# Ask a running portable app to finish its current write/backup and quit.
$running = Get-Process -Name 'LivePulse' -ErrorAction SilentlyContinue
if ($running -and (Test-Path -LiteralPath (Join-Path $appDir 'LivePulse.exe'))) {
    & (Join-Path $appDir 'LivePulse.exe') --quit
    $running | Wait-Process -Timeout 120 -ErrorAction SilentlyContinue
}
if (Get-Process -Name 'LivePulse', 'LivePulse.NativePrototype' -ErrorAction SilentlyContinue) {
    throw '라이브 펄스가 아직 실행 중입니다. 트레이에서 종료한 뒤 다시 실행하세요.'
}

# --- app/ ---------------------------------------------------------------------------------
# Framework-dependent: uses the installed .NET 10 Desktop Runtime (x64), keeping app/ small.
# Another PC needs that runtime (windowsdesktop-runtime-10.x-win-x64) before LivePulse.exe starts.
if (-not (Get-ChildItem "$env:ProgramFiles\dotnet\shared\Microsoft.WindowsDesktop.App" -Directory -Filter '10.*' -ErrorAction SilentlyContinue)) {
    throw '.NET 10 Desktop Runtime(x64)이 설치되어 있지 않습니다. 먼저 설치하세요.'
}
$staging = Join-Path $root 'app.publish-tmp'
if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
& $Dotnet publish (Join-Path $PSScriptRoot 'LivePulse.Windows/LivePulse.Windows.csproj') -c Release -r win-x64 `
    --self-contained false --output $staging -nologo -v q
if ($LASTEXITCODE -ne 0) { throw '앱 빌드가 실패했습니다. 기존 app 폴더는 그대로입니다.' }
New-Item -ItemType File -Path (Join-Path $staging $marker) -Force | Out-Null
if (Test-Path -LiteralPath $appDir) {
    if (-not (Test-Path -LiteralPath (Join-Path $appDir $marker))) {
        throw "app 폴더가 라이브 펄스 빌드가 아닙니다. 덮어쓰지 않았습니다: $appDir"
    }
    Remove-Item -LiteralPath $appDir -Recurse -Force
}
Move-Item -LiteralPath $staging -Destination $appDir
Write-Output "APP_READY $appDir\LivePulse.exe"

# --- data/ (first time only) ----------------------------------------------------------------
if (Test-Path -LiteralPath $database) {
    Write-Output "DATA_KEPT $database"
} elseif ($FromJson) {
    $migrationProject = Join-Path $PSScriptRoot 'LivePulse.DataMigration/LivePulse.DataMigration.csproj'
    $storeTestProject = Join-Path $PSScriptRoot 'LivePulse.NativeStore.Tests/LivePulse.NativeStore.Tests.csproj'
    & $Dotnet build $migrationProject -c Release -nologo -v q; if ($LASTEXITCODE -ne 0) { throw '이전 도구 빌드 실패' }
    & $Dotnet build $storeTestProject -c Release -nologo -v q; if ($LASTEXITCODE -ne 0) { throw '검증 도구 빌드 실패' }
    $migration = Join-Path $PSScriptRoot 'LivePulse.DataMigration/bin/Release/net10.0/LivePulse.DataMigration.dll'
    $storeTest = Join-Path $PSScriptRoot 'LivePulse.NativeStore.Tests/bin/Release/net10.0/LivePulse.NativeStore.Tests.dll'
    New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
    $source = (Resolve-Path -LiteralPath $FromJson).Path
    $sourceCopy = Join-Path $dataDir "electron-source-$(Get-Date -Format 'yyyyMMdd-HHmmss').json"
    Copy-Item -LiteralPath $source -Destination $sourceCopy
    if ((Get-FileHash -LiteralPath $source).Hash -ne (Get-FileHash -LiteralPath $sourceCopy).Hash) {
        throw "원본 복사본의 해시가 다릅니다: $sourceCopy"
    }
    $stage = Join-Path $dataDir "live-pulse.prepare-$([guid]::NewGuid().ToString('N')).sqlite"
    & $Dotnet $migration --import $sourceCopy $stage; if ($LASTEXITCODE -ne 0) { throw '데이터 이전 실패' }
    & $Dotnet $migration --verify $sourceCopy $stage; if ($LASTEXITCODE -ne 0) { throw '데이터 검증 실패' }
    & $Dotnet $storeTest --backup-probe $sourceCopy $stage; if ($LASTEXITCODE -ne 0) { throw '첫 백업 검증 실패' }
    Move-Item -LiteralPath ($stage + '.bak.1') -Destination ($database + '.bak.1')
    Move-Item -LiteralPath $stage -Destination $database
    Write-Output "DATA_IMPORTED $database (원본 복사본: $sourceCopy)"
} else {
    $legacy = Join-Path $env:LOCALAPPDATA 'LivePulseNative'
    $legacyDb = Join-Path $legacy 'live-pulse.sqlite'
    if (-not (Test-Path -LiteralPath $legacyDb)) {
        throw "data 폴더가 없습니다. 처음 설정이면 -FromJson `"$env:APPDATA\youtube-live-pulse\live-pulse.json`"을 지정하세요."
    }
    foreach ($sidecar in '-wal', '-shm', '-journal') {
        if (Test-Path -LiteralPath ($legacyDb + $sidecar)) { throw "이전 DB에 미완료 저장 파일이 있습니다: $legacyDb$sidecar" }
    }
    New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
    # Backups first and primary last, so a partial copy never leaves a primary without backups.
    # An interrupted *.backup.tmp is residue, not data, and is not copied.
    foreach ($suffix in '.bak.2', '.bak.1', '') {
        $from = $legacyDb + $suffix
        if (-not (Test-Path -LiteralPath $from)) { continue }
        $to = $database + $suffix
        $partial = $to + '.copying'
        Copy-Item -LiteralPath $from -Destination $partial
        if ((Get-FileHash -LiteralPath $from).Hash -ne (Get-FileHash -LiteralPath $partial).Hash) {
            throw "복사 검증 실패: $from"
        }
        Move-Item -LiteralPath $partial -Destination $to
    }
    foreach ($extra in 'WebView2', 'electron-startup-command.txt') {
        $from = Join-Path $legacy $extra
        if (Test-Path -LiteralPath $from) { Copy-Item -LiteralPath $from -Destination $dataDir -Recurse }
    }
    Write-Output "DATA_COPIED $legacyDb -> $database (원본은 그대로 보존)"
}

# --- desktop shortcut -----------------------------------------------------------------------
$desktop = [Environment]::GetFolderPath('Desktop')
$legacyShortcut = Join-Path $desktop '라이브 펄스 (네이티브).lnk'
if (Test-Path -LiteralPath $legacyShortcut) { Remove-Item -LiteralPath $legacyShortcut }
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut((Join-Path $desktop '라이브 펄스.lnk'))
$shortcut.TargetPath = Join-Path $appDir 'LivePulse.exe'
$shortcut.Arguments = ''
$shortcut.WorkingDirectory = $appDir
$shortcut.IconLocation = (Join-Path $appDir 'LivePulse.exe') + ',0'
$shortcut.Save()
Write-Output 'SHORTCUT_READY 바탕 화면: 라이브 펄스'

# Intermediate build output is regenerated on the next publish; keep the repository folder small.
Get-ChildItem -LiteralPath $PSScriptRoot -Directory | ForEach-Object {
    foreach ($name in 'bin', 'obj') {
        $folder = Join-Path $_.FullName $name
        if (Test-Path -LiteralPath $folder) { Remove-Item -LiteralPath $folder -Recurse -Force }
    }
}
