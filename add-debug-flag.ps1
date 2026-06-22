# Finds the Edge shortcut on the taskbar/desktop and adds --remote-debugging-port=9222
# Run once as Administrator: right-click -> Run with PowerShell

$flag = "--remote-debugging-port=9222"

$locations = @(
    "$env:APPDATA\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\Microsoft Edge.lnk",
    "$env:USERPROFILE\Desktop\Microsoft Edge.lnk",
    "C:\ProgramData\Microsoft\Windows\Start Menu\Programs\Microsoft Edge.lnk",
    "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Microsoft Edge.lnk"
)

$wsh = New-Object -ComObject WScript.Shell
$patched = 0

foreach ($loc in $locations) {
    if (Test-Path $loc) {
        $sc = $wsh.CreateShortcut($loc)
        if ($sc.Arguments -notlike "*remote-debugging-port*") {
            $sc.Arguments = $flag
            $sc.Save()
            Write-Host "Patched: $loc"
            $patched++
        } else {
            Write-Host "Already has flag: $loc"
            $patched++
        }
    }
}

if ($patched -eq 0) {
    Write-Host "No Edge shortcut found in standard locations."
    Write-Host "Use launch-edge.bat instead (in this folder)."
} else {
    Write-Host ""
    Write-Host "Done. Close Edge and reopen it from the shortcut."
}
