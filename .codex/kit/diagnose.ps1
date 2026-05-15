# Agent setup diagnostics. ASCII-only for PowerShell 5.1 compatibility.
$ErrorActionPreference = 'Stop'

function Add-Result {
    param(
        [string]$Name,
        [string]$Status,
        [string]$Detail
    )
    [pscustomobject]@{
        name = $Name
        status = $Status
        detail = $Detail
    }
}

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$codexDir = Join-Path $projectRoot '.codex'
$hooksDir = Join-Path $codexDir 'hooks'
$agentsPath = Join-Path $codexDir 'agents'
$results = @()

function Test-Crlf {
    param([string]$Path)
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    for ($i = 0; $i -lt $bytes.Length; $i++) {
        if ($bytes[$i] -eq 10) {
            if ($i -eq 0 -or $bytes[$i - 1] -ne 13) {
                return $false
            }
        }
    }
    return $true
}

function Add-Command-Check {
    param(
        [string]$Name,
        [scriptblock]$Command
    )
    try {
        $output = & $Command 2>&1
        $exitCode = $LASTEXITCODE
        $text = ($output | Out-String).Trim()
        if ($exitCode -ne 0) {
            $script:results += Add-Result $Name 'FAIL' ("exit code ${exitCode}: $text")
        } elseif ($text -match '(?i)\b(warning|error|failed|fatal|parsererror|exception)\b') {
            $script:results += Add-Result $Name 'FAIL' ("unexpected warning/error output: $text")
        } else {
            $script:results += Add-Result $Name 'OK' 'no warnings or errors'
        }
    } catch {
        $script:results += Add-Result $Name 'FAIL' $_.Exception.Message
    }
}

function Test-Skill-Frontmatter {
    param(
        [string]$Root,
        [string]$Label
    )
    if (-not (Test-Path $Root)) { return }
    Get-ChildItem -LiteralPath $Root -Recurse -File -Filter 'SKILL.md' | ForEach-Object {
        $rel = $_.FullName.Substring($projectRoot.Length).TrimStart('\')
        try {
            $lines = Get-Content -LiteralPath $_.FullName -Encoding UTF8
            if ($lines.Count -lt 3 -or $lines[0] -ne '---') {
                $script:results += Add-Result "$Label frontmatter: $rel" 'FAIL' 'missing opening YAML frontmatter fence'
                return
            }
            $end = -1
            for ($i = 1; $i -lt $lines.Count; $i++) {
                if ($lines[$i] -eq '---') {
                    $end = $i
                    break
                }
            }
            if ($end -lt 0) {
                $script:results += Add-Result "$Label frontmatter: $rel" 'FAIL' 'missing closing YAML frontmatter fence'
                return
            }
            for ($i = 1; $i -lt $end; $i++) {
                $line = $lines[$i].Trim()
                if (-not $line -or $line.StartsWith('#') -or $line.StartsWith('- ')) { continue }
                if ($line -notmatch '^([A-Za-z0-9_-]+):\s*(.*)$') { continue }
                $key = $Matches[1]
                $value = $Matches[2].Trim()
                $isQuoted = ($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))
                if ($key -eq 'description' -and -not $isQuoted) {
                    $script:results += Add-Result "$Label frontmatter: $rel" 'FAIL' 'description must be quoted'
                    return
                }
                if ($value -match ':\s+' -and -not $isQuoted) {
                    $script:results += Add-Result "$Label frontmatter: $rel" 'FAIL' 'unquoted scalar contains colon-space'
                    return
                }
                if (($value.StartsWith('"') -and -not $value.EndsWith('"')) -or ($value.StartsWith("'") -and -not $value.EndsWith("'"))) {
                    $script:results += Add-Result "$Label frontmatter: $rel" 'FAIL' 'unterminated quoted scalar'
                    return
                }
                if ($value.StartsWith('"') -and $value.EndsWith('"')) {
                    $inner = $value.Substring(1, $value.Length - 2)
                    if ($inner -match '\\[^0abtnvfre "\\/N_LPxuU]') {
                        $script:results += Add-Result "$Label frontmatter: $rel" 'FAIL' 'invalid escape in double-quoted scalar'
                        return
                    }
                }
            }
            $script:results += Add-Result "$Label frontmatter: $rel" 'OK' 'YAML scalar safety passed'
        } catch {
            $script:results += Add-Result "$Label frontmatter: $rel" 'FAIL' $_.Exception.Message
        }
    }
}

if (-not (Test-Path $hooksDir)) {
    Write-Host 'FAIL: .codex/hooks not found'
    exit 1
}

$expectedHooks = @(
    'pre-write-guard.ps1',
    'block-dangerous-bash.ps1',
    'format-on-edit.ps1',
    'lint-on-edit.ps1',
    'roadmap-reminder.ps1',
    'stage-complete-detector.ps1'
)

$mocks = @{
    'pre-write-guard.ps1' = '{"tool_input":{"file_path":"C:/tmp/test.txt"}}'
    'block-dangerous-bash.ps1' = '{"tool_input":{"command":"git status"}}'
    'format-on-edit.ps1' = '{"tool_input":{"file_path":"C:/tmp/test.txt"}}'
    'lint-on-edit.ps1' = '{"tool_input":{"file_path":"C:/tmp/test.txt"}}'
    'roadmap-reminder.ps1' = '{"transcript_path":"C:/tmp/none.jsonl"}'
    'stage-complete-detector.ps1' = '{"tool_input":{"file_path":"C:/tmp/PLAN.md","new_string":"- [x] Done","old_string":"- [ ] Done"}}'
}

function Add-Hook-Output-Check {
    param(
        [string]$Name,
        [string]$HookPath,
        [string]$InputJson,
        [scriptblock]$Validate
    )
    try {
        $output = $InputJson | powershell -NoProfile -ExecutionPolicy Bypass -File $HookPath 2>&1
        $exitCode = $LASTEXITCODE
        $text = ($output | Out-String).Trim()
        if ($exitCode -ne 0) {
            $script:results += Add-Result $Name 'FAIL' ("exit code ${exitCode}: $text")
            return
        }
        if (-not $text) {
            $script:results += Add-Result $Name 'FAIL' 'expected structured JSON output, got empty output'
            return
        }
        $json = $text | ConvertFrom-Json -ErrorAction Stop
        $ok = & $Validate $json
        if ($ok -ne $true) {
            $script:results += Add-Result $Name 'FAIL' 'structured JSON output did not match expected schema'
        } else {
            $script:results += Add-Result $Name 'OK' 'structured JSON output schema passed'
        }
    } catch {
        $script:results += Add-Result $Name 'FAIL' $_.Exception.Message
    }
}

foreach ($name in $expectedHooks) {
    $hookPath = Join-Path $hooksDir $name
    if (-not (Test-Path $hookPath)) {
        $results += Add-Result $name 'FAIL' 'missing hook file'
        continue
    }

    $bytes = [System.IO.File]::ReadAllBytes($hookPath)
    $hasBom = $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
    $hasNonAscii = $false
    foreach ($b in $bytes) {
        if ($b -gt 127) {
            $hasNonAscii = $true
            break
        }
    }

    if ($hasNonAscii) {
        $results += Add-Result $name 'FAIL' 'non-ASCII bytes in hook'
        continue
    }
    if ($hasBom) {
        $results += Add-Result $name 'FAIL' 'UTF-8 BOM present'
        continue
    }
    if (-not (Test-Crlf $hookPath)) {
        $results += Add-Result $name 'FAIL' 'hook must use CRLF line endings'
        continue
    }

    try {
        $null = [System.Management.Automation.PSParser]::Tokenize((Get-Content -LiteralPath $hookPath -Raw), [ref]$null)
        $output = $mocks[$name] | powershell -NoProfile -ExecutionPolicy Bypass -File $hookPath 2>&1
        $exitCode = $LASTEXITCODE
        $outputText = ($output | Out-String).Trim()
        if ($exitCode -ne 0) {
            $results += Add-Result $name 'FAIL' ("exit code ${exitCode}: $outputText")
        } elseif ($outputText -match '(?i)\b(warning|error|failed|fatal|parsererror|exception)\b') {
            $results += Add-Result $name 'FAIL' ("unexpected warning/error output: $outputText")
        } else {
            $results += Add-Result $name 'OK' 'syntax and mock run passed'
        }
    } catch {
        $results += Add-Result $name 'FAIL' $_.Exception.Message
    }
}

Add-Hook-Output-Check 'pre-write-guard block schema' (Join-Path $hooksDir 'pre-write-guard.ps1') '{"tool_input":{"file_path":"C:/tmp/.env","content":"SECRET=1"}}' {
    param($json)
    return $json.hookSpecificOutput.hookEventName -eq 'PreToolUse' -and
        $json.hookSpecificOutput.permissionDecision -eq 'deny' -and
        [string]::IsNullOrWhiteSpace($json.decision)
}

Add-Hook-Output-Check 'block-dangerous-bash schema' (Join-Path $hooksDir 'block-dangerous-bash.ps1') '{"tool_input":{"command":"git reset --hard HEAD"}}' {
    param($json)
    return $json.hookSpecificOutput.hookEventName -eq 'PreToolUse' -and
        $json.hookSpecificOutput.permissionDecision -eq 'deny' -and
        [string]::IsNullOrWhiteSpace($json.decision)
}

Add-Hook-Output-Check 'stage-complete-detector schema' (Join-Path $hooksDir 'stage-complete-detector.ps1') '{"tool_input":{"file_path":"C:/tmp/PLAN.md","new_string":"- [x] Done","old_string":"- [ ] Done"}}' {
    param($json)
    return $json.hookSpecificOutput.hookEventName -eq 'PostToolUse' -and
        -not [string]::IsNullOrWhiteSpace($json.hookSpecificOutput.additionalContext)
}

$tmpTranscript = Join-Path $env:TEMP ('agent-setup-transcript-' + [guid]::NewGuid().ToString() + '.jsonl')
try {
    Set-Content -LiteralPath $tmpTranscript -Value '{"name":"Edit","input":{"file_path":"src/test.ts"}}' -Encoding ASCII
    $escapedTranscript = ($tmpTranscript -replace '\\', '/')
    Add-Hook-Output-Check 'roadmap-reminder stop schema' (Join-Path $hooksDir 'roadmap-reminder.ps1') ("{`"transcript_path`":`"$escapedTranscript`",`"stop_hook_active`":false}") {
        param($json)
        return $json.decision -eq 'block' -and -not [string]::IsNullOrWhiteSpace($json.reason)
    }
} finally {
    Remove-Item -LiteralPath $tmpTranscript -Force -ErrorAction SilentlyContinue
}

if (Test-Path $agentsPath) {
    $badModels = @()
    Get-ChildItem -LiteralPath $agentsPath -Filter '*.md' -File | ForEach-Object {
        $text = Get-Content -LiteralPath $_.FullName -Raw -Encoding UTF8
        if ($text -match 'claude-(opus|sonnet|haiku)') {
            $badModels += $_.Name
        }
    }
    if ($badModels.Count -gt 0) {
        $results += Add-Result 'codex agent models' 'FAIL' ("Claude model names found: $($badModels -join ', ')")
    } else {
        $results += Add-Result 'codex agent models' 'OK' 'no Claude model names in agent frontmatter'
    }
} else {
    $results += Add-Result 'codex agent models' 'FAIL' 'missing .codex/agents'
}

$requiredDirs = @(
    '.codex/skills',
    '.codex/agents',
    '.codex/hooks',
    '.codex/kit/templates'
)

foreach ($dir in $requiredDirs) {
    $path = Join-Path $projectRoot $dir
    if (Test-Path $path) {
        $results += Add-Result $dir 'OK' 'present'
    } else {
        $results += Add-Result $dir 'FAIL' 'missing'
    }
}

Test-Skill-Frontmatter (Join-Path $codexDir 'skills') 'codex skills'

$kitDir = Join-Path $projectRoot 'kit'
if (Test-Path $kitDir) {
    $jsonFiles = @(Get-ChildItem -LiteralPath $kitDir -Recurse -File -Filter '*.json')
    if ($jsonFiles.Count -gt 0) {
        $results += Add-Result 'kit json source files' 'FAIL' ("JSON files under kit: $($jsonFiles.Count)")
    } else {
        $results += Add-Result 'kit json source files' 'OK' 'none'
    }
    Test-Skill-Frontmatter (Join-Path $kitDir 'components\skills') 'kit claude skills'
    Test-Skill-Frontmatter (Join-Path $kitDir 'components\codex\skills') 'kit codex skills'
}

if (Get-Command git -ErrorAction SilentlyContinue) {
    $gitDirOutput = & git -C $projectRoot rev-parse --is-inside-work-tree 2>&1
    if ($LASTEXITCODE -eq 0 -and (($gitDirOutput | Out-String).Trim()) -eq 'true') {
        Add-Command-Check 'git diff --check' {
            git -C $projectRoot diff --check -- .claude .codex kit AGENTS.md CLAUDE.md
        }
    }
}

Write-Host '=== Agent setup diagnose ==='
foreach ($r in $results) {
    $line = '[{0}] {1} - {2}' -f $r.status, $r.name, $r.detail
    Write-Host $line
}

$failed = @($results | Where-Object { $_.status -eq 'FAIL' }).Count
$warnings = @($results | Where-Object { $_.status -eq 'WARN' }).Count
if ($failed -gt 0 -or $warnings -gt 0) {
    exit 1
}
exit 0
