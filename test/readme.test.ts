// The claims in README.md that a script can check, checked.
//
// This file exists because of a specific, small, embarrassing class of defect: prose that counts
// something and is then never counted again. The per-file table in *The code* had two rows drift
// away from `wc -l` while the sentence above it stayed right; the label cap said five hundred for
// a while after the code raised it to a hundred thousand. Neither was a bug in the software and
// both made the rest of the document harder to trust, which for a project whose comments are part
// of the deliverable is the same thing.
//
// The polkit-action count is checked in `test/planes.test.ts` instead — that file already parses
// `ui/chip402.policy`, and the count belongs next to the assertions about what those actions do.

import { readFileSync, readdirSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";
import { MAX_ENTRIES } from "../src/labels.ts";

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

const sourceOf = (name: string): string => readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");

// The same two numbers the README's table prints, computed the way its own *What I ran* section
// computes them: every line, and every line that is neither blank nor a `//` comment.
function counts(name: string): { code: number; total: number } {
  const lines = sourceOf(name).split("\n");
  // A trailing newline is a line terminator, not a line — `wc -l` counts terminators.
  const total = lines.length - 1;
  const code = lines.slice(0, total).filter((line) => line.trim() !== "" && !line.trim().startsWith("//")).length;
  return { code, total };
}

const spelled: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
};

test("every row of the file table is what wc -l says", () => {
  const rows = [...readme.matchAll(/^\| `src\/([a-z]+\.ts)` \|.*\| (\d[\d,]*) \/ (\d[\d,]*) \|$/gm)];
  const shipped = readdirSync(new URL("../src/", import.meta.url)).filter((name) => name.endsWith(".ts")).sort();
  assert.ok(rows.length > 0, "the README no longer lists the files it is made of");
  assert.deepEqual(
    rows.map((row) => row[1]!).sort(),
    shipped,
    "the table and src/ do not contain the same files",
  );
  for (const [, name, code, total] of rows) {
    const real = counts(name!);
    assert.equal(Number(code!.replace(/,/g, "")), real.code, `${name}: the table's code count`);
    assert.equal(Number(total!.replace(/,/g, "")), real.total, `${name}: the table's total count`);
  }
});

test("the sentence above the table adds up to the table", () => {
  const claim = /(\w+) core files, each with one job, each meant to be read aloud: ([\d,]+) lines of code, ([\d,]+) with\nthe comments/.exec(readme);
  assert.ok(claim, "the README stopped saying how much code there is");
  const shipped = readdirSync(new URL("../src/", import.meta.url)).filter((name) => name.endsWith(".ts"));
  const sum = shipped.reduce(
    (running, name) => {
      const one = counts(name);
      return { code: running.code + one.code, total: running.total + one.total };
    },
    { code: 0, total: 0 },
  );
  assert.equal(spelled[claim[1]!.toLowerCase()] ?? Number(claim[1]), shipped.length, "the number of core files");
  assert.equal(Number(claim[2]!.replace(/,/g, "")), sum.code, "the total lines of code");
  assert.equal(Number(claim[3]!.replace(/,/g, "")), sum.total, "the total lines including comments");
});

test("the caps the README quotes are the caps the code has", () => {
  // The 500-vs-100,000 drift, as an assertion. Counted rather than proof-read, so raising
  // MAX_ENTRIES without touching the README fails here.
  const claims = [...readme.matchAll(/capped at ([\d,]+)|kept generously \(([\d,]+)\s*\n?rows/g)];
  assert.ok(claims.length >= 2, "the README stopped saying how many host names are kept");
  for (const claim of claims) {
    const written = Number(String(claim[1] ?? claim[2]).replace(/,/g, ""));
    assert.equal(written, MAX_ENTRIES, `the README says "${claim[0]}" and MAX_ENTRIES is ${MAX_ENTRIES}`);
  }
  // And the number it used to say is gone rather than merely outnumbered.
  assert.doesNotMatch(readme, /five hundred/i, "the old label cap is still in the README");
});

test("every file the README says exists does", () => {
  // Cheap, and it catches the other half of the same drift: a table row for a file that was
  // renamed or removed. Paths in backticks that look like ours, resolved against the tree.
  const named = new Set([...readme.matchAll(/`((?:src|bin|ui|test|demo)\/[A-Za-z0-9_.-]+)`/g)].map((m) => m[1]!));
  assert.ok(named.size > 20, "the README stopped naming the files it describes");
  for (const path of named) {
    const url = new URL(`../${path}`, import.meta.url);
    assert.doesNotThrow(() => readFileSync(url), `README names ${path}, which is not in the tree`);
  }
});
