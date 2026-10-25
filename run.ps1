Write-Host "========================================================" -ForegroundColor Cyan
Write-Host "  Starting Pannala Aruna Paint Center POS Local Server" -ForegroundColor Cyan
Write-Host "========================================================" -ForegroundColor Cyan
$bridge = Start-Process node -ArgumentList "bridge.js" -PassThru -NoNewWindow
Start-Sleep -Seconds 2
try {
    pnpm dev
} finally {
    Stop-Process -Id $bridge.Id -Force -ErrorAction SilentlyContinue
}
