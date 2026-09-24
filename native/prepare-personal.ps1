param(
    [Parameter(Mandatory = $true)]
    [string]$SourceJson,
    [string]$Dotnet = 'dotnet'
)

$ErrorActionPreference = 'Stop'
$source = (Resolve-Path -LiteralPath $SourceJson).Path
$targetDirectory = Join-Path $env:LOCALAPPDATA 'LivePulseNative'
$targetDatabase = Join-Path $targetDirectory 'live-pulse.sqlite'
$migration = Join-Path $PSScriptRoot 'LivePulse.DataMigration/bin/Release/net10.0/LivePulse.DataMigration.dll'
$storeTest = Join-Path $PSScriptRoot 'LivePulse.NativeStore.Tests/bin/Release/net10.0/LivePulse.NativeStore.Tests.dll'

if ((Get-Process -Name '라이브 펄스' -ErrorAction SilentlyContinue) -or
    (Get-Process -Name 'LivePulse.NativePrototype' -ErrorAction SilentlyContinue)) {
    throw 'Electron 및 네이티브 앱을 모두 종료한 뒤 다시 실행하세요.'
}
if ((Test-Path -LiteralPath $targetDatabase) -or
    (Test-Path -LiteralPath ($targetDatabase + '.bak.1'))) {
    throw "개인용 DB 또는 백업이 이미 있습니다. 덮어쓰지 않았습니다: $targetDatabase"
}
if (-not (Test-Path -LiteralPath $migration) -or -not (Test-Path -LiteralPath $storeTest)) {
    throw '먼저 DataMigration 및 NativeStore.Tests를 Release로 빌드하세요.'
}
New-Item -ItemType Directory -Path $targetDirectory -Force | Out-Null
if ((Get-Item -LiteralPath $targetDirectory).Attributes.HasFlag([IO.FileAttributes]::ReparsePoint)) {
    throw '연결된 대상 폴더는 사용할 수 없습니다.'
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$sourceCopy = Join-Path $targetDirectory "electron-source-$stamp-$([guid]::NewGuid().ToString('N')).json"
$stage = Join-Path $targetDirectory "live-pulse.prepare-$([guid]::NewGuid().ToString('N')).sqlite"
Copy-Item -LiteralPath $source -Destination $sourceCopy -ErrorAction Stop
if ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -ne
    (Get-FileHash -LiteralPath $sourceCopy -Algorithm SHA256).Hash) {
    throw "원본 복사본의 해시가 다릅니다. 중단했습니다: $sourceCopy"
}

& $Dotnet $migration --import $sourceCopy $stage
if ($LASTEXITCODE -ne 0) { throw "데이터 이전이 실패했습니다. 원본 복사본: $sourceCopy" }
& $Dotnet $migration --verify $sourceCopy $stage
if ($LASTEXITCODE -ne 0) { throw "데이터 검증이 실패했습니다. 원본 복사본: $sourceCopy" }
& $Dotnet $storeTest --backup-probe $sourceCopy $stage
if ($LASTEXITCODE -ne 0) { throw "첫 백업 검증이 실패했습니다. 원본 복사본: $sourceCopy" }

Move-Item -LiteralPath ($stage + '.bak.1') -Destination ($targetDatabase + '.bak.1') -ErrorAction Stop
Move-Item -LiteralPath $stage -Destination $targetDatabase -ErrorAction Stop
Write-Output "PERSONAL_DATA_READY database=$targetDatabase sourceCopy=$sourceCopy"
