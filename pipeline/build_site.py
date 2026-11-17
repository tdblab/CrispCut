#!/usr/bin/env python3
"""Assemble the static site payload for one species.

usage: build_site.py <workdir> <outdir> [top_n] [more_n]
Expects in <workdir>: genes.jsonl, annotation_clean.csv, guides_ranked.tsv,
primers.tsv, primer_spec.tsv (optional), genome.fa
"""
import csv
import json
import os
import sys
from collections import defaultdict

WORK, OUT = sys.argv[1], sys.argv[2]
TOPN = int(sys.argv[3]) if len(sys.argv) > 3 else 10
MOREN = int(sys.argv[4]) if len(sys.argv) > 4 else 20

TIERCODE = {"excellent": 3, "good": 2, "fair": 1, "poor": 0}
COMP = bytes.maketrans(b"ACGTN", b"TGCAN")


def load_genome(path):
    seqs, name, parts = {}, None, []
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


def write_js(path, key, obj):
    """Emit a data file as a classic script that hands its payload to the app.

    Browsers refuse fetch() over file://, but they will still load a <script>
    from disk, so this is what lets the site work by double-clicking
    index.html. The payload is ordinary JSON inside the call."""
    with open(path, "w") as fh:
        fh.write("__ng(")
        json.dump(key, fh, separators=(",", ":"))
        fh.write(",")
        json.dump(obj, fh, separators=(",", ":"))
        fh.write(");\n")


SEQ_K = 20
SEQ_STEP = 12
SEQ_SHARDS = 256
SEQ_OFFBITS = 18


def fnv1a(s):
    h = 0x811C9DC5
    for ch in s:
        h ^= ord(ch)
        h = (h * 0x01000193) & 0xFFFFFFFF
    return h


def build_seqindex(search, cdsstore, out):
    """Sampled k-mer index over all coding sequences, sharded by hash.

    Every SEQ_STEP-th position of each CDS is indexed, so any query of at least
    SEQ_K + SEQ_STEP - 1 bases must cover an indexed position.  The browser
    fetches only the few shards its query touches.
    """
    import array
    d = os.path.join(out, "data", "seqindex")
    os.makedirs(d, exist_ok=True)
    shards = [array.array("I") for _ in range(SEQ_SHARDS)]
    maxoff = (1 << SEQ_OFFBITS) - 1
    n = 0
    for gi, row in enumerate(search):
        seq = cdsstore.get(row[0])
        if not seq:
            continue
        L = len(seq)
        if L > maxoff:
            print(f"  warning: {row[0]} CDS {L} bp exceeds offset field", file=sys.stderr)
        for off in range(0, L - SEQ_K + 1, SEQ_STEP):
            if off > maxoff:
                break
            km = seq[off:off + SEQ_K]
            if "N" in km:
                continue
            h = fnv1a(km)
            shards[h & (SEQ_SHARDS - 1)].extend((h, (gi << SEQ_OFFBITS) | off))
            n += 1
    total = 0
    import base64
    for i, a in enumerate(shards):
        pairs = sorted((a[j], a[j + 1]) for j in range(0, len(a), 2))
        flat = array.array("I")
        for h, p in pairs:
            flat.append(h)
            flat.append(p)
        raw = flat.tobytes()
        write_js(os.path.join(d, f"s{i}.js"), f"shard:{i}",
                 base64.b64encode(raw).decode("ascii"))
        total += len(raw)
    write_js(os.path.join(d, "meta.js"), "seqmeta",
             {"k": SEQ_K, "step": SEQ_STEP, "shards": SEQ_SHARDS,
              "offbits": SEQ_OFFBITS, "entries": n, "enc": "b64"})
    print(f"seqindex: {n} entries, {total/1e6:.1f} MB over {SEQ_SHARDS} shards",
          file=sys.stderr)


def main():
    os.makedirs(os.path.join(OUT, "data", "genes"), exist_ok=True)
    cdsstore = {}

    # ---- names -----------------------------------------------------------
    ann = {}
    with open(os.path.join(WORK, "annotation_clean.csv"), newline="") as fh:
        for r in csv.DictReader(fh):
            ann[r["Locus"]] = r

    # ---- gene models -----------------------------------------------------
    genes = {}
    for line in open(os.path.join(WORK, "genes.jsonl")):
        g = json.loads(line)
        genes[g["gene_id"]] = g

    # ---- primers ---------------------------------------------------------
    primers = {}
    pp = os.path.join(WORK, "primers.tsv")
    if os.path.exists(pp):
        with open(pp) as fh:
            rd = csv.DictReader(fh, delimiter="\t")
            for r in rd:
                primers[r["key"]] = r
    pspec = {}
    sp = os.path.join(WORK, "primer_spec18.tsv")
    if os.path.exists(sp):
        with open(sp) as fh:
            next(fh)
            for line in fh:
                a, b = line.rstrip("\n").split("\t")
                pspec[a] = int(b)

    # ---- ranked guides ---------------------------------------------------
    print("loading ranked guides...", file=sys.stderr)
    bygene = defaultdict(list)
    with open(os.path.join(WORK, "guides_ranked.tsv")) as fh:
        hdr = fh.readline().rstrip("\n").split("\t")
        ix = {k: i for i, k in enumerate(hdr)}
        for line in fh:
            p = line.rstrip("\n").split("\t")
            bygene[p[ix["gene_id"]]].append(p)

    print("loading genome...", file=sys.stderr)
    G = load_genome(os.path.join(WORK, "genome.fa"))

    search = []
    nfiles = 0
    exp = open(os.path.join(OUT, "data", "guides_top.tsv"), "w")
    exp.write("gene_id\tsymbol\tgene_name\tfly_symbol\tchrom\tstrand\tspacer\tpam\t"
              "ps_start\tcut\tcds_pct\tin_all_isoforms\tgc\ttier\tspecificity\t"
              "score\tNGG_0mm\tNGG_1mm\tNGG_2mm\tNGG_3mm\tNGG_4mm\tNAG_0mm\t"
              "NAG_1mm\tNAG_2mm\tNAG_3mm\tNAG_4mm\tot_in_cds_of\tprimer_F\t"
              "primer_R\tamplicon_bp\n")

    for gid, rows in bygene.items():
        g = genes.get(gid)
        if not g:
            continue
        a = ann.get(gid, {})
        rows.sort(key=lambda r: -float(r[ix["final"]]))

        # CDS sequence in transcript orientation
        chrom = g["chrom"]
        seq = G.get(chrom, b"")
        ivs = g["cds"]
        pieces = [seq[s - 1:e] for s, e in ivs]
        cdsseq = b"".join(pieces)
        if g["strand"] == "-":
            cdsseq = cdsseq.translate(COMP)[::-1]

        def pack(r, full):
            st = r[ix["strand"]]
            ps = int(r[ix["ps_start"]])
            key = f"{gid}|{chrom}|{ps}|{st}"
            d = {
                "sp": r[ix["spacer"]], "pam": r[ix["pam"]], "st": st,
                "ps": ps, "cut": int(r[ix["cut"]]),
                "f": round(float(r[ix["cds_frac"]]) * 100, 1),
                "core": int(r[ix["in_core"]]),
                "gc": round(float(r[ix["gc"]]) * 100),
                "pre": round(float(r[ix["prescore"]])),
                "spec": round(float(r[ix["spec"]]), 1),
                "sc": round(float(r[ix["final"]]), 1),
                "t": TIERCODE[r[ix["tier"]]],
                "n": [int(r[ix[f"n{i}"]]) for i in range(5)],
                "a": [int(r[ix[f"a{i}"]]) for i in range(5)],
            }
            if not full:
                return d
            d["ctx"] = r[ix["ctx30"]]
            d["ex"] = int(r[ix["exon_idx"]])
            otg = r[ix["ot_cds_genes"]].strip()
            if otg:
                d["otg"] = [{"id": x,
                             "sym": ann.get(x, {}).get("Short_Name", "") or x}
                            for x in otg.split(",") if x]
            ot = r[ix["ot_top"]].strip()
            if ot:
                hits = []
                for h in ot.split(";"):
                    if not h:
                        continue
                    pr = h.split(":")
                    if len(pr) < 5:
                        continue
                    loc = pr[1]
                    hit = {"c": pr[0], "p": int(loc[:-1]), "s": loc[-1],
                           "mm": int(pr[2][:-2]), "sd": int(pr[3][1:]),
                           "pam": pr[4]}
                    if len(pr) > 5 and pr[5]:
                        hit["g"] = pr[5]
                        hit["gs"] = ann.get(pr[5], {}).get("Short_Name", "") or pr[5]
                        hit["k"] = pr[6] if len(pr) > 6 else ""
                    hits.append(hit)
                # keep every actionable site (<=3 mismatches); 4-mismatch hits
                # are mostly chance in a 457 Mb genome, so keep a couple only
                # to show how far the nearest site is
                close = [h for h in hits if h["mm"] <= 3]
                if len(close) < 3:
                    close += [h for h in hits if h["mm"] == 4][:3 - len(close)]
                if close:
                    d["ot"] = close
            pm = primers.get(key)
            if pm:
                d["pr"] = {
                    "F": pm["left"], "R": pm["right"],
                    "ftm": float(pm["ltm"]), "rtm": float(pm["rtm"]),
                    "fgc": float(pm["lgc"]), "rgc": float(pm["rgc"]),
                    "size": int(pm["size"]),
                    "s": int(pm["amp_start"]), "e": int(pm["amp_end"]),
                    "co": int(pm["cut_offset"]),
                    # genomic sequence of the product, so the site can show
                    # exactly what gets amplified, introns included
                    "seq": seq[int(pm["amp_start"]) - 1:int(pm["amp_end"])].decode(),
                }
                fh_ = pspec.get(pm["left"][-18:])
                rh_ = pspec.get(pm["right"][-18:])
                if fh_ is not None:
                    d["pr"]["fh"] = fh_
                if rh_ is not None:
                    d["pr"]["rh"] = rh_
            return d

        top = [pack(r, True) for r in rows[:TOPN]]
        # Put the most actionable guide first: cleanest tier wins, then having
        # a working primer pair, then the composite score. A guide you cannot
        # genotype is not a good first choice.
        top.sort(key=lambda d: (-d["t"], 0 if d.get("pr") else 1, -d["sc"]))
        more = [pack(r, False) for r in rows[TOPN:TOPN + MOREN]]

        sym = a.get("Short_Name", "") or gid
        name = a.get("Gene_Name", "") or a.get("NCBI_Protein_Name", "")
        rec = {
            "id": gid, "sym": sym, "name": name,
            "fly": a.get("Fly_Symbol", ""), "fb": a.get("FlyBase_ID", ""),
            "conf": a.get("Fly_Confidence", ""), "basis": a.get("Name_Basis", ""),
            "ncbi": a.get("NCBI_Protein_Name", ""),
            "aa": a.get("Longest_Protein_aa", ""),
            "chrom": chrom, "strand": g["strand"],
            "cds": ivs, "core": g["cds_core"], "cds_len": g["cds_len"],
            "ntx": g["n_tx"], "tx": g["rep_tx"],
            "seq": cdsseq.decode(),
            "guides": top, "more": more,
            "n_scanned": len(rows),
        }
        cdsstore[gid] = rec["seq"]
        sub = os.path.join(OUT, "data", "genes", gid[:6])
        os.makedirs(sub, exist_ok=True)
        write_js(os.path.join(sub, gid + ".js"), "gene:" + gid, rec)
        nfiles += 1

        best = max((x["t"] for x in top), default=0)
        nexc = sum(1 for x in top if x["t"] == 3)
        search.append([gid, sym, name, a.get("Fly_Symbol", ""),
                       a.get("FlyBase_ID", ""), chrom, g["strand"],
                       g["cds_len"], len(ivs), best, nexc, len(top)])

        for x in top:
            pr = x.get("pr", {})
            exp.write(f"{gid}\t{sym}\t{name}\t{a.get('Fly_Symbol','')}\t{chrom}\t"
                      f"{x['st']}\t{x['sp']}\t{x['pam']}\t{x['ps']}\t{x['cut']}\t"
                      f"{x['f']}\t{x['core']}\t{x['gc']}\t{x['t']}\t{x['spec']}\t"
                      f"{x['sc']}\t" + "\t".join(str(v) for v in x["n"]) + "\t" +
                      "\t".join(str(v) for v in x["a"]) + "\t" +
                      ",".join(o["sym"] for o in x.get("otg", [])) + "\t" +
                      f"{pr.get('F','')}\t{pr.get('R','')}\t{pr.get('size','')}\n")

        if nfiles % 2000 == 0:
            print(f"  {nfiles} genes", file=sys.stderr)
    exp.close()

    search.sort(key=lambda r: r[1].lower())
    write_js(os.path.join(OUT, "data", "search.js"), "search",
             {"v": 1, "g": search})

    build_seqindex(search, cdsstore, OUT)

    nguides = sum(r[11] for r in search)
    meta = {
        "species": "Bicyclus anynana",
        "common": "squinting bush brown",
        "assembly": "ilBicAnyn1.1 (GCF_947172395.1)",
        "annotation": "NCBI RefSeq, iBany1.1",
        "n_genes": len(search),
        "n_guides_published": nguides,
        "n_scanned": sum(len(v) for v in bygene.values()),
        "top_n": TOPN, "more_n": MOREN,
        "nuclease": "SpCas9, 20 nt spacer, NGG PAM",
        "ot_search": "complete to 4 mismatches, NGG and NAG PAMs, both strands, "
                     "whole assembly (457.2 Mb)",
        "weights": {"mm": [20, 4, 0.6, 0.08, 0.004], "nag": 0.1},
    }
    write_js(os.path.join(OUT, "data", "meta.js"), "meta", meta)
    # a plain JSON copy of the small metadata file, for scripts
    with open(os.path.join(OUT, "data", "meta.json"), "w") as fh:
        json.dump(meta, fh, indent=1)
    print(f"genes={nfiles} guides={nguides}", file=sys.stderr)


main()
