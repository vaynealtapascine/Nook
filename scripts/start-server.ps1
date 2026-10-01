param([switch]$Open)

$ErrorActionPreference = 'Stop'
$nookRoot = Split-Path -Parent $PSScriptRoot
$nookData = if ($env:NOOK_DATA_DIR) { $env:NOOK_DATA_DIR } else { Join-Path $nookRoot '.nook-data' }
$nookPort = if ($env:PORT) { [int]$env:PORT } else { 4177 }
$nookUrl = "http://127.0.0.1:$nookPort"

try {
    $nookStatus = Invoke-RestMethod "$nookUrl/api/status" -TimeoutSec 3
    if ($nookStatus.app -eq 'webweave-nook' -and $nookStatus.version -ge 3) {
        Write-Output "Nook is already running at $nookUrl"
        if ($Open) { Start-Process $nookUrl }
        exit 0
    }
} catch {}

$nookNode = (Get-Command node -ErrorAction Stop).Source
New-Item -ItemType Directory -Path $nookData -Force | Out-Null
$nookProcess = Start-Process -FilePath $nookNode -ArgumentList 'server.js' `
    -WorkingDirectory $nookRoot -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $nookData 'server.log') `
    -RedirectStandardError (Join-Path $nookData 'server-error.log')
for ($nookAttempt = 0; $nookAttempt -lt 15; $nookAttempt++) {
    Start-Sleep -Milliseconds 300
    $nookProcess.Refresh()
    if ($nookProcess.HasExited) {
        throw "Nook could not start. Read $(Join-Path $nookData 'server-error.log')."
    }
    try {
        $nookStatus = Invoke-RestMethod "$nookUrl/api/status" -TimeoutSec 2
        if ($nookStatus.app -eq 'webweave-nook' -and $nookStatus.version -ge 3) {
            Write-Output "Nook is running at $nookUrl (process $($nookProcess.Id))."
            if ($Open) { Start-Process $nookUrl }
            exit 0
        }
    } catch {}
}
throw "Nook did not become ready. Read $(Join-Path $nookData 'server-error.log')."
