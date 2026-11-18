<p align="center"><img src="assets/logo.svg" alt="CrispCut" width="360"></p>

# CrispCut

Precomputed, off-target-verified SpCas9 guides for every protein-coding gene of
a genome, each one paired with primers for amplicon sequencing. Built for
non-model organisms, where no such resource exists. CrispCut is the
precomputed companion to [NEO-CRISPR](https://github.com/tdblab/NEO-CRISPR):
that tool designs guides on demand for a genome you supply, this one ships the
answers already computed and checked.

The first release covers *Bicyclus anynana* (assembly ilBicAnyn1.1,
GCF_947172395.1): 13,577 coding genes, 135,723 guides, every one scanned
against the whole 457 Mb genome.

Adding a species means running the pipeline below over its genome FASTA and
GTF; nothing in the site code is specific to *Bicyclus*. The species name shown
in the header comes from `data/meta.json`.

The site is **entirely static**. There is no server, no database and no API
call. Every page is HTML plus data files loaded from `data/`. It will run from
GitHub Pages, Cloudflare Pages, an S3 bucket, or a USB stick.

## What is in here

```
index.html              app shell
start.bat / start.sh    optional local web server, for development
assets/app.css          styles
assets/app.js           search, gene pages, exon map, export
data/meta.js            build parameters (also as meta.json)
data/search.js          search index over all genes
data/genes/LOC112/*.js  one file per gene: CDS, guides, primers
data/seqindex/*.js      sampled k-mer index for sequence search
data/guides_top.tsv     every published guide as one plain table
```

## Using it

Every part of the interface is explained on the **Manual** page inside the site,
in plain language and with no assumed CRISPR background. It sits next to Methods
in the top bar, or open `#/manual` directly. Methods covers how the data was
produced; the Manual covers how to read it.

## Running it locally

**Open `index.html`.** That is all: no server, no Python, no terminal. It
works from a folder, from a USB stick, and with no network at all.

This works because every data file is a classic script rather than JSON fetched
over the network (see *Data format* below). Browsers block `fetch()` over
`file://`, which is what breaks most static data sites when opened from disk;
loading a `<script>` from disk is still allowed, so CrispCut sidesteps it.

If you would rather serve it properly while developing, `start.bat` (Windows)
or `./start.sh` (macOS, Linux) will serve this folder at
<http://localhost:8765>.

## Data format

Each data file calls a single registry function with its payload:

```js
__ng("gene:LOC112044525", { "id": "LOC112044525", "sym": "Optix", ... });
```

The payload is ordinary JSON. To read one in a script, strip the wrapper:

```python
import json
raw = open("data/genes/LOC112/LOC112044525.js").read()
gene = json.loads(raw[raw.index(",") + 1 : raw.rindex(");")])
```

For anything bulk, use **`data/guides_top.tsv`** instead. It holds every published guide
for every gene, with scores, off-target counts and primers, as one plain table.
That is the intended route for reuse and needs no unwrapping.
`data/meta.json` is also kept as plain JSON.

The sequence-search shards hold base64-encoded `Uint32` pairs rather than JSON
numbers, which keeps that index at 20 MB instead of about 30 MB.

## Hosting on GitHub Pages

1. Create a repository (for example `tdblab/crispcut`) and push this folder
   at the repository root.

   ```bash
   cd site
   git init -b main
   git add .
   git commit -m "Guide atlas: Bicyclus anynana"
   git remote add origin https://github.com/tdblab/crispcut.git
   git push -u origin main
   ```

2. In the repository, open **Settings → Pages**, set **Source** to
   *Deploy from a branch*, branch `main`, folder `/ (root)`, and save.

3. The site appears at `https://tdblab.github.io/crispcut/` within a minute
   or two.

Nothing needs a build step, so no GitHub Action is required. Jekyll is bypassed
by the `.nojekyll` file in this folder. Do not delete it, or directories whose
names start with an underscore would be dropped.

### Size

This build is roughly 266 MB across about 13,900 files. That is comfortably
inside GitHub's limits (the warning threshold is 1 GB per repository and 100 MB
per file), but the first `git clone` will take a minute. If you would rather
keep the repository small, put `data/` on a separate host and change the `DATA`
constant at the top of `assets/app.js`.

### Custom domain

Add a file named `CNAME` containing one line, for example
`crispr.tirthadasbanerjee.com`, then point a CNAME record at
`tdblab.github.io`.

## Hosting on Cloudflare Pages instead

Cloudflare Pages caps a deployment at **20,000 files**, and this build is near
that for a single species. It works today but will not survive adding more
genomes, so bundle the per-gene files first if you go that route. Connect the
GitHub repository in the Cloudflare dashboard, leave the build command empty and
set the output directory to `/`.

## Regenerating the data

The pipeline that produced `data/` is in `pipeline/`:

| Step | Script | What it does |
| --- | --- | --- |
| 1 | `parse_gtf.py` | GTF → per-gene CDS models, representative transcript, isoform-shared CDS |
| 2 | `enumerate_guides.py` | every NGG 23-mer inside a coding exon, both strands, with sequence-rule prescore |
| 3 | `otscan.c` | exhaustive off-target scan of the whole genome, complete to 4 mismatches |
| 4 | `integrate.py` | joins counts onto guides, annotates hits by gene, ranks |
| 5 | `design_primers.py` | Primer3 amplicons under 300 bp around each cut site |
| 6 | `kmercount.c` | counts each primer's 3′ end against the genome |
| 7 | `build_site.py` | writes everything in `data/` |

Build the two C tools first:

```bash
gcc -O3 -march=native -fopenmp -DNBLK=5 -DBLKBITS=8 -DMAXHIT=16 -o otscan4 otscan.c
gcc -O3 -march=native -o kmercount kmercount.c
```

`otscan` is the part that matters. It streams the genome once and tests every
NGG and NAG site on both strands against every guide. Completeness is
guaranteed by the pigeonhole principle rather than by sampling: a 20-mer
differing at no more than four positions must match one of five four-base
blocks exactly, so indexing all five blocks of every guide cannot miss a hit.
The full run for this genome, 528,697 guides against 457 Mb, takes about nine
minutes on two cores.

## Caveats worth repeating

These are predictions. Verify every oligo against your own sequence before
ordering, and confirm edits by sequencing.

- **Activity is not predicted.** Guides are ranked so that the first one listed
  is in the cleanest tier available for that gene and has a working primer pair,
  which is as much as can be guaranteed computationally. The score says how
  *specific* a guide is and whether its sequence has obvious defects. It does
  not say how well it cuts.
  Published activity models are trained on human and mouse data and have never
  been validated in Lepidoptera.
- **Off-targets are counted against the reference**, which is not the genome of
  your colony. Strain polymorphism creates and destroys sites.
- **Coding sequence only.** Guides never cross a splice junction and are never
  placed in UTRs, introns or regulatory regions.
- **Substitutions only.** Insertions and deletions within the protospacer are
  not searched.
