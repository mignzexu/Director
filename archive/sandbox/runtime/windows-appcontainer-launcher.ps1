# Agent Platform sandbox launcher.
#
# Called per shell.exec with a sandbox request (see README.md for the schema).
# Responsibilities:
#   1. load the compiled native launcher (cached dll, fallback Add-Type)
#   2. ensure the stable AppContainer profile exists
#   3. LIVE provision: verify every desired ACL rule against the actual DACL,
#      re-apply only what is missing (truth-from-source, no marker file)
#   4. after any repair, run behavioral probes inside the sandbox and
#      FAIL CLOSED if the probes contradict the policy
#   5. run the command inside the AppContainer via the native CreateProcess path
#
# Error channel (dual, backward compatible):
#   AGENT_PLATFORM_SANDBOX_ERROR: [code] message     <- legacy human line
#   {"svc":"agent-platform-sandbox","code":...}      <- structured JSON line
#
# Exit codes: 0.. = command exit; 124 = launcher self-timeout; 125 = sandbox error.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$RequestFile
)

$ErrorActionPreference = "Stop"
$exitTimeout = 124
$exitSandboxError = 125
$commandExitCode = $exitSandboxError
$policyVersion = 3

. (Join-Path $PSScriptRoot "_acl-lib.ps1")

$script:provisionLogPath = $null
$script:Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Write-ProvisionLog([string]$Message) {
    if ($null -eq $script:provisionLogPath) {
        return
    }
    try {
        $line = (Get-Date).ToUniversalTime().ToString("o") + " " + $Message
        Add-Content -LiteralPath $script:provisionLogPath -Value $line -Encoding ASCII -ErrorAction SilentlyContinue
    } catch {
    }
}

function Write-SandboxError([string]$Code, [string]$Message) {
    [Console]::Error.WriteLine("AGENT_PLATFORM_SANDBOX_ERROR: [$Code] $Message")
    $payload = [PSCustomObject]@{
        svc = "agent-extensions-sandbox"
        code = $Code
        message = $Message
        ts = (Get-Date).ToUniversalTime().ToString("o")
    }
    [Console]::Error.WriteLine(($payload | ConvertTo-Json -Compress))
    Write-ProvisionLog ("error[" + $Code + "]: " + $Message)
}

function Get-NativeType {
    $csPath = Join-Path $PSScriptRoot "windows-appcontainer-native.cs"
    $existing = "AgentPlatform.Runtime.NativeLauncher" -as [type]
    if ($null -ne $existing) {
        return $existing
    }
    if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
        $env:LOCALAPPDATA = [System.Environment]::GetFolderPath("LocalApplicationData")
    }
    try {
        $cacheDir = Join-Path $env:LOCALAPPDATA "agent-platform\native-cache"
        $dllPath = Join-Path $cacheDir "AgentPlatformNative.dll"
        $hashPath = Join-Path $cacheDir "source.sha256"
        $sourceHash = (Get-FileHash -LiteralPath $csPath -Algorithm SHA256).Hash
        $cached = $false
        if ((Test-Path -LiteralPath $dllPath) -and (Test-Path -LiteralPath $hashPath)) {
            $cachedHash = (Get-Content -LiteralPath $hashPath -Raw -ErrorAction SilentlyContinue)
            $cached = ($null -ne $cachedHash) -and ($cachedHash.Trim() -eq $sourceHash)
        }
        if (-not $cached) {
            $cscCandidates = @(
                (Join-Path $env:SystemRoot "Microsoft.NET\Framework64\v4.0.30319\csc.exe"),
                (Join-Path $env:SystemRoot "Microsoft.NET\Framework\v4.0.30319\csc.exe")
            )
            $csc = $null
            foreach ($candidate in $cscCandidates) {
                if (Test-Path -LiteralPath $candidate) {
                    $csc = $candidate
                    break
                }
            }
            if ($null -eq $csc) {
                throw "project sandbox requires .NET Framework csc.exe; none was found"
            }
            New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null
            $tempDll = Join-Path $cacheDir "AgentPlatformNative.$PID.new.dll"
            & $csc "/nologo" "/target:library" "/out:$tempDll" "/r:System.dll" "$csPath"
            if ($LASTEXITCODE -ne 0) {
                Remove-Item -LiteralPath $tempDll -Force -ErrorAction SilentlyContinue
                throw "csc.exe failed to compile the sandbox native launcher (exit $LASTEXITCODE)"
            }
            Move-Item -LiteralPath $tempDll -Destination $dllPath -Force
            Set-Content -LiteralPath $hashPath -Value $sourceHash -Encoding ASCII
        }
        [System.Reflection.Assembly]::LoadFrom($dllPath) | Out-Null
    } catch {
        Write-SandboxError "native_unavailable" ("native dll cache unavailable, compiling in memory: " + $_.Exception.Message)
        try {
            Add-Type -TypeDefinition (Get-Content -LiteralPath $csPath -Raw) -Language CSharp
        } catch {
            throw
        }
    }
    $type = "AgentPlatform.Runtime.NativeLauncher" -as [type]
    if ($null -eq $type) {
        throw [Management.Automation.RuntimeException]::new("sandbox native launcher type AgentPlatform.Runtime.NativeLauncher is not available")
    }
    return $type
}

function Get-UserChain {
    $chain = @()
    foreach ($name in @("USERPROFILE", "APPDATA", "LOCALAPPDATA", "HOME")) {
        $value = [System.Environment]::GetEnvironmentVariable($name, "Process")
        if (-not [string]::IsNullOrWhiteSpace($value)) {
            $chain += Get-NormalizedPath $value
        }
    }
    foreach ($folder in @(
        [System.Environment]::GetFolderPath("UserProfile"),
        [System.Environment]::GetFolderPath("ApplicationData"),
        [System.Environment]::GetFolderPath("LocalApplicationData"))) {
        if (-not [string]::IsNullOrEmpty($folder)) {
            $chain += Get-NormalizedPath $folder
        }
    }
    return @($chain | Select-Object -Unique)
}

function Test-LauncherShell([string]$Comspec) {
    # The native launcher hardcodes cmd flags (cmd /d /s /c call file.cmd), so
    # the comspec must be an absolute, existing cmd.exe. No silent fallback.
    if ([string]::IsNullOrWhiteSpace($Comspec)) {
        return "comspec is empty"
    }
    if (-not [System.IO.Path]::IsPathRooted($Comspec)) {
        return "comspec must be an absolute path (got '$Comspec')"
    }
    if (-not (Test-Path -LiteralPath $Comspec -PathType Leaf)) {
        return "comspec does not exist: '$Comspec'"
    }
    $base = [System.IO.Path]::GetFileName($Comspec).ToLowerInvariant()
    if ($base -ne "cmd.exe") {
        return "the sandbox executes commands through cmd.exe (got '$Comspec'); POSIX shells change command semantics and are rejected"
    }
    return $null
}

# Desired machine-level grant set as declarative rule objects. The live
# provisioner verifies each against the real DACL and repairs only the missing.
function Get-MachineGrantSet([string]$Workspace, [string]$TemporaryDirectory, [string[]]$SkipPrefixes) {
    # System roots already carry ALL APPLICATION PACKAGES read+execute ACEs by
    # default; granting them again would trigger full-subtree inheritance
    # propagation for no benefit.
    $defaultCoveredPrefixes = @()
    foreach ($name in @("SystemRoot", "ProgramFiles", "ProgramFiles(x86)")) {
        $value = [System.Environment]::GetEnvironmentVariable($name, "Process")
        if (-not [string]::IsNullOrWhiteSpace($value)) {
            $defaultCoveredPrefixes += Get-NormalizedPath $value
        }
    }

    $grants = @()
    foreach ($entry in (Get-PathEntries)) {
        $pathEntry = $null
        if (-not [string]::IsNullOrWhiteSpace($entry)) {
            try { $pathEntry = Get-NormalizedPath $entry.Trim() } catch { $pathEntry = $null }
        }
        if ($null -eq $pathEntry -or -not (Test-Path -LiteralPath $pathEntry -PathType Container)) {
            continue
        }
        if (Test-PathUnderAny $pathEntry $SkipPrefixes) {
            continue
        }
        if (Test-PathUnderAny $pathEntry $defaultCoveredPrefixes) {
            continue
        }
        foreach ($ancestor in (Get-AncestorsUpToRoot $pathEntry)) {
            if (-not (Test-PathUnderAny $ancestor $SkipPrefixes)) {
                $grants += @{ Path = $ancestor; Type = "Allow"; Rights = [long]$rightsTraverse; Inherit = $false }
            }
        }
        $grants += @{ Path = $pathEntry; Type = "Allow"; Rights = [long]$rightsReadExecute; Inherit = $true }
    }

    $drives = @{}
    foreach ($root in @($Workspace, $TemporaryDirectory)) {
        $drive = [System.IO.Path]::GetPathRoot($root)
        if (-not [string]::IsNullOrEmpty($drive)) {
            $drives[$drive] = $true
        }
    }
    foreach ($drive in $drives.Keys) {
        $grants += @{ Path = $drive; Type = "Allow"; Rights = [long]$rightsTraverse; Inherit = $false }
    }

    $seen = @{}
    $unique = @()
    foreach ($grant in $grants) {
        $key = $grant.Path + "|" + $grant.Type + "|" + $grant.Rights + "|" + $grant.Inherit
        if (-not $seen.ContainsKey($key)) {
            $seen[$key] = $true
            $unique += $grant
        }
    }
    return $unique
}

# Live provision: verify every desired rule against the actual DACL, apply the
# missing ones. Returns the number of repairs performed.
function Invoke-LiveProvision([string]$Sid, [object[]]$DesiredRules) {
    $repaired = 0
    foreach ($rule in $DesiredRules) {
        if (-not (Test-SandboxRule $rule.Path $Sid $rule.Type $rule.Rights $rule.Inherit)) {
            Write-ProvisionLog ("repair: " + $rule.Type + " " + $rule.Rights + " inherit=" + $rule.Inherit + " -> " + $rule.Path)
            try {
                Add-SandboxRule $rule.Path $Sid $rule.Type $rule.Rights $rule.Inherit
            } catch {
                Write-SandboxError "provision_failed" ("failed to apply " + $rule.Type + " rule on " + $rule.Path + ": " + $_.Exception.Message)
                throw
            }
            $repaired++
        }
    }
    return $repaired
}

function Invoke-SandboxProbe(
    [string]$Profile,
    [string]$Comspec,
    [string]$Command,
    [string]$Cwd,
    [string[]]$EnvironmentEntries,
    [string]$TmpDir,
    [uint32]$TimeoutMs
) {
    $commandFile = Join-Path $TmpDir ("probe-" + [guid]::NewGuid().ToString("N") + ".cmd")
    $stdoutFile = Join-Path $TmpDir ("probe-" + [guid]::NewGuid().ToString("N") + ".out")
    $stderrFile = Join-Path $TmpDir ("probe-" + [guid]::NewGuid().ToString("N") + ".err")
    [System.IO.File]::WriteAllText($commandFile, "@echo off`r`n" + $Command + "`r`n", $script:Utf8NoBom)
    [System.IO.File]::WriteAllText($stdoutFile, "", $script:Utf8NoBom)
    [System.IO.File]::WriteAllText($stderrFile, "", $script:Utf8NoBom)
    $code = [AgentPlatform.Runtime.NativeLauncher]::Run($Profile, $Comspec, $commandFile, $stdoutFile, $stderrFile, $Cwd, $EnvironmentEntries, $TimeoutMs)
    $out = ""
    $err = ""
    if (Test-Path -LiteralPath $stdoutFile) { $out = [System.IO.File]::ReadAllText($stdoutFile, $script:Utf8NoBom) }
    if (Test-Path -LiteralPath $stderrFile) { $err = [System.IO.File]::ReadAllText($stderrFile, $script:Utf8NoBom) }
    return @{ Code = $code; Stdout = $out; Stderr = $err }
}

# Behavioral verification (sandbox-runtime verifyWindowsWfpEgress pattern):
# after ANY repair, prove the policy HOLDS by exercising it, not by trusting
# the ACL write. Any contradiction fails closed: the user command never runs.
function Invoke-BehavioralVerify(
    [string]$Profile,
    [string]$Sid,
    [string]$Comspec,
    [string]$Workspace,
    [string]$TemporaryDirectory,
    [string[]]$EnvironmentEntries,
    [string[]]$ProtectedAbsolutes
) {
    # probe 1: workspace write must succeed (if-exist is the ground truth;
    # cmd redirection failures do not reliably set a nonzero exit code)
    $marker = Join-Path $TemporaryDirectory ("verify-" + [guid]::NewGuid().ToString("N") + ".txt")
    $p1 = Invoke-SandboxProbe $Profile $Comspec ('echo ap-verify > "' + $marker + '" & if exist "' + $marker + '" (type "' + $marker + '") else (exit 1)') $Workspace $EnvironmentEntries $TemporaryDirectory 8000
    if ($p1.Code -ne 0 -or $p1.Stdout -notmatch "ap-verify") {
        return @{ Code = "verify_failed"; Message = "workspace write probe failed (exit=" + $p1.Code + "): " + ($p1.Stderr.Trim() -replace "\r?\n", "; ") }
    }
    Write-ProvisionLog "verify: workspace write ok"

    # probe 2: protected path must reject writes. Truth is judged HOST-side
    # (Test-Path after the probe): in-container `if exist` and cmd exit codes
    # are both unreliable under denied-enumeration conditions.
    if ($ProtectedAbsolutes.Count -gt 0) {
        $target = Join-Path $ProtectedAbsolutes[0] ("ap-verify-deny-" + [guid]::NewGuid().ToString("N") + ".txt")
        $p2 = Invoke-SandboxProbe $Profile $Comspec ('echo x > "' + $target + '"') $Workspace $EnvironmentEntries $TemporaryDirectory 8000
        $createdOnHost = Test-Path -LiteralPath $target
        Write-ProvisionLog ("verify: protected probe exit=" + $p2.Code + " hostFileExists=" + $createdOnHost + " stderr=" + ($p2.Stderr.Trim() -replace "\r?\n", "; "))
        if ($createdOnHost) {
            try { Remove-Item -LiteralPath $target -Force -ErrorAction SilentlyContinue } catch { }
            $aclDump = ""
            try { $aclDump = (Get-Acl -LiteralPath $ProtectedAbsolutes[0]).Sddl } catch { $aclDump = "unreadable: " + $_.Exception.Message }
            Write-ProvisionLog ("verify: DACL of " + $ProtectedAbsolutes[0] + " = " + $aclDump)
            Write-ProvisionLog ("verify: sandbox SID (profile " + $Profile + ") = " + $Sid)
            return @{
                Code = "protected_probe_violation"
                Message = "protection broken: write into protected path '" + $ProtectedAbsolutes[0] + "' succeeded inside the sandbox (probe exit=" + $p2.Code + ", stderr=" + ($p2.Stderr.Trim() -replace "\r?\n", "; ") + ")"
            }
        }
        Write-ProvisionLog "verify: protected-path deny ok"
    }

    # probe 3: network must be unreachable (no capabilities granted to the
    # AppContainer SID; a connected probe means the fence is absent)
    $p3 = Invoke-SandboxProbe $Profile $Comspec 'curl.exe -s -o NUL -m 3 https://example.com' $Workspace $EnvironmentEntries $TemporaryDirectory 10000
    if ($p3.Code -eq 0) {
        return @{ Code = "verify_network_open"; Message = "network fence is not active: the sandboxed probe connected to https://example.com" }
    }
    Write-ProvisionLog "verify: network fence ok"

    return $null
}

try {
    $request = Get-Content -LiteralPath $RequestFile -Raw | ConvertFrom-Json
    if ([int]$request.version -ne 2) {
        Write-SandboxError "request_unsupported" ("sandbox request version must be 2 (got " + $request.version + ")")
        exit $exitSandboxError
    }
    $profile = [string]$request.profile
    if ([string]::IsNullOrWhiteSpace($profile) -or $profile -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') {
        Write-SandboxError "profile_invalid" ("invalid AppContainer profile name: '$profile'")
        exit $exitSandboxError
    }

    $workspace = Get-NormalizedPath ([string]$request.workspace)
    $cwd = Get-NormalizedPath ([string]$request.cwd)

    if (-not (Test-Path -LiteralPath $workspace -PathType Container)) {
        Write-SandboxError "workspace_invalid" ("workspace is not a directory: $workspace")
        exit $exitSandboxError
    }
    if (-not (Test-Path -LiteralPath $cwd -PathType Container)) {
        Write-SandboxError "cwd_invalid" ("working directory is not a directory: $cwd")
        exit $exitSandboxError
    }
    $shellReason = Test-LauncherShell ([string]$request.comspec)
    if ($null -ne $shellReason) {
        Write-SandboxError "shell_invalid" $shellReason
        exit $exitSandboxError
    }

    # Per-invocation scratch lives inside the workspace so it inherits the
    # workspace grant automatically; nothing outside the workspace is touched.
    $workspaceTmpRoot = Get-NormalizedPath (Join-Path $workspace ".extensions\tmp")
    if (-not (Test-Path -LiteralPath $workspaceTmpRoot -PathType Container)) {
        [System.IO.Directory]::CreateDirectory($workspaceTmpRoot) | Out-Null
    }
    $temporaryDirectory = Get-NormalizedPath (Join-Path $workspaceTmpRoot ("exec-" + [guid]::NewGuid().ToString("N")))
    [System.IO.Directory]::CreateDirectory($temporaryDirectory) | Out-Null

    if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
        $env:LOCALAPPDATA = [System.Environment]::GetFolderPath("LocalApplicationData")
    }
    $cacheDir = Join-Path $env:LOCALAPPDATA "agent-platform\native-cache"
    $script:provisionLogPath = Join-Path $cacheDir "provision.log"
    Write-ProvisionLog "=== launcher run start (policy v$policyVersion) ==="

    $environmentEntries = @($request.environment.PSObject.Properties | ForEach-Object { "$($_.Name)=$($_.Value)" })
    $comspec = [string]$request.comspec

    try {
        $commandExitCode = $exitSandboxError
        $failClosed = $false

        # ---- inner shell normalization (single validation point; no silent fallback)
        $requestShell = [string]$request.shell
        if ([string]::IsNullOrWhiteSpace($requestShell)) {
            $requestShell = "cmd"
        }
        $requestShell = $requestShell.ToLowerInvariant()
        if ($requestShell -notin @("cmd", "powershell", "pwsh")) {
            Write-SandboxError "shell_invalid" ("shell must be 'cmd', 'powershell' or 'pwsh' (got '$requestShell')")
            $failClosed = $true
        }

        $commandFile = Join-Path $temporaryDirectory "command.cmd"
        $stdoutFile = Join-Path $temporaryDirectory "stdout.txt"
        $stderrFile = Join-Path $temporaryDirectory "stderr.txt"
        $utf8 = New-Object System.Text.UTF8Encoding($false)
        if (-not $failClosed) {
            if ($requestShell -eq "cmd") {
                # chcp 65001: cmd output must be UTF-8 — the OEM codepage
                # (GBK on CJK hosts) produced mojibake when read as UTF-8.
                [System.IO.File]::WriteAllText($commandFile, "@echo off`r`nchcp 65001>nul`r`n" + [string]$request.command + "`r`n", $utf8)
            } else {
                $scriptFile = Join-Path $temporaryDirectory "script.ps1"
                $psExe = if ($requestShell -eq "pwsh") { "pwsh.exe" } else { "powershell.exe" }
                if ($requestShell -eq "pwsh" -and -not (Get-Command pwsh.exe -ErrorAction SilentlyContinue)) {
                    Write-SandboxError "shell_invalid" "pwsh.exe was not found on PATH"
                    $failClosed = $true
                } else {
                    $inner = '$host.UI.RawUI.WindowTitle = "agent-extensions"; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ' + [string]$request.command
                    [System.IO.File]::WriteAllText($scriptFile, $inner, $utf8)
                    [System.IO.File]::WriteAllText($commandFile, "@echo off`r`nchcp 65001>nul`r`n$psExe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$scriptFile`"`r`n", $utf8)
                }
            }
            [System.IO.File]::WriteAllText($stdoutFile, "", $utf8)
            [System.IO.File]::WriteAllText($stderrFile, "", $utf8)
        }

        Get-NativeType | Out-Null

        try {
            $consoleKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Console", $true)
            if ($null -eq $consoleKey) {
                $consoleKey = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey("Console")
            }
            $consoleKey.SetValue("LowBoxConsoleEnabled", 1, [Microsoft.Win32.RegistryValueKind]::DWord)
            $consoleKey.Close()
        } catch {
            Write-ProvisionLog ("lowbox console enable failed: " + $_.Exception.Message)
        }

        $sid = [AgentPlatform.Runtime.NativeLauncher]::CreateProfile($profile)
        Write-ProvisionLog "profile ready"

        $protectedAbsolutes = @()
        foreach ($protected in @($request.protected_paths)) {
            if ([string]::IsNullOrWhiteSpace([string]$protected)) {
                continue
            }
            $absolute = Get-NormalizedPath (Join-Path $workspace ([string]$protected))
            if ((Test-Path -LiteralPath $absolute) -and ($absolute -ne $workspace)) {
                $protectedAbsolutes += $absolute
            }
        }

        # ---- desired rule set, then live provision
        # The per-exec scratch dir inherits the workspace grant — no explicit
        # rule (a fresh dir every run would otherwise trigger repair+probes
        # on every single invocation).
        $desired = @()
        $desired += @{ Path = $workspace; Type = "Allow"; Rights = [long]$rightsModify; Inherit = $true }
        $skipPrefixes = @(Get-UserChain) + @($workspace, $temporaryDirectory)
        $desired += Get-MachineGrantSet $workspace $temporaryDirectory $skipPrefixes
        $repaired = Invoke-LiveProvision $sid @($desired)

        # Protected paths use the grant-absence model (see _acl-lib.ps1):
        # inheritance isolated, every sandbox-SID ACE stripped; ReadOnly adds
        # back exactly ReadAndExecute. Never deny-ACE-ordering dependent.
        foreach ($absolute in $protectedAbsolutes) {
            $leaf = [System.IO.Path]::GetFileName($absolute)
            $mode = "Blocked"
            if ($leaf -eq ".git") {
                $mode = "ReadOnly"
            }
            if (-not (Test-SandboxPathPolicy $absolute $sid $mode)) {
                Write-ProvisionLog ("repair: protect " + $mode + " -> " + $absolute)
                Set-SandboxPathPolicy $absolute $sid $mode
                $repaired++
            }
        }

        if ($repaired -gt 0) {
            Write-ProvisionLog ("repaired $repaired rule(s); running behavioral verification")
            $violation = Invoke-BehavioralVerify $profile $sid $comspec $workspace $temporaryDirectory $environmentEntries @($protectedAbsolutes)
            if ($null -ne $violation) {
                Write-SandboxError $violation.Code $violation.Message
                $failClosed = $true
            } else {
                Write-ProvisionLog "behavioral verification passed"
            }
        } else {
            Write-ProvisionLog "all sandbox rules verified present (no repair needed)"
        }

        if (-not $failClosed) {
            $launcherTimeoutRaw = $request.launcher_timeout_ms
            if ($null -eq $launcherTimeoutRaw) {
                $launcherTimeout = [uint32]0
            } else {
                $launcherTimeout = [uint32]([double]$launcherTimeoutRaw)
            }
            Write-ProvisionLog "run: entering native wait"
            $commandExitCode = [AgentPlatform.Runtime.NativeLauncher]::Run(
                $profile,
                $comspec,
                $commandFile,
                $stdoutFile,
                $stderrFile,
                $cwd,
                $environmentEntries,
                $launcherTimeout)
            Write-ProvisionLog ("run: exited with " + $commandExitCode)

            if ($commandExitCode -eq $exitTimeout) {
                [Console]::Error.WriteLine("AGENT_PLATFORM_SANDBOX_TIMEOUT: command exceeded its timeout inside the sandbox and was terminated")
            }

            if (Test-Path -LiteralPath $stdoutFile) {
                [Console]::Out.Write([System.IO.File]::ReadAllText($stdoutFile, $script:Utf8NoBom))
            }
            if (Test-Path -LiteralPath $stderrFile) {
                [Console]::Error.Write([System.IO.File]::ReadAllText($stderrFile, $script:Utf8NoBom))
            }
        }
    } catch {
        Write-SandboxError "internal_error" ($_.Exception.Message)
        $commandExitCode = $exitSandboxError
    }
} catch {
    Write-SandboxError "internal_error" ($_.Exception.Message)
    $commandExitCode = $exitSandboxError
} finally {
    if ($null -ne $temporaryDirectory) {
        try {
            Remove-Item -LiteralPath $temporaryDirectory -Recurse -Force -ErrorAction SilentlyContinue
        } catch {
        }
    }
}

exit $commandExitCode
