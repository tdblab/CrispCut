#!/usr/bin/env python3
"""Cut a small, fully working preview out of the full site."""
import array
import base64
import json
import os
import shutil
import sys

SRC, DST = sys.argv[1], sys.argv[2]
SHARDS = 16
K, STEP, OFFBITS = 20, 12, 18

WANT = ["Optix", "wg", "Dll", "hh", "Antp", "dsx", "ap", "Ubx", "ci", "dpp",
        "N", "sd", "vg", "so", "arm", "Abd-B", "br", "usp", "EcR", "ple",
        "al", "dl", "wnt6", "fz4", "Dr", "ey", "toy", "esg", "sna", "run",
        "hairy", "Ser"]


def write_js(path, key, obj):
    with open(path, "w") as fh:
        fh.write("__ng(")
        json.dump(key, fh, separators=(",", ":"))
        fh.write(",")
        json.dump(obj, fh, separators=(",", ":"))
        fh.write(");\n")


def fnv1a(s):
    h = 0x811C9DC5
    for ch in s:
        h ^= ord(ch)
        h = (h * 0x01000193) & 0xFFFFFFFF
    return h


def read_js(path):
    raw = open(path).read()
    i = raw.index(",")
    return json.loads(raw[i + 1:raw.rindex(");")])


idx = read_js(os.path.join(SRC, "data", "search.js"))["g"]
by = {}
for r in idx:
    by.setdefault(r[1].lower(), r)

picked, seen = [], set()
for w in WANT:
    r = by.get(w.lower())
    if r and r[0] not in seen:
        picked.append(r)
        seen.add(r[0])
# pad with genes that have an interesting off-target profile
for r in idx:
    if len(picked) >= 34:
        break
    if r[0] in seen or r[9] == 3:
        continue
    picked.append(r)
    seen.add(r[0])

shutil.rmtree(DST, ignore_errors=True)
os.makedirs(os.path.join(DST, "assets"), exist_ok=True)
os.makedirs(os.path.join(DST, "data", "genes"), exist_ok=True)
os.makedirs(os.path.join(DST, "data", "seqindex"), exist_ok=True)
for f in ["index.html"]:
    shutil.copy(os.path.join(SRC, f), os.path.join(DST, f))
for f in ["app.css", "app.js", "mark.svg"]:
    shutil.copy(os.path.join(SRC, "assets", f), os.path.join(DST, "assets", f))

picked.sort(key=lambda r: r[1].lower())
cds = {}
for gi, r in enumerate(picked):
    gid = r[0]
    sub = os.path.join(DST, "data", "genes", gid[:6])
    os.makedirs(sub, exist_ok=True)
    src = os.path.join(SRC, "data", "genes", gid[:6], gid + ".js")
    rec = read_js(src)
    cds[gi] = rec["seq"]
    write_js(os.path.join(sub, gid + ".js"), "gene:" + gid, rec)

write_js(os.path.join(DST, "data", "search.js"), "search", {"v": 1, "g": picked})

shards = [array.array("I") for _ in range(SHARDS)]
n = 0
for gi, seq in cds.items():
    for off in range(0, len(seq) - K + 1, STEP):
        km = seq[off:off + K]
        if "N" in km:
            continue
        h = fnv1a(km)
        shards[h & (SHARDS - 1)].extend((h, (gi << OFFBITS) | off))
        n += 1
for i, a in enumerate(shards):
    pairs = sorted((a[j], a[j + 1]) for j in range(0, len(a), 2))
    flat = array.array("I")
    for h, p in pairs:
        flat.extend((h, p))
    write_js(os.path.join(DST, "data", "seqindex", f"s{i}.js"), f"shard:{i}",
             base64.b64encode(flat.tobytes()).decode("ascii"))
write_js(os.path.join(DST, "data", "seqindex", "meta.js"), "seqmeta",
         {"k": K, "step": STEP, "shards": SHARDS, "offbits": OFFBITS,
          "entries": n, "enc": "b64"})

meta = read_js(os.path.join(SRC, "data", "meta.js"))
meta["preview_note"] = (f"Preview build: {len(picked)} genes of "
                        f"{meta['n_genes']:,}. Everything else is the real site.")
meta["n_genes_preview"] = len(picked)
write_js(os.path.join(DST, "data", "meta.js"), "meta", meta)

print(f"preview: {len(picked)} genes, {n} seqindex entries")
print("genes:", ", ".join(r[1] for r in picked))
