#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
sync_tester_gui.py — grafikus (nem parancssoros) teszt-eszköz Windowsra az
androidos szinkron szimulálásához.

NEM KELL TELEPÍTENI — csak futtatni kell. Kizárólag a Python beépített
könyvtárait használja (tkinter, sqlite3, urllib), semmilyen "pip install"
nem szükséges hozzá.

Indítás (Windows PowerShell / parancssor):
    python3 sync_tester_gui.py

Mit csinál:
  1. Betölthetsz egy .db fájlt (Tallózás gomb) — a táblázat megmutatja a
     benne lévő cikkeket (név, csoport, ár, ÁFA-kódok).
  2. "Szinkronizálás most" gombra lekérdezi a szervertől a függő
     módosításokat, ALKALMAZZA ŐKET a betöltött .db fájlra (pontosan úgy,
     ahogy egy androidos appnak kellene), és a táblázatban SZÍNNEL
     kiemeli, mi változott: zöld = új cikk, sárga = módosult ár/ÁFA.
  3. "Feltöltés a szerverre" gombra elküldi a (immár frissített) .db
     fájlt a szokásos feltöltési végpontra — ez zárja le a kört, és a
     szerver ekkor jelöli a módosításokat "leszinkronizálva" állapotúra.
"""

import json
import os
import sqlite3
import threading
import tkinter as tk
import urllib.error
import urllib.parse
import urllib.request
from tkinter import filedialog, messagebox, ttk

APP_TITLE = "L-NYUGTA — szinkron teszt-eszköz (androidos szimuláció)"


# ---------------------------------------------------------------------------
# Alsó réteg — HTTP + SQLite logika. Ugyanaz, mint a simulate_android_pull.py
# / dump_products.py szkriptekben, itt egybegyűjtve, hogy a GUI önmagában,
# más fájl nélkül is futtatható legyen.
# ---------------------------------------------------------------------------

def mask_key(key: str) -> str:
    if len(key) <= 8:
        return "•" * len(key)
    return key[:4] + "…" + key[-4:]


def pretty_json(raw: str) -> str:
    try:
        return json.dumps(json.loads(raw), indent=2, ensure_ascii=False)
    except (json.JSONDecodeError, TypeError):
        return raw


def fetch_pending(url: str, adoszam: str, api_key: str, telephely: str = "01", timeout: int = 30, log_fn=None) -> list:
    endpoint = url.rstrip("/") + "/api/sync/pending-changes?adoszam=" + urllib.parse.quote(adoszam)
    if log_fn:
        log_fn("KÉRÉS", f"GET {endpoint}\nx-api-key: {mask_key(api_key)}\nx-telephely: {telephely}")
    req = urllib.request.Request(endpoint, headers={"x-api-key": api_key, "x-telephely": telephely})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
            if log_fn:
                log_fn("VÁLASZ", f"{resp.status} {resp.reason}\n{pretty_json(raw)}")
            return json.loads(raw).get("items", [])
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace")
        if log_fn:
            log_fn("VÁLASZ (HIBA)", f"{e.code} {e.reason}\n{pretty_json(raw)}")
        raise


def upload_db(url: str, adoszam: str, api_key: str, db_path: str, telephely: str = "01", timeout: int = 60, log_fn=None) -> dict:
    endpoint = url.rstrip("/") + "/api/sync/upload"
    with open(db_path, "rb") as f:
        body = f.read()
    if log_fn:
        log_fn("KÉRÉS", f"POST {endpoint}\nx-api-key: {mask_key(api_key)}\nx-adoszam: {adoszam}\nx-telephely: {telephely}\n(törzs: {len(body)} bájt)")
    req = urllib.request.Request(
        endpoint, data=body, method="POST",
        headers={"x-api-key": api_key, "x-adoszam": adoszam, "x-telephely": telephely, "Content-Type": "application/octet-stream"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
            if log_fn:
                log_fn("VÁLASZ", f"{resp.status} {resp.reason}\n{pretty_json(raw)}")
            return json.loads(raw)
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace")
        if log_fn:
            log_fn("VÁLASZ (HIBA)", f"{e.code} {e.reason}\n{pretty_json(raw)}")
        raise


def next_unique_azon(conn: sqlite3.Connection, table: str) -> str:
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
    azon = next_unique_azon(conn, "cikkcsop")
    conn.execute("INSERT INTO cikkcsop (azon, megnevezes, status) VALUES (?, ?, 'A')", (azon, megnevezes))
    return azon, True


def apply_cikk(conn: sqlite3.Connection, payload: dict) -> str:
    # A payload a szó szerinti cikkt-oszlopneveken felül egy beágyazott
    # "csoport": {"megnevezes": "..."} mezőt is tartalmazhat — az androidos
    # oldal ezt külön, nem-generikus logikával dolgozza fel.
    megnevezes = payload["megnevezes"]
    me = payload.get("me") or "Darab"
    bruttoar = payload["bruttoar"]
    afakod = payload["afakod"]
    vonalkod = payload.get("vonalkod") or ""
    afakodelv = payload.get("afakodelv")
    csoport = payload.get("csoport")
    csopazon = "1"
    if csoport and csoport.get("megnevezes"):
        csopazon, _ = apply_csoport(conn, csoport["megnevezes"])

    row = conn.execute("SELECT azon FROM cikkt WHERE megnevezes = ?", (megnevezes,)).fetchone()
    if row:
        conn.execute(
            "UPDATE cikkt SET bruttoar = ?, afakod = ?, me = ?, vonalkod = ?, csopazon = ?, afakodelv = ? "
            "WHERE megnevezes = ?",
            (bruttoar, afakod, me, vonalkod, csopazon, afakodelv, megnevezes),
        )
        return "frissítve"
    azon = next_unique_azon(conn, "cikkt")
    conn.execute(
        "INSERT INTO cikkt (csopazon, megnevezes, me, bruttoar, afakod, vonalkod, azon, status, afakodelv) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, 'A', ?)",
        (csopazon, megnevezes, me, bruttoar, afakod, vonalkod, azon, afakodelv),
    )
    return "létrehozva"


def dump_products(db_path: str) -> dict:
    """Visszaadja a cikktörzset {nev: {me, ar, afa, afaElv, csoport}} alakban."""
    conn = sqlite3.connect(db_path)
    try:
        rows = conn.execute(
            "SELECT c.megnevezes, c.me, c.bruttoar, c.afakod, IFNULL(c.afakodelv,''), "
            "IFNULL(g.megnevezes,'Nincs csoport') "
            "FROM cikkt c LEFT JOIN cikkcsop g ON g.azon = c.csopazon "
            "WHERE c.status = 'A' ORDER BY c.megnevezes"
        ).fetchall()
    finally:
        conn.close()
    return {
        r[0]: {"me": r[1], "ar": r[2], "afa": r[3], "afaElv": r[4], "csoport": r[5]}
        for r in rows
    }


# ---------------------------------------------------------------------------
# GUI
# ---------------------------------------------------------------------------

class SyncTesterApp:
    def __init__(self, root: tk.Tk):
        self.root = root
        root.title(APP_TITLE)
        root.geometry("980x640")

        self.db_path = tk.StringVar()
        self.url_var = tk.StringVar(value="https://lnyugta-szinkron-1.onrender.com")
        self.adoszam_var = tk.StringVar(value="18774455")
        self.telephely_var = tk.StringVar(value="01")
        self.apikey_var = tk.StringVar(value=os.environ.get("SYNC_API_KEY", ""))

        self._build_ui()
        self.last_snapshot = {}

    # --- UI felépítése ---------------------------------------------------
    def _build_ui(self):
        pad = {"padx": 6, "pady": 4}

        top = ttk.Frame(self.root)
        top.pack(fill="x", **pad)

        ttk.Label(top, text="Szerver URL:").grid(row=0, column=0, sticky="e")
        ttk.Entry(top, textvariable=self.url_var, width=48).grid(row=0, column=1, columnspan=3, sticky="we", **pad)

        ttk.Label(top, text="Adószám:").grid(row=1, column=0, sticky="e")
        ttk.Entry(top, textvariable=self.adoszam_var, width=16).grid(row=1, column=1, sticky="w", **pad)

        ttk.Label(top, text="API kulcs:").grid(row=1, column=2, sticky="e")
        ttk.Entry(top, textvariable=self.apikey_var, width=28, show="•").grid(row=1, column=3, sticky="w", **pad)

        ttk.Label(top, text="Telephely-kód:").grid(row=2, column=0, sticky="e")
        ttk.Entry(top, textvariable=self.telephely_var, width=16).grid(row=2, column=1, sticky="w", **pad)
        ttk.Label(top, text="(csak egytelephelyes cégnél \"01\")", foreground="#888").grid(row=2, column=2, columnspan=2, sticky="w", **pad)

        ttk.Label(top, text="Adatbázis (.db):").grid(row=3, column=0, sticky="e")
        ttk.Entry(top, textvariable=self.db_path, width=60).grid(row=3, column=1, columnspan=2, sticky="we", **pad)
        ttk.Button(top, text="Tallózás…", command=self.browse_db).grid(row=3, column=3, sticky="w", **pad)

        btns = ttk.Frame(self.root)
        btns.pack(fill="x", **pad)
        self.btn_load = ttk.Button(btns, text="Adatbázis betöltése / frissítés", command=self.load_db)
        self.btn_load.pack(side="left", padx=4)
        self.btn_sync = ttk.Button(btns, text="Szinkronizálás most (lekérdezés + alkalmazás)", command=self.do_sync)
        self.btn_sync.pack(side="left", padx=4)
        self.btn_upload = ttk.Button(btns, text="Feltöltés a szerverre", command=self.do_upload)
        self.btn_upload.pack(side="left", padx=4)

        self.status_var = tk.StringVar(value="Nincs betöltött adatbázis.")
        ttk.Label(self.root, textvariable=self.status_var, foreground="#555").pack(fill="x", padx=8)

        # --- Termék táblázat ---
        table_frame = ttk.Frame(self.root)
        table_frame.pack(fill="both", expand=True, padx=8, pady=6)

        columns = ("nev", "csoport", "ar", "afa", "afaElv", "me")
        self.tree = ttk.Treeview(table_frame, columns=columns, show="headings", height=16)
        headers = {"nev": "Cikk", "csoport": "Csoport", "ar": "Bruttó ár", "afa": "ÁFA", "afaElv": "Elviteli ÁFA", "me": "Egység"}
        widths = {"nev": 220, "csoport": 160, "ar": 100, "afa": 70, "afaElv": 100, "me": 80}
        for c in columns:
            self.tree.heading(c, text=headers[c])
            self.tree.column(c, width=widths[c], anchor="w")
        vsb = ttk.Scrollbar(table_frame, orient="vertical", command=self.tree.yview)
        self.tree.configure(yscrollcommand=vsb.set)
        self.tree.pack(side="left", fill="both", expand=True)
        vsb.pack(side="left", fill="y")

        self.tree.tag_configure("new", background="#d6f5d6")       # zöld — új cikk
        self.tree.tag_configure("changed", background="#fff3cd")   # sárga — módosult
        self.tree.tag_configure("normal", background="white")

        # --- Napló / Terminál (fület-váltós) ---
        ttk.Label(self.root, text="Napló / Terminál:").pack(anchor="w", padx=8)
        self.notebook = ttk.Notebook(self.root)
        self.notebook.pack(fill="x", padx=8, pady=(0, 8))

        log_frame = ttk.Frame(self.notebook)
        self.log = tk.Text(log_frame, height=8, state="disabled", bg="#f7f7f7")
        self.log.pack(fill="both", expand=True)
        self.notebook.add(log_frame, text="Napló")

        term_frame = ttk.Frame(self.notebook)
        self.terminal = tk.Text(term_frame, height=8, state="disabled", bg="#1e1e1e", fg="#d4d4d4",
                                 insertbackground="#d4d4d4", font=("Consolas", 9))
        self.terminal.pack(fill="both", expand=True)
        self.terminal.tag_configure("req", foreground="#7ec699")    # zöldes — kimenő kérés
        self.terminal.tag_configure("resp", foreground="#79b8ff")   # kékes — beérkező válasz
        self.terminal.tag_configure("err", foreground="#ff8080")    # piros — hibás válasz
        self.notebook.add(term_frame, text="Terminál")

    # --- Segédfüggvények ---------------------------------------------------
    def log_line(self, text: str):
        self.log.configure(state="normal")
        self.log.insert("end", text + "\n")
        self.log.see("end")
        self.log.configure(state="disabled")

    def terminal_log(self, kind: str, text: str):
        """Hívható háttérszálból is — a tényleges szövegbeírást a fő szálra ütemezi."""
        self.root.after(0, lambda: self._terminal_log_ui(kind, text))

    def _terminal_log_ui(self, kind: str, text: str):
        tag = "err" if "HIBA" in kind else ("req" if kind == "KÉRÉS" else "resp")
        self.terminal.configure(state="normal")
        self.terminal.insert("end", f"── {kind} ──\n", tag)
        self.terminal.insert("end", text + "\n\n")
        self.terminal.see("end")
        self.terminal.configure(state="disabled")

    def set_busy(self, busy: bool):
        state = "disabled" if busy else "normal"
        self.btn_load.configure(state=state)
        self.btn_sync.configure(state=state)
        self.btn_upload.configure(state=state)
        self.root.update_idletasks()

    def browse_db(self):
        path = filedialog.askopenfilename(title="Válassz .db fájlt", filetypes=[("SQLite adatbázis", "*.db"), ("Minden fájl", "*.*")])
        if path:
            self.db_path.set(path)
            self.load_db()

    def refresh_table(self, snapshot: dict, changed: dict | None = None):
        """changed: {nev: 'new'|'changed'} — a legutóbbi szinkron kimenete színezéshez."""
        changed = changed or {}
        self.tree.delete(*self.tree.get_children())
        for nev in sorted(snapshot.keys(), key=lambda s: s.lower()):
            item = snapshot[nev]
            tag = changed.get(nev, "normal")
            self.tree.insert("", "end", values=(nev, item["csoport"], item["ar"], item["afa"], item["afaElv"], item["me"]), tags=(tag,))

    # --- Fő műveletek -------------------------------------------------------
    def load_db(self):
        path = self.db_path.get().strip()
        if not path or not os.path.isfile(path):
            messagebox.showerror(APP_TITLE, "Nem található a megadott adatbázis-fájl.")
            return
        try:
            snapshot = dump_products(path)
        except Exception as e:
            messagebox.showerror(APP_TITLE, f"Nem sikerült beolvasni az adatbázist:\n{e}")
            return
        self.last_snapshot = snapshot
        self.refresh_table(snapshot)
        self.status_var.set(f"Betöltve: {path}  —  {len(snapshot)} cikk.")
        self.log_line(f"Betöltve: {path} ({len(snapshot)} cikk)")

    def do_sync(self):
        path = self.db_path.get().strip()
        if not path or not os.path.isfile(path):
            messagebox.showerror(APP_TITLE, "Előbb tölts be egy adatbázist.")
            return
        url = self.url_var.get().strip()
        adoszam = self.adoszam_var.get().strip()
        api_key = self.apikey_var.get().strip()
        telephely = self.telephely_var.get().strip() or "01"
        if not url or not adoszam or not api_key:
            messagebox.showerror(APP_TITLE, "Add meg a szerver URL-t, az adószámot és az API-kulcsot.")
            return

        self.set_busy(True)
        self.status_var.set("Szinkronizálás folyamatban…")
        self.notebook.select(1)  # automatikusan a Terminál fülre vált
        self.log_line("→ Függő módosítások lekérdezése…")
        threading.Thread(target=self._do_sync_worker, args=(url, adoszam, api_key, path, telephely), daemon=True).start()

    def _do_sync_worker(self, url, adoszam, api_key, path, telephely):
        try:
            before = dump_products(path)
            items = fetch_pending(url, adoszam, api_key, telephely=telephely, log_fn=self.terminal_log)
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", errors="replace")
            self.root.after(0, lambda: self._sync_failed(f"Szerver hiba ({e.code}): {detail}"))
            return
        except Exception as e:
            self.root.after(0, lambda: self._sync_failed(str(e)))
            return

        if not items:
            self.root.after(0, lambda: self._sync_done(before, {}, 0))
            return

        try:
            conn = sqlite3.connect(path)
            applied = 0
            changed = {}
            for it in items:
                p = it["payload"]
                if it["type"] == "cikk_upsert":
                    result = apply_cikk(conn, p)
                    changed[p["megnevezes"]] = "new" if result == "létrehozva" else "changed"
                    applied += 1
                elif it["type"] == "csoport_upsert":
                    apply_csoport(conn, p["megnevezes"])
                    applied += 1
            conn.commit()
            conn.close()
        except Exception as e:
            self.root.after(0, lambda: self._sync_failed(f"Hiba az alkalmazás közben: {e}"))
            return

        after = dump_products(path)
        self.root.after(0, lambda: self._sync_done(after, changed, applied))

    def _sync_failed(self, message: str):
        self.set_busy(False)
        self.status_var.set("Hiba történt.")
        self.log_line(f"✗ HIBA: {message}")
        messagebox.showerror(APP_TITLE, message)

    def _sync_done(self, snapshot: dict, changed: dict, applied: int):
        self.set_busy(False)
        self.last_snapshot = snapshot
        self.refresh_table(snapshot, changed)
        if applied == 0:
            self.status_var.set("Nincs függő módosítás — nincs teendő.")
            self.log_line("Nincs függő módosítás ehhez az adószámhoz.")
        else:
            self.status_var.set(f"{applied} módosítás alkalmazva. (zöld = új cikk, sárga = módosult)")
            self.log_line(f"✓ {applied} módosítás alkalmazva a helyi adatbázisra.")
            for nev, kind in changed.items():
                self.log_line(f"   {'ÚJ CIKK' if kind == 'new' else 'MÓDOSULT'}: {nev}")

    def do_upload(self):
        path = self.db_path.get().strip()
        if not path or not os.path.isfile(path):
            messagebox.showerror(APP_TITLE, "Előbb tölts be egy adatbázist.")
            return
        url = self.url_var.get().strip()
        adoszam = self.adoszam_var.get().strip()
        api_key = self.apikey_var.get().strip()
        telephely = self.telephely_var.get().strip() or "01"
        if not url or not adoszam or not api_key:
            messagebox.showerror(APP_TITLE, "Add meg a szerver URL-t, az adószámot és az API-kulcsot.")
            return
        if not messagebox.askyesno(APP_TITLE, "Biztosan feltöltöd ezt az adatbázist a szerverre?\n\nEz éles hatással lehet a cég szinkronizált adataira."):
            return

        self.set_busy(True)
        self.status_var.set("Feltöltés folyamatban…")
        self.notebook.select(1)  # automatikusan a Terminál fülre vált
        self.log_line("→ Feltöltés indul…")
        threading.Thread(target=self._do_upload_worker, args=(url, adoszam, api_key, path, telephely), daemon=True).start()

    def _do_upload_worker(self, url, adoszam, api_key, path, telephely):
        try:
            result = upload_db(url, adoszam, api_key, path, telephely=telephely, log_fn=self.terminal_log)
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", errors="replace")
            self.root.after(0, lambda: self._sync_failed(f"Feltöltési hiba ({e.code}): {detail}"))
            return
        except Exception as e:
            self.root.after(0, lambda: self._sync_failed(str(e)))
            return
        self.root.after(0, lambda: self._upload_done(result))

    def _upload_done(self, result: dict):
        self.set_busy(False)
        self.status_var.set("Feltöltve.")
        self.log_line(f"✓ Feltöltve — {result.get('nev', '?')} ({result.get('companyKey', '?')})")
        messagebox.showinfo(APP_TITLE, "A feltöltés sikeres volt.\nA weben a Cikktörzs oldalon ellenőrizheted, hogy a módosítások \"leszinkronizálva\" állapotúra váltottak-e.")


def main():
    root = tk.Tk()
    try:
        ttk.Style().theme_use("vista")
    except tk.TclError:
        pass  # ha nem elérhető ez a téma, marad az alapértelmezett
    app = SyncTesterApp(root)
    root.mainloop()


if __name__ == "__main__":
    main()
