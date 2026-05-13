$ErrorActionPreference = 'SilentlyContinue'
try {
    $raw = ""
    if ([Console]::IsInputRedirected) {
        $raw = [Console]::In.ReadToEnd()
    }
    if (-not $raw) { exit 0 }

    $input_json = $raw | ConvertFrom-Json -ErrorAction SilentlyContinue
    if (-not $input_json) { exit 0 }
    if ($input_json.stop_hook_active -eq $true) { exit 0 }

    $tpath = $input_json.transcript_path
    if (-not $tpath -or -not (Test-Path $tpath)) { exit 0 }

    $transcript = Get-Content $tpath -Raw -ErrorAction SilentlyContinue
    if (-not $transcript) { exit 0 }

    $has_writes = $transcript -match '"name"\s*:\s*"(Write|Edit)"'
    $touched_roadmap = $transcript -match 'PROJECT_MAP\.md|ARCHITECTURE\.md'
    $said_skip = $transcript -match '(?i)skip[- ]roadmap'

    if ($has_writes -and -not $touched_roadmap -and -not $said_skip) {
        @{
            decision = "block"
            reason = "Files were edited but PROJECT_MAP.md / ARCHITECTURE.md were not touched. Run /roadmap or say 'skip-roadmap', then stop again."
        } | ConvertTo-Json -Compress
    }
    exit 0
} catch {
    exit 0
}
