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
    if (-not (Test-Path $path)) { exit 0 }

    $ext = [System.IO.Path]::GetExtension($path).ToLower()
    switch ($ext) {
        ".py"   { if (Get-Command ruff -ErrorAction SilentlyContinue)     { ruff format $path 2>$null | Out-Null } }
        ".ts"   { if (Get-Command prettier -ErrorAction SilentlyContinue) { prettier --write $path 2>$null | Out-Null } }
        ".tsx"  { if (Get-Command prettier -ErrorAction SilentlyContinue) { prettier --write $path 2>$null | Out-Null } }
        ".js"   { if (Get-Command prettier -ErrorAction SilentlyContinue) { prettier --write $path 2>$null | Out-Null } }
        ".jsx"  { if (Get-Command prettier -ErrorAction SilentlyContinue) { prettier --write $path 2>$null | Out-Null } }
        ".json" { if (Get-Command prettier -ErrorAction SilentlyContinue) { prettier --write $path 2>$null | Out-Null } }
        ".css"  { if (Get-Command prettier -ErrorAction SilentlyContinue) { prettier --write $path 2>$null | Out-Null } }
        ".go"   { if (Get-Command gofmt -ErrorAction SilentlyContinue)    { gofmt -w $path 2>$null | Out-Null } }
        ".rs"   { if (Get-Command rustfmt -ErrorAction SilentlyContinue)  { rustfmt $path 2>$null | Out-Null } }
    }
    exit 0
} catch {
    exit 0
}
