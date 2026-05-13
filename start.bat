@echo off
setlocal
cd /d "%~dp0"

echo ============================================================
echo  PostDash dev environment
echo ============================================================
echo.

REM --- Check pnpm ---
where pnpm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] pnpm not found in PATH.
  echo Install: npm install -g pnpm@9
  goto :fail
)

REM --- Check .env ---
if not exist ".env" (
  echo [ERROR] .env not found.
  echo Run: copy .env.example .env
  echo Then fill DATABASE_URL with your Neon connection string.
  goto :fail
)

REM --- Check node_modules ---
if not exist "node_modules\.modules.yaml" (
  echo [INFO] node_modules missing or incomplete. Running pnpm install...
  call pnpm install
  if errorlevel 1 goto :fail
)

REM --- Apply DB migrations (idempotent: skips already-applied) ---
echo.
echo [STEP 1/2] Applying DB migrations...
call pnpm db:migrate
if errorlevel 1 (
  echo [ERROR] Migration failed. Check DATABASE_URL in .env.
  goto :fail
)

REM --- Start all dev services in one console ---
echo.
echo [STEP 2/2] Starting api + worker + miniapp...
echo Press Ctrl+C to stop all.
echo.
call pnpm dev

echo.
echo All services stopped.
goto :end

:fail
echo.
echo Startup aborted.
pause
exit /b 1

:end
pause
endlocal
