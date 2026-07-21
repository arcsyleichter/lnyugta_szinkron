#!/bin/bash
# ============================================================
# L-NYUGTA — automatikus, git-től FÜGGETLEN mentés
# ============================================================
# Ez a szkript a data/ mappa TELJES tartalmát (cégek adatbázisai,
# felhasználók, licenc, készlet, stb.) egy időbélyeges, tömörített
# fájlba menti, EGY, a git-repótól teljesen külön mappába.
#
# EZ A LÉNYEG: ez a mentés SOHA nem kerülhet konfliktusba egyetlen
# git-művelettel sem (pull, stash, checkout, fresh clone) — teljesen
# más helyen van, más eszközzel (tar), nem git-tel.
#
# Használat:
#   ./scripts/backup-data.sh
#
# Automatikus, napi futtatáshoz (cron), add hozzá ezt a sort:
#   crontab -e
#   0 3 * * * /home/lnyugta/lnyugta_szinkron/enyugta-dashboard/scripts/backup-data.sh >> /home/lnyugta/lnyugta_backups/backup.log 2>&1
# (ez minden nap hajnali 3-kor lefuttatja, és a kimenetet naplózza)
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(dirname "$SCRIPT_DIR")"
DATA_DIR="$APP_DIR/data"
BACKUP_ROOT="$HOME/lnyugta_backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="$BACKUP_ROOT/data_backup_${TIMESTAMP}.tar.gz"
KEEP_DAYS=14

if [ ! -d "$DATA_DIR" ]; then
  echo "[HIBA] Nem található a data/ mappa itt: $DATA_DIR — nincs mit menteni."
  exit 1
fi

mkdir -p "$BACKUP_ROOT"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Mentés indul: $DATA_DIR -> $BACKUP_FILE"
tar -czf "$BACKUP_FILE" -C "$APP_DIR" data

if [ -f "$BACKUP_FILE" ]; then
  SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Kész: $BACKUP_FILE ($SIZE)"
else
  echo "[HIBA] A mentés nem jött létre — ellenőrizd a hibaüzeneteket fent."
  exit 1
fi

# Régi mentések automatikus törlése — csak a legutóbbi KEEP_DAYS napnyit
# tartjuk meg, hogy a lemez ne teljen be a végtelenségig.
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Törlöm a(z) $KEEP_DAYS napnál régebbi mentéseket…"
find "$BACKUP_ROOT" -name "data_backup_*.tar.gz" -mtime "+$KEEP_DAYS" -print -delete

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Jelenlegi mentések:"
ls -lh "$BACKUP_ROOT"/data_backup_*.tar.gz 2>/dev/null | tail -10
