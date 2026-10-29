#!/usr/bin/env bun
// check-vendor.ts — report drift between server/vendor/omp-host/ and the Onlyne
// monorepo sources each file was vendored from (packages/omp-onlyne/src/).
//
// Usage:
//   bun scripts/check-vendor.ts            print a per-file report, exit 0
//   bun scripts/check-vendor.ts --strict   exit 1 when any file has drifted
//
// Both sides are compared with comments stripped (line comments, block
// comments, and blank lines are ignored), so the first-line `// vendored
// from ...` annotation here and upstream reference comments do not count as
// drift. `+N` counts lines that exist only upstream (the vendor copy is
// behind); `-N` counts lines that exist only in the vendor copy. The script
// only reports; syncing content is a manual copy in either direction.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const vendored = ["acquire.ts", "bridge-text.ts", "host-text.ts", "node.ts", "store.ts", "types.ts"] as const;

const vendorDir = resolve(import.meta.dir, "..", "server", "vendor", "omp-host");
const ompSrc = resolve(import.meta.dir, "..", "..", "..", "packages", "omp-onlyne", "src");

const strict = process.argv.includes("--strict");

/**
 * Split a TypeScript source into normalized, comment-free lines.
 * Tracks string literals so `//` and `/*` inside quotes are kept as content.
 */
function stripComments(source: string): string[] {
	const lines: string[] = [];
	let inBlock = false;
	for (const raw of source.split("\n")) {
		let kept = "";
		let quote: '"' | "'" | "`" | null = null;
		let i = 0;
		while (i < raw.length) {
			const ch = raw[i] as string;
			const next = i + 1 < raw.length ? (raw[i + 1] as string) : "";
			if (inBlock) {
				if (ch === "*" && next === "/") {
					inBlock = false;
					i += 2;
				} else {
					i += 1;
				}
				continue;
			}
			if (quote !== null) {
				if (ch === "\\") {
					kept += ch + next;
					i += 2;
					continue;
				}
				if (ch === quote) quote = null;
				kept += ch;
				i += 1;
				continue;
			}
			if (ch === '"' || ch === "'" || ch === "`") {
				quote = ch;
				kept += ch;
				i += 1;
				continue;
			}
			if (ch === "/" && next === "/") break; // line comment: drop the rest
			if (ch === "/" && next === "*") {
				inBlock = true;
				i += 2;
				continue;
			}
			kept += ch;
			i += 1;
		}
		const line = kept.trim();
		if (line !== "") lines.push(line);
	}
	return lines;
}

/** Longest-common-subsequence line diff: lines only in `up` are added, only in `ven` removed. */
function diffCounts(ven: string[], up: string[]): { added: number; removed: number } {
	const n = ven.length;
	const m = up.length;
	// lcs[i * (m + 1) + j] = LCS length of ven[i..] and up[j..]
	const lcs = new Uint32Array((n + 1) * (m + 1));
	const at = (i: number, j: number): number => lcs[i * (m + 1) + j] as number;
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			lcs[i * (m + 1) + j] =
				ven[i] === up[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
		}
	}
	let added = 0;
	let removed = 0;
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (ven[i] === up[j]) {
			i += 1;
			j += 1;
		} else if (at(i + 1, j) >= at(i, j + 1)) {
			removed += 1;
			i += 1;
		} else {
			added += 1;
			j += 1;
		}
	}
	removed += n - i;
	added += m - j;
	return { added, removed };
}

if (!existsSync(ompSrc)) {
	console.error(`check-vendor: upstream sources not found at ${ompSrc}`);
	console.error("check-vendor: run this inside a checkout of the Onlyne monorepo.");
	process.exit(2);
}

const rows: string[] = [];
let drifted = 0;
for (const name of vendored) {
	const vendorPath = join(vendorDir, name);
	const ompPath = join(ompSrc, name);
	if (!existsSync(vendorPath)) {
		rows.push(`${name}\tmissing in ${vendorDir}`);
		drifted += 1;
		continue;
	}
	if (!existsSync(ompPath)) {
		rows.push(`${name}\tmissing in packages/omp-onlyne/src`);
		drifted += 1;
		continue;
	}
	const { added, removed } = diffCounts(
		stripComments(readFileSync(vendorPath, "utf8")),
		stripComments(readFileSync(ompPath, "utf8")),
	);
	if (added === 0 && removed === 0) {
		rows.push(`${name}\tsame`);
	} else {
		drifted += 1;
		rows.push(`${name}\tdrifted\t+${added}/-${removed}`);
	}
}

for (const row of rows) console.log(row);
console.log(`${vendored.length} files, ${drifted} drifted (+upstream-only lines, -vendor-only lines)`);

if (strict && drifted > 0) process.exit(1);
