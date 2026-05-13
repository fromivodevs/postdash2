# /kit-diagnose

Run the installed kit health check.

Command:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\.claude\kit\diagnose.ps1
```

If it fails, fix in this order:

1. Hook syntax.
2. Missing copied files.
3. Settings hook paths.
4. Encoding warnings.

