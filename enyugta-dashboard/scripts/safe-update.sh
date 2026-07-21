#!/bin/bash
# ============================================================
# L-NYUGTA — biztonságos frissítés a VPS-en
# ============================================================
# EZT HASZNÁLD a jövőben git pull helyett — soha többé ne töröld
# a teljes mappát friss klónozás céljából, ez okozta a korábbi
# adatvesztést.
#
# Ez a szkript mindig:
#   1. Előbb menti a data/ mappát (git-től teljesen függetlenül)
#   2. Csak utána frissíti a KÓDOT git pull-lal (a data/ mappát a
#      .gitignore immár helyesen kihagyja, tehát a pull sosem
#      nyúlhat hozzá)
#   3. Újraindítja a szolgáltatást
#
# Használat:
#   ./scripts/safe-update.sh
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(dirname "$SCRIPT_DIR")"
cd "$APP_DIR"

echo "=== 1. Biztonsági mentés a frissítés előtt ==="
"$SCRIPT_DIR/backup-data.sh"

echo ""
echo "=== 2. Helyi, nem véglegesített kódmódosítások ellenőrzése ==="
if [ -n "$(git status --porcelain -- . ':!data')" ]; then
  echo "[FIGYELEM] Vannak helyi, nem commitolt kódmódosítások a VPS-en."
  echo "Ez régen okozott konfliktust — most megállunk, hogy megnézd, mielőtt bármi elveszne:"
  git status --short -- . ':!data'
  echo ""
  echo "Ha ezeket biztonságosan eldobhatod (mert csak a GitHub-on lévő,"
  echo "hiteles verziót akarod futtatni), futtasd le kézzel, majd told újra:"
  echo "  git checkout -- ."
  echo "  ./scripts/safe-update.sh"
  exit 1
fi

echo "Nincs konfliktus — tiszta git pull következik."

echo ""
echo "=== 3. Kód frissítése (git pull — a data/ mappát a .gitignore véd) ==="
git pull

echo ""
echo "=== 4. Szolgáltatás újraindítása ==="
sudo systemctl restart lnyugta
sleep 2
sudo systemctl status lnyugta --no-pager

echo ""
echo "=== Kész ==="
cat package.json | grep version
