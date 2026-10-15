# Start the OpenSocket dev stack. Processes survive the calling shell
# (Start-Process gives each one its own console). Logs land in %TEMP%\opensocket.
$ErrorActionPreference = "Stop"
$logDir = Join-Path $env:TEMP "opensocket"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$repo = Split-Path $PSScriptRoot -Parent

# Deploy the pi approval gate next to the daemon data dir. PiHarness loads
# <dataDir>/extensions/opensocket-approval.js into every pi child when present.
$extDir = Join-Path $env:USERPROFILE ".opensocket\extensions"
New-Item -ItemType Directory -Force -Path $extDir | Out-Null
Copy-Item (Join-Path $repo "demo\pi-agent\extensions\opensocket-approval.js") `
  (Join-Path $extDir "opensocket-approval.js") -Force

# Load .env from the repo root if present (gitignored). KEY=VALUE lines.
$envFile = Join-Path $repo ".env"
if (Test-Path $envFile) {
  Get-Content $envFile | ForEach-Object {
    if ($_ -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$') {
      Set-Item -Path ("env:" + $Matches[1]) -Value $Matches[2]
    }
  }
}

# Real Orchestra server. Set ORCHESTRA_DIR to your local checkout if it
# differs from the default, or let it default below.
$orchestraDir = if ($env:ORCHESTRA_DIR) { $env:ORCHESTRA_DIR } else { "C:\Users\Administrator\projects\Orchestra" }
$orchestraExe = Join-Path $orchestraDir "bin\orchestra.exe"
$orchestraCfg = Join-Path $orchestraDir "configs\orchestra.yaml"
$env:ORCHESTRA_DEFAULT_PROVIDER = "openrouter"
# api.openrouter.ai is NXDOMAIN at authoritative DNS right now; the API answers
# on the apex domain. Override the provider's base_url accordingly.
$env:ORCHESTRA_PROVIDER_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"

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

Start-Process -FilePath "node" `
  -ArgumentList (Join-Path $repo "scripts\mock-openai.ts") `
  -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $logDir "mock-openai.log") `
  -RedirectStandardError (Join-Path $logDir "mock-openai.err")

$env:DAEMON_TOKEN = "devsecret"
$env:PORT = "8097"
$env:ORCHESTRA_URL = "http://127.0.0.1:8080"
$env:OPENSOCKET_MODEL = "openai/gpt-4o"
# Built-in agent: real key goes to OpenRouter (apex domain; see PLAN/README).
if ($env:OPENROUTER_API_KEY) {
  $env:BUILTIN_BASE_URL = "https://openrouter.ai/api/v1"
  $env:BUILTIN_API_KEY = $env:OPENROUTER_API_KEY
  $env:BUILTIN_MODEL = "openai/gpt-4o"
}
Start-Process -FilePath "node" `
  -ArgumentList (Join-Path $repo "apps\daemon\src\index.ts") `
  -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $logDir "daemon-real.log") `
  -RedirectStandardError (Join-Path $logDir "daemon-real.err")

$env:PORT = "8098"
$env:ORCHESTRA_URL = "http://127.0.0.1:8081"
# Keyless demo: pi talks to the local OpenAI-compatible mock via this config dir.
$env:PI_CODING_AGENT_DIR = Join-Path $repo "demo\pi-agent"
$env:PI_OFFLINE = "1"
$env:OPENSOCKET_MODEL = "mock/mock-gpt"
# Built-in agent: keyless via the local OpenAI mock.
$env:BUILTIN_BASE_URL = "http://127.0.0.1:8082/v1"
$env:BUILTIN_API_KEY = "mock-not-needed"
$env:BUILTIN_MODEL = "mock-gpt"
Start-Process -FilePath "node" `
  -ArgumentList (Join-Path $repo "apps\daemon\src\index.ts") `
  -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $logDir "daemon-mock.log") `
  -RedirectStandardError (Join-Path $logDir "daemon-mock.err")

Write-Host "orchestra(real) :8080 | orchestra(mock) :8081 | mock-openai :8082 | daemon(real) :8097 | daemon(keyless demo) :8098"
Write-Host "logs: $logDir"
