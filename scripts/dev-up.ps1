# Start the OpenSocket dev stack. Processes survive the calling shell
# (Start-Process gives each one its own console). Logs land in %TEMP%\opensocket.
$ErrorActionPreference = "Stop"
$logDir = Join-Path $env:TEMP "opensocket"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$repo = Split-Path $PSScriptRoot -Parent

# Real Orchestra server (edit if your checkout lives elsewhere).
$orchestraExe = "C:\Users\Administrator\projects\Orchestra\bin\orchestra.exe"
$orchestraCfg = "C:\Users\Administrator\projects\Orchestra\configs\orchestra.yaml"

Start-Process -FilePath $orchestraExe `
  -ArgumentList "serve", "--config", $orchestraCfg, "--addr", "127.0.0.1:8080" `
  -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $logDir "orchestra.log") `
  -RedirectStandardError (Join-Path $logDir "orchestra.err")

Start-Process -FilePath "node" `
  -ArgumentList (Join-Path $repo "scripts\mock-orchestra.ts") `
  -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $logDir "mock-orchestra.log") `
  -RedirectStandardError (Join-Path $logDir "mock-orchestra.err")

$env:DAEMON_TOKEN = "devsecret"
$env:PORT = "8097"
$env:ORCHESTRA_URL = "http://127.0.0.1:8080"
Start-Process -FilePath "node" `
  -ArgumentList (Join-Path $repo "apps\daemon\src\index.ts") `
  -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $logDir "daemon-real.log") `
  -RedirectStandardError (Join-Path $logDir "daemon-real.err")

$env:PORT = "8098"
$env:ORCHESTRA_URL = "http://127.0.0.1:8081"
Start-Process -FilePath "node" `
  -ArgumentList (Join-Path $repo "apps\daemon\src\index.ts") `
  -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $logDir "daemon-mock.log") `
  -RedirectStandardError (Join-Path $logDir "daemon-mock.err")

Write-Host "orchestra(real) :8080 | orchestra(mock) :8081 | daemon(real) :8097 | daemon(mock/demo) :8098"
Write-Host "logs: $logDir"
