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
    if ($path -notmatch '(PLAN|ROADMAP|plan)\.md$') { exit 0 }

    $new_content = $input_json.tool_input.new_string
    $old_content = $input_json.tool_input.old_string
    if (-not $new_content) { exit 0 }

    $new_has_x = $new_content -match '- \[x\]'
    $old_has_x = $old_content -match '- \[x\]'

    if ($new_has_x -and -not $old_has_x) {
        $stage_match = [regex]::Match($new_content, '- \[x\] (.+)', 'IgnoreCase')
        $stage = if ($stage_match.Success) { $stage_match.Groups[1].Value.Trim() } else { "unknown stage" }

        $is_phase = $stage -match '(?i)\bphase[ -]?\d+\b'

        if ($is_phase) {
            $suggestion = "Phase boundary completed: $stage. Run /step-perfect-loop with full 5x5 depth (phase-level validation: lean core + pl-plan-keeper + git diff for the whole phase)."
        } else {
            $suggestion = "Step completed: $stage. Run /step-perfect-loop to validate (default 3x3 depth)."
        }

        @{
            hookSpecificOutput = @{
                hookEventName = "PostToolUse"
                additionalContext = $suggestion
            }
            suppressOutput = $true
        } | ConvertTo-Json -Compress
    }
    exit 0
} catch {
    exit 0
}
