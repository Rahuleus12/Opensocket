# Stop the OpenSocket dev stack by listening port.
foreach ($port in 8080, 8081, 8082, 8097, 8098) {
  Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique |
    ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }
}
Write-Host "stopped"
