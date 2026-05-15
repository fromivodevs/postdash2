$ErrorActionPreference = 'SilentlyContinue'
try {
    $raw = ""
    if ([Console]::IsInputRedirected) {
        $raw = [Console]::In.ReadToEnd()
    }
    if (-not $raw) { exit 0 }

    $input_json = $raw | ConvertFrom-Json -ErrorAction SilentlyContinue
    if (-not $input_json) { exit 0 }

    $path = $input_json.tool_input.file_path
    if (-not $path) { exit 0 }

    # Script files must stay ASCII-only to avoid PS5.1/cmd encoding failures.
    if ($path -match '\.(ps1|bat|cmd)$') {
        $candidate_text = ""
        if ($input_json.tool_input.content) {
            $candidate_text = [string]$input_json.tool_input.content
        } elseif ($input_json.tool_input.new_string) {
            $candidate_text = [string]$input_json.tool_input.new_string
        }
        if ($candidate_text -and $candidate_text -match '[^\x00-\x7F]') {
            @{
                hookSpecificOutput = @{
                    hookEventName = "PreToolUse"
                    permissionDecision = "deny"
                    permissionDecisionReason = "Script files must be ASCII-only: $path"
                }
                suppressOutput = $true
            } | ConvertTo-Json -Compress
            exit 0
        }
    }

    # Allowlist: template/example env files are safe to write
    $env_allowlist = @(
        '\.env\.example$',
        '\.env\.template$',
        '\.env\.sample$',
        '\.env\.dist$'
    )
    $is_env_template = $false
    foreach ($a in $env_allowlist) {
        if ($path -match $a) { $is_env_template = $true; break }
    }

    $blocked_patterns = @(
        '[\\/]node_modules[\\/]',
        '[\\/]dist[\\/]',
        '[\\/]\.next[\\/]',
        '[\\/]\.venv[\\/]',
        '[\\/]__pycache__[\\/]',
        'package-lock\.json$',
        'yarn\.lock$',
        'pnpm-lock\.yaml$',
        'poetry\.lock$',
        'C:\\Windows\\',
        'C:\\Program Files'
    )
    if (-not $is_env_template) {
        $blocked_patterns += '\.env$'
        $blocked_patterns += '\.env\.local$'
        $blocked_patterns += '\.env\.production$'
        $blocked_patterns += '\.env\.development$'
        $blocked_patterns += '\.env\.staging$'
        $blocked_patterns += '\.env\.test$'
    }

    foreach ($p in $blocked_patterns) {
        if ($path -match $p) {
            @{
                hookSpecificOutput = @{
                    hookEventName = "PreToolUse"
                    permissionDecision = "deny"
                    permissionDecisionReason = "Protected path matched pattern: $p ($path)"
                }
                suppressOutput = $true
            } | ConvertTo-Json -Compress
            exit 0
        }
    }
    exit 0
} catch {
    exit 0
}
