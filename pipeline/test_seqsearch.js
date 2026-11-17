/* Verify the sequence-search index end to end: take real CDS fragments out of
   gene files, run the exact lookup the browser runs against the real shard
   binaries, and check the right gene comes back at the right offset. */
const fs = require("fs");
const path = require("path");

const SITE = process.argv[2] || "/home/claude/site";
const D = path.join(SITE, "data");
const readJs = (f) => {
  const raw = fs.readFileSync(f, "utf8");
  return JSON.parse(raw.slice(raw.indexOf(",") + 1, raw.lastIndexOf(");")));
};
const meta = readJs(path.join(D, "seqindex", "meta.js"));
const search = readJs(path.join(D, "search.js")).g;
const RC = { A: "T", C: "G", G: "C", T: "A", N: "N" };
const rc = (s) => s.split("").reverse().map((c) => RC[c] || "N").join("");

function hash32(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}
const shardCache = new Map();
function b64ToU32(b64) {
  const bin = Buffer.from(b64, "base64");
  return new Uint32Array(bin.buffer, bin.byteOffset, bin.length >> 2);
}
function loadShard(n) {
  if (!shardCache.has(n)) {
    shardCache.set(n, b64ToU32(readJs(path.join(D, "seqindex", `s${n}.js`))));
  }
  return shardCache.get(n);
}

function lookup(q) {
  const K = meta.k, OFFBITS = meta.offbits;
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
    for (const [shard, list] of need) {
      const arr = loadShard(shard);
      for (const [h, qoff] of list) {
        let lo = 0, hi = arr.length / 2 - 1, at = -1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1, v = arr[mid * 2];
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
  return Array.from(votes.entries())
    .map(([k, v]) => { const [gi, si, st] = k.split("|").map(Number); return { gi, si, st, v }; })
    .sort((a, b) => b.v - a.v);
}

// --- sample real CDS fragments ------------------------------------------
let ok = 0, fail = 0, okrc = 0, offok = 0;
const picks = [];
for (let i = 0; i < 60; i++) picks.push(Math.floor((i * 7919) % search.length));
for (const gi of picks) {
  const row = search[gi];
  const id = row[0];
  const f = path.join(D, "genes", id.slice(0, 6), id + ".js");
  if (!fs.existsSync(f)) continue;
  const g = readJs(f);
  if (!g.seq || g.seq.length < 160) continue;
  const start = 37 % Math.max(1, g.seq.length - 130);
  const frag = g.seq.substr(start, 90);

  let r = lookup(frag);
  let hit = r.find((x) => x.gi === gi && x.si === 0);
  if (hit) { ok++; if (hit.st === start) offok++; } else { fail++;
    console.log("MISS", id, "top:", r.slice(0, 2).map((x) => search[x.gi] && search[x.gi][0])); }

  // same fragment reverse complemented must be found on the reverse pass
  r = lookup(rc(frag));
  if (r.find((x) => x.gi === gi && x.si === 1)) okrc++;
}
console.log(`forward found ${ok}, missed ${fail}, offset exact ${offok}`);
console.log(`reverse-complement found ${okrc}`);

// --- a sequence that should not be there ---------------------------------
const junk = "GGATCCTTAATTAAGCGGCCGCACTAGTCCTGCAGGTCGACTCTAGAGGATCCAAGCTTGCATGCCTGCAGG";
const jr = lookup(junk);
console.log("synthetic polylinker top votes:", jr.length ? jr[0].v : 0,
  jr.length && jr[0].v >= 3 ? "(unexpected)" : "(correctly no strong match)");
process.exit(fail === 0 && ok > 40 ? 0 : 1);
