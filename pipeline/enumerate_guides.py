#!/usr/bin/env python3
"""Enumerate all SpCas9 (NGG) guides fully contained in CDS exons.

For every protein-coding gene, every 23-mer (20nt protospacer + NGG) that lies
entirely within a single CDS exon of the representative transcript, on both
strands.  Emits sequence-rule features and a rule-only prescore used to pick
which guides go to the (expensive) genome-wide off-target scan.

Outputs
  guides_all.tsv   every guide (for the exon map + sequence search)
  guides_scan.tsv  subset sent to the off-target scanner, spread along the CDS
"""
import json
import sys
from collections import defaultdict

GENOME = sys.argv[1]
GENES = sys.argv[2]
OUT_ALL = sys.argv[3]
OUT_SCAN = sys.argv[4]
PER_GENE = int(sys.argv[5]) if len(sys.argv) > 5 else 40
NBIN = 10  # pick the best guides within each decile of the CDS for even coverage

COMP = bytes.maketrans(b"ACGTN", b"TGCAN")


def load_genome(path):
    seqs = {}
    name = None
    parts = []
    with open(path, "rb") as fh:
        for line in fh:
            if line[:1] == b">":
                if name:
                    seqs[name] = b"".join(parts).upper()
                name = line[1:].split()[0].decode()
                parts = []
            else:
                parts.append(line.strip())
    if name:
        seqs[name] = b"".join(parts).upper()
    return seqs


def rc(b):
    return b.translate(COMP)[::-1]


def gc_frac(s):
    return (s.count(b"G") + s.count(b"C")) / len(s)


def max_homopolymer(s):
    best = run = 1
    for i in range(1, len(s)):
        run = run + 1 if s[i] == s[i - 1] else 1
        if run > best:
            best = run
    return best


def self_comp(s):
    """Count of 5-mers in the spacer whose reverse complement also occurs.
    Crude proxy for internal hairpins / duplex formation."""
    n = 0
    seen = {s[i:i + 5] for i in range(len(s) - 4)}
    for k in seen:
        if rc(k) in seen:
            n += 1
    return n


def prescore(spacer, cds_frac, in_core, dist_edge):
    """Rule-only score, 0-100. Documented sequence determinants of SpCas9
    sgRNA performance; NOT a trained efficiency predictor."""
    s = 50.0
    gc = gc_frac(spacer)
    if 0.40 <= gc <= 0.65:
        s += 15
    elif 0.30 <= gc <= 0.75:
        s += 5
    else:
        s -= 15
    if b"TTTT" in spacer:
        s -= 25           # Pol III termination signal in U6-driven sgRNA
    hp = max_homopolymer(spacer)
    if hp >= 5:
        s -= 10
    elif hp == 4:
        s -= 3
    if spacer[19:20] == b"G":
        s += 5            # G at the PAM-proximal position
    if spacer[0:1] in (b"G", b"A"):
        s += 2
    sc = self_comp(spacer)
    s -= min(10, 2 * sc)
    # position in the coding sequence: early truncation is more likely null,
    # but the extreme 5' end can be rescued by downstream ATGs
    if 0.05 <= cds_frac <= 0.40:
        s += 12
    elif cds_frac < 0.05:
        s += 2
    elif cds_frac <= 0.65:
        s += 6
    elif cds_frac <= 0.85:
        s += 0
    else:
        s -= 12           # last 15% of the CDS often tolerates indels
    if in_core:
        s += 6            # CDS shared by every annotated isoform
    if dist_edge < 6:
        s -= 6            # cut site very close to a splice junction
    return max(0.0, min(100.0, s))


def main():
    print("loading genome...", file=sys.stderr)
    G = load_genome(GENOME)
    print(f"  {len(G)} sequences, {sum(len(v) for v in G.values())/1e6:.1f} Mb",
          file=sys.stderr)

    fa = open(OUT_ALL, "w")
    fs = open(OUT_SCAN, "w")
    hdr = ("gene_id\tchrom\tstrand\tspacer\tpam\tctx30\tps_start\tps_end\t"
           "cut\tcds_frac\tin_core\texon_idx\tdist_edge\tgc\tprescore\n")
    fa.write(hdr)
    fs.write(hdr)

    n_all = n_scan = 0
    n_genes = 0
    for line in open(GENES):
        g = json.loads(line)
        chrom = g["chrom"]
        seq = G.get(chrom)
        if seq is None:
            continue
        cds = [(a, b) for a, b in g["cds"]]
        if not cds:
            continue
        core = [(a, b) for a, b in g["cds_core"]]
        coreset = None
        if core != cds:
            coreset = set()
            for a, b in core:
                coreset.update(range(a, b + 1))
        gstrand = g["strand"]
        cds_len = g["cds_len"]

        # cumulative CDS offset of each exon, in transcript orientation
        order = list(range(len(cds)))
        if gstrand == "-":
            order = order[::-1]
        cum = {}
        acc = 0
        for oi in order:
            cum[oi] = acc
            acc += cds[oi][1] - cds[oi][0] + 1

        rows = []
        for ei in range(len(cds)):
            a, b = cds[ei]
            exlen = b - a + 1
            if exlen < 23:
                continue
            ex = seq[a - 1:b]
            if b"N" in ex:
                pass  # handled per-guide below
            # + strand: protospacer ex[i:i+20], PAM ex[i+20:i+23]
            for i in range(0, exlen - 22):
                if ex[i + 21:i + 23] != b"GG":
                    continue
                sp = ex[i:i + 20]
                if b"N" in sp:
                    continue
                ps = a + i                      # genomic 1-based start
                cut = ps + 16
                ctx = seq[max(0, ps - 1 - 4):ps - 1 + 26]
                if len(ctx) != 30 or b"N" in ctx:
                    ctx = b"."
                rows.append((ei, "+", sp, ex[i + 20:i + 23], ctx, ps, ps + 19,
                             cut, i, exlen - (i + 23)))
            # - strand: PAM is CCN on the + strand at ex[i:i+3]
            for i in range(0, exlen - 22):
                if ex[i:i + 2] != b"CC":
                    continue
                sp = rc(ex[i + 3:i + 23])
                if b"N" in sp:
                    continue
                aa = a + i + 3                  # genomic start of protospacer
                cut = aa + 2
                ctx = seq[max(0, aa - 1 - 3):aa - 1 + 27]
                if len(ctx) == 30 and b"N" not in ctx:
                    ctx = rc(ctx)
                else:
                    ctx = b"."
                rows.append((ei, "-", sp, rc(ex[i:i + 3]), ctx, aa, aa + 19,
                             cut, i, exlen - (i + 23)))

        out = []
        for (ei, st, sp, pam, ctx, p1, p2, cut, left, right) in rows:
            # CDS fraction of the cut site, transcript orientation
            a, b = cds[ei]
            if gstrand == "+":
                off = cum[ei] + (cut - a)
            else:
                off = cum[ei] + (b - cut)
            frac = off / cds_len if cds_len else 0.0
            in_core = True if coreset is None else (cut in coreset)
            dist_edge = min(left, right)
            spd = sp.decode()
            scr = prescore(sp, frac, in_core, dist_edge)
            out.append((spd, pam.decode(), ctx.decode(), st, p1, p2, cut,
                        frac, in_core, ei, dist_edge, gc_frac(sp), scr))

        # dedupe identical genomic sites
        seen = set()
        ded = []
        for r in out:
            k = (r[4], r[3])
            if k in seen:
                continue
            seen.add(k)
            ded.append(r)
        ded.sort(key=lambda r: r[4])

        for r in ded:
            fa.write(f"{g['gene_id']}\t{chrom}\t{r[3]}\t{r[0]}\t{r[1]}\t{r[2]}\t"
                     f"{r[4]}\t{r[5]}\t{r[6]}\t{r[7]:.4f}\t{int(r[8])}\t{r[9]}\t"
                     f"{r[10]}\t{r[11]:.3f}\t{r[12]:.1f}\n")
        n_all += len(ded)

        # pick guides for the off-target scan: best per CDS decile, then best overall
        bins = defaultdict(list)
        for r in ded:
            bins[min(NBIN - 1, int(r[7] * NBIN))].append(r)
        pick = []
        per_bin = max(1, PER_GENE // NBIN)
        for bi in range(NBIN):
            cand = sorted(bins.get(bi, []), key=lambda r: -r[12])
            pick.extend(cand[:per_bin])
        if len(pick) < PER_GENE:
            have = {(r[4], r[3]) for r in pick}
            extra = sorted((r for r in ded if (r[4], r[3]) not in have),
                           key=lambda r: -r[12])
            pick.extend(extra[:PER_GENE - len(pick)])
        for r in sorted(pick, key=lambda r: r[4]):
            fs.write(f"{g['gene_id']}\t{chrom}\t{r[3]}\t{r[0]}\t{r[1]}\t{r[2]}\t"
                     f"{r[4]}\t{r[5]}\t{r[6]}\t{r[7]:.4f}\t{int(r[8])}\t{r[9]}\t"
                     f"{r[10]}\t{r[11]:.3f}\t{r[12]:.1f}\n")
        n_scan += len(pick)
        n_genes += 1
        if n_genes % 2000 == 0:
            print(f"  {n_genes} genes, {n_all} guides", file=sys.stderr)

    fa.close()
    fs.close()
    print(f"genes={n_genes} all_guides={n_all} scan_guides={n_scan}",
          file=sys.stderr)


main()
