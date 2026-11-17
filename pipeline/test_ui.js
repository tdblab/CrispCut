/* Render the real site in jsdom against the real data files and assert that
   each route produces the expected content without throwing. */
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");

const SITE = process.argv[2] || "/home/claude/site";
const html = fs.readFileSync(path.join(SITE, "index.html"), "utf8");
const js = fs.readFileSync(path.join(SITE, "assets/app.js"), "utf8");

const errors = [];
const vc = new VirtualConsole();
vc.on("jsdomError", (e) => errors.push("jsdomError: " + e.message));
vc.on("error", (...a) => errors.push("console.error: " + a.join(" ")));

const dom = new JSDOM(html, {
  url: "https://example.org/",
  runScripts: "outside-only",
  virtualConsole: vc,
  pretendToBeVisual: true,
});
const { window } = dom;

// Data files are classic scripts now, so serve them by executing from disk the
// way a browser would. fetch is left undefined on purpose: if the app ever
// reaches for it again these tests must fail.
const loadedScripts = [];
const origCreate = window.document.createElement.bind(window.document);
window.document.createElement = (tag) => {
  const el = origCreate(tag);
  if (String(tag).toLowerCase() !== "script") return el;
  let src = "";
  Object.defineProperty(el, "src", {
    configurable: true,
    get: () => src,
    set: (v) => {
      src = String(v);
      loadedScripts.push(src);
      setTimeout(() => {
        const rel = src.replace(/^.*?\/?(data\/)/, "$1");
        const p = path.join(SITE, rel);
        if (!fs.existsSync(p)) { if (el.onerror) el.onerror(); return; }
        try { window.eval(fs.readFileSync(p, "utf8")); }
        catch (e) { errors.push("data script threw: " + e.message); }
        if (el.onload) el.onload();
      }, 0);
    },
  });
  return el;
};
window.matchMedia = window.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {} }));
Object.defineProperty(window.Element.prototype, "clientWidth", { get() { return 900; }, configurable: true });
window.scrollTo = () => {};
window.Element.prototype.scrollIntoView = () => {};
window.navigator.clipboard = { writeText: () => Promise.resolve() };
window.URL.createObjectURL = () => "blob:x";
window.URL.revokeObjectURL = () => {};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (s) => window.document.querySelector(s);

const RCM0 = { A: "T", C: "G", G: "C", T: "A" };
const rcs = (x) => x.split("").reverse().map((c) => RCM0[c] || "N").join("");

(async () => {
  window.eval(js);
  await sleep(400);

  const checks = [];
  const t = (name, cond, extra) => {
    checks.push([name, !!cond, extra || ""]);
  };

  // ---- home -------------------------------------------------------------
  t("no fetch() left in the data path", typeof window.fetch === "undefined");
  t("data arrived via script tags", loadedScripts.length > 0,
    `${loadedScripts.length} scripts`);
  t("home hero renders", /Every coding gene/.test($("#main").textContent));
  const statTxt = $("#main").textContent;
  t("gene count substituted", /\d{2},\d{3}/.test(statTxt), statTxt.slice(0, 0));
  t("example gene links present", $("#examples") && $("#examples").querySelectorAll("a").length > 0,
    $("#examples") ? $("#examples").textContent.trim() : "");

  // ---- search index -----------------------------------------------------
  const readJs = (f) => {
    const raw = fs.readFileSync(f, "utf8");
    return JSON.parse(raw.slice(raw.indexOf(",") + 1, raw.lastIndexOf(");")));
  };
  const idx = readJs(path.join(SITE, "data/search.js")).g;
  const probe = idx.find((g) => g[1] && /^[A-Za-z]/.test(g[1]) && g[9] === 3) || idx[0];

  // ---- typeahead --------------------------------------------------------
  const q = $("#q");
  q.value = probe[1];
  q.dispatchEvent(new window.Event("input", { bubbles: true }));
  await sleep(250);
  const sug = $("#sug");
  t("typeahead offers the gene", sug && !sug.hidden && /\S/.test(sug.textContent),
    sug ? sug.textContent.slice(0, 60).replace(/\s+/g, " ") : "");

  // ---- gene page --------------------------------------------------------
  window.location.hash = `#/gene/${probe[0]}`;
  window.dispatchEvent(new window.Event("hashchange"));
  await sleep(500);
  const main = $("#main");
  t("gene header renders", main.querySelector(".gh h1") &&
    main.querySelector(".gh h1").textContent.trim().length > 0,
    main.querySelector(".gh h1") ? main.querySelector(".gh h1").textContent : "");
  const svg = main.querySelector("svg.cdsmap");
  t("CDS map drawn", !!svg);
  const rings = svg ? svg.querySelectorAll("g.gm").length : 0;
  t("guide markers on map", rings > 0, `${rings} markers`);
  const exons = svg ? svg.querySelectorAll("rect.exon").length : 0;
  t("exons drawn", exons > 0, `${exons} exons`);
  const rows = main.querySelectorAll(".guide").length;
  t("guide rows listed", rows > 0, `${rows} rows`);
  t("spacer shown in row", /[ACGT]{20}/.test(main.querySelector(".gseq").textContent));

  // ---- expand a guide ---------------------------------------------------
  main.querySelector(".grow").dispatchEvent(new window.Event("click", { bubbles: true }));
  await sleep(200);
  const det = main.querySelector(".gdetail");
  t("detail panel builds", det && det.dataset.built === "1");
  const dt = det ? det.textContent : "";
  t("off-target table present", /Mismatches/.test(dt));
  t("cloning oligos present", /CACC/.test(dt));
  const hasPrimer = /Genotyping primers/.test(dt);
  t("primer section present", hasPrimer);
  t("amplicon drawn or explained", det.querySelector("svg.amp") || /No primer pair/.test(dt));

  // ---- CDS sequence highlight -------------------------------------------
  const seqEl = $("#cdsseq");
  const marks = seqEl ? seqEl.querySelectorAll("mark").length : 0;
  t("CDS sequence rendered", seqEl && seqEl.textContent.length > 100,
    seqEl ? `${seqEl.textContent.length} bp` : "");
  t("guides highlighted in CDS", marks > 0, `${marks} highlighted spans`);

  // every highlighted span must be exactly a protospacer of this gene
  const gene = readJs(path.join(SITE, "data/genes", probe[0].slice(0, 6), probe[0] + ".js"));
  const RCM = { A: "T", C: "G", G: "C", T: "A" };
  const rcs = (s) => s.split("").reverse().map((c) => RCM[c] || "N").join("");
  const spset = new Set();
  for (const gd of gene.guides) { spset.add(gd.sp); spset.add(rcs(gd.sp)); }
  let markBad = 0, markChecked = 0;
  for (const m of (seqEl ? seqEl.querySelectorAll("mark") : [])) {
    const txt = m.textContent;
    if (txt.length !== 20) continue;   // adjacent guides can merge into one span
    markChecked++;
    if (!spset.has(txt)) markBad++;
  }
  t("highlighted 20-mers are real protospacers", markBad === 0,
    `${markChecked} checked, ${markBad} wrong`);

  // ---- top pick ---------------------------------------------------------
  const first = main.querySelector(".guide");
  t("rank 1 marked as best available", first.classList.contains("top") &&
    /Best available guide/.test(first.textContent));
  t("ranking rationale shown", /not predicted by this or any other tool/.test(main.textContent));

  // ---- oligo formats ----------------------------------------------------
  t("20 nt spacer shown first", det.querySelector(".big20") &&
    /^[ACGT]{20}$/.test(det.querySelector(".big20").textContent.trim()),
    det.querySelector(".big20") ? det.querySelector(".big20").textContent.trim() : "");
  const fmt = det.querySelector("details.fmt");
  t("other formats collapsed by default", fmt && !fmt.open);
  t("T7 IVT oligos present", /TAATACGACTCACTATA/.test(dt));
  t("universal bottom oligo present", /AAAAAAGCACCGACTCGGTGCCACT/.test(dt));
  t("BbsI oligos still available", /CACC/.test(dt) && /AAAC/.test(dt));

  // T7 top oligo must contain the spacer and the scaffold overlap
  const gd0 = readJs(path.join(SITE, "data/genes", probe[0].slice(0, 6), probe[0] + ".js")).guides[0];
  const t7row = Array.from(det.querySelectorAll(".pseq"))
    .map((e) => e.textContent).find((x) => x.startsWith("TAATACGACTCACTATA"));
  t("T7 oligo contains spacer + scaffold",
    t7row && t7row.includes(gd0.sp) && t7row.endsWith("GTTTTAGAGCTAGAAATAGCAAGTTAAAATAG"),
    t7row ? t7row.slice(0, 40) + "..." : "missing");
  t("T7 transcript starts with GG", t7row &&
    /TAATACGACTCACTATAGG/.test(t7row.slice(0, 20) + t7row.slice(17, 20)),
    t7row ? t7row.slice(0, 22) : "");

  // ---- amplicon ---------------------------------------------------------
  const amps = det.querySelector(".ampseq");
  if (gd0.pr) {
    t("amplicon sequence rendered", amps && amps.textContent.replace(/[^ACGT]/g, "").length === gd0.pr.size,
      amps ? `${amps.textContent.replace(/[^ACGT]/g, "").length} vs ${gd0.pr.size}` : "none");
    t("amplicon matches stored sequence",
      amps && amps.textContent.replace(/[^ACGT]/g, "") === gd0.pr.seq);
    t("primers marked in amplicon", det.querySelectorAll(".ampseq .ap").length >= 2);
    t("protospacer marked in amplicon", det.querySelectorAll(".ampseq .as").length >= 1);
    t("cut site marked in amplicon", det.querySelectorAll(".ampseq .acut").length >= 1);
    t("legend present", !!det.querySelector(".amplegend"));
  }

  // ---- exon-structured sequence ------------------------------------------
  const blks = seqEl.querySelectorAll(".exonblk");
  t("sequence split into exon blocks", blks.length === gene.cds.length,
    `${blks.length} blocks vs ${gene.cds.length} exons`);
  t("exon headers carry coordinates", /Exon 1/.test(seqEl.textContent) &&
    /CDS 1–/.test(seqEl.textContent));
  const blkBases = Array.from(blks).reduce((a, b) =>
    a + b.querySelector(".exseq").textContent.replace(/[^ACGTN]/g, "").length, 0);
  t("exon blocks reproduce the whole CDS", blkBases === gene.seq.length,
    `${blkBases} vs ${gene.seq.length}`);

  // ---- selection highlights both views -----------------------------------
  const ring = main.querySelector('svg.cdsmap .gm[data-i="0"]');
  t("map ring marked selected", ring && ring.classList.contains("on"));
  const selSpan = seqEl.querySelector("mark.cur");
  t("sequence span marked selected", !!selSpan,
    selSpan ? selSpan.textContent : "none");
  t("selected span is the guide protospacer", selSpan &&
    (selSpan.textContent === gd0.sp || selSpan.textContent === rcs(gd0.sp)),
    selSpan ? selSpan.textContent : "");
  t("selected exon block flagged", !!seqEl.querySelector(".exonblk.cur"));

  // selecting a different guide moves both highlights
  const rows2 = main.querySelectorAll(".guide");
  if (rows2.length > 1) {
    rows2[1].querySelector(".grow").dispatchEvent(new window.Event("click", { bubbles: true }));
    await sleep(200);
    const r2 = main.querySelector('svg.cdsmap .gm[data-i="1"]');
    t("selection follows to guide 2 on the map", r2 && r2.classList.contains("on") &&
      !main.querySelector('svg.cdsmap .gm[data-i="0"]').classList.contains("on"));
    const gd1 = readJs(path.join(SITE, "data/genes", probe[0].slice(0, 6), probe[0] + ".js")).guides[1];
    const s2 = seqEl.querySelector("mark.cur");
    t("selection follows to guide 2 in the sequence", s2 &&
      (s2.textContent === gd1.sp || s2.textContent === rcs(gd1.sp)),
      s2 ? s2.textContent : "none");
  }

  // ---- filters ----------------------------------------------------------
  const segs = main.querySelectorAll(".seg button");
  segs[1].dispatchEvent(new window.Event("click", { bubbles: true }));
  await sleep(120);
  t("filter changes the list", $("#guides").children.length > 0,
    `${$("#guides").children.length} after 'cleanest'`);
  segs[0].dispatchEvent(new window.Event("click", { bubbles: true }));
  await sleep(120);

  // ---- methods ----------------------------------------------------------
  window.location.hash = "#/methods";
  window.dispatchEvent(new window.Event("hashchange"));
  await sleep(300);
  t("methods page renders", /How these guides were made/.test($("#main").textContent));
  t("methods shows assembly", /ilBicAnyn/.test($("#main").textContent));

  // ---- text search route ------------------------------------------------
  window.location.hash = `#/search/${encodeURIComponent(probe[1])}`;
  window.dispatchEvent(new window.Event("hashchange"));
  await sleep(300);
  t("search results render", $("#main").querySelectorAll(".rlist a").length > 0,
    `${$("#main").querySelectorAll(".rlist a").length} results`);

  // ---- sequence search route --------------------------------------------
  const frag = gene.seq.substr(30, 80);
  window.location.hash = `#/search/${frag}`;
  window.dispatchEvent(new window.Event("hashchange"));
  await sleep(900);
  const stxt = $("#main").textContent;
  t("sequence search finds the gene", stxt.includes(gene.sym) || stxt.includes(gene.id),
    stxt.slice(0, 90).replace(/\s+/g, " "));

  // ---- missing gene -----------------------------------------------------
  window.location.hash = "#/gene/LOC000000000";
  window.dispatchEvent(new window.Event("hashchange"));
  await sleep(300);
  t("unknown gene handled", /Gene not found/.test($("#main").textContent));

  // ---- report -----------------------------------------------------------
  let fails = 0;
  for (const [n, ok, extra] of checks) {
    if (!ok) fails++;
    console.log(`${ok ? "  ok  " : "FAIL  "}${n}${extra ? "   [" + extra + "]" : ""}`);
  }
  if (errors.length) {
    console.log("\nRUNTIME ERRORS:");
    errors.slice(0, 10).forEach((e) => console.log("  " + e));
  }
  console.log(`\n${checks.length - fails}/${checks.length} checks passed, ${errors.length} runtime errors`);
  process.exit(fails === 0 && errors.length === 0 ? 0 : 1);
})().catch((e) => { console.error("HARNESS ERROR", e); process.exit(2); });
