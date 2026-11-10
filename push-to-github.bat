@echo off
setlocal
cd /d "%~dp0"

echo.
echo  ==========================================================
echo   Publish this extension to your own GitHub repository
echo  ==========================================================
echo.
echo   STEP 1 - Create an EMPTY repo on https://github.com/new
echo            Name      : witch-paintbox-comfyui
echo            Visibility: Public   (private repos cannot be
echo                                  cloned by SillyTavern)
echo            Leave "Add a README", ".gitignore" and
echo            "license" UNTICKED.
echo.
echo   STEP 2 - Come back here and press Enter.
echo.
pause

set "GHUSER="
set /p "GHUSER=  Your GitHub username: "
if not defined GHUSER (
  echo.
  echo   No username given, nothing to do.
  pause
  exit /b 1
)

set "REPO="
set /p "REPO=  Repository name [witch-paintbox-comfyui]: "
if not defined REPO set "REPO=witch-paintbox-comfyui"

set "REPOURL=https://github.com/%GHUSER%/%REPO%.git"

echo.
echo  ----------------------------------------------------------
echo   Pushing to: %REPOURL%
echo   A browser window may open for GitHub login. Approve it.
echo  ----------------------------------------------------------
echo.

git remote remove origin >nul 2>&1
git remote add origin "%REPOURL%"
git push -u origin main

if errorlevel 1 goto failed

echo.
echo  ==========================================================
echo   Done.
echo.
echo   Install address for SillyTavern:
echo     %REPOURL%
echo.
echo   Extensions -^> Install extension -^> paste the address
echo   -^> confirm -^> refresh the page.
echo  ==========================================================
echo.
pause
exit /b 0

:failed
echo.
echo  ==========================================================
echo   Push failed. Most likely causes:
echo.
echo   1. The repo does not exist yet
echo      -^> create it at https://github.com/new and retry
echo.
echo   2. The repo already has a README commit
echo      -^> run this once, then retry:
echo         git push -u origin main --force
echo.
echo   3. You cancelled the GitHub login window
echo      -^> just run this script again
echo  ==========================================================
echo.
pause
exit /b 1
