#!/bin/bash
# ============================================================
# L-NYUGTA — mentés visszaállítása
# ============================================================
# Használat:
#   ./scripts/restore-data.sh                 # a legutóbbi mentést listázza, majd rákérdez
#   ./scripts/restore-data.sh <fájlnév.tar.gz> # egy konkrét mentést állít vissza
#
# BIZTONSÁGI LÉPÉS: mielőtt bármit felülírna, a JELENLEGI data/ mappát is
# elmenti egy "előtte" pillanatképként — így ha rossz mentést választanál,
# az sem vész el véglegesen.
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(dirname "$SCRIPT_DIR")"
DATA_DIR="$APP_DIR/data"
BACKUP_ROOT="$HOME/lnyugta_backups"

if [ -z "${1:-}" ]; then
  echo "Elérhető mentések (legújabb elöl):"
  ls -1t "$BACKUP_ROOT"/data_backup_*.tar.gz 2>/dev/null | head -20 | nl
  echo ""
  echo "Használat: $0 <a fenti listából egy teljes fájlnév>"
  exit 0
fi

RESTORE_FILE="$1"
if [[ "$RESTORE_FILE" != /* ]]; then
  RESTORE_FILE="$BACKUP_ROOT/$RESTORE_FILE"
fi

if [ ! -f "$RESTORE_FILE" ]; then
  echo "[HIBA] Nem található: $RESTORE_FILE"
  exit 1
fi

echo "Ezt a mentést fogod visszaállítani: $RESTORE_FILE"
read -p "Biztosan folytatod? A JELENLEGI data/ mappa előbb mentésre kerül. (y/n) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "Megszakítva."
  exit 0
fi

echo "Szolgáltatás leállítása…"
sudo systemctl stop lnyugta || true

SAFETY_TS=$(date +%Y%m%d_%H%M%S)
SAFETY_FILE="$BACKUP_ROOT/ELOTTE_visszaallitas_${SAFETY_TS}.tar.gz"
echo "A jelenlegi állapot mentése (biztonsági háló): $SAFETY_FILE"
tar -czf "$SAFETY_FILE" -C "$APP_DIR" data

echo "Visszaállítás: $RESTORE_FILE"
rm -rf "$DATA_DIR"
tar -xzf "$RESTORE_FILE" -C "$APP_DIR"

echo "Szolgáltatás újraindítása…"
sudo systemctl start lnyugta
sleep 2
sudo systemctl status lnyugta --no-pager

echo ""
echo "Kész. Ha valami nem stimmel, a visszaállítás ELŐTTI állapot itt van:"
echo "  $SAFETY_FILE"
