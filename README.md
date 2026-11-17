# NeoGuide

<img width="1208" height="324" alt="neoguide_rnp_arrow_lockups - Copy" src="https://github.com/user-attachments/assets/a5d77634-9d67-403e-bc27-5470bcbe666b" />


Website: https://tirthadasbanerjee.com/NeoGuide/

Precomputed, off-target-verified SpCas9 guides for every protein-coding gene of
a genome, each one paired with primers for amplicon sequencing. Built for
non-model organisms, where no such resource exists. NeoGuide is the
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
call - every page is HTML plus JSON fetched from `data/`. It will run from
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

## Running it locally

**Open `index.html`.** That is all - no server, no Python, no terminal. It
works from a folder, from a USB stick, and with no network at all.

This works because every data file is a classic script rather than JSON fetched
over the network (see *Data format* below). Browsers block `fetch()` over
`file://`, which is what breaks most static data sites when opened from disk;
loading a `<script>` from disk is still allowed, so NeoGuide sidesteps it.

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

For anything bulk, use **`data/guides_top.tsv`** instead — every published guide
for every gene, with scores, off-target counts and primers, as one plain table.
That is the intended route for reuse and needs no unwrapping.
`data/meta.json` is also kept as plain JSON.

The sequence-search shards hold base64-encoded `Uint32` pairs rather than JSON
numbers, which keeps that index at 20 MB instead of about 30 MB.


- **Substitutions only.** Insertions and deletions within the protospacer are
  not searched.
