@echo off
chcp 65001 >nul
echo Updating Moodle Agent Bridge extension from GitHub...
where git >nul 2>nul
if %errorlevel%==0 (
  if exist ".git" (
    git pull origin main
    echo Done! Now click Reload in chrome://extensions/
    pause
    exit /b 0
  )
)
powershell -NoProfile -Command ^
  "$zip = Join-Path $env:TEMP 'moodle-ext.zip';" ^
  "$out = Join-Path $env:TEMP 'moodle-ext-unpack';" ^
  "if (Test-Path $out) { Remove-Item $out -Recurse -Force };" ^
  "Invoke-WebRequest -Uri 'https://github.com/Grusha033/moodle-bridge-extension/archive/refs/heads/main.zip' -OutFile $zip;" ^
  "Expand-Archive -Path $zip -DestinationPath $out -Force;" ^
  "Copy-Item -Path (Join-Path $out 'moodle-bridge-extension-main\*') -Destination '.' -Recurse -Force;" ^
  "Remove-Item $zip -Force; Remove-Item $out -Recurse -Force;"
echo Done! Now click Reload in chrome://extensions/
pause
