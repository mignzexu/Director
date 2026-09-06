# Shared ACL helpers for the Agent Platform Windows sandbox.
# Dot-sourced by windows-appcontainer-launcher.ps1 and cleanup-legacy-acl.ps1.
#
# Sandboxing model (see README.md):
#   - one stable AppContainer SID per platform profile (default agent-platform-main)
#   - truth from live enumeration: every rule is verified against the actual
#     DACL before use; there is NO marker/flag file for provision state
#     (sandbox-runtime principle — status always reflects the live system)
#   - grants:
#       * PATH dirs outside system/Program Files: read+execute (inherited)
#       * ancestors of those dirs + drive roots: traverse only (not inherited)
#       * workspace + platform tmp root: modify (inherited)
#       * protected paths: deny write (.git/.opencode) or deny read+write (others)
#   - Windows grants C:\Windows and C:\Program Files read+execute to
#     ALL APPLICATION PACKAGES by default, so they are never touched.

$rightsTraverse = 0x00000020 -bor 0x00000080
$rightsReadExecute = 0x000200A9
$rightsModify = 0x000301BF
$rightsDenyWrite = 0x00000116 -bor 0x00000002 -bor 0x00000004 -bor 0x00010000 -bor 0x00000040 -bor 0x00040000 -bor 0x00080000
$rightsDenyReadExtra = 0x00000001 -bor 0x00000008 -bor 0x00000080 -bor 0x00020000

function Get-NormalizedPath([string]$Path) {
    return [System.IO.Path]::GetFullPath($Path)
}

function Get-IsUnderRoot([string]$Path, [string]$Root) {
    if ([string]::IsNullOrEmpty($Root)) {
        return $false
    }
    return ($Path -eq $Root -or $Path.StartsWith($Root + [System.IO.Path]::DirectorySeparatorChar))
}

function Test-PathUnderAny([string]$Path, [string[]]$Roots) {
    foreach ($root in $Roots) {
        if (Get-IsUnderRoot $Path $root) {
            return $true
        }
    }
    return $false
}

function Get-AncestorsUpToRoot([string]$Path) {
    $ancestors = @()
    $drive = [System.IO.Path]::GetPathRoot($Path)
    if ([string]::IsNullOrEmpty($drive)) {
        return @()
    }
    $current = [System.IO.Path]::GetDirectoryName($Path)
    while (-not [string]::IsNullOrEmpty($current) -and $current.Length -gt $drive.Length) {
        $ancestors += $current
        $current = [System.IO.Path]::GetDirectoryName($current)
    }
    return @($ancestors | Select-Object -Unique)
}

function Get-PathEntries {
    return @(([string]$env:PATH).Split(';'))
}

function Get-SandboxInheritance([bool]$Inherit, [bool]$IsContainer) {
    if ($Inherit -and $IsContainer) {
        return [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
    }
    return [System.Security.AccessControl.InheritanceFlags]::None
}

# Sole rule matcher: exact (SID, type, rights, inheritance) over EXPLICIT rules.
# Both Test-SandboxRule (live verification) and Add-SandboxRule (idempotent
# apply / force re-apply) go through here so they can never disagree.
#
# RIGHTS COMPARISON IS SYNCHRONIZE-INSENSITIVE: Windows normalizes stored
# file rights to include SYNCHRONIZE (0x100000) — we write 0x301BF, the DACL
# reads back 0x1301BF. An exact numeric compare never matches, which caused
# infinite repair loops and duplicate-ACE accumulation.
function Find-SandboxRule($Acl, [string]$Sid, [string]$Type, [long]$RightsValue, $Inheritance) {
    $typeValue = [System.Security.AccessControl.AccessControlType]$Type
    $expected = $RightsValue -bor 0x100000
    foreach ($rule in $Acl.GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier])) {
        if (
            $rule.IdentityReference.Value -eq $Sid -and
            $rule.AccessControlType -eq $typeValue -and
            (([long]$rule.FileSystemRights -bor 0x100000) -eq $expected) -and
            $rule.InheritanceFlags -eq $Inheritance
        ) {
            return $rule
        }
    }
    return $null
}

# Live presence check — reads the actual DACL, no cached state.
function Test-SandboxRule([string]$Path, [string]$Sid, [string]$Type, [long]$RightsValue, [bool]$Inherit) {
    if (-not (Test-Path -LiteralPath $Path)) {
        return $false
    }
    try {
        $item = Get-Item -LiteralPath $Path -Force
        $acl = Get-Acl -LiteralPath $Path
    } catch {
        return $false
    }
    $inheritance = Get-SandboxInheritance $Inherit ([bool]$item.PSIsContainer)
    return ($null -ne (Find-SandboxRule $acl $Sid $Type $RightsValue $inheritance))
}

function Add-SandboxRule {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [Parameter(Mandatory = $true)]
        [string]$Sid,
        [Parameter(Mandatory = $true)]
        [ValidateSet("Allow", "Deny")]
        [string]$Type,
        [Parameter(Mandatory = $true)]
        [long]$RightsValue,
        [Parameter(Mandatory = $true)]
        [bool]$Inherit,
        # Force (default) removes a matching rule and re-applies it, which also
        # re-triggers inheritance propagation. -OnlyIfMissing skips the write
        # entirely when the rule is already present (cheap per-invocation path).
        [switch]$OnlyIfMissing
    )
    if (-not (Test-Path -LiteralPath $Path)) {
        return
    }
    $item = Get-Item -LiteralPath $Path -Force
    $acl = Get-Acl -LiteralPath $Path
    $rights = [System.Security.AccessControl.FileSystemRights]$RightsValue
    $typeValue = [System.Security.AccessControl.AccessControlType]$Type
    $inheritance = Get-SandboxInheritance $Inherit ([bool]$item.PSIsContainer)
    # Remove EVERY matching instance (historic duplicate accumulation is
    # cleaned up by this loop), then re-apply exactly one.
    while ($true) {
        $existing = Find-SandboxRule $acl $Sid $Type $RightsValue $inheritance
        if ($null -eq $existing) {
            break
        }
        if ($OnlyIfMissing) {
            return
        }
        $acl.RemoveAccessRuleSpecific($existing) | Out-Null
    }
    $identity = New-Object System.Security.Principal.SecurityIdentifier($Sid)
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
        $identity, $rights, $inheritance, [System.Security.AccessControl.PropagationFlags]::None, $typeValue)
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $Path -AclObject $acl
}

function Remove-SidAccess([string]$Path, [string[]]$Sids) {
    if (-not (Test-Path -LiteralPath $Path) -or $Sids.Count -eq 0) {
        return
    }
    try {
        $acl = Get-Acl -LiteralPath $Path
        $changed = $false
        foreach ($rule in @($acl.GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier]))) {
            if ($Sids -contains $rule.IdentityReference.Value) {
                $acl.RemoveAccessRuleSpecific($rule) | Out-Null
                $changed = $true
            }
        }
        if ($changed) {
            Set-Acl -LiteralPath $Path -AclObject $acl
        }
    } catch {
        Write-Warning "legacy ACL cleanup skipped for ${Path}: $($_.Exception.Message)"
    }
}

# Protected-path policy — grant-absence model (sandbox-runtime design).
#
# Deny ACEs proved unreliable against AppContainer tokens in this environment
# (a full-control explicit deny for the exact package SID was traversed by a
# containerized write). Enforcement therefore NEVER relies on deny ordering:
#
#   Blocked  — the protected tree carries NO ACE for the sandbox SID and its
#              DACL is protected (inheritance from the workspace grant cut).
#              AppContainer default-deny does the rest.
#   ReadOnly — same isolation, plus a single ReadAndExecute grant (.git):
#              writes are absent-by-construction, not denied-by-order.
function Set-SandboxPathPolicy {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [Parameter(Mandatory = $true)]
        [string]$Sid,
        [Parameter(Mandatory = $true)]
        [ValidateSet("Blocked", "ReadOnly")]
        [string]$Mode
    )
    if (-not (Test-Path -LiteralPath $Path)) {
        return
    }
    # Mutations go through icacls (the OS's own ACL editor) — the .NET
    # FileSystemSecurity Remove* APIs silently no-op on inherited and even
    # freshly-materialized rules in ways that cannot be relied upon.
    # /T applies across the subtree; /c continues past individual failures.
    $sidArg = "*$Sid"
    $null = icacls.exe $Path /inheritance:d /c /q 2>&1
    $null = icacls.exe $Path /remove:g $sidArg /T /c /q 2>&1
    $null = icacls.exe $Path /remove:d $sidArg /T /c /q 2>&1
    if ($Mode -eq "ReadOnly") {
        $null = icacls.exe $Path /grant "${sidArg}:(OI)(CI)RX" /T /c /q 2>&1
    }
}

function Test-SandboxPathPolicy {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [Parameter(Mandatory = $true)]
        [string]$Sid,
        [Parameter(Mandatory = $true)]
        [ValidateSet("Blocked", "ReadOnly")]
        [string]$Mode
    )
    if (-not (Test-Path -LiteralPath $Path)) {
        return $true
    }
    try {
        $acl = Get-Acl -LiteralPath $Path
    } catch {
        return $false
    }
    if (-not $acl.AreAccessRulesProtected) {
        return $false
    }
    $rxExpected = [long]$rightsReadExecute -bor 0x100000
    $hasReadOnly = $false
    foreach ($rule in $acl.GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier])) {
        if ($rule.IdentityReference.Value -ne $Sid) {
            continue
        }
        if (
            $rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
            (([long]$rule.FileSystemRights -bor 0x100000) -eq $rxExpected)
        ) {
            $hasReadOnly = $true
            continue
        }
        return $false
    }
    if ($Mode -eq "ReadOnly") {
        return $hasReadOnly
    }
    return (-not $hasReadOnly)
}
