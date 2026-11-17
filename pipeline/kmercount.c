/* kmercount.c -- count exact genomic occurrences of a set of k-mers.
 *
 * Streams the genome once and counts, for each query k-mer, how many times it
 * occurs on either strand.  Used to check that each PCR primer's 3' end is
 * unique in the genome.
 *
 * build: gcc -O3 -march=native -o kmercount kmercount.c
 * usage: ./kmercount genome.fa kmers.txt out.tsv [k]
 *        kmers.txt: one k-mer per line (uppercase ACGT, length >= k; the
 *        3'-most k bases are used)
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

static int K = 18;
#define HBITS 23
#define HSIZE (1u << HBITS)
#define EMPTY 0xFFFFFFFFu

static uint64_t *hkey;
static uint32_t *hval;
static uint32_t *counts;

static const int8_t CODE[256] = {
    ['A'] = 0, ['C'] = 1, ['G'] = 2, ['T'] = 3,
    ['a'] = 0, ['c'] = 1, ['g'] = 2, ['t'] = 3
};
static int8_t VALID[256];

static inline uint64_t mix(uint64_t x) {
    x ^= x >> 33; x *= 0xff51afd7ed558ccdull;
    x ^= x >> 33; x *= 0xc4ceb9fe1a85ec53ull;
    x ^= x >> 33; return x;
}

static void hinsert(uint64_t key, uint32_t idx) {
    uint32_t h = (uint32_t)(mix(key) & (HSIZE - 1));
    while (hkey[h] != UINT64_MAX) {
        if (hkey[h] == key) return;   /* duplicate query: first index wins */
        h = (h + 1) & (HSIZE - 1);
    }
    hkey[h] = key; hval[h] = idx;
}

static inline uint32_t hfind(uint64_t key) {
    uint32_t h = (uint32_t)(mix(key) & (HSIZE - 1));
    while (hkey[h] != UINT64_MAX) {
        if (hkey[h] == key) return hval[h];
        h = (h + 1) & (HSIZE - 1);
    }
    return EMPTY;
}

int main(int argc, char **argv) {
    if (argc < 4) { fprintf(stderr, "usage: %s genome.fa kmers.txt out.tsv [k]\n", argv[0]); return 1; }
    if (argc > 4) K = atoi(argv[4]);
    if (K < 8 || K > 31) { fprintf(stderr, "k out of range\n"); return 1; }
    for (int i = 0; i < 256; i++) VALID[i] = 0;
    VALID['A'] = VALID['C'] = VALID['G'] = VALID['T'] = 1;
    VALID['a'] = VALID['c'] = VALID['g'] = VALID['t'] = 1;

    hkey = malloc((size_t)HSIZE * 8);
    hval = malloc((size_t)HSIZE * 4);
    for (uint32_t i = 0; i < HSIZE; i++) hkey[i] = UINT64_MAX;

    /* ---- load queries ---- */
    FILE *qf = fopen(argv[2], "r");
    if (!qf) { perror(argv[2]); return 1; }
    size_t cap = 1 << 18, nq = 0;
    char **qs = malloc(cap * sizeof(char *));
    char buf[512];
    while (fgets(buf, sizeof buf, qf)) {
        size_t n = strlen(buf);
        while (n && (buf[n - 1] == '\n' || buf[n - 1] == '\r')) buf[--n] = 0;
        if ((int)n < K) continue;
        if (nq == cap) { cap *= 2; qs = realloc(qs, cap * sizeof(char *)); }
        qs[nq] = strdup(buf);
        /* 3'-most K bases */
        const char *t = buf + n - K;
        uint64_t key = 0; int ok = 1;
        for (int i = 0; i < K; i++) {
            unsigned char c = (unsigned char)t[i];
            if (!VALID[c]) { ok = 0; break; }
            key = (key << 2) | (uint64_t)CODE[c];
        }
        if (ok) hinsert(key, (uint32_t)nq);
        nq++;
    }
    fclose(qf);
    counts = calloc(nq, 4);
    fprintf(stderr, "queries: %zu (k=%d)\n", nq, K);

    /* ---- stream genome ---- */
    FILE *f = fopen(argv[1], "rb");
    if (!f) { perror(argv[1]); return 1; }
    uint64_t mask = (K == 32) ? ~0ull : ((1ull << (2 * K)) - 1);
    uint64_t fw = 0, rv = 0;
    int run = 0;
    char *line = malloc(1 << 20);
    int64_t nb = 0;
    while (fgets(line, 1 << 20, f)) {
        if (line[0] == '>') { fw = rv = 0; run = 0; continue; }
        for (char *p = line; *p; p++) {
            unsigned char c = (unsigned char)*p;
            if (c == '\n' || c == '\r') continue;
            if (!VALID[c]) { run = 0; fw = rv = 0; continue; }
            uint64_t b = (uint64_t)CODE[c];
            fw = ((fw << 2) | b) & mask;
            rv = (rv >> 2) | ((3ull - b) << (2 * (K - 1)));
            nb++;
            if (++run >= K) {
                uint32_t i = hfind(fw);
                if (i != EMPTY) counts[i]++;
                uint32_t j = hfind(rv);
                if (j != EMPTY) counts[j]++;
            }
        }
    }
    fclose(f);
    fprintf(stderr, "scanned %lld bases\n", (long long)nb);

    FILE *o = fopen(argv[3], "w");
    fprintf(o, "kmer\thits\n");
    for (size_t i = 0; i < nq; i++) fprintf(o, "%s\t%u\n", qs[i], counts[i]);
    fclose(o);
    return 0;
}
