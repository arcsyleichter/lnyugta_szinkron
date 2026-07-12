#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
simulate_android_pull.py — szimulálja az androidos L-NYUGTA GO app oldalát a
cikktörzs kétirányú szinkronjában: lekérdezi a szerverről a függőben lévő
cikk/csoport-módosításokat (pontosan úgy, ahogy majd az android appnak is
tennie kell MINDEN szinkron előtt), és — ha megadsz egy helyi .db fájlt —
azokat ténylegesen alkalmazza is rá, mintha az androidos app tenné helyben.

Nincs külső függősége — csak a Python beépített könyvtárait használja
(urllib, sqlite3), tehát `pip install` nélkül, bármilyen Python 3.8+ alatt
lefut.

Használat — csak megnézni, mi van függőben:
    python3 simulate_android_pull.py --url https://lnyugta-szinkron-1.onrender.com \
        --adoszam 18774455 --api-key <kulcs>

Használat — a teljes kört is kipróbálva (lekérdezés + helyi alkalmazás):
    python3 simulate_android_pull.py --url https://lnyugta-szinkron-1.onrender.com \
        --adoszam 18774455 --api-key <kulcs> \
        --apply-to data/companies/18774455.db

Ezután a módosított .db fájlt visszaküldve az upload_sync.py-jal (pontosan
úgy, ahogy egy valódi androidos szinkron tenné), a szerver a következő
feltöltésben automatikusan felismeri, hogy a kért érték megérkezett, és a
függő módosítást "leszinkronizálva" állapotba teszi — semmilyen külön
visszaigazoló hívás nem kell:

    python3 upload_sync.py --url https://lnyugta-szinkron-1.onrender.com \
        --db data/companies/18774455.db --adoszam 18774455 --api-key <kulcs>

Az API kulcsot kényelmesebb környezeti változóból megadni:
    export SYNC_API_KEY="a szerver data/.secrets.json-jában lévő kulcs"

Folyamatos, időzített lekérdezéshez (mintha egy WorkManager-feladat futna a
telefonon) használható a --interval kapcsoló is.
"""

import argparse
import json
import os
import sqlite3
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


def fetch_pending(url: str, adoszam: str, api_key: str, timeout: int, telephely: str = "01") -> list:
    endpoint = url.rstrip("/") + "/api/sync/pending-changes?adoszam=" + urllib.parse.quote(adoszam)
    req = urllib.request.Request(endpoint, headers={"x-api-key": api_key, "x-telephely": telephely})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            return data.get("items", [])
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")
        try:
            detail = json.loads(detail).get("error", detail)
        except json.JSONDecodeError:
            pass
        sys.exit(f"✗ Szerver hibát adott vissza ({e.code}): {detail}")
    except urllib.error.URLError as e:
        sys.exit(f"✗ Nem sikerült elérni a szervert ({endpoint}): {e.reason}")


def next_azon(conn: sqlite3.Connection, table: str) -> str:
    """Új, egyedi 'azon' (szöveges azonosító) generálása — a meglévő
    legnagyobb numerikus azon + 1, vagy '1', ha még üres a tábla."""
    max_n = 0
    for (azon,) in conn.execute(f"SELECT azon FROM {table}"):
        try:
            n = int(azon)
            if n > max_n:
                max_n = n
        except (TypeError, ValueError):
            continue
    return str(max_n + 1)


def apply_csoport(conn: sqlite3.Connection, megnevezes: str):
    row = conn.execute("SELECT azon FROM cikkcsop WHERE megnevezes = ?", (megnevezes,)).fetchone()
    if row:
        return row[0], False
    azon = next_azon(conn, "cikkcsop")
    conn.execute("INSERT INTO cikkcsop (azon, megnevezes, status) VALUES (?, ?, 'A')", (azon, megnevezes))
    return azon, True


def apply_cikk(conn: sqlite3.Connection, payload: dict) -> str:
    megnevezes = payload["megnevezes"]
    me = payload.get("me") or "Darab"
    bruttoar = payload["bruttoar"]
    afakod = payload["afakod"]
    vonalkod = payload.get("vonalkod") or ""
    afakodelv = payload.get("afakodelv")
    csoport = payload.get("csoport")  # {"megnevezes": "..."} vagy None
    csopazon = "1"
    if csoport and csoport.get("megnevezes"):
        csopazon, _ = apply_csoport(conn, csoport["megnevezes"])

    row = conn.execute("SELECT azon FROM cikkt WHERE megnevezes = ?", (megnevezes,)).fetchone()
    if row:
        conn.execute(
            "UPDATE cikkt SET bruttoar = ?, afakod = ?, me = ?, vonalkod = ?, csopazon = ?, afakodelv = ? WHERE megnevezes = ?",
            (bruttoar, afakod, me, vonalkod, csopazon, afakodelv, megnevezes),
        )
        return "frissítve"
    azon = next_azon(conn, "cikkt")
    conn.execute(
        "INSERT INTO cikkt (csopazon, megnevezes, me, bruttoar, afakod, vonalkod, azon, status, afakodelv) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, 'A', ?)",
        (csopazon, megnevezes, me, bruttoar, afakod, vonalkod, azon, afakodelv),
    )
    return "létrehozva"


def run_once(args) -> None:
    items = fetch_pending(args.url, args.adoszam, args.api_key, args.timeout, args.telephely)
    ts = time.strftime("%H:%M:%S")
    if not items:
        print(f"[{ts}] Nincs függő módosítás ehhez az adószámhoz.")
        return

    print(f"[{ts}] {len(items)} függő módosítás érkezett:")
    for it in items:
        p = it["payload"]
        if it["type"] == "cikk_upsert":
            csoport_nev = (p.get("csoport") or {}).get("megnevezes")
            print(f"  #{it['id']} CIKK     {p['megnevezes']!r} → {p['bruttoar']} Ft ({p['afakod']}), csoport: {csoport_nev or '—'}")
        elif it["type"] == "csoport_upsert":
            print(f"  #{it['id']} CSOPORT  {p['megnevezes']!r}")
        else:
            print(f"  #{it['id']} {it['type']}  {p}")

    if not args.apply_to:
        print("  (Ha szeretnéd, hogy ezeket ténylegesen alkalmazzam is egy helyi .db fájlra, add meg a --apply-to kapcsolót.)")
        return

    if not os.path.isfile(args.apply_to):
        sys.exit(f"✗ A megadott adatbázis nem található: {args.apply_to}")

    conn = sqlite3.connect(args.apply_to)
    try:
        applied = 0
        for it in items:
            p = it["payload"]
            if it["type"] == "cikk_upsert":
                result = apply_cikk(conn, p)
                print(f"    → helyben alkalmazva ({result}): {p['megnevezes']}")
                applied += 1
            elif it["type"] == "csoport_upsert":
                _, created = apply_csoport(conn, p["megnevezes"])
                print(f"    → helyben alkalmazva ({'létrehozva' if created else 'már létezett'}): {p['megnevezes']}")
                applied += 1
        conn.commit()
    finally:
        conn.close()

    print(f"→ {applied} módosítás alkalmazva itt: {args.apply_to}")
    print(f"  Most töltsd fel (mintha az androidos app tenné):")
    print(f"  python3 upload_sync.py --url {args.url} --db {args.apply_to} --adoszam {args.adoszam}")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Az androidos app oldalának szimulálása: függő cikktörzs-módosítások lekérdezése (és opcionálisan helyi alkalmazása)."
    )
    parser.add_argument("--url", required=True, help="A szerver alap URL-je, pl. https://lnyugta-szinkron-1.onrender.com")
    parser.add_argument("--adoszam", required=True, help="A cég adószáma (legalább az első 8 számjegy)")
    parser.add_argument("--telephely", default="01", help="Telephely-kód (alapértelmezett: 01, ha a cégnek csak egy telephelye van)")
    parser.add_argument("--api-key", default=os.environ.get("SYNC_API_KEY"), help="Szinkron API kulcs (vagy SYNC_API_KEY env változó)")
    parser.add_argument("--apply-to", help="Helyi .db fájl, amire ténylegesen alkalmazza a lekérdezett módosításokat")
    parser.add_argument("--interval", type=int, default=0, help="Ha megadod (mp), folyamatosan, ennyi időnként újra lekérdez (Ctrl+C-ig)")
    parser.add_argument("--timeout", type=int, default=30, help="HTTP timeout másodpercben")
    args = parser.parse_args()

    if not args.api_key:
        sys.exit(
            "✗ Nincs API kulcs megadva. Add meg a --api-key kapcsolóval, vagy állítsd be a\n"
            "  SYNC_API_KEY környezeti változót (a szerver data/.secrets.json fájljában található)."
        )

    print(f"→ Függő módosítások lekérdezése: {args.url}  [adószám: {args.adoszam}, telephely: {args.telephely}]")
    if args.interval > 0:
        print(f"→ Folyamatos mód: lekérdezés {args.interval} másodpercenként. Leállítás: Ctrl+C.")
        try:
            while True:
                run_once(args)
                time.sleep(args.interval)
        except KeyboardInterrupt:
            print("\n→ Leállítva.")
    else:
        run_once(args)


if __name__ == "__main__":
    main()
