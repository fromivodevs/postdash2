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
    $errors = ""
    switch ($ext) {
        ".py" {
            if (Get-Command ruff -ErrorAction SilentlyContinue) {
                $errors = (ruff check $path 2>&1) -join "`n"
            }
        }
        {$_ -in ".ts",".tsx",".js",".jsx"} {
            if (Get-Command eslint -ErrorAction SilentlyContinue) {
                $errors = (eslint --quiet $path 2>&1) -join "`n"
            }
        }
    }
    # Non-blocking: don't emit decision, just exit
    exit 0
} catch {
    exit 0
}
