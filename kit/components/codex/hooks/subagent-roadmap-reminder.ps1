$ErrorActionPreference = 'SilentlyContinue'
try {
    $raw = ""
    if ([Console]::IsInputRedirected) {
        $raw = [Console]::In.ReadToEnd()
    }

    $input_json = $null
    if ($raw) {
        $input_json = $raw | ConvertFrom-Json -ErrorAction SilentlyContinue
    }

    # SubagentStop hook fires when a Task/Agent subagent finishes.
    # Goal: if the subagent edited source files but did NOT touch PROJECT_MAP.md /
    # ARCHITECTURE.md / architecture/<system>.md, inject a system reminder so the
    # orchestrator evaluates whether structural docs need updating BEFORE moving on.
    # User preference (non-negotiable): never silently skip roadmap maintenance,
    # even during perfect-loop chains.

    $wrote_source = $false
    $touched_map = $false
    $new_file_signal = $false

    if ($input_json -and $input_json.transcript_path -and (Test-Path $input_json.transcript_path)) {
        $transcript = Get-Content $input_json.transcript_path -Raw -ErrorAction SilentlyContinue
        if ($transcript) {
            $wrote_source = $transcript -match '"name"\s*:\s*"(Write|Edit|MultiEdit|NotebookEdit)"'
            $touched_map  = $transcript -match 'PROJECT_MAP\.md|ARCHITECTURE\.md|architecture[\\/][\w.-]+\.md'
            $new_file_signal = $transcript -match '"name"\s*:\s*"Write"\s*,\s*"input"\s*:\s*\{\s*"file_path"\s*:\s*"[^"]*\.(ts|tsx|js|jsx|py|sql|md|json|yaml|yml)"'
        }
    }

    if (-not $wrote_source) {
        exit 0
    }

    if (-not $touched_map) {
        $msg = "[roadmap-guard] Subagent finished after editing source files but did NOT touch PROJECT_MAP.md / ARCHITECTURE.md / architecture/<system>.md. User preference (non-negotiable): the orchestrator MUST evaluate whether structural docs need updating BEFORE continuing the task. If the subagent added a new file/module/system, invoke roadmap-keeper-agent in a separate Agent() call. If the change was purely behavioral (no structural shift, no new file), explicitly note 'no roadmap update needed' in the next response so the decision is on record. This reminder fires on every SubagentStop and never auto-clears."
        if ($new_file_signal) {
            $msg = $msg + " STRONG SIGNAL: subagent invoked Write tool (likely a NEW file was created) - roadmap update is almost certainly required."
        }
    } else {
        $msg = "[roadmap-guard] Subagent edited source AND touched PROJECT_MAP/ARCHITECTURE. Verify the doc accurately reflects the structural changeset (test counts, new files, system descriptions, recent-changes line). If the subagent only made a partial sweep, follow up with roadmap-keeper-agent for a full pass."
    }

    @{
        hookSpecificOutput = @{
            hookEventName     = "SubagentStop"
            additionalContext = $msg
        }
        suppressOutput = $true
    } | ConvertTo-Json -Compress
    exit 0
} catch {
    exit 0
}
