/* otscan.c -- exhaustive SpCas9 off-target scanner.
 *
 * Streams a genome, both strands, every NGG and NAG PAM site, and finds every
 * site within MAXMM mismatches of any query spacer.  Completeness comes from
 * the pigeonhole principle: a 20-mer with <= 3 mismatches must match one of
 * four 5-nt blocks exactly, so indexing all four blocks of every query and
 * looking up all four blocks of every genomic site cannot miss a hit.
 *
 * Encoding: 2 bits/base, protospacer position 1 (PAM-distal) in bits 38-39,
 * position 20 (PAM-proximal) in bits 0-1.  Seed = positions 9-20 = bits 0-23.
 *
 * build: gcc -O3 -march=native -fopenmp -o otscan otscan.c
 * usage: ./otscan genome.fa queries.txt counts.bin hits.bin [maxmm] [threads]
 *   queries.txt: spacer<TAB>chrom_idx<TAB>ps_start<TAB>strand(0=+,1=-)
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#ifdef _OPENMP
#include <omp.h>
#endif

#define K 20
#ifndef NBLK
#define NBLK 4                /* 4 blocks x 5 bases -> complete to 3 mismatches */
#endif
#ifndef BLKBITS
#define BLKBITS 10
#endif
#define NBUCK (1 << BLKBITS)
#define BSHIFT(b) (2 * K - BLKBITS * ((b) + 1))
#ifndef MAXHIT
#define MAXHIT 16
#endif
#define SEEDMASK 0xFFFFFFull  /* positions 9-20 */

static int MAXMM = 3;

typedef struct { uint64_t key; uint32_t qid; } Entry;

typedef struct {
    int32_t pos;      /* 1-based genomic start of protospacer */
    uint8_t chrom;
    uint8_t strand;   /* 0 = +, 1 = - */
    uint8_t mm;
    uint8_t seedmm;
    uint8_t pam;      /* 0 = NGG, 1 = NAG */
    uint8_t pad[3];
} Hit;

static inline int popc64(uint64_t x) { return __builtin_popcountll(x); }

static inline int mmcount(uint64_t x) {
    uint64_t m = (x | (x >> 1)) & 0x5555555555555555ull;
    return popc64(m);
}
static inline int seedmmcount(uint64_t x) {
    uint64_t m = (x | (x >> 1)) & 0x5555555555555555ull;
    return popc64(m & SEEDMASK);
}

static const int8_t CODE[256] = {
    ['A'] = 0, ['C'] = 1, ['G'] = 2, ['T'] = 3,
    ['a'] = 0, ['c'] = 1, ['g'] = 2, ['t'] = 3
};
static int8_t VALID[256];

/* ---------------- genome loading ---------------- */
typedef struct { char name[256]; uint8_t *b; int64_t len; } Chrom;

static Chrom *load_fa(const char *path, int *nc_out) {
    FILE *f = fopen(path, "rb");
    if (!f) { perror(path); exit(1); }
    int cap = 256, nc = 0;
    Chrom *cs = calloc(cap, sizeof(Chrom));
    int64_t bcap = 0;
    char *line = malloc(1 << 20);
    while (fgets(line, 1 << 20, f)) {
        if (line[0] == '>') {
            nc++;
            if (nc > cap) { cap *= 2; cs = realloc(cs, cap * sizeof(Chrom));
                            memset(cs + cap / 2, 0, (cap / 2) * sizeof(Chrom)); }
            char *p = line + 1, *q = cs[nc - 1].name;
            int i = 0;
            while (*p && *p != ' ' && *p != '\t' && *p != '\n' && i < 255) q[i++] = *p++;
            q[i] = 0;
            bcap = 1 << 20;
            cs[nc - 1].b = malloc(bcap);
            cs[nc - 1].len = 0;
        } else {
            if (!nc) continue;
            Chrom *c = &cs[nc - 1];
            int64_t n = strlen(line);
            while (n && (line[n - 1] == '\n' || line[n - 1] == '\r')) n--;
            if (c->len + n > bcap) {
                while (c->len + n > bcap) bcap *= 2;
                c->b = realloc(c->b, bcap);
            }
            memcpy(c->b + c->len, line, n);
            c->len += n;
        }
    }
    free(line);
    fclose(f);
    *nc_out = nc;
    return cs;
}

/* ---------------- main ---------------- */
int main(int argc, char **argv) {
    if (argc < 5) { fprintf(stderr, "usage: %s genome.fa queries.txt counts.bin hits.bin [maxmm] [threads]\n", argv[0]); return 1; }
    if (argc > 5) MAXMM = atoi(argv[5]);
    int nthreads = (argc > 6) ? atoi(argv[6]) : 2;
    for (int i = 0; i < 256; i++) VALID[i] = 0;
    VALID['A'] = VALID['C'] = VALID['G'] = VALID['T'] = 1;
    VALID['a'] = VALID['c'] = VALID['g'] = VALID['t'] = 1;

    /* ---- queries ---- */
    fprintf(stderr, "reading queries...\n");
    FILE *qf = fopen(argv[2], "r");
    if (!qf) { perror(argv[2]); return 1; }
    int64_t qcap = 1 << 20, nq = 0;
    uint64_t *qkey = malloc(qcap * sizeof(uint64_t));
    uint8_t *qchrom = malloc(qcap), *qstrand = malloc(qcap);
    int32_t *qpos = malloc(qcap * sizeof(int32_t));
    char buf[512];
    while (fgets(buf, sizeof buf, qf)) {
        char sp[64]; int ci, st; long ps;
        if (sscanf(buf, "%63s\t%d\t%ld\t%d", sp, &ci, &ps, &st) != 4) continue;
        if (strlen(sp) != K) continue;
        uint64_t k = 0; int ok = 1;
        for (int i = 0; i < K; i++) {
            unsigned char c = (unsigned char)sp[i];
            if (!VALID[c]) { ok = 0; break; }
            k = (k << 2) | (uint64_t)CODE[c];
        }
        if (!ok) continue;
        if (nq == qcap) {
            qcap *= 2;
            qkey = realloc(qkey, qcap * sizeof(uint64_t));
            qchrom = realloc(qchrom, qcap); qstrand = realloc(qstrand, qcap);
            qpos = realloc(qpos, qcap * sizeof(int32_t));
        }
        qkey[nq] = k; qchrom[nq] = (uint8_t)ci; qpos[nq] = (int32_t)ps;
        qstrand[nq] = (uint8_t)st;
        nq++;
    }
    fclose(qf);
    fprintf(stderr, "  %lld queries\n", (long long)nq);

    /* ---- block index over queries (CSR) ---- */
    int64_t *cnt = calloc((int64_t)NBLK * NBUCK + 1, sizeof(int64_t));
    for (int64_t i = 0; i < nq; i++)
        for (int b = 0; b < NBLK; b++) {
            uint32_t v = (uint32_t)((qkey[i] >> BSHIFT(b)) & (NBUCK - 1));
            cnt[(int64_t)b * NBUCK + v + 1]++;
        }
    for (int64_t i = 0; i < (int64_t)NBLK * NBUCK; i++) cnt[i + 1] += cnt[i];
    int64_t total = cnt[(int64_t)NBLK * NBUCK];
    Entry *ent = malloc(total * sizeof(Entry));
    int64_t *fill = malloc(((int64_t)NBLK * NBUCK) * sizeof(int64_t));
    memcpy(fill, cnt, ((int64_t)NBLK * NBUCK) * sizeof(int64_t));
    for (int64_t i = 0; i < nq; i++)
        for (int b = 0; b < NBLK; b++) {
            uint32_t v = (uint32_t)((qkey[i] >> BSHIFT(b)) & (NBUCK - 1));
            int64_t s = fill[(int64_t)b * NBUCK + v]++;
            ent[s].key = qkey[i]; ent[s].qid = (uint32_t)i;
        }
    free(fill);
    fprintf(stderr, "  index: %lld entries (%.1f MB)\n", (long long)total,
            total * sizeof(Entry) / 1e6);

    /* ---- genome ---- */
    int nc = 0;
    fprintf(stderr, "loading genome...\n");
    Chrom *cs = load_fa(argv[1], &nc);
    int64_t gtot = 0;
    for (int i = 0; i < nc; i++) gtot += cs[i].len;
    fprintf(stderr, "  %d sequences, %.1f Mb\n", nc, gtot / 1e6);
    FILE *nf = fopen("chrom_order.txt", "w");
    for (int i = 0; i < nc; i++) fprintf(nf, "%d\t%s\t%lld\n", i, cs[i].name, (long long)cs[i].len);
    fclose(nf);

    int nmmslot = 2 * (MAXMM + 1);  /* [NGG 0..MAXMM][NAG 0..MAXMM] */
#ifdef _OPENMP
    omp_set_num_threads(nthreads);
#else
    nthreads = 1;
#endif
    uint32_t **tcounts = malloc(nthreads * sizeof(uint32_t *));
    Hit **thits = malloc(nthreads * sizeof(Hit *));
    uint8_t **tnh = malloc(nthreads * sizeof(uint8_t *));
    for (int t = 0; t < nthreads; t++) {
        tcounts[t] = calloc((size_t)nq * nmmslot, sizeof(uint32_t));
        thits[t] = calloc((size_t)nq * MAXHIT, sizeof(Hit));
        tnh[t] = calloc(nq, 1);
        if (!tcounts[t] || !thits[t] || !tnh[t]) { fprintf(stderr, "OOM\n"); return 1; }
    }

    fprintf(stderr, "scanning (maxmm=%d, threads=%d)...\n", MAXMM, nthreads);
    for (int ci = 0; ci < nc; ci++) {
        const uint8_t *B = cs[ci].b;
        int64_t L = cs[ci].len;
        if (L < K + 3) continue;
#pragma omp parallel
        {
            int tid = 0;
#ifdef _OPENMP
            tid = omp_get_thread_num();
#endif
            uint32_t *myc = tcounts[tid];
            Hit *myh = thits[tid];
            uint8_t *mynh = tnh[tid];
#pragma omp for schedule(static)
            for (int64_t i = 0; i <= L - (K + 3); i++) {
                /* ---- plus strand: protospacer B[i..i+19], PAM B[i+20..i+22] ---- */
                uint8_t p1 = B[i + 21], p2 = B[i + 22];
                int isgg = (p2 == 'G' || p2 == 'g');
                if (isgg) {
                    int pam = -1;
                    if (p1 == 'G' || p1 == 'g') pam = 0;
                    else if (p1 == 'A' || p1 == 'a') pam = 1;
                    if (pam >= 0) {
                        uint64_t t = 0; int ok = 1;
                        for (int j = 0; j < K; j++) {
                            unsigned char c = B[i + j];
                            if (!VALID[c]) { ok = 0; break; }
                            t = (t << 2) | (uint64_t)CODE[c];
                        }
                        if (ok) {
                            int32_t gpos = (int32_t)(i + 1);
                            for (int b = 0; b < NBLK; b++) {
                                uint32_t v = (uint32_t)((t >> BSHIFT(b)) & (NBUCK - 1));
                                int64_t s = cnt[(int64_t)b * NBUCK + v];
                                int64_t e = cnt[(int64_t)b * NBUCK + v + 1];
                                for (int64_t z = s; z < e; z++) {
                                    uint64_t x = ent[z].key ^ t;
                                    int mm = mmcount(x);
                                    if (mm > MAXMM) continue;
                                    int dup = 0;
                                    for (int b2 = 0; b2 < b; b2++)
                                        if (((x >> BSHIFT(b2)) & (NBUCK - 1)) == 0) { dup = 1; break; }
                                    if (dup) continue;
                                    uint32_t q = ent[z].qid;
                                    if (mm == 0 && pam == 0 && qstrand[q] == 0 &&
                                        qchrom[q] == (uint8_t)ci && qpos[q] == gpos) continue;
                                    myc[(size_t)q * nmmslot + pam * (MAXMM + 1) + mm]++;
                                    if (mynh[q] < MAXHIT) {
                                        Hit *h = &myh[(size_t)q * MAXHIT + mynh[q]++];
                                        h->pos = gpos; h->chrom = (uint8_t)ci; h->strand = 0;
                                        h->mm = (uint8_t)mm; h->seedmm = (uint8_t)seedmmcount(x);
                                        h->pam = (uint8_t)pam;
                                    }
                                }
                            }
                        }
                    }
                }
                /* ---- minus strand: PAM CC/CT at B[i..i+1], protospacer rc(B[i+3..i+22]) ---- */
                uint8_t m0 = B[i], m1 = B[i + 1];
                if (m0 == 'C' || m0 == 'c') {
                    int pam = -1;
                    if (m1 == 'C' || m1 == 'c') pam = 0;
                    else if (m1 == 'T' || m1 == 't') pam = 1;
                    if (pam >= 0) {
                        uint64_t t = 0; int ok = 1;
                        /* protospacer 5'->3' on minus strand runs from i+22 down to i+3 */
                        for (int j = 0; j < K; j++) {
                            unsigned char c = B[i + 22 - j];
                            if (!VALID[c]) { ok = 0; break; }
                            t = (t << 2) | (uint64_t)(3 - CODE[c]);
                        }
                        if (ok) {
                            int32_t gpos = (int32_t)(i + 4); /* 1-based genomic start of protospacer */
                            for (int b = 0; b < NBLK; b++) {
                                uint32_t v = (uint32_t)((t >> BSHIFT(b)) & (NBUCK - 1));
                                int64_t s = cnt[(int64_t)b * NBUCK + v];
                                int64_t e = cnt[(int64_t)b * NBUCK + v + 1];
                                for (int64_t z = s; z < e; z++) {
                                    uint64_t x = ent[z].key ^ t;
                                    int mm = mmcount(x);
                                    if (mm > MAXMM) continue;
                                    int dup = 0;
                                    for (int b2 = 0; b2 < b; b2++)
                                        if (((x >> BSHIFT(b2)) & (NBUCK - 1)) == 0) { dup = 1; break; }
                                    if (dup) continue;
                                    uint32_t q = ent[z].qid;
                                    if (mm == 0 && pam == 0 && qstrand[q] == 1 &&
                                        qchrom[q] == (uint8_t)ci && qpos[q] == gpos) continue;
                                    myc[(size_t)q * nmmslot + pam * (MAXMM + 1) + mm]++;
                                    if (mynh[q] < MAXHIT) {
                                        Hit *h = &myh[(size_t)q * MAXHIT + mynh[q]++];
                                        h->pos = gpos; h->chrom = (uint8_t)ci; h->strand = 1;
                                        h->mm = (uint8_t)mm; h->seedmm = (uint8_t)seedmmcount(x);
                                        h->pam = (uint8_t)pam;
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        fprintf(stderr, "  %s done (%.1f Mb)\n", cs[ci].name, cs[ci].len / 1e6);
        fflush(stderr);
    }

    /* ---- merge threads ---- */
    fprintf(stderr, "merging...\n");
    uint32_t *counts = tcounts[0];
    for (int t = 1; t < nthreads; t++)
        for (size_t i = 0; i < (size_t)nq * nmmslot; i++) counts[i] += tcounts[t][i];

    Hit *hits = calloc((size_t)nq * MAXHIT, sizeof(Hit));
    uint8_t *nh = calloc(nq, 1);
    for (int64_t q = 0; q < nq; q++) {
        /* gather all thread hits for this query, keep the MAXHIT best by (mm, seedmm) */
        Hit tmp[MAXHIT * 8];
        int n = 0;
        for (int t = 0; t < nthreads && n < MAXHIT * 8; t++)
            for (int j = 0; j < tnh[t][q] && n < MAXHIT * 8; j++)
                tmp[n++] = thits[t][(size_t)q * MAXHIT + j];
        for (int a = 0; a < n; a++)
            for (int b = a + 1; b < n; b++) {
                int ka = tmp[a].mm * 100 + tmp[a].seedmm * 10 + tmp[a].pam;
                int kb = tmp[b].mm * 100 + tmp[b].seedmm * 10 + tmp[b].pam;
                if (kb < ka) { Hit s = tmp[a]; tmp[a] = tmp[b]; tmp[b] = s; }
            }
        int keep = n < MAXHIT ? n : MAXHIT;
        for (int j = 0; j < keep; j++) hits[(size_t)q * MAXHIT + j] = tmp[j];
        nh[q] = (uint8_t)keep;
    }

    FILE *cf = fopen(argv[3], "wb");
    int32_t hdr[4] = { (int32_t)nq, nmmslot, MAXHIT, 0 };
    fwrite(hdr, sizeof hdr, 1, cf);
    fwrite(counts, sizeof(uint32_t), (size_t)nq * nmmslot, cf);
    fclose(cf);
    FILE *hf = fopen(argv[4], "wb");
    fwrite(hdr, sizeof hdr, 1, hf);
    fwrite(nh, 1, nq, hf);
    fwrite(hits, sizeof(Hit), (size_t)nq * MAXHIT, hf);
    fclose(hf);
    fprintf(stderr, "done\n");
    return 0;
}
