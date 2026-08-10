$success = 0
$errCount = 0
for ($i = 0; $i -lt 50; $i++) {
    try {
        $r = Invoke-WebRequest -Uri "http://209.50.241.215:3000/v1/health" -Method Get -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop
        if ($r.StatusCode -eq 200) { $success++ } else { $errCount++ }
    } catch { $errCount++ }
}
Write-Host "---"
Write-Host "Backend API Test: Success=$success, Errors=$errCount"

$frontSuccess = 0
$frontErrorCount = 0
$urls = @("http://209.50.241.215/", "http://209.50.241.215/app.js", "http://209.50.241.215/app.css")
foreach ($u in $urls) {
    try {
        $r = Invoke-WebRequest -Uri $u -UseBasicParsing -ErrorAction Stop
        if ($r.StatusCode -eq 200) { $frontSuccess++ } else { $frontErrorCount++ }
    } catch { $frontErrorCount++ }
}
Write-Host "Frontend Test: Success=$frontSuccess, Errors=$frontErrorCount"
Write-Host "---"
