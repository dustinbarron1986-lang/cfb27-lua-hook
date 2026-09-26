@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
set "REPO_ROOT=%SCRIPT_DIR%.."

if "%CFB27_GAME_DIR%"=="" set "CFB27_GAME_DIR=C:\Games\EA-SPORTS-College-Football-27\EA SPORTS College Football 27"
if "%CFB27_MMC_DIR%"=="" set "CFB27_MMC_DIR=C:\Tarkov\MMC_Modding_Tools_v1.1.0.4_CFBUpdate-9-10-26\MMC_ModManager_v1.1.0.4"
if "%CFB27_HOOK_ARTIFACTS%"=="" set "CFB27_HOOK_ARTIFACTS=C:\CFB27Tools\cfb27-lua-hook\native\build-active\Release"

echo Close College Football 27 now if it is running, then press any key to continue.
pause >nul

node "%REPO_ROOT%\packages\cli\bin\cfb27lua.cjs" install --autorun-script "%SCRIPT_DIR%autorun.lua"
if errorlevel 1 (
  echo.
  echo Sync FAILED - see the error above. autorun.lua was NOT updated in the game directory.
  exit /b 1
)

echo.
echo autorun.lua is now in sync. You can launch College Football 27.
