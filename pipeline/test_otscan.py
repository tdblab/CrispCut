#!/usr/bin/env python3
"""Verify otscan against an independent brute-force scan on a random genome."""
import os
import random
import struct
import subprocess
import sys

random.seed(7)
TMP = "/tmp/ottest"
os.makedirs(TMP, exist_ok=True)
COMP = str.maketrans("ACGT", "TGCA")


def rc(s):
    return s.translate(COMP)[::-1]


# --- random genome with a few planted near-matches -------------------------
chroms = {}
for ci, nm in enumerate(["chrA", "chrB"]):
    L = 60000 if ci == 0 else 25000
    chroms[nm] = [random.choice("ACGT") for _ in range(L)]
# sprinkle some N
for i in range(0, 300):
    chroms["chrA"][random.randrange(50000)] = "N"

names = list(chroms)

# pick queries from real NGG sites in chrA so on-targets exist
def sites(seq):
    out = []
    s = "".join(seq)
    for i in range(len(s) - 22):
        if s[i + 21] == "G" and s[i + 22] == "G":
            sp = s[i:i + 20]
            if "N" not in sp:
                out.append((sp, 0, i + 1, 0))
    return out


cand = sites(chroms["chrA"])
random.shuffle(cand)
queries = cand[:40]

# plant mutated copies of some queries into chrB so there are known off-targets
for qi in range(8):
    sp = queries[qi][0]
    l = list(sp)
    for _ in range(random.randint(1, 3)):
        p = random.randrange(20)
        l[p] = random.choice([c for c in "ACGT" if c != l[p]])
    mut = "".join(l)
    pos = 1000 + qi * 500
    pam = random.choice(["AGG", "TGG", "CAG", "GGG"])
    if qi % 2 == 0:
        chroms["chrB"][pos:pos + 23] = list(mut + pam)
    else:
        blk = rc(mut + pam)
        chroms["chrB"][pos:pos + 23] = list(blk)

fa = os.path.join(TMP, "g.fa")
with open(fa, "w") as fh:
    for nm in names:
        fh.write(">" + nm + " test\n")
        s = "".join(chroms[nm])
        for i in range(0, len(s), 70):
            fh.write(s[i:i + 70] + "\n")

qf = os.path.join(TMP, "q.txt")
with open(qf, "w") as fh:
    for sp, ci, ps, st in queries:
        fh.write(f"{sp}\t{ci}\t{ps}\t{st}\n")

MAXMM = 3
subprocess.run(["/home/claude/scripts/otscan", fa, qf,
                os.path.join(TMP, "c.bin"), os.path.join(TMP, "h.bin"),
                str(MAXMM), "2"], check=True, cwd=TMP,
               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

nq, nslot, maxhit, _ = struct.unpack("<4i", open(os.path.join(TMP, "c.bin"), "rb").read(16))
data = open(os.path.join(TMP, "c.bin"), "rb").read()[16:]
got = {}
for i in range(nq):
    got[i] = list(struct.unpack_from("<" + "I" * nslot, data, i * 4 * nslot))

# --- independent brute force ----------------------------------------------
exp = {i: [0] * (MAXMM + 1) for i in range(nq)}
for ci, nm in enumerate(names):
    s = "".join(chroms[nm])
    L = len(s)
    for i in range(L - 22):
        # plus
        if s[i + 22] == "G" and s[i + 21] in "GA":
            t = s[i:i + 20]
            if "N" not in t:
                for qi, (sp, qc, qp, qs) in enumerate(queries):
                    mm = sum(1 for a, b in zip(sp, t) if a != b)
                    if mm <= MAXMM:
                        if mm == 0 and s[i + 21] == "G" and qs == 0 and qc == ci and qp == i + 1:
                            continue
                        exp[qi][mm] += 1
        # minus: need rc(s[i+3:i+23]) as protospacer, PAM rc(s[i:i+3])
        if s[i] == "C" and s[i + 1] in "CT":
            blk = s[i + 3:i + 23]
            if "N" not in blk and len(blk) == 20:
                t = rc(blk)
                for qi, (sp, qc, qp, qs) in enumerate(queries):
                    mm = sum(1 for a, b in zip(sp, t) if a != b)
                    if mm <= MAXMM:
                        if mm == 0 and s[i + 1] == "C" and qs == 1 and qc == ci and qp == i + 4:
                            continue
                        exp[qi][mm] += 1

bad = 0
for i in range(nq):
    if got[i] != exp[i]:
        bad += 1
        if bad <= 6:
            print(f"MISMATCH q{i} {queries[i][0]} got={got[i]} exp={exp[i]}")
print(f"queries={nq}  mismatched={bad}")
tot_exp = sum(sum(v) for v in exp.values())
print(f"total expected hits={tot_exp}")
print("PASS" if bad == 0 and tot_exp > 0 else "FAIL")
sys.exit(0 if bad == 0 and tot_exp > 0 else 1)
