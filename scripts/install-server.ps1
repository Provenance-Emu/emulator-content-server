param(
    [ValidateSet('nightly', 'release')][string]$Channel,
    [ValidateSet('server', 'both')][string]$Components
)

$ErrorActionPreference = 'Stop'
$repo = 'Provenance-Emu/emulator-content-server'
$api = "https://api.github.com/repos/$repo/releases"
$downloads = "https://github.com/$repo/releases/download"
$origin = 'http://127.0.0.1:8473'
$task = 'EmulatorContentServer'
if ($env:OS -ne 'Windows_NT' -or [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64') {
    throw 'This installer supports Windows x64.'
}
$base = Join-Path $env:LOCALAPPDATA 'Emulation Server'
$data = Join-Path $base 'data'
$interactiveChannel = !$Channel
if (!$Channel) {
    switch (Read-Host 'Install from [1] Nightly or [2] Release? [1]') {
        ''  { $Channel = 'nightly' }
        '1' { $Channel = 'nightly' }
        '2' { $Channel = 'release' }
        default { throw 'Choose 1 or 2.' }
    }
}

function Assert-NoService {
    if (Get-ScheduledTask -TaskName $task -TaskPath '\' -ErrorAction SilentlyContinue) {
        throw 'A login service already exists. Use it or its update settings.'
    }
}

function Find-Package {
    $endpoint = if ($Channel -eq 'nightly') { "$api/tags/nightly" } else { "${api}?per_page=100" }
    $releases = Invoke-RestMethod -Uri $endpoint -TimeoutSec 30
    foreach ($release in $releases) {
        if ($release.draft) { continue }
        $tag = $release.tag_name
        if ($Channel -eq 'nightly' -and $tag -cne 'nightly') { continue }
        if ($Channel -eq 'release' -and $tag -cnotmatch '^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$') { continue }
        $name = 'Emulation-Server-' + ($tag -creplace '^v', '') + '-windows-x64'
        $server = @($release.assets | Where-Object { $_.name -ceq "$name.zip" })
        if ($server.Count -ne 1) { continue }
        $desktop = @($release.assets | Where-Object { $_.name -ceq "$name.msi" })
        return @{ Tag = $tag; Name = $name; Server = $server[0]; Desktop = $desktop }
    }
}

function Get-VerifiedAsset($Asset) {
    if ($Asset.size -le 0 -or $Asset.size -gt 512MB -or $Asset.digest -cnotmatch '^sha256:[a-f0-9]{64}$') {
        throw "Could not verify the download metadata for $($Asset.name)."
    }
    $file = Join-Path $scratch $Asset.name
    # curl.exe is included in Windows and can reject an oversized download.
    & curl.exe -q -fsSL --proto '=https' --proto-redir '=https' --connect-timeout 15 --max-time 300 `
        --max-filesize $Asset.size -o $file "$downloads/$($package.Tag)/$($Asset.name)"
    if ($LASTEXITCODE -ne 0) { throw "Could not download $($Asset.name)." }
    if ((Get-Item -LiteralPath $file).Length -ne $Asset.size -or
        (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -cne $Asset.digest.Substring(7)) {
        throw "Checksum mismatch for $($Asset.name). Try again shortly."
    }
    return $file
}

Assert-NoService
$package = Find-Package
if (!$package -and $Channel -eq 'release' -and $interactiveChannel) {
    if ((Read-Host 'No tagged server package is available for this system. Install Nightly? [y/N]') -ine 'y') { return }
    $Channel = 'nightly'
    $package = Find-Package
}
if (!$package) { throw "No $Channel server package is available for this system." }
$desktop = $false
if ($package.Desktop.Count -eq 1) {
    $desktop = $Components -eq 'both' -or
        (!$Components -and (Read-Host 'Install the server and the desktop app? [y/N]') -ieq 'y')
} elseif ($Components -eq 'both') {
    throw 'A desktop app is unavailable for this release.'
}

$launchers = Join-Path $base 'launchers'
$null = New-Item -ItemType Directory -Path $launchers -Force
$lock = New-Item -ItemType Directory -Path (Join-Path $base '.installer-lock')
$id = [guid]::NewGuid().ToString('N')
$scratch = Join-Path $launchers ".install-$id"
try {
    $null = New-Item -ItemType Directory -Path $scratch
    Write-Host "Downloading $($package.Tag) server…"
    $archive = Get-VerifiedAsset $package.Server
    Expand-Archive -LiteralPath $archive -DestinationPath $scratch
    $extracted = Join-Path $scratch $package.Name
    if (!(Test-Path -LiteralPath (Join-Path $extracted 'ecs.cmd') -PathType Leaf)) {
        throw 'The downloaded package is missing its launcher.'
    }
    Assert-NoService
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 8473)
    try { $listener.Start() } catch { throw "Port 8473 is already in use. Open $origin/ui/ to check the existing server." }
    finally { $listener.Stop() }
    $launcher = Join-Path $launchers "$($package.Name)-$id"
    Move-Item -LiteralPath $extracted -Destination $launcher
    $ecs = Join-Path $launcher 'ecs.cmd'
    & $ecs init --data $data | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not initialize the local catalog.' }
    & $ecs service install --data $data --host 127.0.0.1
    if ($LASTEXITCODE -ne 0) { throw 'Could not register the login service.' }
    Start-ScheduledTask -TaskName $task -TaskPath '\'
    $healthy = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        try {
            if ((Invoke-RestMethod -Uri "$origin/health" -TimeoutSec 1).ok) {
                $healthy = $true
                break
            }
        } catch {}
        Start-Sleep -Seconds 1
    }
    if (!$healthy) { throw "The login service was registered, but the server has not answered. Check $data\logs\ecs.log." }
    Write-Host "`nServer is running. Open $origin/ui/"
    if (Test-Path -LiteralPath (Join-Path $data 'bootstrap.token')) {
        Write-Host "Use the one-time setup code from $data\bootstrap.token to create the owner account."
    }
    if ($desktop) {
        Write-Host 'Downloading the desktop app…'
        $msi = Get-VerifiedAsset $package.Desktop[0]
        $installer = Start-Process -FilePath msiexec.exe -ArgumentList '/i', ('"{0}"' -f $msi) -Wait -PassThru
        if ($installer.ExitCode -notin @(0, 1641, 3010)) { throw "The desktop installer returned $($installer.ExitCode)." }
    }
} finally {
    if (Test-Path -LiteralPath $scratch) { Remove-Item -LiteralPath $scratch -Recurse -Force }
    Remove-Item -LiteralPath $lock.FullName
}
