# One-time legacy sandbox decontamination for the Agent Platform.
#
# The pre-2.0 launcher created a random AppContainer profile (agent-platform-<guid>)
# per invocation and granted recursive ACLs on PATH ancestor directories up to the
# drive roots. When a run was force-killed, its ACL edits and profile leaked. This
# script removes:
#   1. the leaked AppContainer profiles themselves, and
#   2. every ACE belonging to those profiles from the directories the old launcher
#      touched (PATH dirs + ancestors, workspace, tmp, protected paths, and
#      optionally the drive roots).
#
# Usage (PowerShell, as the same user that runs OpenCode):
#   .\cleanup-legacy-acl.ps1                          # high-traffic roots only (fast)
#   .\cleanup-legacy-acl.ps1 -IncludeDriveRoots       # full decontamination (very slow: rewrites the
#                                                     # security descriptor of every file on the drives)
#
# Note: dead-SID ACEs are inert (the profile no longer exists, so they grant and
# deny nothing). Running this script is hygiene, not a security fix.

[CmdletBinding()]
param(
    [switch]$IncludeDriveRoots
)

$ErrorActionPreference = "Continue"
$profilePrefix = "agent-platform-*"
$keepProfile = "agent-platform-main"

. (Join-Path $PSScriptRoot "_acl-lib.ps1")

$csPath = Join-Path $PSScriptRoot "windows-appcontainer-native.cs"
Add-Type -TypeDefinition (Get-Content -LiteralPath $csPath -Raw) -Language CSharp

# --- collect legacy profile names and their SIDs -------------------------------
$storage = "HKCU:\Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppContainer\Storage"
$legacyNames = @()
if (Test-Path -LiteralPath $storage) {
    foreach ($key in (Get-ChildItem -LiteralPath $storage)) {
        $name = $key.PSChildName
        if ($name -like $profilePrefix -and $name -ne $keepProfile) {
            $legacyNames += $name
        }
    }
}
Write-Host "Found $($legacyNames.Count) legacy profile(s)."

$legacySids = @()
foreach ($name in $legacyNames) {
    try {
        $sid = [AgentPlatform.Runtime.NativeLauncher]::DeriveSidString($name)
        if ($legacySids -notcontains $sid) {
            $legacySids += $sid
        }
        Write-Host "  $name -> $sid"
    } catch {
        Write-Warning "cannot derive SID for legacy profile ${name}: $($_.Exception.Message)"
    }
}

# --- build the list of roots whose trees must be swept --------------------------
$roots = @()
foreach ($entry in (Get-PathEntries)) {
    if ([string]::IsNullOrWhiteSpace($entry)) {
        continue
    }
    try {
        $pathEntry = Get-NormalizedPath $entry.Trim()
    } catch {
        continue
    }
    if (-not (Test-Path -LiteralPath $pathEntry -PathType Container)) {
        continue
    }
    $roots += $pathEntry
    $roots += Get-AncestorsUpToRoot $pathEntry
    if ($IncludeDriveRoots) {
        $roots += [System.IO.Path]::GetPathRoot($pathEntry)
    }
}
foreach ($extra in @((Get-Location).Path, $env:TEMP)) {
    if (-not [string]::IsNullOrWhiteSpace($extra)) {
        try {
            $roots += Get-NormalizedPath $extra
        } catch {
        }
    }
}
$roots = @($roots | Select-Object -Unique)

# --- remove every ACE that belongs to a legacy SID ------------------------------
foreach ($root in $roots) {
    Remove-SidAccess $root $legacySids
}

# --- delete the leaked profiles --------------------------------------------------
foreach ($name in $legacyNames) {
    try {
        [AgentPlatform.Runtime.NativeLauncher]::DeleteProfile($name)
        Write-Host "deleted profile: $name"
    } catch {
        Write-Warning "could not delete profile ${name}: $($_.Exception.Message)"
    }
}

Write-Host "Legacy cleanup finished."
