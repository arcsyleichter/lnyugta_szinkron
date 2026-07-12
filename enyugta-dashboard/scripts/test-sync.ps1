# test-sync.ps1 — leszimulálja az androidos app szinkronját egy helyi teszt
# adatbázison, és megmutatja, PONTOSAN mit módosított a szinkron (előtte/utána
# összehasonlítással) — cikkenként, jól látható táblázatban.
#
# A tényleges lekérdezést és alkalmazást a már meglévő
# scripts\simulate_android_pull.py végzi (ugyanaz a logika, amit az
# androidos fejlesztőnek is implementálnia kell) — ez a szkript csak
# "előtte" és "utána" pillanatképet készít köré, és szépen megjeleníti a
# különbséget.
#
# Használat:
#   $env:SYNC_API_KEY = "a szinkron API-kulcsod"
#   .\scripts\test-sync.ps1 -Url https://lnyugta-szinkron-1.onrender.com -Adoszam 18774455 -Telephely 01 -DbPath .\proba-corvin-presszo-teszt2.db
#
# Ha a -DbPath paramétert nem adod meg, alapból ".\proba-corvin-presszo-teszt2.db"-t használja.
# Ha a -Telephely paramétert nem adod meg, alapból "01"-et használja (egytelephelyes cégeknél ez a helyes).

param(
    [Parameter(Mandatory = $true)][string]$Url,
    [Parameter(Mandatory = $true)][string]$Adoszam,
    [string]$Telephely = "01",
    [string]$ApiKey = $env:SYNC_API_KEY,
    [string]$DbPath = ".\proba-corvin-presszo-teszt2.db"
)

if (-not $ApiKey) {
    Write-Host "[HIBA] Nincs API-kulcs megadva. Add meg a -ApiKey kapcsolóval, vagy állítsd be:" -ForegroundColor Red
    Write-Host '  $env:SYNC_API_KEY = "..."' -ForegroundColor Red
    exit 1
}
if (-not (Test-Path $DbPath)) {
    Write-Host "[HIBA] Nem található az adatbázis: $DbPath" -ForegroundColor Red
    exit 1
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$dumpScript = Join-Path $scriptDir "dump_products.py"
$pullScript = Join-Path $scriptDir "simulate_android_pull.py"

Write-Host "-> Pillanatkép készítése szinkron ELŐTT ($DbPath)..." -ForegroundColor Cyan
$beforeJson = python3 $dumpScript $DbPath
$before = $beforeJson | ConvertFrom-Json
$beforeMap = @{}
foreach ($item in $before) { $beforeMap[$item.nev] = $item }

Write-Host "-> Függő módosítások lekérdezése és alkalmazása..." -ForegroundColor Cyan
python3 $pullScript --url $Url --adoszam $Adoszam --telephely $Telephely --api-key $ApiKey --apply-to $DbPath

Write-Host ""
Write-Host "-> Pillanatkép készítése szinkron UTÁN..." -ForegroundColor Cyan
$afterJson = python3 $dumpScript $DbPath
$after = $afterJson | ConvertFrom-Json
$afterMap = @{}
foreach ($item in $after) { $afterMap[$item.nev] = $item }

Write-Host ""
Write-Host "===================== VÁLTOZÁSOK =====================" -ForegroundColor Yellow

$changedCount = 0
foreach ($nev in $afterMap.Keys) {
    $new = $afterMap[$nev]
    if (-not $beforeMap.ContainsKey($nev)) {
        Write-Host "ÚJ CIKK    " -ForegroundColor Green -NoNewline
        Write-Host "  $nev  ->  $($new.ar) Ft ($($new.afa))"
        $changedCount++
        continue
    }
    $old = $beforeMap[$nev]
    if ($old.ar -ne $new.ar -or $old.afa -ne $new.afa -or $old.afaElv -ne $new.afaElv) {
        Write-Host "MÓDOSULT   " -ForegroundColor Magenta -NoNewline
        Write-Host "  $nev  :  $($old.ar) Ft ($($old.afa))  ->  $($new.ar) Ft ($($new.afa))"
        $changedCount++
    }
}

# eltűnt cikkek jelzése (ha esetleg egy régi cikk kikerült volna — ritka eset)
foreach ($nev in $beforeMap.Keys) {
    if (-not $afterMap.ContainsKey($nev)) {
        Write-Host "ELTŰNT     " -ForegroundColor Red -NoNewline
        Write-Host "  $nev"
        $changedCount++
    }
}

if ($changedCount -eq 0) {
    Write-Host "(Nem volt semmilyen alkalmazható függő módosítás — a két állapot azonos.)" -ForegroundColor DarkGray
}

Write-Host "========================================================" -ForegroundColor Yellow
Write-Host ""
Write-Host "-> Most töltsd fel, mintha az androidos app tenné:" -ForegroundColor Cyan
Write-Host "  python3 $scriptDir\upload_sync.py --url $Url --db $DbPath --adoszam $Adoszam --telephely $Telephely"
