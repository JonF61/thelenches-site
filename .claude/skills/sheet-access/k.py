#!/usr/bin/env python3
"""Kryten's helper for the Worker's /k Sheet endpoint (both pipeline Sheets).

Reads give rows keyed by header name with their real Sheet row numbers; writes name the
column by its header, never a letter, so a column can't be mistaken. Every write keeps
/k's safeguards (stale check, RAW, never row 1, max 50 cells, a Kryten log row, an undo id).

  k.py read TAB [--site S] [--where COL=VAL ...] [--has COL] [--since COL=YYYY-MM-DD]
                [--cols A,B] [--last N] [--width N] [--json] [--count COL]
  k.py get TAB ROW [--site S]                      every field of one row, in full
  k.py headers TAB [--site S]                      the header row with column letters
  k.py set TAB ROW COLUMN VALUE --expect OLD [--site S]   (VALUE or OLD '-' = read stdin)
  k.py set TAB ROW COLUMN VALUE --blank [--site S]        (only into an empty cell)
  k.py append TAB '{"col": "value", ...}' [--site S]      (one row, columns by header)
  k.py undo UNDO_ID [--site S]

Needs KRYTEN_TOKEN in the environment (never printed). Output is for Kryten's screen
only: never copy it into a commit, PR, workflow input, log or the Plan doc.
"""
import argparse, csv, io, json, os, sys, urllib.request, urllib.error

URL = 'https://approvals.lenches.workers.dev/k'
PAGE = 500  # /k's row cap per read


def call(body, site):
    tok = os.environ.get('KRYTEN_TOKEN')
    if not tok:
        sys.exit('KRYTEN_TOKEN is not set: use the Read Sheet tab / Write Sheet cells workflows instead')
    if site and site != 'lenches':
        body = {**body, 'site': site}
    req = urllib.request.Request(URL, data=json.dumps(body).encode(), method='POST',
                                 headers={'authorization': 'Bearer ' + tok, 'content-type': 'application/json',
                                          'user-agent': 'kryten-helper/1.0'})  # Cloudflare refuses Python's default (error 1010)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            d = json.load(r)
    except urllib.error.HTTPError as e:
        try:
            d = json.load(e)
        except Exception:
            sys.exit(f'/k HTTP {e.code} (a 403 from the proxy = host not allowed: fall back to the workflows)')
    if d.get('error'):
        sys.exit('/k refused: ' + str(d['error']))
    return d


def letters(n):  # 0 -> A
    s = ''
    n += 1
    while n:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


def parse(csv_text):
    """/k CSV: line 1 = 'row' + column letters; then each line starts with its Sheet row number."""
    lines = [l for l in csv_text.split('\n') if not l.startswith('# ')]
    r = list(csv.reader(io.StringIO('\n'.join(lines))))
    if len(r) < 1:
        return [], []
    cols = r[0][1:]
    return cols, [(int(x[0]), x[1:]) for x in r[1:] if x and x[0].isdigit()]


def headers(tab, site):
    cols, rows = parse(call({'op': 'read', 'tab': tab, 'range': 'A1:ZZ1', 'max_rows': 1}, site)['csv'])
    h = rows[0][1] if rows else []
    return [(letters(i), name.strip()) for i, name in enumerate(h)]


def read_all(tab, site):
    hdr = None
    out = []
    start = 1
    while True:
        rng = f'A{start}:ZZ{start + PAGE - 1}'
        cols, rows = parse(call({'op': 'read', 'tab': tab, 'range': rng, 'max_rows': PAGE}, site)['csv'])
        for n, vals in rows:
            if n == 1:
                hdr = [v.strip() for v in vals]
            elif n >= start:
                out.append((n, vals))
        got = sum(1 for n, _ in rows if n >= start)
        if got < PAGE:
            break
        start += PAGE
    hdr = hdr or []
    recs = []
    for n, vals in out:
        if not any(v.strip() for v in vals):
            continue
        rec = {'_row': n}
        for i, name in enumerate(hdr):
            if name:
                rec[name] = vals[i] if i < len(vals) else ''
        recs.append(rec)
    return hdr, recs


def col_letter(tab, site, column):
    hs = headers(tab, site)
    hits = [l for l, name in hs if name.lower() == column.lower()]
    if len(hits) != 1:
        sys.exit(f'Column "{column}" {"is not" if not hits else "is more than once"} in {tab}. Headers: '
                 + ', '.join(f'{l} {n}' for l, n in hs if n))
    return hits[0]


def arg_text(v):
    return sys.stdin.read().rstrip('\n') if v == '-' else v


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('cmd', choices=['read', 'get', 'headers', 'set', 'append', 'undo'])
    p.add_argument('args', nargs='*')
    p.add_argument('--site', default='lenches', help='lenches (default) or harvington')
    p.add_argument('--where', action='append', default=[], help='COL=VAL (exact, case-insensitive); repeatable')
    p.add_argument('--has', action='append', default=[], help='COL is not blank; repeatable')
    p.add_argument('--since', help='COL=YYYY-MM-DD: keep rows whose COL starts on or after that date')
    p.add_argument('--cols', help='comma-separated columns to show')
    p.add_argument('--last', type=int, help='only the last N matching rows')
    p.add_argument('--width', type=int, default=120, help='cut each shown value to N characters (0 = full)')
    p.add_argument('--json', action='store_true', help='print matching rows as JSON, in full')
    p.add_argument('--count', help='print counts of COL among matching rows instead of the rows')
    p.add_argument('--expect', help='set: the value you read in that cell (stale check)')
    p.add_argument('--blank', action='store_true', help='set: the cell must be empty')
    a = p.parse_args()
    site = a.site.strip().lower()

    if a.cmd == 'headers':
        for l, n in headers(a.args[0], site):
            if n:
                print(l, n)
        return

    if a.cmd in ('read', 'get'):
        tab = a.args[0]
        hdr, recs = read_all(tab, site)
        if a.cmd == 'get':
            row = int(a.args[1])
            rec = next((r for r in recs if r['_row'] == row), None)
            if not rec:
                sys.exit(f'No row {row} in {tab}')
            print(json.dumps(rec, indent=1, ensure_ascii=False))
            return
        low = {h.lower(): h for h in hdr if h}
        def need(c):
            if c.lower() not in low:
                sys.exit(f'No column "{c}" in {tab}. Headers: ' + ', '.join(h for h in hdr if h))
            return low[c.lower()]
        for w in a.where:
            c, _, v = w.partition('=')
            c = need(c)
            recs = [r for r in recs if r.get(c, '').strip().lower() == v.strip().lower()]
        for c in a.has:
            c = need(c)
            recs = [r for r in recs if r.get(c, '').strip()]
        if a.since:
            c, _, d = a.since.partition('=')
            c = need(c)
            recs = [r for r in recs if r.get(c, '')[:10] >= d]
        if a.last:
            recs = recs[-a.last:]
        if a.count:
            c = need(a.count)
            from collections import Counter
            for v, n in Counter(r.get(c, '') for r in recs).most_common():
                print(n, v or '(blank)')
            print(len(recs), 'rows')
            return
        if a.json:
            print(json.dumps(recs, indent=1, ensure_ascii=False))
            return
        show = [need(c) for c in a.cols.split(',')] if a.cols else [h for h in hdr if h]
        cut = (lambda s: s if not a.width or len(s) <= a.width else s[:a.width] + '…')
        for r in recs:
            print(f"{r['_row']}: " + ' | '.join(f'{c}={cut(r.get(c, "").replace(chr(10), " / "))}'
                                              for c in show if r.get(c, '')))
        print(f'{len(recs)} rows ({tab}, {site})')
        return

    if a.cmd == 'set':
        tab, row, column, value = a.args[0], int(a.args[1]), a.args[2], arg_text(a.args[3])
        if row < 2:
            sys.exit('Row 1 is the header row: never written')
        if a.expect is None and not a.blank:
            sys.exit('Give --expect with the value you read in that cell, or --blank for an empty cell')
        cell = f'{col_letter(tab, site, column)}{row}'
        body = {'op': 'set', 'tab': tab, 'range': cell, 'values': value}
        if a.expect is not None:
            body['expect'] = arg_text(a.expect)
        print(call(body, site).get('message'))
        return

    if a.cmd == 'append':
        tab, data = a.args[0], json.loads(a.args[1])
        hs = [n for _, n in headers(tab, site)]
        low = {n.lower(): i for i, n in enumerate(hs) if n}
        bad = [k for k in data if k.lower() not in low]
        if bad:
            sys.exit(f'Not columns of {tab}: {bad}. Headers: ' + ', '.join(n for n in hs if n))
        width = max(low[k.lower()] for k in data) + 1
        row = [''] * width
        for k, v in data.items():
            row[low[k.lower()]] = '' if v is None else str(v)
        print(call({'op': 'append', 'tab': tab, 'values': json.dumps([row])}, site).get('message'))
        return

    if a.cmd == 'undo':
        print(call({'op': 'undo', 'undo_id': a.args[0]}, site).get('message'))


if __name__ == '__main__':
    main()
