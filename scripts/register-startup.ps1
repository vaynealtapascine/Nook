$ErrorActionPreference = 'Stop'
$nookRoot = Split-Path -Parent $PSScriptRoot
$nookUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$nookScript = Join-Path $PSScriptRoot 'start-server.ps1'
$nookPowerShell = (Get-Command powershell.exe).Source
$nookAction = New-ScheduledTaskAction -Execute $nookPowerShell `
    -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$nookScript`"" `
    -WorkingDirectory $nookRoot
$nookTrigger = New-ScheduledTaskTrigger -AtLogOn -User $nookUser
$nookPrincipal = New-ScheduledTaskPrincipal -UserId $nookUser -LogonType Interactive -RunLevel Limited
$nookSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 2)
Register-ScheduledTask -TaskName 'Webweave Nook' -Action $nookAction -Trigger $nookTrigger `
    -Principal $nookPrincipal -Settings $nookSettings `
    -Description 'Serve the on-device Webweave Nook collection after sign-in.' -Force | Out-Null
Write-Output 'Webweave Nook will start in the background after Windows sign-in.'
