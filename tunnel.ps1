# Запускать на компьютере Windows, который в одной сети с регистратором.
# Публикует TCP регистратора через ngrok и печатает строку для .env ноутбука.
#
#   powershell -ExecutionPolicy Bypass -File .\tunnel.ps1
#   powershell -ExecutionPolicy Bypass -File .\tunnel.ps1 192.168.1.253:34567
param(
    [string]$Addr = "192.168.1.253:34567"
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command ngrok -ErrorAction SilentlyContinue)) {
    Write-Host "На этом компьютере нет ngrok." -ForegroundColor Red
    Write-Host "Скачайте его с https://ngrok.com/download и распакуйте так, чтобы команда ngrok открывалась в PowerShell."
    Write-Host "Токен один раз, его не кладут в проект: ngrok config add-authtoken <токен>"
    Write-Host "Токен берётся в кабинете: https://dashboard.ngrok.com/get-started/your-authtoken"
    exit 1
}

Write-Host "Туннель: ngrok tcp $Addr"
Write-Host "После старта в .env ноутбука нужна строка DEVICE_HOST=хост:порт без tcp://"
Write-Host ""

$log = Join-Path $env:TEMP "ngrok-recorder.log"
if (Test-Path $log) { Remove-Item $log -Force }
$ngrok = Start-Process -FilePath "ngrok" -ArgumentList @("tcp", $Addr) -PassThru -WindowStyle Hidden -RedirectStandardOutput $log -RedirectStandardError $log

try {
    $deadline = (Get-Date).AddSeconds(20)
    $printed = $false
    while ((Get-Date) -lt $deadline) {
        if ($ngrok.HasExited) { break }
        try {
            $payload = Invoke-RestMethod -Uri "http://127.0.0.1:4040/api/tunnels" -TimeoutSec 1
        } catch {
            Start-Sleep -Milliseconds 400
            continue
        }
        foreach ($tunnel in @($payload.tunnels)) {
            $public = [string]$tunnel.public_url
            if ($public.StartsWith("tcp://")) {
                $hostport = $public.Substring(6)
                Write-Host ""
                Write-Host "Скопируйте на ноутбук в файл .env ровно эту строку:"
                Write-Host "DEVICE_HOST=$hostport"
                Write-Host ""
                Write-Host "Пример того, как выглядит адрес: 0.tcp.ngrok.io:12345"
                Write-Host "Префикс tcp:// в .env не нужен. После каждого перезапуска ngrok порт меняется."
                Write-Host "На ноутбуке затем перезапустите клиент и нажмите Открыть."
                Write-Host "Остановить туннель: Ctrl+C"
                $printed = $true
                break
            }
        }
        if ($printed) { break }
        Start-Sleep -Milliseconds 400
    }

    if (-not $printed) {
        Write-Host "ngrok не выдал публичный адрес. Последние строки лога:" -ForegroundColor Red
        if (Test-Path $log) { Get-Content $log -Tail 30 }
        exit 1
    }

    Wait-Process -Id $ngrok.Id
} finally {
    if ($ngrok -and -not $ngrok.HasExited) {
        Stop-Process -Id $ngrok.Id -Force -ErrorAction SilentlyContinue
    }
}
