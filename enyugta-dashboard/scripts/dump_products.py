#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
dump_products.py — kiírja egy helyi .db fájl cikkt tábláját JSON formátumban
(cikknév, bruttó ár, ÁFA kód). Segédeszköz a test-sync.ps1 szkripthez, hogy
"előtte/utána" állapotot tudjon összehasonlítani — de önmagában is
használható gyors ellenőrzésre.

Használat:
    python3 dump_products.py <db_fajl_utvonala>
"""

import json
import sqlite3
import sys


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit("Használat: python3 dump_products.py <db_fajl_utvonala>")
    db_path = sys.argv[1]
    conn = sqlite3.connect(db_path)
    try:
        rows = conn.execute(
            "SELECT megnevezes, bruttoar, afakod, IFNULL(afakodelv,'') FROM cikkt "
            "WHERE status = 'A' ORDER BY megnevezes"
        ).fetchall()
    finally:
        conn.close()
    items = [{"nev": r[0], "ar": r[1], "afa": r[2], "afaElv": r[3]} for r in rows]
    print(json.dumps(items, ensure_ascii=False))


if __name__ == "__main__":
    main()
