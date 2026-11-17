#!/usr/bin/env python3
"""Design amplicon-sequencing primers around each published guide's cut site.

Amplicon <= 300 bp, must span the cut site with >= 50 bp of margin on both
sides so the indel sits comfortably inside the read.

usage: design_primers.py genome.fa guides_ranked.tsv out.tsv top_n [workers]
"""
import os
import sys
from collections import defaultdict
from multiprocessing import Pool

import primer3

GENOME, RANKED, OUT = sys.argv[1:4]
TOPN = int(sys.argv[4]) if len(sys.argv) > 4 else 10
WORKERS = int(sys.argv[5]) if len(sys.argv) > 5 else 2

FLANK = 360
MIN_MARGIN = 50

GLOBALS = {
    "PRIMER_TASK": "generic",
    "PRIMER_PICK_LEFT_PRIMER": 1,
    "PRIMER_PICK_RIGHT_PRIMER": 1,
    "PRIMER_PICK_INTERNAL_OLIGO": 0,
    "PRIMER_OPT_SIZE": 20,
    "PRIMER_MIN_SIZE": 18,
    "PRIMER_MAX_SIZE": 25,
    "PRIMER_OPT_TM": 60.0,
    "PRIMER_MIN_TM": 57.0,
    "PRIMER_MAX_TM": 63.0,
    "PRIMER_PAIR_MAX_DIFF_TM": 3.0,
    "PRIMER_MIN_GC": 30.0,
    "PRIMER_MAX_GC": 70.0,
    "PRIMER_GC_CLAMP": 1,
    "PRIMER_MAX_POLY_X": 4,
    "PRIMER_MAX_NS_ACCEPTED": 0,
    "PRIMER_MAX_SELF_ANY_TH": 45.0,
    "PRIMER_MAX_SELF_END_TH": 35.0,
    "PRIMER_PAIR_MAX_COMPL_ANY_TH": 45.0,
    "PRIMER_PAIR_MAX_COMPL_END_TH": 35.0,
    "PRIMER_MAX_HAIRPIN_TH": 40.0,
    "PRIMER_NUM_RETURN": 3,
    "PRIMER_SALT_MONOVALENT": 50.0,
    "PRIMER_DNA_CONC": 50.0,
}
# Progressively relaxed attempts. Lepidopteran genomes are AT-rich, so a
# strict Tm/GC window leaves many cut sites without a pair; later passes widen
# it rather than giving up.
TRIES = [
    {"PRIMER_PRODUCT_SIZE_RANGE": [[200, 300]]},
    {"PRIMER_PRODUCT_SIZE_RANGE": [[150, 300]]},
    {"PRIMER_PRODUCT_SIZE_RANGE": [[130, 300]],
     "PRIMER_MIN_TM": 55.0, "PRIMER_MAX_TM": 65.0,
     "PRIMER_MIN_GC": 25.0, "PRIMER_MAX_GC": 75.0,
     "PRIMER_PAIR_MAX_DIFF_TM": 4.0, "PRIMER_MAX_POLY_X": 5},
    {"PRIMER_PRODUCT_SIZE_RANGE": [[110, 300]],
     "PRIMER_MIN_TM": 53.0, "PRIMER_MAX_TM": 67.0,
     "PRIMER_MIN_GC": 20.0, "PRIMER_MAX_GC": 80.0,
     "PRIMER_PAIR_MAX_DIFF_TM": 5.0, "PRIMER_MAX_POLY_X": 5,
     "PRIMER_GC_CLAMP": 0, "PRIMER_MAX_SIZE": 27,
     "PRIMER_MAX_SELF_ANY_TH": 50.0, "PRIMER_MAX_HAIRPIN_TH": 45.0},
]

_G = {}


def load_genome(path):
    seqs = {}
    name = None
    parts = []
    with open(path, "rb") as fh:
        for line in fh:
            if line[:1] == b">":
                if name:
                    seqs[name] = b"".join(parts).upper().decode()
                name = line[1:].split()[0].decode()
                parts = []
            else:
                parts.append(line.strip())
    if name:
        seqs[name] = b"".join(parts).upper().decode()
    return seqs


def init():
    _G.update(load_genome(GENOME))


def one(job):
    key, chrom, cut = job
    seq = _G.get(chrom)
    if seq is None:
        return (key, None)
    lo = max(0, cut - FLANK)
    hi = min(len(seq), cut + FLANK)
    tmpl = seq[lo:hi]
    if "N" in tmpl:
        # trim to the largest N-free window containing the cut site
        c = cut - lo
        l = c
        while l > 0 and tmpl[l - 1] != "N":
            l -= 1
        r = c
        while r < len(tmpl) and tmpl[r] != "N":
            r += 1
        tmpl = tmpl[l:r]
        lo = lo + l
        if len(tmpl) < 150:
            return (key, None)
    coff = cut - lo                    # cut index within template
    if coff < 60 or coff > len(tmpl) - 60:
        return (key, None)

    for ti, over in enumerate(TRIES):
        g = dict(GLOBALS)
        g.update(over)
        margin = MIN_MARGIN if ti < 3 else 40
        try:
            r = primer3.bindings.design_primers(
                {"SEQUENCE_ID": key,
                 "SEQUENCE_TEMPLATE": tmpl,
                 "SEQUENCE_TARGET": [max(0, coff - 5), 10]}, g)
        except Exception:
            continue
        n = r.get("PRIMER_PAIR_NUM_RETURNED", 0)
        for i in range(n):
            lseq = r[f"PRIMER_LEFT_{i}_SEQUENCE"]
            rseq = r[f"PRIMER_RIGHT_{i}_SEQUENCE"]
            lpos, llen = r[f"PRIMER_LEFT_{i}"]
            rpos, rlen = r[f"PRIMER_RIGHT_{i}"]
            amp_s = lpos                       # template coords
            amp_e = rpos                       # right primer 3' end index
            size = r[f"PRIMER_PAIR_{i}_PRODUCT_SIZE"]
            if size > 300:
                continue
            if (coff - amp_s) < margin or (amp_e - coff) < margin:
                continue
            return (key, {
                "left": lseq, "right": rseq,
                "ltm": round(r[f"PRIMER_LEFT_{i}_TM"], 1),
                "rtm": round(r[f"PRIMER_RIGHT_{i}_TM"], 1),
                "lgc": round(r[f"PRIMER_LEFT_{i}_GC_PERCENT"], 1),
                "rgc": round(r[f"PRIMER_RIGHT_{i}_GC_PERCENT"], 1),
                "size": size, "pass": ti + 1,
                "amp_start": lo + amp_s + 1,   # genomic 1-based
                "amp_end": lo + amp_e + 1,
                "cut_offset": coff - amp_s,    # cut position within amplicon
            })
    return (key, None)


def main():
    # pick top N guides per gene
    fin = open(RANKED)
    hdr = fin.readline().rstrip("\n").split("\t")
    ix = {k: i for i, k in enumerate(hdr)}
    bygene = defaultdict(list)
    for line in fin:
        p = line.rstrip("\n").split("\t")
        bygene[p[ix["gene_id"]]].append(p)
    jobs = []
    keys = {}
    for gid, rows in bygene.items():
        rows.sort(key=lambda r: -float(r[ix["final"]]))
        for r in rows[:TOPN]:
            key = f"{gid}|{r[ix['chrom']]}|{r[ix['ps_start']]}|{r[ix['strand']]}"
            jobs.append((key, r[ix["chrom"]], int(r[ix["cut"]])))
            keys[key] = True
    print(f"designing primers for {len(jobs)} guides across {len(bygene)} genes",
          file=sys.stderr)

    out = open(OUT, "w")
    out.write("key\tleft\tright\tltm\trtm\tlgc\trgc\tsize\tamp_start\tamp_end\t"
              "cut_offset\tpass\n")
    ok = 0
    with Pool(WORKERS, initializer=init) as pool:
        for i, (key, res) in enumerate(
                pool.imap_unordered(one, jobs, chunksize=200), 1):
            if res:
                out.write(f"{key}\t{res['left']}\t{res['right']}\t{res['ltm']}\t"
                          f"{res['rtm']}\t{res['lgc']}\t{res['rgc']}\t{res['size']}\t"
                          f"{res['amp_start']}\t{res['amp_end']}\t{res['cut_offset']}\t{res['pass']}\n")
                ok += 1
            if i % 20000 == 0:
                print(f"  {i}/{len(jobs)} ok={ok}", file=sys.stderr)
    out.close()
    print(f"primers designed: {ok}/{len(jobs)}", file=sys.stderr)


main()
