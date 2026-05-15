# /encoding-check

Check encoding and line-ending safety for kit files and project scripts.

Required rules:

- `.ps1`, `.bat`, `.cmd`: ASCII-only, no UTF-8 BOM, CRLF preferred.
- `.md`, `.ts`, `.tsx`, `.js`, `.py`, `.sql`, `.yml`, `.yaml`: UTF-8 without BOM, LF preferred.
- PowerShell reads text kit files with `-Encoding UTF8`.
- `.claude/settings.json` hook commands use absolute paths with forward slashes.

Report every violation with the file path.
