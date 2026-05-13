$ErrorActionPreference = 'SilentlyContinue'
try {
    $raw = ""
    if ([Console]::IsInputRedirected) {
        $raw = [Console]::In.ReadToEnd()
    }
    if (-not $raw) { exit 0 }

    $input_json = $raw | ConvertFrom-Json -ErrorAction SilentlyContinue
    if (-not $input_json) { exit 0 }

    $cmd = $input_json.tool_input.command
    if (-not $cmd) { exit 0 }

    $dangerous = @(
        'rm\s+-rf\s+[/~]',
        'rm\s+-rf\s+C:\\',
        'git\s+push\s+--force.*\b(main|master)\b',
        'git\s+reset\s+--hard',
        'DROP\s+TABLE',
        'TRUNCATE\s+TABLE',
        'chmod\s+777',
        'supabase\s+db\s+reset\s+--linked'
    )
    foreach ($d in $dangerous) {
        if ($cmd -match $d) {
            @{
                hookSpecificOutput = @{
                    hookEventName = "PreToolUse"
                    permissionDecision = "deny"
                    permissionDecisionReason = "Dangerous command matched: $d. Run manually if intended."
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
