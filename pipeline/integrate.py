#!/usr/bin/env python3
"""Join off-target scan results onto guides, annotate hits by gene, rank.

Inputs : guides_scan.tsv, ot_counts.bin, ot_hits.bin, chrom_idx.tsv, genes.jsonl
Output : guides_ranked.tsv  (one row per scanned guide, with specificity + rank)
"""
import bisect
import json
import struct
import sys
from collections import defaultdict

SCAN, COUNTS, HITS, CHROMIDX, GENES, OUT = sys.argv[1:7]

# ---- off-target weighting (heuristic; documented in the site Methods) -----
# Weight of a single off-target site by mismatch count, for an NGG PAM.
# Calibrated so that the unavoidable 4-mismatch background of a 457 Mb genome
# (~40 sites per guide by chance) costs only a few points, while a single
# 0-2 mismatch site dominates the score.
W_MM = {0: 20.0, 1: 4.0, 2: 0.6, 3: 0.08, 4: 0.004}
W_NAG = 0.1          # NAG PAMs are cleaved far less efficiently than NGG


def specificity(ngg, nag):
    load = 0.0
    for mm, n in ngg.items():
        load += W_MM.get(mm, 0.0) * n
    for mm, n in nag.items():
        load += W_MM.get(mm, 0.0) * W_NAG * n
    return 100.0 / (1.0 + load)


# ---- gene / CDS interval index -------------------------------------------
print("indexing genes...", file=sys.stderr)
cds_iv = defaultdict(list)     # chrom -> [(start,end,gene_id)]
gene_iv = defaultdict(list)
for line in open(GENES):
    g = json.loads(line)
    c = g["chrom"]
    gid = g["gene_id"]
    lo = min(a for a, b in g["cds"]) if g["cds"] else 0
    hi = max(b for a, b in g["cds"]) if g["cds"] else 0
    if hi:
        gene_iv[c].append((lo, hi, gid))
    for a, b in g["cds"]:
        cds_iv[c].append((a, b, gid))
for d in (cds_iv, gene_iv):
    for c in d:
        d[c].sort()

cds_starts = {c: [x[0] for x in v] for c, v in cds_iv.items()}
gene_starts = {c: [x[0] for x in v] for c, v in gene_iv.items()}


def locate(chrom, pos, iv, starts):
    """gene_id of the first interval containing pos, else None."""
    v = iv.get(chrom)
    if not v:
        return None
    i = bisect.bisect_right(starts[chrom], pos)
    # scan back a bounded window; CDS exons are short, genes can be long
    for j in range(i - 1, max(-1, i - 400), -1):
        a, b, gid = v[j]
        if a <= pos <= b:
            return gid
    return None


# ---- chrom names ----------------------------------------------------------
cname = {}
for line in open(CHROMIDX):
    i, n = line.split()
    cname[int(i)] = n

# ---- read binaries -------------------------------------------------------
print("reading scan output...", file=sys.stderr)
raw = open(COUNTS, "rb").read()
nq, nslot, maxhit, _ = struct.unpack_from("<4i", raw, 0)
counts = memoryview(raw)[16:].cast("I")
print(f"  nq={nq} nslot={nslot} maxhit={maxhit}", file=sys.stderr)

hraw = open(HITS, "rb").read()
hnq, hnslot, hmaxhit, _ = struct.unpack_from("<4i", hraw, 0)
assert hnq == nq and hmaxhit == maxhit
nh = memoryview(hraw)[16:16 + nq].cast("B")
HITSZ = 12
hoff = 16 + nq

# ---- guides --------------------------------------------------------------
fin = open(SCAN)
hdr = fin.readline().rstrip("\n").split("\t")
out = open(OUT, "w")
MAXMM = nslot // 2 - 1
out.write("\t".join(hdr) + "\tn0\tn1\tn2\tn3\tn4\ta0\ta1\ta2\ta3\ta4\tspec\tfinal\t"
          "tier\tot_cds_genes\tot_top\n")

n = 0
for line in fin:
    p = line.rstrip("\n").split("\t")
    # counts are complete and split by PAM: [NGG 0..MAXMM][NAG 0..MAXMM]
    raw_c = [int(counts[n * nslot + k]) for k in range(nslot)]
    ngg = {m: raw_c[m] for m in range(MAXMM + 1)}
    nag = {m: raw_c[MAXMM + 1 + m] for m in range(MAXMM + 1)}
    cnts = [ngg.get(m, 0) for m in range(5)]
    acnts = [nag.get(m, 0) for m in range(5)]

    k = int(nh[n])
    tops = []
    for j in range(k):
        off = hoff + (n * maxhit + j) * HITSZ
        pos, ch, st, mm, sd, pam = struct.unpack_from("<iBBBBB", hraw, off)
        tops.append((mm, sd, pam, cname.get(ch, str(ch)), pos, "+" if st == 0 else "-"))

    spec = specificity(ngg, nag)

    pre = float(p[14])
    final = 0.45 * pre + 0.55 * spec
    if cnts[0] > 0:
        final = min(final, 25.0)
    elif cnts[1] > 0:
        final = min(final, 50.0)

    # annotate every stored off-target with the gene it falls in
    otg = []
    hitgene = []
    for (mm, sd, pam, ch, pos, st) in tops:
        gid = locate(ch, pos + 10, cds_iv, cds_starts)
        kind = "cds"
        if not gid:
            gid = locate(ch, pos + 10, gene_iv, gene_starts)
            kind = "intron" if gid else ""
        hitgene.append((gid or "", kind if gid else ""))
        if kind == "cds" and mm <= 3 and gid != p[0] and gid not in otg:
            otg.append(gid)
    if otg:
        final -= 8.0
    final = max(0.0, min(100.0, final))

    if cnts[0] == 0 and cnts[1] == 0 and cnts[2] == 0 and final >= 72:
        tier = "excellent"
    elif cnts[0] == 0 and cnts[1] == 0 and final >= 58:
        tier = "good"
    elif cnts[0] == 0 and final >= 42:
        tier = "fair"
    else:
        tier = "poor"

    ottop = ";".join(
        f"{ch}:{pos}{st}:{mm}mm:s{sd}:{'NGG' if pam==0 else 'NAG'}:"
        f"{hitgene[i][0]}:{hitgene[i][1]}"
        for i, (mm, sd, pam, ch, pos, st) in enumerate(tops[:8]))
    out.write("\t".join(p) +
              "\t" + "\t".join(str(x) for x in cnts) +
              "\t" + "\t".join(str(x) for x in acnts) +
              f"\t{spec:.2f}\t{final:.2f}\t{tier}\t{','.join(otg[:6])}\t{ottop}\n")
    n += 1
    if n % 100000 == 0:
        print(f"  {n}", file=sys.stderr)

out.close()
print(f"wrote {n} ranked guides -> {OUT}", file=sys.stderr)
assert n == nq, f"row count {n} != nq {nq}"
