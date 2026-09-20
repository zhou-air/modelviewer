# Downloads the cloudflared standalone exe (Windows amd64).
# Tries a direct download first; on failure retries through a local
# proxy at 127.0.0.1:7890 if it is reachable.
param(
    [Parameter(Mandatory = $true)][string]$Destination
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$url = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"

function Get-File([string]$u, [string]$out, [string]$proxy) {
    if ($proxy) {
        Invoke-WebRequest -Uri $u -OutFile $out -UseBasicParsing -Proxy $proxy -TimeoutSec 120
    } else {
        Invoke-WebRequest -Uri $u -OutFile $out -UseBasicParsing -TimeoutSec 120
    }
}

$proxy = "http://127.0.0.1:7890"
$proxyUp = $false
try {
    $t = New-Object Net.Sockets.TcpClient
    $t.Connect("127.0.0.1", 7890)
    $t.Close()
    $proxyUp = $true
} catch { }

try {
    Write-Host "  trying direct download ..."
    Get-File $url $Destination $null
} catch {
    Write-Host "  direct download failed: $($_.Exception.Message)"
    if ($proxyUp) {
        Write-Host "  retrying through proxy $proxy ..."
        try {
            Get-File $url $Destination $proxy
        } catch {
            Write-Host "  proxy download also failed: $($_.Exception.Message)"
            exit 1
        }
    } else {
        exit 1
    }
}

if ((Test-Path $Destination) -and ((Get-Item $Destination).Length -gt 10MB)) {
    exit 0
}
exit 1
