# Replaces only the external Task Scheduler COM object. The production script
# below still resolves the real current-user identity and makes every decision.
$script:task = [pscustomobject]@{
    State = $testState
    Definition = [pscustomobject]@{
        Principal = [pscustomobject]@{
            UserId = if ($testForeign) { 'S-1-5-18' } elseif ($testAccountName) {
                [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
            } else {
                [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
            }
            RunLevel = $testRunLevel
            LogonType = $testLogonType
        }
    }
}
$script:task | Add-Member -MemberType ScriptMethod -Name Run -Value {
    param($arguments)
    [System.IO.File]::WriteAllText($testEventFile, 'run')
}
$script:task | Add-Member -MemberType ScriptMethod -Name Stop -Value {
    param($flags)
    if ($flags -ne 0) { throw 'Unexpected stop flags' }
    [System.IO.File]::WriteAllText($testEventFile, 'stop')
}
$script:folder = [pscustomobject]@{}
$script:folder | Add-Member -MemberType ScriptMethod -Name GetTask -Value {
    param($name)
    if ($name -ne 'EmulatorContentServer') { throw 'Wrong task' }
    if ($testMissing) {
        throw [System.Runtime.InteropServices.COMException]::new(
            'File not found', -2147024894)
    }
    return $script:task
}
$script:scheduler = [pscustomobject]@{}
$script:scheduler | Add-Member -MemberType ScriptMethod -Name Connect -Value {}
$script:scheduler | Add-Member -MemberType ScriptMethod -Name GetFolder -Value {
    param($path)
    if ($path -ne '\') { throw 'Wrong task folder' }
    return $script:folder
}
function New-Object {
    param([string]$ComObject)
    if ($ComObject -ne 'Schedule.Service') { throw 'Unexpected COM object' }
    return $script:scheduler
}
