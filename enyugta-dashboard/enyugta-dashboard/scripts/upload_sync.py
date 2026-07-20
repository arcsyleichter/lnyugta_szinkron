#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
upload_sync.py — feltölti egy cég SQLite adatbázisát az L-NYUGTA szerver
/api/sync/upload végpontjára. Pontosan azt csinálja, amit majd az androidos
L-NYUGTA GO appnak (vagy egy azt helyettesítő szkriptnek) kell tennie
minden egyes szinkronizáláskor: elküldi a .db fájl nyers tartalmát, az
x-api-key-jel hitelesítve és az x-adoszam fejléccel megjelölve, hogy melyik
céghez tartozik a feltöltés.

Nincs külső függősége — csak a Python beépített könyvtárait használja,
tehát `pip install` nélkül, bármilyen Python 3.8+ alatt lefut.

Használat:
    python3 upload_sync.py --url https://l-nyugta-dashboard.onrender.com \
        --db data/companies/18774455.db --adoszam 18774455 --api-key <kulcs>

Az API kulcsot kényelmesebb környezeti változóból megadni, hogy ne kelljen
minden híváskor kiírni (és ne kerüljön bele a shell historyba):
    export SYNC_API_KEY="a szerver data/.secrets.json-jában lévő kulcs"
    python3 upload_sync.py --url https://l-nyugta-dashboard.onrender.com \
        --db data/companies/18774455.db --adoszam 18774455

Folyamatos, időzített szinkronhoz (pl. helyi teszteléshez, mielőtt az
androidos oldal élesedik) használható a --interval kapcsoló is: ez esetben
a szkript nem lép ki egy feltöltés után, hanem a megadott másodpercenként
újra elküldi ugyanazt a fájlt — pontosan úgy, ahogy egy WorkManager-feladat
tenné a telefonon.
"""

import argparse
import os
import sys
import time
import json
import urllib.request
import urllib.error


def human_size(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} TB"


def validate_sqlite_file(path: str) -> bytes:
    if not os.path.isfile(path):
        sys.exit(f"✗ A fájl nem található: {path}")
    with open(path, "rb") as f:
        data = f.read()
    if len(data) < 100 or not data[:16].startswith(b"SQLite format 3"):
        sys.exit(
            f"✗ A fájl nem tűnik érvényes SQLite adatbázisnak (nincs meg a "
            f"'SQLite format 3' fejléc): {path}"
        )
    return data


def upload_once(url: str, api_key: str, adoszam: str, telephely: str, data: bytes, timeout: int) -> None:
    endpoint = url.rstrip("/") + "/api/sync/upload"
    req = urllib.request.Request(
        endpoint,
        data=data,
        method="POST",
        headers={
            "x-api-key": api_key,
            "x-adoszam": adoszam,
            "x-telephely": telephely,
            "Content-Type": "application/octet-stream",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = json.loads(resp.read().decode("utf-8"))
            ts = time.strftime("%H:%M:%S")
            new_flag = "  (ÚJ CÉG regisztrálva)" if body.get("newCompany") else ""
            print(
                f"[{ts}] ✓ Feltöltve — {body.get('nev', '?')} "
                f"({body.get('companyKey', '?')}), {human_size(body.get('bytes', len(data)))}"
                f"{new_flag}"
            )
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")
        try:
            detail = json.loads(detail).get("error", detail)
        except json.JSONDecodeError:
            pass
        sys.exit(f"✗ Szerver hibát adott vissza ({e.code}): {detail}")
    except urllib.error.URLError as e:
        sys.exit(f"✗ Nem sikerült elérni a szervert ({endpoint}): {e.reason}")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Cég SQLite adatbázisának feltöltése az L-NYUGTA szinkron végpontjára."
    )
    parser.add_argument(
        "--url", required=True,
        help="A szerver alap URL-je, pl. https://l-nyugta-dashboard.onrender.com vagy http://localhost:3000"
    )
    parser.add_argument(
        "--db", required=True,
        help="A feltöltendő .db fájl elérési útja (pl. data/companies/18774455.db)"
    )
    parser.add_argument(
        "--adoszam", required=True,
        help="A cég adószáma (legalább az első 8 számjegy) — ez azonosítja, melyik céghez tartozik a feltöltés"
    )
    parser.add_argument(
        "--telephely", default="01",
        help="Telephely-kód (alapértelmezett: 01, ha a cégnek csak egy telephelye van)"
    )
    parser.add_argument(
        "--api-key", default=os.environ.get("SYNC_API_KEY"),
        help="A szerver szinkron API kulcsa. Ha nincs megadva, a SYNC_API_KEY környezeti változóból olvassa."
    )
    parser.add_argument(
        "--interval", type=int, default=0,
        help="Ha meg van adva (másodpercben), a szkript nem lép ki, hanem ennyi időnként újra feltölti "
             "ugyanazt a fájlt — folyamatos szinkron szimulálásához. Alapértelmezés: egyszeri feltöltés."
    )
    parser.add_argument(
        "--timeout", type=int, default=60,
        help="HTTP timeout másodpercben (alapértelmezés: 60 — nagyobb adatbázisoknál hasznos lehet emelni)"
    )
    args = parser.parse_args()

    if not args.api_key:
        sys.exit(
            "✗ Nincs API kulcs megadva. Add meg a --api-key kapcsolóval, vagy állítsd be a\n"
            "  SYNC_API_KEY környezeti változót (a szerver data/.secrets.json fájljában található)."
        )

    data = validate_sqlite_file(args.db)
    print(f"→ {args.db} ({human_size(len(data))}) feltöltése ide: {args.url}  [adószám: {args.adoszam}, telephely: {args.telephely}]")

    if args.interval > 0:
        print(f"→ Folyamatos mód: feltöltés {args.interval} másodpercenként. Leállítás: Ctrl+C.")
        try:
            while True:
                upload_once(args.url, args.api_key, args.adoszam, args.telephely, data, args.timeout)
                time.sleep(args.interval)
        except KeyboardInterrupt:
            print("\n→ Leállítva.")
    else:
        upload_once(args.url, args.api_key, args.adoszam, args.telephely, data, args.timeout)


if __name__ == "__main__":
    main()
