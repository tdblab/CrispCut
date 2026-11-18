/* NeoGuide client application.
   Static site: one search index + one JSON file per gene. */
(() => {
"use strict";

// Resolve the data directory against this script's own URL rather than the
// page URL: the page may be served at a path without a trailing slash, where a
// bare relative fetch would resolve one level too high.
const DATA = (() => {
  try {
    const me = document.currentScript && document.currentScript.src;
    if (me) return new URL("../data", me).href.replace(/\/$/, "");
  } catch (_) { /* fall through */ }
  return "data";
})();
const TIERNAME = ["check carefully", "fair", "good", "clean"];
const TIERLABEL = ["Poor", "Fair", "Good", "Excellent"];
const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num = (n) => Number(n).toLocaleString("en-US");
const RC = { A: "T", C: "G", G: "C", T: "A", N: "N" };
const rc = (s) => s.split("").reverse().map((c) => RC[c] || "N").join("");

const state = { index: null, meta: null, gene: null, filter: "all", q: "",
  selected: null, pastedSeq: null };

/* ------------------------------------------------------------------ data */
/* Data files are classic scripts that call __ng(key, payload) rather than JSON
   fetched over the network. Browsers block fetch() on file:// but still load a
   <script> from disk, so this is what lets the site run by double-clicking
   index.html, from a USB stick, with no server and no Python. It behaves
   identically over http. */
const waiting = new Map();
window.__ng = function (key, payload) {
  const w = waiting.get(key);
  if (w) { waiting.delete(key); w.resolve(payload); }
};

function getData(key, url) {
  return new Promise((resolve, reject) => {
    const prev = waiting.get(key);
    if (prev) { prev.chain.push({ resolve, reject }); return; }
    const chain = [];
    waiting.set(key, {
      chain,
      resolve: (v) => { resolve(v); chain.forEach((c) => c.resolve(v)); },
    });
    const el = document.createElement("script");
    el.src = url;
    el.async = true;
    const fail = (msg) => {
      waiting.delete(key);
      const e = new Error(msg);
      reject(e);
      chain.forEach((c) => c.reject(e));
    };
    el.onerror = () => { el.remove(); fail(`could not load ${url}`); };
    el.onload = () => {
      el.remove();
      // the file loaded but never called __ng: truncated or wrong contents
      if (waiting.has(key)) fail(`no data in ${url}`);
    };
    document.head.appendChild(el);
  });
}

function b64ToU32(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Uint32Array(bytes.buffer, 0, bytes.length >> 2);
}

let indexP = null;
function loadIndex() {
  if (!indexP) {
    indexP = Promise.all([
      getData("search", `${DATA}/search.js`),
      getData("meta", `${DATA}/meta.js`),
    ]).then(([s, m]) => {
      state.index = s.g;
      state.meta = m;
      state.index.forEach((g, i) => { g.push(i); });
      renderFootMeta();
      const bs = $("#brandsp");
      if (bs && m.species) bs.textContent = m.species;
      return s.g;
    }).catch((e) => {
      // Never leave a rejected promise cached: every route awaits this one, so
      // a cached rejection would hang the whole app until a reload.
      indexP = null;
      throw e;
    });
  }
  return indexP;
}

function dataError(e) {
  const main = $("#main");
  if (!main) return;
  const isFile = false;
  main.innerHTML = `<div class="results">
    <h1>${isFile ? "Open this through a web server, not from the folder"
                 : "Could not load the gene data"}</h1>
    ${isFile ? `<p class="nores">You opened <code>index.html</code> straight from
      disk. Browsers refuse to read data files over <code>file://</code>, so no
      gene can load this way. It is a browser security rule, not a problem with
      these files.</p>
      <p class="nores"><b>On Windows:</b> double-click <code>start.bat</code> in
      this folder.<br>
      <b>On macOS or Linux:</b> run <code>./start.sh</code> in this folder.<br>
      Either one opens it at <code>http://localhost:8765</code>. Nothing is
      uploaded anywhere.</p>
      <p class="nores">Once it is on GitHub Pages this does not apply. Served
      over http, it just works.</p>`
    : `<p class="nores">The page loaded but its data files did not. That is a
      hosting or network problem, not a problem with what you searched for.</p>`}
    <p class="nores" style="font-family:var(--mono);font-size:13.5px">
      ${esc(String((e && e.message) || e))}<br>data directory: ${esc(DATA)}</p>
    ${isFile ? "" : `<p class="nores"><button type="button" class="btn" id="retry">Try again</button></p>`}
  </div>`;
  const b = $("#retry");
  if (b) b.addEventListener("click", () => location.reload());
}
const geneCache = new Map();
function loadGene(id) {
  if (geneCache.has(id)) return Promise.resolve(geneCache.get(id));
  return getData("gene:" + id, `${DATA}/genes/${id.slice(0, 6)}/${id}.js`)
    .then((g) => { geneCache.set(id, g); return g; });
}

/* ---------------------------------------------------------------- search */
const isSeq = (q) => {
  const s = q.replace(/\s/g, "").toUpperCase();
  return s.length >= 15 && /^[ACGTN]+$/.test(s);
};

function rank(q) {
  const s = q.trim().toLowerCase();
  if (!s) return [];
  const out = [];
  for (const g of state.index) {
    const [id, sym, name, fly, fb] = g;
    const ls = sym.toLowerCase();
    let sc = -1;
    if (ls === s) sc = 0;
    else if (id.toLowerCase() === s) sc = 1;
    else if (fly && fly.toLowerCase() === s) sc = 2;
    else if (fb && fb.toLowerCase() === s) sc = 3;
    else if (ls.startsWith(s)) sc = 10 + ls.length / 100;
    else if (fly && fly.toLowerCase().startsWith(s)) sc = 12;
    else if (id.toLowerCase().startsWith(s)) sc = 14;
    else if (ls.includes(s)) sc = 20;
    else if (name && name.toLowerCase().includes(s)) sc = 30;
    else if (fly && fly.toLowerCase().includes(s)) sc = 34;
    if (sc >= 0) out.push([sc, g]);
  }
  out.sort((a, b) => a[0] - b[0] || a[1][1].length - b[1][1].length);
  return out.map((x) => x[1]);
}

/* ----------------------------------------------------------- suggestions */
function wireSearch(input, box) {
  let items = [], cur = -1;
  const close = () => { box.hidden = true; cur = -1; };
  const draw = () => {
    if (!items.length) {
      box.innerHTML = `<div class="s-empty">No gene matches that. Try a LOC number,
        a <i>Drosophila</i> symbol, or part of the protein name.</div>`;
      box.hidden = false; return;
    }
    box.innerHTML = items.map((g, i) => `
      <button type="button" role="option" data-id="${esc(g[0])}"
        ${i === cur ? 'aria-selected="true"' : ""}>
        <span class="s-sym">${esc(g[1])}</span>
        <span class="s-loc">${esc(g[0])}</span>
        <span class="s-name">${esc(g[2] || "")}</span>
        ${g[3] ? `<span class="s-sub">fly ${esc(g[3])}${g[9] === 3
            ? " · has clean guides" : ""}</span>` : ""}
      </button>`).join("");
    box.hidden = false;
  };
  const go = (id) => { close(); input.blur(); location.hash = `#/gene/${id}`; };

  input.addEventListener("input", async () => {
    const q = input.value;
    state.q = q;
    if (!q.trim()) { close(); return; }
    try { await loadIndex(); } catch (e) {
      box.innerHTML = `<div class="s-empty">Gene data could not be loaded.
        Reload the page to retry.</div>`;
      box.hidden = false; items = []; return;
    }
    if (isSeq(q)) {
      box.innerHTML = `<div class="s-empty">Press Enter to find this sequence
        in the coding sequences.</div>`;
      box.hidden = false; items = []; return;
    }
    items = rank(q).slice(0, 8);
    draw();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!items.length) return;
      e.preventDefault();
      cur = (cur + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      draw();
    } else if (e.key === "Enter") {
      if (cur >= 0 && items[cur]) { go(items[cur][0]); return; }
      const q = input.value.trim();
      if (!q) return;
      close(); input.blur();
      location.hash = `#/search/${encodeURIComponent(q)}`;
    } else if (e.key === "Escape") { close(); }
  });
  box.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-id]");
    if (b) go(b.dataset.id);
  });
  document.addEventListener("click", (e) => {
    if (!box.contains(e.target) && e.target !== input) close();
  });
}

/* ------------------------------------------------------------- home page */
function renderHome() {
  const main = $("#main");
  main.innerHTML = "";
  main.appendChild($("#t-home").content.cloneNode(true));
  wireSearch($("#q2"), $("#sug2"));
  loadIndex().then(() => {
    const m = state.meta;
    const set = (k, v) => $$(`[data-n="${k}"]`).forEach((e) => { e.textContent = v; });
    set("genes", num(m.n_genes));
    set("guides", num(m.n_guides_published));
    set("scanned", num(m.n_scanned || m.n_guides_scanned || 528697));
    if (m.preview_note) {
      const h = document.querySelector(".hero");
      if (h && !document.querySelector(".pvnote")) {
        const d = document.createElement("p");
        d.className = "examples pvnote";
        d.style.cssText = "margin:0 0 18px;color:var(--gold);font-weight:500";
        d.textContent = m.preview_note;
        h.insertBefore(d, h.querySelector(".herosearch"));
      }
    }
    const picks = ["Optix", "wg", "Dll", "hh", "Antp", "dsx"];
    const found = [];
    for (const p of picks) {
      const hit = state.index.find((g) => g[1].toLowerCase() === p.toLowerCase());
      if (hit) found.push(hit);
    }
    if (!found.length) found.push(...state.index.slice(0, 4));
    $("#examples").innerHTML = found.slice(0, 6)
      .map((g) => `<a href="#/gene/${esc(g[0])}"><i>${esc(g[1])}</i></a>`).join(" ");
    setTimeout(() => $("#q2") && $("#q2").focus(), 30);
  }).catch(dataError);
}

/* ---------------------------------------------------------- results page */
function renderResults(q) {
  const main = $("#main");
  main.innerHTML = `<div class="loading">Searching…</div>`;
  loadIndex().then(() => {
    if (isSeq(q)) return renderSeqSearch(q);
    const res = rank(q);
    main.innerHTML = `
      <div class="results">
        <h1>${esc(q)}</h1>
        <p class="sub">${res.length ? `${num(res.length)} gene${res.length > 1 ? "s" : ""}`
          : "No match"}</p>
        ${res.length ? `<div class="rlist">${res.slice(0, 300).map((g) => `
          <a href="#/gene/${esc(g[0])}">
            <span class="rs">${esc(g[1])}</span>
            <span class="rn">${esc(g[2] || "")}</span>
            <span class="rr"><span class="ring sm t${g[9]}"></span>
              <span class="rl">${esc(g[0])}</span></span>
          </a>`).join("")}</div>`
          : `<p class="nores">Nothing matched <b>${esc(q)}</b>. Gene symbols follow
             <i>Drosophila</i> convention, so try <i>optix</i> rather than SIX3, or
             search the LOC number straight from the NCBI annotation.</p>`}
      </div>`;
  }).catch(dataError);
}

/* ------------------------------------------------------ sequence search  */
let seqIdxMeta = null;
const shardCache = new Map();

function hash32(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

async function seqIndexMeta() {
  if (!seqIdxMeta) {
    seqIdxMeta = getData("seqmeta", `${DATA}/seqindex/meta.js`).catch(() => null);
  }
  return seqIdxMeta;
}
async function loadShard(n) {
  if (shardCache.has(n)) return shardCache.get(n);
  const p = getData(`shard:${n}`, `${DATA}/seqindex/s${n}.js`)
    .then((b64) => (typeof b64 === "string" ? b64ToU32(b64) : null))
    .catch(() => null);
  shardCache.set(n, p);
  return p;
}

async function renderSeqSearch(qraw) {
  const main = $("#main");
  const q = qraw.replace(/[^A-Za-z]/g, "").toUpperCase();
  main.innerHTML = `<div class="loading">Looking for this sequence in the coding
    sequences…</div>`;
  const meta = await seqIndexMeta();
  if (!meta) {
    main.innerHTML = `<div class="results"><h1>Sequence search</h1>
      <p class="nores">The sequence index is not available on this deployment.</p></div>`;
    return;
  }
  const K = meta.k, STEP = meta.step, OFFBITS = meta.offbits;
  const both = [q, rc(q)];
  const votes = new Map();
  for (let si = 0; si < 2; si++) {
    const s = both[si];
    if (s.length < K) continue;
    const need = new Map();
    for (let i = 0; i + K <= s.length; i++) {
      const h = hash32(s.substr(i, K));
      const shard = h & (meta.shards - 1);
      if (!need.has(shard)) need.set(shard, []);
      need.get(shard).push([h, i]);
      if (need.size > 24) break;
    }
    // fetch every shard this query touches at once; serially they would be up
    // to two dozen round trips before the first result appears
    const nums = Array.from(need.keys());
    const arrs = await Promise.all(nums.map((n) => loadShard(n)));
    for (let ni = 0; ni < nums.length; ni++) {
      const arr = arrs[ni];
      if (!arr) continue;
      const list = need.get(nums[ni]);
      for (const [h, qoff] of list) {
        let lo = 0, hi = arr.length / 2 - 1, at = -1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          const v = arr[mid * 2];
          if (v === h) { at = mid; break; }
          if (v < h) lo = mid + 1; else hi = mid - 1;
        }
        if (at < 0) continue;
        let a = at; while (a > 0 && arr[(a - 1) * 2] === h) a--;
        for (let j = a; j < arr.length / 2 && arr[j * 2] === h; j++) {
          const pk = arr[j * 2 + 1];
          const gi = pk >>> OFFBITS;
          const off = pk & ((1 << OFFBITS) - 1);
          const key = `${gi}|${si}|${off - qoff}`;
          votes.set(key, (votes.get(key) || 0) + 1);
        }
      }
    }
  }
  const best = Array.from(votes.entries())
    .map(([k, v]) => { const [gi, si, st] = k.split("|").map(Number); return { gi, si, st, v }; })
    .sort((a, b) => b.v - a.v).slice(0, 20);
  if (!best.length) {
    main.innerHTML = `<div class="results"><h1>Sequence search</h1>
      <p class="sub">${q.length} bp</p>
      <p class="nores">That sequence is not in any annotated coding sequence.
        It may lie in an intron or UTR, come from another species, or contain
        enough mismatches to miss. Guides here are only designed inside CDS.</p>
      </div>`;
    return;
  }
  const rows = [];
  for (const b of best.slice(0, 12)) {
    const g = state.index[b.gi];
    if (!g) continue;
    rows.push({ g, b });
  }
  main.innerHTML = `
    <div class="results">
      <h1>Sequence search</h1>
      <p class="sub">${num(q.length)} bp · ${rows.length} match${rows.length > 1 ? "es" : ""}
        in coding sequence</p>
      <div class="rlist">${rows.map(({ g, b }) => `
        <a href="#/gene/${esc(g[0])}?seq=${esc(q)}">
          <span class="rs">${esc(g[1])}</span>
          <span class="rn">${esc(g[2] || "")} · ${b.si ? "reverse" : "forward"}
            strand of the CDS, from position ${num(Math.max(0, b.st) + 1)}</span>
          <span class="rr"><span class="ring sm t${g[9]}"></span>
            <span class="rl">${esc(g[0])}</span></span>
        </a>`).join("")}</div>
    </div>`;
}

/* ------------------------------------------------------------- gene page */
function cdsOffsetOfCut(g, cut) {
  let acc = 0;
  const ivs = g.strand === "-" ? g.cds.slice().reverse() : g.cds;
  for (const [a, b] of ivs) {
    if (cut >= a && cut <= b) return acc + (g.strand === "+" ? cut - a : b - cut);
    acc += b - a + 1;
  }
  return -1;
}

function guideCdsSpan(g, gd) {
  const off = cdsOffsetOfCut(g, gd.cut);
  if (off < 0) return null;
  // Genomic protospacer is [cut-16, cut+3] for a sense guide and
  // [cut-2, cut+17] for an antisense one; CDS coordinates run backwards when
  // the gene is on the minus strand, so all four cases differ.
  let s;
  if (g.strand === "+") s = (gd.st === "+") ? off - 16 : off - 2;
  else s = (gd.st === "+") ? off - 3 : off - 17;
  return { s, e: s + 20, cut: off };
}

function exonNumber(g, gd) {
  if (gd.ex == null) return null;
  return g.strand === "+" ? gd.ex + 1 : g.cds.length - gd.ex;
}

function flagsFor(gd, gene) {
  const f = [];
  if (gd.n[0] > 0) f.push(['bad', `${gd.n[0]} perfect match elsewhere`]);
  else if (gd.n[1] > 0) f.push(['bad', `${gd.n[1]} site at 1 mismatch`]);
  else if (gd.n[2] > 0) f.push(['warn', `${gd.n[2]} site${gd.n[2] > 1 ? "s" : ""} at 2 mismatches`]);
  if (gd.otg && gd.otg.length) {
    f.push(['bad', `hits ${gd.otg.slice(0, 2).map((o) => o.sym).join(", ")}`]);
  }
  if (gd.sp.includes("TTTT")) f.push(['warn', "poly-T in spacer"]);
  if (gd.gc < 30 || gd.gc > 75) f.push(['warn', `GC ${gd.gc}%`]);
  if (gene.ntx > 1) {
    f.push(gd.core ? ['good', "all isoforms"] : ['warn', "not in every isoform"]);
  }
  if (gd.f <= 40 && gd.f >= 5 && !f.some((x) => x[0] === "bad")) {
    f.push(['good', "early in CDS"]);
  }
  return f;
}

function cloningOligos(sp) {
  const top = sp[0] === "G" ? "CACC" + sp : "CACCG" + sp;
  const bot = "AAAC" + rc(sp[0] === "G" ? sp : "G" + sp);
  return { top, bot };
}

// Two-oligo in vitro transcription template (Lin & Staahl 2014). T7 needs the
// transcript to start with G, so the GG at the end of the promoter is replaced
// by protospacer bases whenever the spacer already supplies them.
const T7_SCAFFOLD = "GTTTTAGAGCTAGAAATAGCAAGTTAAAATAG";
const T7_BOTTOM =
  "AAAAAAGCACCGACTCGGTGCCACTTTTTCAAGTTGATAACGGACTAGCCTATTTTAACTTGCTATTTCT";
function t7Oligos(sp) {
  const prom = "TAATACGACTCACTATA";
  let lead = "GG";
  if (sp.startsWith("GG")) lead = "";
  else if (sp[0] === "G") lead = "G";
  return { top: prom + lead + sp + T7_SCAFFOLD, bot: T7_BOTTOM,
           extra: lead.length };
}

function renderGene(id, params) {
  const main = $("#main");
  main.innerHTML = `<div class="loading">Loading ${esc(id)}…</div>`;
  Promise.all([loadIndex(), loadGene(id)]).then(([, g]) => {
    state.gene = g;
    const conf = (g.conf || "").toLowerCase();
    const confClass = conf === "high" ? "hi" : conf === "medium" ? "med"
      : conf === "low" ? "lo" : "";
    const span = g.cds.length
      ? `${num(Math.min(...g.cds.map((x) => x[0])))}–${num(Math.max(...g.cds.map((x) => x[1])))}`
      : "";
    main.innerHTML = `
      <section class="gh">
        <div class="ghtop"><h1>${esc(g.sym)}</h1></div>
        <p class="fullname">${esc(g.name || g.ncbi || "")}</p>
        <div class="badges">
          <span class="badge mono">${esc(g.id)}</span>
          ${g.fly ? `<span class="badge ${confClass}">fly ortholog ${esc(g.fly)}${
            conf ? ` · ${esc(conf)} confidence` : ""}</span>` : ""}
          ${g.fb ? `<span class="badge mono"><a href="https://flybase.org/reports/${
            esc(g.fb)}" target="_blank" rel="noopener">${esc(g.fb)}</a></span>` : ""}
          <span class="badge">${num(g.cds_len)} bp CDS · ${g.cds.length} coding exon${
            g.cds.length > 1 ? "s" : ""}</span>
          ${g.ntx > 1 ? `<span class="badge">${g.ntx} isoforms</span>` : ""}
          ${g.aa ? `<span class="badge">${esc(g.aa)} aa</span>` : ""}
        </div>
        <p class="coords">${esc(g.chrom)}:${span} (${esc(g.strand)}) · representative
          transcript ${esc(g.tx)}${g.basis ? ` · name from ${esc(g.basis)}` : ""}</p>
      </section>

      <section class="mapwrap">
        <div class="maphead">
          <h2>Coding sequence and guide positions</h2>
          <span class="hint">Exons laid end to end, 5′ to 3′. Click a ring to open
            that guide.</span>
        </div>
        <div id="mapholder" style="position:relative"></div>
      </section>

      <div class="controls">
        <h2>Guides</h2>
        <span class="rankhint">best first</span>
        <div class="seg" role="group" aria-label="Filter guides">
          <button type="button" data-f="all" aria-pressed="true">All ${g.guides.length}</button>
          <button type="button" data-f="clean" aria-pressed="false">Cleanest</button>
          <button type="button" data-f="iso" aria-pressed="false">All isoforms</button>
        </div>
        <div class="spacer"></div>
        <button type="button" class="btn" id="dlcsv">Download CSV</button>
      </div>
      <p class="rankwhy">Ranked by off-target counts measured against the whole
        genome, then sequence quality, then whether a primer pair exists. How
        efficiently a guide cuts is not predicted by this or any other tool.</p>
      <div class="guides" id="guides"></div>
      ${g.more && g.more.length ? `<div style="margin-top:14px">
        <button type="button" class="btn ghost" id="showmore">Show ${g.more.length}
          more scanned guides</button>
        <div id="morelist" hidden></div></div>` : ""}

      <section class="seqpanel">
        <h2>Coding sequence</h2>
        <p class="hint">Guides are highlighted on the strand shown in the table;
          colour follows the same quality scale. Exon boundaries are marked with a rule.</p>
        <div class="cdsseq" id="cdsseq"></div>
      </section>`;

    drawMap(g);
    renderGuides(g);
    $$(".seg button").forEach((b) => b.addEventListener("click", () => {
      state.filter = b.dataset.f;
      $$(".seg button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      renderGuides(g);
    }));
    $("#dlcsv").addEventListener("click", () => downloadCSV(g));
    const sm = $("#showmore");
    if (sm) sm.addEventListener("click", () => {
      const box = $("#morelist");
      if (!box.dataset.built) { box.innerHTML = moreTable(g); box.dataset.built = "1"; }
      box.hidden = !box.hidden;
      sm.textContent = box.hidden
        ? `Show ${g.more.length} more scanned guides`
        : "Hide the extra guides";
    });
    state.pastedSeq = (params && params.seq) || null;
    state.selected = null;
    renderCdsSeq(g, state.pastedSeq, null);
    if (state.pastedSeq) {
      const el = $("#cdsseq .hit");
      if (el) el.scrollIntoView({ block: "center" });
    }
  }).catch((e) => {
    if (!state.index) return dataError(e);
    main.innerHTML = `<div class="results"><h1>Gene not found</h1>
      <p class="nores">No gene with id <b>${esc(id)}</b> in this build.</p></div>`;
  });
}

/* ---------------------------------------------------------------- CDS map */
function drawMap(g) {
  const holder = $("#mapholder");
  const W = Math.max(320, holder.clientWidth || 900);
  const PAD = 10, TRACK_Y = 86, TRACK_H = 22;
  const inner = W - PAD * 2;
  const L = g.cds_len || 1;
  const ivs = g.strand === "-" ? g.cds.slice().reverse() : g.cds;

  let acc = 0;
  const exons = ivs.map(([a, b], i) => {
    const len = b - a + 1;
    const x = PAD + (acc / L) * inner;
    const w = Math.max(1, (len / L) * inner);
    acc += len;
    return { x, w, len, i };
  });

  // lay guides out in rows so rings never overlap
  const marks = g.guides.map((gd, i) => ({ gd, i, x: PAD + (gd.f / 100) * inner }))
    .sort((a, b) => a.x - b.x);
  const rows = [];
  for (const m of marks) {
    let r = 0;
    while (rows[r] != null && m.x - rows[r] < 19) r++;
    rows[r] = m.x; m.row = r;
  }
  const nrow = rows.length;
  const topPad = 14;
  const H = TRACK_Y + TRACK_H + 30;

  const svg = [];
  svg.push(`<svg class="cdsmap" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"
    role="img" aria-label="Coding sequence with ${g.guides.length} guide positions">`);
  for (const e of exons) {
    svg.push(`<rect class="exon${e.i % 2 ? " alt" : ""}" x="${e.x.toFixed(1)}"
      y="${TRACK_Y}" width="${e.w.toFixed(1)}" height="${TRACK_H}" rx="2"/>`);
    if (e.w > 34) {
      svg.push(`<text class="exlab" x="${(e.x + e.w / 2).toFixed(1)}"
        y="${TRACK_Y + TRACK_H + 14}" text-anchor="middle">${e.i + 1}</text>`);
    }
  }
  for (const p of [0, 25, 50, 75, 100]) {
    const x = PAD + (p / 100) * inner;
    svg.push(`<line class="axis" x1="${x}" y1="${TRACK_Y + TRACK_H + 2}" x2="${x}"
      y2="${TRACK_Y + TRACK_H + 6}"/>`);
  }
  svg.push(`<text class="tick" x="${PAD}" y="${TRACK_Y - 4}" text-anchor="start">5′</text>`);
  svg.push(`<text class="tick" x="${W - PAD}" y="${TRACK_Y - 4}" text-anchor="end">3′</text>`);

  for (const m of marks) {
    const y = topPad + (nrow - 1 - m.row) * 19 + 9;
    const t = m.gd.t;
    svg.push(`<line class="gstem" x1="${m.x.toFixed(1)}" y1="${y + 8}"
      x2="${m.x.toFixed(1)}" y2="${TRACK_Y}"/>`);
    svg.push(`<g class="gm" data-i="${m.i}" tabindex="0" role="button"
      aria-label="Guide ${m.i + 1}, ${TIERLABEL[t]}">
      <circle class="ghalo" cx="${m.x.toFixed(1)}" cy="${y}" r="10.5" fill="none"
        stroke="var(--ink)" stroke-width="2"/>
      <circle class="gouter" cx="${m.x.toFixed(1)}" cy="${y}" r="6.2" fill="none"
        stroke="var(--t${t})" stroke-width="2.6"/>
      <circle cx="${m.x.toFixed(1)}" cy="${y}" r="2.4" fill="var(--t${t})"/>
      <circle cx="${m.x.toFixed(1)}" cy="${y}" r="9" fill="transparent"/>
    </g>`);
  }
  svg.push(`</svg>`);
  holder.innerHTML = svg.join("");

  const tip = document.createElement("div");
  tip.className = "maptip"; tip.hidden = true;
  holder.appendChild(tip);
  const show = (el) => {
    const i = +el.dataset.i, gd = g.guides[i];
    tip.innerHTML = `<b>${esc(gd.sp)}&nbsp;${esc(gd.pam)}</b><br>
      guide ${i + 1} · ${gd.f}% into the CDS · ${TIERLABEL[gd.t]}<br>
      off-target ${gd.n.join(" · ")}`;
    tip.hidden = false;
    const c = el.querySelector("circle");
    const cx = +c.getAttribute("cx"), cy = +c.getAttribute("cy");
    const sc = (holder.clientWidth || W) / W;
    tip.style.left = Math.min(Math.max(4, cx * sc - 120), (holder.clientWidth || W) - 260) + "px";
    tip.style.top = Math.max(0, cy * sc - 62) + "px";
  };
  holder.addEventListener("mouseover", (e) => {
    const el = e.target.closest(".gm"); if (el) show(el);
  });
  holder.addEventListener("mouseout", (e) => {
    if (e.target.closest(".gm")) tip.hidden = true;
  });
  holder.addEventListener("focusin", (e) => {
    const el = e.target.closest(".gm"); if (el) show(el);
  });
  holder.addEventListener("focusout", () => { tip.hidden = true; });
  const open = (el) => {
    const i = +el.dataset.i;
    const card = $(`.guide[data-i="${i}"]`);
    if (!card) { selectGuide(g, i, true); return; }
    if (!card.classList.contains("open")) $(".grow", card).click();
    else selectGuide(g, i, false);
    card.scrollIntoView({ block: "center", behavior: "smooth" });
  };
  holder.addEventListener("click", (e) => {
    const el = e.target.closest(".gm"); if (el) open(el);
  });
  holder.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const el = e.target.closest(".gm"); if (el) { e.preventDefault(); open(el); }
  });
}

/* ------------------------------------------------------------ guide list */
function guideRow(gd, i, gene) {
  const fl = flagsFor(gd, gene);
  return `
  <article class="guide${i === 0 ? " top" : ""}" data-i="${i}">
    ${i === 0 ? `<div class="toppick">Best available guide for this gene${
      gd.n[0] + gd.n[1] + gd.n[2] === 0 ? " · no off-target site within 2 mismatches" : ""}${
      gd.core && gene.ntx > 1 ? " · hits every isoform" : ""}${
      gd.pr ? " · primers ready" : ""}</div>` : ""}
    <button type="button" class="grow" aria-expanded="false">
      <span class="grank"><span class="ring sm t${gd.t}"></span></span>
      <span class="gseq">${esc(gd.sp)}<span class="pam">${esc(gd.pam)}</span>
        <span class="st">${gd.st === "+" ? "sense" : "antisense"}</span></span>
      <span class="gmeta">
        <span class="kv"><b>${gd.f}%</b><span>into CDS</span></span>
        <span class="kv"><b>${exonNumber(gene, gd) || "–"}</b><span>exon of ${gene.cds.length}</span></span>
        <span class="kv"><b>${gd.spec}</b><span>specificity</span></span>
        <span class="kv mono"><b>${gd.n.join("·")}</b><span>0–4 mismatch sites</span></span>
      </span>
      <span class="flags">${fl.slice(0, 3).map(([c, t]) =>
        `<span class="flag ${c}">${esc(t)}</span>`).join("")}</span>
      <span></span>
      <svg class="chev" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 11 3 5h10z"/></svg>
    </button>
    <div class="gdetail" hidden></div>
  </article>`;
}

function guideDetail(gd, i, gene) {
  const ctx = gd.ctx && gd.ctx !== "." ? gd.ctx : null;
  let ctxHtml = "";
  if (ctx) {
    ctxHtml = `<span class="fl">${esc(ctx.slice(0, 4))}</span><span class="sp">${
      esc(ctx.slice(4, 21))}</span><span class="cutmark">|</span><span class="sp">${
      esc(ctx.slice(21, 24))}</span><span class="pamx">${esc(ctx.slice(24, 27))}</span>
      <span class="fl">${esc(ctx.slice(27))}</span>`;
  }
  const ol = cloningOligos(gd.sp);
  const t7 = t7Oligos(gd.sp);
  const pr = gd.pr;
  let ampSvg = "";
  if (pr) {
    const W = 420, H = 34, y = 12, h = 10;
    const f = pr.co / pr.size;
    ampSvg = `<svg class="amp" viewBox="0 0 ${W} ${H}" role="img"
      aria-label="Amplicon ${pr.size} base pairs, cut site at ${pr.co} base pairs">
      <rect class="abody" x="0" y="${y}" width="${W}" height="${h}" rx="2"/>
      <rect class="apr" x="0" y="${y}" width="${(pr.F.length / pr.size * W).toFixed(1)}"
        height="${h}" rx="2"/>
      <rect class="apr" x="${(W - pr.R.length / pr.size * W).toFixed(1)}" y="${y}"
        width="${(pr.R.length / pr.size * W).toFixed(1)}" height="${h}" rx="2"/>
      <line class="acut" x1="${(f * W).toFixed(1)}" y1="${y - 5}"
        x2="${(f * W).toFixed(1)}" y2="${y + h + 5}"/>
      <text class="alab" x="0" y="${H - 1}">F</text>
      <text class="alab" x="${(f * W).toFixed(1)}" y="${H - 1}" text-anchor="middle">cut at ${pr.co} bp</text>
      <text class="alab" x="${W}" y="${H - 1}" text-anchor="end">R</text>
    </svg>`;
  }
  const mmColor = (mm) => ["var(--t0)", "var(--t0)", "var(--t1)", "var(--t2)", "var(--ink3)"][mm] || "var(--ink3)";
  return `
  <div class="dgrid">
    <div class="dsec">
      <h3>Target site in the genome</h3>
      ${ctx ? `<p class="seqline">${ctxHtml}</p>` : ""}
      <p class="seqline" style="color:var(--ink3);font-size:13px;letter-spacing:0">
        ${esc(gene.chrom)}:${num(gd.ps)}–${num(gd.ps + 19)} on the ${
        gd.st === "+" ? "forward" : "reverse"} strand · blunt cut at ${num(gd.cut)}
        ${exonNumber(gene, gd) ? `· exon ${exonNumber(gene, gd)} of ${gene.cds.length}` : ""}
        · GC ${gd.gc}% · sequence score ${gd.pre}</p>
      <h3 style="margin-top:16px">Spacer to order</h3>
      <div class="prim">
        <div class="primrow"><span class="tag">20&nbsp;nt</span>
          <span class="pseq big20">${esc(gd.sp)}</span>
          <button class="copy" data-copy="${esc(gd.sp)}">Copy</button></div>
      </div>
      <p class="ampnote">Order this as a synthetic sgRNA, or use it as the
        protospacer in any of the formats below.</p>
      <details class="fmt">
        <summary>Other oligo formats</summary>
        <div class="fmtbody">
          <h4>In vitro transcription, two oligos</h4>
          <p>Anneal and extend these, then transcribe with T7 to make sgRNA for
            Cas9 RNP injection. The bottom oligo never changes, so you order it
            once.</p>
          <div class="prim">
            <div class="primrow"><span class="tag">top</span>
              <span class="pseq">${esc(t7.top)}</span>
              <button class="copy" data-copy="${esc(t7.top)}">Copy</button></div>
            <div class="primrow"><span class="tag">bot</span>
              <span class="pseq">${esc(t7.bot)}</span>
              <button class="copy" data-copy="${esc(t7.bot)}">Copy</button></div>
          </div>
          ${t7.extra ? `<p class="ampnote">T7 needs the transcript to start with
            GG, so ${t7.extra} extra G${t7.extra > 1 ? "s are" : " is"} added
            ahead of the spacer.</p>` : ""}
          <h4>Plasmid cloning, BbsI</h4>
          <p>Anneal these and ligate into a BbsI-cut U6 vector such as pX330,
            where Cas9 and the scaffold are already encoded. Only for plasmid
            workflows, so check the overhangs match your backbone.</p>
          <div class="prim">
            <div class="primrow"><span class="tag">top</span>
              <span class="pseq">${esc(ol.top)}</span>
              <button class="copy" data-copy="${esc(ol.top)}">Copy</button></div>
            <div class="primrow"><span class="tag">bot</span>
              <span class="pseq">${esc(ol.bot)}</span>
              <button class="copy" data-copy="${esc(ol.bot)}">Copy</button></div>
          </div>
        </div>
      </details>
    </div>

    <div class="dsec">
      <h3>Off-target sites</h3>
      <table class="ot">
        <thead><tr><th>Mismatches</th><th>NGG</th><th>NAG</th></tr></thead>
        <tbody>${[0, 1, 2, 3, 4].map((m) => `<tr>
          <td><span class="mmdot" style="background:${mmColor(m)}"></span>${m}</td>
          <td>${num(gd.n[m])}</td><td>${num(gd.a[m])}</td></tr>`).join("")}</tbody>
      </table>
      ${gd.ot && gd.ot.length ? `
        <h3 style="margin-top:16px">Closest sites</h3>
        <table class="ot">
          <thead><tr><th>Position</th><th>MM</th><th>Seed</th><th>PAM</th><th>Lands in</th></tr></thead>
          <tbody>${gd.ot.slice(0, 6).map((h) => {
            const where = h.g
              ? `<a href="#/gene/${esc(h.g)}">${esc(h.gs || h.g)}</a>${
                  h.k === "intron" ? ' <span style="font-style:normal;color:var(--ink3)">intron</span>' : ""}`
              : '<span style="font-style:normal;color:var(--ink3)">intergenic</span>';
            return `<tr>
              <td>${esc(h.c.replace(/^N[CW]_0?/, ""))}:${num(h.p)}${esc(h.s)}</td>
              <td>${h.mm}</td><td>${h.sd}</td><td>${esc(h.pam)}</td>
              <td class="gene">${where}</td></tr>`;
          }).join("")}</tbody>
        </table>` : `<p class="seqline" style="font-size:13.5px;letter-spacing:0;color:var(--ink3)">
          No site anywhere in the assembly within ${gd.n[3] || gd.n[4] ? "2" : "4"} mismatches.</p>`}
      ${gd.otg && gd.otg.length ? `<p class="seqline"
        style="font-size:13.5px;letter-spacing:0;color:var(--t0);margin-top:10px">
        A close site falls in the coding sequence of
        ${gd.otg.map((o) => `<a href="#/gene/${esc(o.id)}"><i>${esc(o.sym)}</i></a>`).join(", ")}.</p>` : ""}
    </div>

    <div class="dsec">
      <h3>Genotyping primers</h3>
      ${pr ? `
        <div class="prim">
          <div class="primrow"><span class="tag">F</span>
            <span class="pseq">${esc(pr.F)}</span>
            <span class="pm">${pr.ftm}°C</span></div>
          <div class="primrow"><span class="tag">R</span>
            <span class="pseq">${esc(pr.R)}</span>
            <span class="pm">${pr.rtm}°C</span></div>
        </div>
        <div class="ampbar">${ampSvg}</div>
        ${ampliconHtml(gd, gene)}
        <p class="seqline" style="font-size:13px;letter-spacing:0;color:var(--ink3);line-height:1.5">
          ${esc(gene.chrom)}:${num(pr.s)}–${num(pr.e)}.
          ${pr.fh != null ? `3′ ends occur ${pr.fh} and ${pr.rh} time${
            pr.fh === 1 && pr.rh === 1 ? "" : "s"} in the genome.` : ""}
        </p>
        <button class="copy" data-copy="${esc(pr.F)}\t${esc(pr.R)}"
          style="margin-top:8px">Copy both primers</button>`
        : `<p class="seqline" style="font-size:13.5px;letter-spacing:0;color:var(--ink3)">
           No primer pair under 300 bp met the criteria around this cut site.
           Pick a neighbouring guide, or widen the product size yourself.</p>`}
    </div>
  </div>`;
}

function moreTable(g) {
  return `<p class="hint" style="font-size:14px;color:var(--ink3);margin:12px 0 10px">
      These were scanned against the whole genome but scored below the ten above,
      so they carry no primers. Useful when you need a cut at a particular place.</p>
    <table class="ot" style="margin-bottom:8px">
      <thead><tr><th>Spacer</th><th>PAM</th><th>Strand</th><th>% into CDS</th>
        <th>Specificity</th><th>0–4 mismatch sites</th><th></th></tr></thead>
      <tbody>${g.more.map((gd) => `<tr>
        <td style="letter-spacing:.03em">${esc(gd.sp)}</td>
        <td style="color:var(--gold)">${esc(gd.pam)}</td>
        <td>${gd.st === "+" ? "sense" : "anti"}</td>
        <td>${gd.f}%</td><td>${gd.spec}</td><td>${gd.n.join("·")}</td>
        <td><span class="ring sm t${gd.t}" style="vertical-align:-3px"></span></td>
      </tr>`).join("")}</tbody></table>`;
}

function ampliconHtml(gd, gene) {
  const pr = gd.pr;
  if (!pr || !pr.seq) return "";
  const L = pr.seq.length;
  const cls = new Array(L);
  const pamStart = gd.st === "+" ? gd.ps + 20 : gd.ps - 3;
  for (let k = 0; k < L; k++) {
    const p = pr.s + k;                       // genomic coordinate
    let inExon = false;
    for (const [a, b] of gene.cds) { if (p >= a && p <= b) { inExon = true; break; } }
    let c = inExon ? "ax" : "ai";
    if (k < pr.F.length || k >= L - pr.R.length) c = "ap";
    else if (p >= gd.ps && p <= gd.ps + 19) c = "as t" + gd.t;
    else if (p >= pamStart && p <= pamStart + 2) c = "am";
    cls[k] = c;
  }
  const out = [];
  let cur = null;
  for (let k = 0; k < L; k++) {
    if (k === pr.co) { if (cur !== null) { out.push("</span>"); cur = null; }
      out.push('<span class="acut" title="blunt cut site">&#9474;</span>'); }
    if (cls[k] !== cur) {
      if (cur !== null) out.push("</span>");
      out.push(`<span class="${cls[k]}">`);
      cur = cls[k];
    }
    out.push(pr.seq[k]);
  }
  if (cur !== null) out.push("</span>");
  const exonic = cls.filter((c) => c === "ax" || c.startsWith("as") || c === "am").length;
  const intronic = cls.filter((c) => c === "ai").length;
  return `<div class="ampseq">${out.join("")}</div>
    <p class="amplegend">
      <span class="k ap"></span>primer
      <span class="k as t${gd.t}"></span>protospacer
      <span class="k am"></span>PAM
      <span class="k ai"></span>intron
      <span class="acut">&#9474;</span>cut
    </p>
    <p class="ampnote">${num(pr.size)} bp from genomic DNA${
      intronic ? `, of which ${num(intronic)} bp is intron` : ", entirely exonic"}.
      The cut sits ${num(pr.co)} bp from the forward primer and ${
      num(pr.size - pr.co)} bp from the reverse.</p>`;
}

function renderGuides(g) {
  const list = $("#guides");
  let gs = g.guides.map((gd, i) => [gd, i]);
  if (state.filter === "clean") gs = gs.filter(([gd]) => gd.t >= 2);
  if (state.filter === "iso") gs = gs.filter(([gd]) => gd.core);
  if (!gs.length) {
    list.innerHTML = `<p class="nores">No guide in this gene meets that filter.
      Switch back to <b>All</b> to see everything that was scored.</p>`;
    return;
  }
  list.innerHTML = gs.map(([gd, i]) => guideRow(gd, i, g)).join("");
  list.querySelectorAll(".grow").forEach((btn) => {
    btn.addEventListener("click", () => {
      const card = btn.closest(".guide");
      const det = $(".gdetail", card);
      const open = card.classList.toggle("open");
      btn.setAttribute("aria-expanded", String(open));
      if (open && !det.dataset.built) {
        det.innerHTML = guideDetail(g.guides[+card.dataset.i], +card.dataset.i, g);
        det.dataset.built = "1";
      }
      det.hidden = !open;
      if (open) {
        $$(".guide").forEach((c) => c.classList.toggle("cur", c === card));
        selectGuide(g, +card.dataset.i, false);
      }
    });
  });
}

/* ------------------------------------------------------- CDS sequence view */
function renderCdsSeq(g, highlight, selIdx) {
  const el = $("#cdsseq");
  if (!el || !g.seq) return;
  const L = g.seq.length;

  // tier of the best guide covering each base; the selected guide wins
  const paint = new Int8Array(L).fill(-1);
  const sel = new Uint8Array(L);
  g.guides.forEach((gd, i) => {
    const sp = guideCdsSpan(g, gd);
    if (!sp) return;
    for (let k = Math.max(0, sp.s); k < Math.min(L, sp.e); k++) {
      if (paint[k] < gd.t) paint[k] = gd.t;
      if (i === selIdx) sel[k] = 1;
    }
  });

  // the pasted-sequence hit, if any
  let hitStart = -1, hitLen = 0;
  if (highlight) {
    const h = highlight.replace(/[^ACGTacgt]/g, "").toUpperCase();
    hitLen = h.length;
    hitStart = g.seq.indexOf(h);
    if (hitStart < 0) hitStart = g.seq.indexOf(rc(h));
  }

  // exons in transcript order, with their genomic coordinates
  const ivs = g.strand === "-" ? g.cds.slice().reverse() : g.cds;
  const out = [];
  let acc = 0;
  ivs.forEach(([a, b], n) => {
    const len = b - a + 1;
    const from = acc, to = Math.min(L, acc + len);
    acc += len;
    const nGuides = g.guides.filter((gd) => {
      const sp = guideCdsSpan(g, gd);
      return sp && sp.s >= from && sp.s < to;
    }).length;
    const hasSel = selIdx != null && (() => {
      const sp = guideCdsSpan(g, g.guides[selIdx]);
      return sp && sp.s >= from && sp.s < to;
    })();

    out.push(`<div class="exonblk${hasSel ? " cur" : ""}">
      <div class="exhdr">
        <b>Exon ${n + 1}</b>
        <span>${esc(g.chrom)}:${num(a)}–${num(b)}</span>
        <span>${num(len)} bp</span>
        <span>CDS ${num(from + 1)}–${num(to)}</span>
        <span class="exg">${nGuides ? `${nGuides} guide${nGuides > 1 ? "s" : ""}` : "no guide"}</span>
      </div><div class="exseq">`);

    let cur = -2, open = false;
    for (let i = from; i < to; i++) {
      const inHit = hitStart >= 0 && i >= hitStart && i < hitStart + hitLen;
      const v = inHit ? 9 : (sel[i] ? 20 + paint[i] : paint[i]);
      if (v !== cur) {
        if (open) { out.push("</mark>"); open = false; }
        if (v >= 20) { out.push(`<mark class="t${v - 20} cur" id="selspan">`); open = true; }
        else if (v === 9) { out.push('<mark class="hit">'); open = true; }
        else if (v >= 0) { out.push(`<mark class="t${v}">`); open = true; }
        cur = v;
      }
      out.push(g.seq[i]);
    }
    if (open) out.push("</mark>");
    out.push("</div></div>");
  });
  el.innerHTML = out.join("");
}

function selectGuide(g, i, scroll) {
  state.selected = i;
  renderCdsSeq(g, state.pastedSeq, i);
  $$("#mapholder .gm").forEach((el) => {
    el.classList.toggle("on", +el.dataset.i === i);
  });
  if (scroll) {
    const t = $("#selspan");
    if (t) t.scrollIntoView({ block: "center", behavior: "smooth" });
  }
}

/* ----------------------------------------------------------------- export */
function downloadCSV(g) {
  const head = ["gene_id", "symbol", "rank", "spacer", "pam", "strand", "chrom",
    "protospacer_start", "cut_site", "pct_into_cds", "in_all_isoforms", "gc_pct",
    "tier", "specificity", "score", "NGG_0mm", "NGG_1mm", "NGG_2mm", "NGG_3mm",
    "NGG_4mm", "NAG_0mm", "NAG_1mm", "NAG_2mm", "NAG_3mm", "NAG_4mm",
    "off_target_in_cds_of", "oligo_top", "oligo_bottom", "primer_F", "primer_R",
    "primer_F_tm", "primer_R_tm", "amplicon_bp", "amplicon_start", "amplicon_end"];
  const rows = [head.join(",")];
  g.guides.forEach((gd, i) => {
    const ol = cloningOligos(gd.sp);
    const p = gd.pr || {};
    const r = [g.id, g.sym, i + 1, gd.sp, gd.pam, gd.st, g.chrom, gd.ps, gd.cut,
      gd.f, gd.core ? "yes" : "no", gd.gc, TIERLABEL[gd.t], gd.spec, gd.sc,
      ...gd.n, ...gd.a,
      (gd.otg || []).map((o) => o.sym).join(" "), ol.top, ol.bot,
      p.F || "", p.R || "", p.ftm || "", p.rtm || "", p.size || "", p.s || "", p.e || ""];
    rows.push(r.map((v) => {
      const s = String(v);
      return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(","));
  });
  const blob = new Blob([rows.join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${g.sym}_${g.id}_guides.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

document.addEventListener("click", (e) => {
  const b = e.target.closest(".copy");
  if (!b) return;
  const txt = b.dataset.copy.replace(/\\t/g, "\t");
  navigator.clipboard.writeText(txt).then(() => {
    const old = b.textContent;
    b.textContent = "Copied"; b.classList.add("done");
    setTimeout(() => { b.textContent = old; b.classList.remove("done"); }, 1400);
  });
});


/* ---------------------------------------------------------------- manual */
function renderManual() {
  const sections = [
    ["what", "What NeoGuide is"],
    ["find", "Finding your gene"],
    ["page", "The gene page"],
    ["map", "The picture at the top"],
    ["list", "The list of guides"],
    ["ring", "What the coloured dot means"],
    ["numbers", "The five off-target numbers"],
    ["inside", "Opening a guide"],
    ["seq", "The sequence at the bottom"],
    ["get", "Filters and downloads"],
    ["pick", "How to pick a guide"],
    ["cannot", "What NeoGuide cannot tell you"],
    ["words", "Words you will see"],
  ];
  $("#main").innerHTML = `
  <article class="doc manual">
    <h1>How to use NeoGuide</h1>
    <p class="lede2">Everything on this site in plain language. If you have never
      designed a CRISPR experiment before, start at the top. If you just want to
      know what one number means, jump to it.</p>

    <nav class="toc">${sections.map((x) =>
      `<button type="button" data-goto="m-${x[0]}">${esc(x[1])}</button>`).join("")}</nav>

    <h2 id="m-what">What NeoGuide is</h2>
    <p>To knock out a gene with CRISPR you need three things. A short piece of
      RNA, called a guide, that matches a 20 letter stretch of your gene and
      tells the Cas9 protein where to cut. Proof that those 20 letters do not
      also match somewhere else in the genome, because Cas9 would cut there too.
      And a pair of PCR primers so you can check afterwards whether the edit
      actually happened.</p>
    <p>NeoGuide has done all three for every protein-coding gene in
      <i>Bicyclus anynana</i>. You look up your gene and copy what you need.
      There is nothing to install and nothing to run.</p>

    <h2 id="m-find">Finding your gene</h2>
    <p>There is one search box at the top of every page, and it accepts three
      different things.</p>
    <p><b>A gene name.</b> Names here follow the <i>Drosophila</i> convention, so
      type <code>optix</code>, <code>wg</code>, <code>Dll</code>,
      <code>hh</code>. Part of a name works too, and so does part of the longer
      protein description if the short name escapes you.</p>
    <p><b>A LOC number.</b> Paste it straight from the NCBI annotation, for
      example <code>LOC112048811</code>. Both the current and the older
      assembly numbering are recognised.</p>
    <p><b>A piece of sequence.</b> Paste at least 31 letters of coding sequence
      and press Enter. NeoGuide works out which gene it came from and where in
      that gene it sits, then highlights it for you. This is the one to use when
      you have a fragment from sequencing, or you want to cut inside one
      particular domain. It searches coding sequence only, so a piece of an
      intron or an untranslated region will not be found.</p>

    <h2 id="m-page">The gene page</h2>
    <p>The top of the page identifies the gene. The large name is the short name,
      the line under it is the full protein description, and the small labels
      below give the LOC number, the matching fruit fly gene and how confident
      that match is, a link to FlyBase, the length of the coding sequence, how
      many coding exons it has, and how many different versions of the gene
      (isoforms) are annotated.</p>
    <p>The confidence label on the fly gene is worth a glance. <b>High</b> means
      the two genes are each other's best match in both directions, which is the
      strongest evidence of a true equivalent. <b>Low</b> means the name comes
      from family resemblance rather than a clean one-to-one match, so treat the
      name as a hint and not a fact.</p>

    <h2 id="m-map">The picture at the top</h2>
    <p>The grey blocks are the coding exons of the gene, laid end to end in
      reading order with the start of the protein on the left. Introns are not
      drawn, because guides are never placed in them.</p>
    <p>Each small circle above the blocks is one guide, sitting at the position
      where it cuts. The colour tells you how clean that guide is, using the
      same scale as the list below. Hover over a circle to see the sequence, or
      click it to open that guide and highlight it everywhere else on the page.</p>

    <h2 id="m-list">The list of guides</h2>
    <p>Each row is one guide, and the ten shown are the best ten for that gene.
      Reading a row from left to right: the coloured dot is the overall verdict;
      the letters are the 20 letter spacer you would order, with the three letter
      PAM after it in gold; then whether the guide reads along the gene (sense)
      or against it (antisense), which does not affect how well it works; how
      far into the coding sequence it cuts, as a percentage; which exon it falls
      in; a specificity score; and the five off-target numbers.</p>
    <p>The first row is labelled as the best available guide for that gene. That
      label means two specific things, both of which are checked: it is in the
      cleanest group available for this gene, and it has a working primer pair.
      It does not mean the guide is guaranteed to cut well. Nothing on this site
      can promise that.</p>

    <h2 id="m-ring">What the coloured dot means</h2>
    <p>The dot is a quick verdict, meant for triage rather than for the final
      decision. Read the numbers before you order.</p>
    <table>
      <tr><td><span class="ring sm t3"></span></td><td><b>Dark green.</b> No other
        place in the genome comes within two letters of matching this guide.</td></tr>
      <tr><td><span class="ring sm t2"></span></td><td><b>Light green.</b> Nothing
        within one letter, but something within two. Usually still fine.</td></tr>
      <tr><td><span class="ring sm t1"></span></td><td><b>Amber.</b> No exact
        duplicate, but close enough matches exist that you should look at them.</td></tr>
      <tr><td><span class="ring sm t0"></span></td><td><b>Red.</b> The same
        sequence, or something one letter away from it, exists somewhere else in
        the genome. Cas9 will probably cut there as well.</td></tr>
    </table>

    <h2 id="m-numbers">The five off-target numbers</h2>
    <p>A row of five numbers such as <code>0 · 0 · 1 · 14 · 212</code> is the
      heart of the whole site. They count the other places in the genome that
      look like your guide, grouped by how many letters differ.</p>
    <p>The first number counts places that match perfectly. The second counts
      places that differ by one letter, the third by two, and so on up to four.
      So <code>0 · 0 · 1 · 14 · 212</code> means nothing matches exactly,
      nothing is one letter off, one place is two letters off, fourteen are
      three letters off, and two hundred and twelve are four letters off.</p>
    <p>Fewer differences means more dangerous. A site that differs by one or two
      letters is a real risk. Sites differing by four letters are mostly
      coincidence in a genome this size, and nearly every guide has some.</p>
    <p>These are complete counts from searching the whole genome on both
      strands, not estimates or samples. Your own target is not included in them.</p>

    <h2 id="m-inside">Opening a guide</h2>
    <p>Clicking a row opens three panels.</p>
    <h3>Left: the target and what to order</h3>
    <p>The sequence is shown with its surroundings, the cut point marked, and the
      exact position in the genome written underneath. Below that is the 20
      letter spacer with a copy button. If you buy ready-made synthetic guide
      RNA, that is all you need.</p>
    <p>If you make your own, open <b>Other oligo formats</b>. The first option
      gives you two DNA oligos that you anneal and transcribe with T7 to produce
      the guide RNA yourself, which is the usual route for injecting Cas9
      protein into embryos. The second oligo of that pair never changes, so you
      order it once and reuse it for every gene. The second option gives you
      oligos with sticky ends for cloning the guide into a plasmid such as
      pX330, which only applies if you work with plasmids rather than injecting
      protein.</p>
    <h3>Middle: where else this guide could cut</h3>
    <p>The first table repeats the five numbers, split by PAM type. The
      <b>NGG</b> column is the one that matters, because that is the sequence
      Cas9 needs in order to cut. <b>NAG</b> is a weaker version that Cas9 uses
      only rarely, so those numbers are far less worrying.</p>
    <p>The second table lists the individual sites that come closest, with the
      most concerning first. <b>MM</b> is how many letters differ. <b>Seed</b> is
      how many of those differences fall in the twelve letters nearest the PAM,
      which is the stretch Cas9 is fussiest about. A difference in the seed
      usually stops Cas9 cutting, so a high seed number is reassuring and a seed
      of zero deserves a look. <b>Lands in</b> tells you whether that site falls
      inside another gene's coding sequence, inside an intron, or in empty space
      between genes. A site inside another gene's coding sequence is the one to
      take seriously, and NeoGuide names the gene so you can judge whether
      cutting it would ruin your experiment.</p>
    <h3>Right: primers for checking the edit</h3>
    <p>After injecting, you need to know whether anything actually changed.
      These two primers amplify a short piece of DNA around the cut, which you
      then sequence. The product is under 300 letters and the cut sits at least
      50 letters from each end, so the change is comfortably inside the read.</p>
    <p>The bar underneath shows the product with the cut marked. Below it is the
      actual sequence that will be amplified, with the primers shaded, the guide
      marked in its colour, the PAM in gold, and any intron in lighter type so
      you can see whether the product crosses a splice junction. The line about
      3' ends tells you how many times each primer's business end occurs in the
      genome. One is what you want.</p>

    <h2 id="m-seq">The sequence at the bottom</h2>
    <p>This is the full coding sequence of the gene, split into its exons. Each
      exon has its own heading giving its number, its position in the genome,
      its length, and how many guides fall inside it.</p>
    <p>Guides are highlighted in the sequence in their verdict colour, so you can
      see at a glance where the clean ones cluster. When you open a guide, that
      one is outlined in black and the page scrolls to it, so you can always see
      exactly which letters you are about to cut.</p>

    <h2 id="m-get">Filters and downloads</h2>
    <p>Above the list, <b>Cleanest</b> hides anything but the best two
      categories, and <b>All isoforms</b> keeps only guides that sit in sequence
      shared by every annotated version of the gene, which matters when a gene
      has several isoforms and you want to disable all of them.</p>
    <p>Below the list, <b>Show more scanned guides</b> reveals another twenty
      that were checked against the genome but scored lower. They carry no
      primers. They are useful when you need to cut at one particular place
      rather than simply anywhere in the gene.</p>
    <p><b>Download CSV</b> gives you the ten guides for the gene you are looking
      at, with every number, the oligos and the primers, ready for a
      spreadsheet. If you want the whole species at once, the file
      <code>data/guides_top.tsv</code> holds every published guide for every
      gene as one plain table.</p>
    <p>The moon button at the top right switches between light and dark.</p>

    <h2 id="m-pick">How to pick a guide</h2>
    <p>In most cases the first row is the right answer and you can stop there.
      When you want to think about it, here is the order worth checking.</p>
    <p>Start with the first two of the five numbers. If either is above zero,
      something in the genome matches your guide exactly or nearly so, and you
      should choose a different guide unless you have a reason not to. Next look
      at whether any close site lands inside another gene's coding sequence, and
      whether that gene would matter to your experiment. Then think about
      position. Cutting in the first half of the coding sequence is more likely
      to destroy the protein than cutting near the end, and the percentage
      column tells you where you are. If the gene has several isoforms and you
      want to disable all of them, use the <b>All isoforms</b> filter. Finally,
      check there is a primer pair, because without one you cannot easily tell
      whether the edit worked.</p>
    <p>Many labs inject two guides against the same gene to cut out the piece
      between them, which makes the change easy to see on a gel. If you plan
      that, pick two clean guides from different parts of the list and check
      that one primer pair spans both cut sites.</p>

    <h2 id="m-cannot">What NeoGuide cannot tell you</h2>
    <p>It cannot tell you how well a guide will cut. Everything here is about
      whether a guide is <i>specific</i>, meaning it hits your gene and nothing
      else. How efficiently a given guide works is a different question, and the
      published tools that try to predict it were trained on human and mouse
      cells and have never been tested in butterflies. Treat two clean guides as
      equally promising and test them.</p>
    <p>It also compares your guide against the reference genome, which is not
      the exact genome of the animals in your cage. Natural variation between
      individuals can create a mismatch that stops a guide working, or remove
      one and create an off-target that is not listed here.</p>
    <p>Guides are only placed inside coding sequence, so if you want to edit a
      promoter, an enhancer, an untranslated region or a splice site, you will
      not find what you need here.</p>
    <p>Finally, the off-target search looks for letter substitutions only. It
      does not look for sites that match after allowing an insertion or a
      deletion, which are rarer but not impossible.</p>
    <p>None of this is a reason to distrust the numbers. It is a reason to check
      every oligo against your own sequence before ordering, and to confirm
      edits by sequencing rather than by hope.</p>

    <h2 id="m-words">Words you will see</h2>
    <table>
      <tr><td>Spacer</td><td>The 20 letters of your guide that match the gene.
        This is what you order.</td></tr>
      <tr><td>Protospacer</td><td>The matching 20 letters in the DNA itself.</td></tr>
      <tr><td>PAM</td><td>Three letters sitting next to the target that Cas9 must
        find before it will cut. For this Cas9 it is NGG, where N is any letter.
        It is part of the DNA, not part of what you order.</td></tr>
      <tr><td>Seed</td><td>The twelve letters of the spacer closest to the PAM.
        Cas9 is least tolerant of differences here.</td></tr>
      <tr><td>Mismatch</td><td>One letter that differs between your guide and
        some place in the genome.</td></tr>
      <tr><td>Off-target</td><td>Another place in the genome similar enough that
        Cas9 might cut it too.</td></tr>
      <tr><td>Cut site</td><td>Where Cas9 breaks the DNA, three letters in from
        the PAM end of the target.</td></tr>
      <tr><td>CDS</td><td>Coding sequence. The part of the gene that is actually
        turned into protein.</td></tr>
      <tr><td>Exon and intron</td><td>Exons are the pieces kept in the finished
        message, introns the pieces cut out. Guides here sit wholly inside
        coding exons.</td></tr>
      <tr><td>Isoform</td><td>One of several versions of the same gene, built by
        joining its exons in different combinations.</td></tr>
      <tr><td>sgRNA</td><td>The finished guide RNA molecule, spacer plus the
        fixed scaffold that Cas9 holds on to.</td></tr>
      <tr><td>RNP</td><td>Cas9 protein with its guide RNA already loaded,
        injected as a ready-made complex.</td></tr>
      <tr><td>Amplicon</td><td>The piece of DNA your two primers copy, which you
        sequence to check the edit.</td></tr>
      <tr><td>Specificity</td><td>A single number summarising the off-target
        counts. Higher is cleaner. It is a convenience, not a measurement, and
        the <a href="#/methods">Methods</a> page gives the formula.</td></tr>
    </table>

    <p class="endnote">Still stuck, or something here is wrong or unclear? That is
      worth fixing, so please say so.</p>
  </article>`;
  $("#main").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-goto]");
    if (!b) return;
    const t = document.getElementById(b.dataset.goto);
    if (t) t.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

/* ---------------------------------------------------------------- methods */
function renderMethods() {
  loadIndex().then(() => {
    const m = state.meta || {};
    $("#main").innerHTML = `
    <article class="doc">
      <h1>How these guides were made</h1>
      <p>Every number on this site comes from the assembly and annotation named
        below. Nothing is carried over from another species or another tool.</p>

      <h2>Source data</h2>
      <table>
        <tr><td>Species</td><td><i>${esc(m.species || "")}</i></td></tr>
        <tr><td>Assembly</td><td>${esc(m.assembly || "")}</td></tr>
        <tr><td>Annotation</td><td>${esc(m.annotation || "")}</td></tr>
        <tr><td>Coding genes</td><td>${num(m.n_genes || 0)}</td></tr>
        <tr><td>Nuclease</td><td>${esc(m.nuclease || "")}</td></tr>
      </table>

      <h2>Finding the guides</h2>
      <p>For each gene the longest annotated coding transcript is taken as the
        representative. Every 23-mer that sits entirely inside one coding exon and
        ends in NGG is a candidate, on both strands. Guides are never allowed to
        run across a splice junction, because the genomic target would then
        contain intron sequence.</p>
      <p>Candidates are ranked on sequence features alone. Those features are
        GC content, poly-T tracts that terminate Pol III transcription,
        homopolymers, internal self-complementarity, position along the coding
        sequence, distance from the exon edge, and whether the cut falls in
        coding sequence shared by every annotated isoform. The best of each tenth of the CDS go forward, so
        the scan covers the whole gene rather than clustering at one end.</p>

      <h2>The off-target scan</h2>
      <p>Each selected guide was compared against <b>every</b> NGG and NAG site on
        both strands of the whole ${esc((m.assembly || "").split(" ")[0])} assembly,
        complete to four mismatches. Completeness is guaranteed rather than
        sampled: a 20-mer differing at no more than four positions must match one
        of five four-base blocks exactly, so indexing all five blocks of every
        guide cannot miss a hit. The guide's own site is excluded; a second
        perfect match elsewhere is reported, because that is a real off-target.</p>
      <p>The counts shown are exhaustive. The listed closest sites are capped at
        the sixteen best per guide, lowest mismatch first.</p>

      <h2>What specificity means here</h2>
      <p>Specificity is a <b>heuristic</b>, not a validated efficiency predictor.
        Each off-target site adds a load by mismatch count, an NAG PAM counts a
        tenth of an NGG, and specificity is <code>100 / (1 + load)</code>:</p>
      <table>
        <tr><th>Mismatches</th><th>0</th><th>1</th><th>2</th><th>3</th><th>4</th></tr>
        <tr><td>Load per NGG site</td><td>20</td><td>4</td><td>0.6</td><td>0.08</td><td>0.004</td></tr>
      </table>
      <p>The weights are set so that the unavoidable four-mismatch background of a
        457 Mb genome costs a few points while a single close site dominates. A
        typical clean guide lands near 78. These values are not comparable with
        the MIT or CFD scores printed by other tools, so use the raw mismatch
        counts when you want to compare across software.</p>
      <p>The ring colour combines that specificity with the sequence score, then
        caps the result whenever a perfect or single-mismatch site exists
        elsewhere. Treat the ring as triage and read the counts before you order.</p>

      <h2>Genotyping primers</h2>
      <p>Primers are designed with Primer3 on genomic sequence around each cut
        site, so the product can be amplified straight from genomic DNA. Products
        are under 300 bp and place the cut at least 50 bp from both ends, which
        keeps the indel away from the read edges in amplicon sequencing. Where the
        3′ end of each primer was counted against the genome, that count is shown;
        anything other than one deserves a second look.</p>

      <h2>Known limits</h2>
      <ul>
        <li>Guide activity is not predicted. Nothing here tells you how well a
          guide cuts, only how specific it is and whether the sequence has obvious
          defects. Published activity models are trained on human and mouse data
          and have never been validated in Lepidoptera.</li>
        <li>Off-targets are counted against the assembly, which is not the genome
          of your colony. Strain polymorphism can create or destroy sites.</li>
        <li>Only coding sequence is targeted. Regulatory knockouts, tagging and
          promoter edits need guides this build does not contain.</li>
        <li>Insertions and deletions in the protospacer, as opposed to
          substitutions, are not searched.</li>
      </ul>

      <h2>Bulk download</h2>
      <p>The complete published set is a single tab-separated table:
        <a href="${DATA}/guides_top.tsv"><code>data/guides_top.tsv</code></a>.
        Every gene also has its own JSON file under <code>data/genes/</code>.</p>
    </article>`;
  }).catch(dataError);
}

function renderFootMeta() {
  const m = state.meta; if (!m) return;
  $("#footmeta").textContent =
    `${m.species} · ${m.assembly} · ${num(m.n_genes)} coding genes · ` +
    `${num(m.n_guides_published)} guides · off-targets searched ${m.ot_search}`;
}

/* ----------------------------------------------------------------- router */
function route() {
  const h = location.hash.replace(/^#/, "") || "/";
  const [path, query] = h.split("?");
  const params = {};
  if (query) for (const kv of query.split("&")) {
    const [k, v] = kv.split("=");
    params[k] = decodeURIComponent(v || "");
  }
  const parts = path.split("/").filter(Boolean);
  window.scrollTo(0, 0);
  if (!parts.length) return renderHome();
  if (parts[0] === "gene" && parts[1]) return renderGene(parts[1], params);
  if (parts[0] === "search" && parts[1]) return renderResults(decodeURIComponent(parts[1]));
  if (parts[0] === "manual") return renderManual();
  if (parts[0] === "methods") return renderMethods();
  renderHome();
}

/* ------------------------------------------------------------------ theme */
(function theme() {
  // localStorage throws on opaque origins (file:// in some browsers); a throw
  // here would abort the whole script before the app ever starts.
  let saved = null;
  try { saved = localStorage.getItem("ng-theme") || localStorage.getItem("ga-theme"); }
  catch (_) { saved = null; }
  const sys = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  document.documentElement.dataset.theme = saved || sys;
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#theme")) return;
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("ng-theme", next); } catch (_) {}
  });
})();

window.addEventListener("hashchange", route);
wireSearch($("#q"), $("#sug"));
loadIndex();
route();
let rt;
window.addEventListener("resize", () => {
  if (!state.gene || !$("#mapholder")) return;
  clearTimeout(rt);
  rt = setTimeout(() => {
    if (!$("#mapholder")) return;
    drawMap(state.gene);
    if (state.selected != null) {
      $$("#mapholder .gm").forEach((el) => {
        el.classList.toggle("on", +el.dataset.i === state.selected);
      });
    }
  }, 160);
});
})();
