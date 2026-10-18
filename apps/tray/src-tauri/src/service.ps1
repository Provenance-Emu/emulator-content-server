param([ValidateSet('status', 'start', 'stop')][string]$Action)
$ErrorActionPreference = 'Stop'
try {
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    if ($identity.IsSystem) { exit 1 }
    $scheduler = New-Object -ComObject 'Schedule.Service'
    $scheduler.Connect()
    try {
        $task = $scheduler.GetFolder('\').GetTask('EmulatorContentServer')
    } catch {
        $cause = $_.Exception
        while ($cause.InnerException) { $cause = $cause.InnerException }
        if ($cause.HResult -eq -2147024894) {
            if ($Action -eq 'status') { Write-Output 'absent'; exit 0 }
        }
        exit 1
    }
    $owner = $task.Definition.Principal.UserId
    if ($owner -notmatch '^S-1-') {
        $owner = ([System.Security.Principal.NTAccount]::new($owner)).Translate(
            [System.Security.Principal.SecurityIdentifier]).Value
    }
    # A fixed task name alone does not prove this is the current user's task.
    if ($owner -ne $identity.User.Value -or
        $task.Definition.Principal.RunLevel -ne 0 -or
        $task.Definition.Principal.LogonType -ne 3) { exit 1 }
    if ($Action -eq 'start') {
        if ($task.State -eq 4) { Write-Output 'running'; exit 0 }
        $task.Run($null) | Out-Null
        Write-Output 'starting'
    } elseif ($Action -eq 'stop') {
        if ($task.State -eq 4 -or $task.State -eq 2) { $task.Stop(0) }
        Write-Output 'stopping'
    } else {
        switch ($task.State) {
            2 { Write-Output 'starting' }
            3 { Write-Output 'stopped' }
            4 { Write-Output 'running' }
            default { exit 1 }
        }
    }
} catch {
    # Task definitions and exception messages can contain command arguments.
    # Only fixed status values ever cross back into the webview.
    exit 1
}
