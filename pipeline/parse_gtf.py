#!/usr/bin/env python3
"""Parse iBany1.1 annotation.gtf -> per-gene CDS models.

Output: genes.jsonl, one record per protein-coding gene:
  gene_id, chrom, strand, desc, biotype, n_tx, rep_tx,
  cds:   [[start,end],...]  1-based inclusive, genomic order, representative tx
  cds_core: [[start,end],...] CDS intervals shared by ALL coding transcripts
"""
import csv
import gzip
import json
import re
import sys
from collections import defaultdict

GTF = sys.argv[1]
NAMECSV = sys.argv[2]
OUT = sys.argv[3]

attr_re = re.compile(r'(\S+) "([^"]*)"')


def attrs(s):
    return dict(attr_re.findall(s))


gene_info = {}
# gene -> tx -> list of (start,end)
cds = defaultdict(lambda: defaultdict(list))

n = 0
with open(GTF) as fh:
    for line in fh:
        if line[0] == "#":
            continue
        f = line.rstrip("\n").split("\t")
        if len(f) < 9:
            continue
        feat = f[2]
        if feat == "gene":
            a = attrs(f[8])
            gid = a.get("gene_id")
            gene_info[gid] = {
                "gene_id": gid,
                "chrom": f[0],
                "strand": f[6],
                "gstart": int(f[3]),
                "gend": int(f[4]),
                "desc": a.get("description", ""),
                "biotype": a.get("gene_biotype", ""),
                "dbxref": a.get("db_xref", ""),
            }
        elif feat == "CDS":
            a = attrs(f[8])
            gid = a.get("gene_id")
            tid = a.get("transcript_id")
            cds[gid][tid].append((int(f[3]), int(f[4])))
            n += 1
            if n % 200000 == 0:
                print(f"  {n} CDS rows", file=sys.stderr)

# secondary names from the user's CSV (old-assembly LOC -> protein name)
csvname = {}
with open(NAMECSV, newline="") as fh:
    r = csv.reader(fh)
    next(r, None)
    for row in r:
        if len(row) >= 2 and row[1] and row[1] != row[0]:
            csvname[row[0].strip()] = row[1].strip()

out = open(OUT, "w")
kept = 0
for gid, txs in cds.items():
    gi = gene_info.get(gid)
    if gi is None:
        continue
    # representative transcript = longest total CDS; tie-break on id for determinism
    best = None
    for tid, ivs in txs.items():
        tot = sum(e - s + 1 for s, e in ivs)
        key = (tot, tid)
        if best is None or key > best[0]:
            best = (key, tid, sorted(ivs))
    rep_ivs = best[2]
    # core CDS = intersection across all transcripts (base-level, then re-interval)
    if len(txs) == 1:
        core = rep_ivs
    else:
        sets = []
        for tid, ivs in txs.items():
            s = set()
            for a, b in ivs:
                s.update(range(a, b + 1))
            sets.append(s)
        inter = set.intersection(*sets)
        core = []
        for p in sorted(inter):
            if core and p == core[-1][1] + 1:
                core[-1][1] = p
            else:
                core.append([p, p])
        core = [tuple(x) for x in core]

    desc = gi["desc"]
    alt = csvname.get(gid, "")
    rec = {
        "gene_id": gid,
        "chrom": gi["chrom"],
        "strand": gi["strand"],
        "desc": desc,
        "alt_name": alt if alt and alt != desc else "",
        "biotype": gi["biotype"],
        "n_tx": len(txs),
        "rep_tx": best[1],
        "cds": [[a, b] for a, b in rep_ivs],
        "cds_core": [[a, b] for a, b in core],
        "cds_len": sum(b - a + 1 for a, b in rep_ivs),
    }
    out.write(json.dumps(rec, separators=(",", ":")) + "\n")
    kept += 1
out.close()
print(f"wrote {kept} coding genes -> {OUT}", file=sys.stderr)
