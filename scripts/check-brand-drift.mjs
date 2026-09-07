#!/usr/bin/env node
// Brand-drift check for parcelrow.com.
//
// The Vantrow registry (getvantrow.com/api/platform/manifest) is the family's
// single source of truth for brand colour. This site restates those values in
// its own CSS custom properties, and nothing else forces the two to agree —
// this script is that force. It fetches the live manifest and compares the
// parcelrow palette against EVERY `:root { ... }` block in the repo: site.css
// and any inline copy in an .html file. The inline copy in index.html is the
// reason for "every": three earlier fixes landed in site.css while index.html
// silently kept the old values.
//
// Zero dependencies, Node 18+ (global fetch). Exit codes:
//   0  every mapped token matches the registry
//   1  drift found (details in the table)
//   2  manifest unreachable or malformed — a network problem, not a brand one
//
// When this is red, the BRANDBOOK maintenance rule decides which side moves:
// the LIVE KIT WINS and the registry is corrected — unless the book explicitly
// derived the value, in which case the book wins and this site is republished.

import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_URL =
  process.env.VANTROW_MANIFEST_URL ?? "https://getvantrow.com/api/platform/manifest";
const BRAND_KEY = "parcelrow";

// Registry palette key -> this site's CSS custom property. Keys absent here
// are deliberately not compared: `layerUpzone` is the map's upzone screen and
// lives in the plat SVG, not in a site token (BRANDBOOK §4 — "product
// semantics, not brand decoration"). Site vars with no registry key
// (--thread-ink, --eyebrow-ink, --live-wash, fonts) are this site's own.
const MAP = {
  brand: "--brand",
  brandDeep: "--brand-deep",
  brandWash: "--brand-wash",
  gold: "--gold",
  goldInk: "--gold-ink",
  goldPale: "--gold-pale",
  cream: "--cream",
  card: "--card",
  ink: "--ink",
  muted: "--mut",
  line: "--line",
  vault: "--vault",
  live: "--live",
};

/** Lower-case six-digit hex, or null if the value is not a plain hex colour. */
function normalizeHex(value) {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(value).trim());
  if (!m) return null;
  const h = m[1].toLowerCase();
  return "#" + (h.length === 3 ? h.split("").map((c) => c + c).join("") : h);
}

/** Every `--name: value` declared inside any rule whose selector mentions
 *  `:root` — a bare `:root {`, but also a selector LIST like
 *  `:root, :root[data-theme="dark"] {`, which is exactly how index.html
 *  declares its inline palette. A `:root\s*\{` pattern would skip that block
 *  and this check would silently miss the one file it most needs to read. */
function rootVars(text) {
  const vars = new Map();
  for (const block of text.matchAll(/:root[^{}]*\{([^}]*)\}/g)) {
    for (const decl of block[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      vars.set(decl[1], decl[2].trim());
    }
  }
  return vars;
}

async function loadPalette() {
  let res;
  try {
    res = await fetch(MANIFEST_URL, { signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    throw new Error(`manifest unreachable: ${err?.message ?? err}`);
  }
  if (!res.ok) throw new Error(`manifest returned HTTP ${res.status}`);
  const manifest = await res.json();
  const brand = (manifest.brands ?? []).find((b) => b.key === BRAND_KEY);
  if (!brand?.palette) throw new Error(`manifest has no palette for "${BRAND_KEY}"`);
  return brand.palette;
}

const files = ["site.css", ...readdirSync(ROOT).filter((f) => f.endsWith(".html"))].sort();

let palette;
try {
  palette = await loadPalette();
} catch (err) {
  console.error(`✗ ${err.message}`);
  console.error(`  (${MANIFEST_URL})`);
  process.exit(2);
}

const declared = files.map((f) => ({ file: f, vars: rootVars(readFileSync(join(ROOT, f), "utf8")) }));
const rows = [];
let drift = 0;

for (const [key, cssVar] of Object.entries(MAP)) {
  const want = normalizeHex(palette[key]);
  if (!want) {
    rows.push([key, cssVar, String(palette[key] ?? "—"), "—", "registry value is not a hex colour"]);
    continue;
  }
  let seen = false;
  for (const { file, vars } of declared) {
    if (!vars.has(cssVar)) continue;
    seen = true;
    const got = normalizeHex(vars.get(cssVar));
    const ok = got === want;
    if (!ok) drift++;
    rows.push([key, cssVar, want, `${file}: ${got ?? vars.get(cssVar)}`, ok ? "ok" : "DRIFT"]);
  }
  if (!seen) rows.push([key, cssVar, want, "—", "not declared in any :root (warn)"]);
}

// Registry keys this script doesn't know about — surfaced so a new token in the
// registry gets a decision here instead of silently going unchecked.
const unmapped = Object.keys(palette).filter((k) => !(k in MAP) && k !== "layerUpzone");

const widths = [0, 0, 0, 0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
for (const r of rows) {
  const cells = r.slice(0, 4).map((c, i) => c.padEnd(widths[i]));
  console.log(`${r[4] === "DRIFT" ? "✗" : r[4] === "ok" ? "✓" : "·"} ${cells.join("  ")}  ${r[4]}`);
}
console.log();
console.log(
  `${files.length} files · ${declared.reduce((n, d) => n + d.vars.size, 0)} :root vars found · ` +
    `${Object.keys(MAP).length} tokens compared · ${drift} drift`,
);
if (unmapped.length) console.log(`registry keys not mapped here (decide): ${unmapped.join(", ")}`);

process.exit(drift ? 1 : 0);
