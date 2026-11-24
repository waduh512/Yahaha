// main.ts is mend, the CLI SPEC.md specifies (version 1). It applies edits in
// four formats (unified diff, SEARCH/REPLACE, V4A, JSON) to a tree of text
// files, matching lines at three tiers, and changes every file or none.
// Node 22, the standard library alone; run as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and
// then this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

function existsAny(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

// Per-run state, reset at the start of run().
let STRICT = false;
let MOVES: Array<[string, string]> = [];

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------------------
// Files: lines, line break, final break (SPEC section 3)
// ---------------------------------------------------------------------------

interface FileState {
  lines: string[];
  br: string; // '\n' or '\r\n'
  finalBreak: boolean;
}

function splitFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', finalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) parts.pop();
  return { lines: parts, br, finalBreak };
}

function joinFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.finalBreak ? f.br : '');
}

// ---------------------------------------------------------------------------
// Matching lines at three tiers (SPEC section 5)
// ---------------------------------------------------------------------------

const trail = (s: string): string => s.replace(/[ \t]+$/, '');
const lead = (s: string): string => s.replace(/^[ \t]+/, '');
const leadingOf = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trail(a) === trail(b);
  return lead(trail(a)) === lead(trail(b));
}

/** Positions where O occurs in file lines at the given tier (overlaps allowed). */
function occurrencesAt(fileLines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = from; i + o.length <= fileLines.length; i += 1) {
    let ok = true;
    for (let k = 0; k < o.length; k += 1) {
      if (!lineEq(fileLines[i + k]!, o[k]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** First tier (0, 1, 2) at which O occurs at least once at/after `from`, with its positions. */
function findTier(fileLines: string[], o: string[], from: number): { tier: number; pos: number[] } | null {
  return findTierFiltered(fileLines, o, from, false);
}

/**
 * As findTier, but for an end-of-file chunk only occurrences that end at the
 * file's last line count (SPEC section 8): the restriction applies while
 * choosing the tier, so a tier-2 tail match is not hidden by a tier-0 match
 * elsewhere in the file.
 */
function findTierFiltered(fileLines: string[], o: string[], from: number, eofOnly: boolean): { tier: number; pos: number[] } | null {
  const tiers = STRICT ? [0] : [0, 1, 2];
  for (const t of tiers) {
    let pos = occurrencesAt(fileLines, o, t, from);
    if (eofOnly) pos = pos.filter((p) => p + o.length === fileLines.length);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

interface NItem {
  text: string;
  context: boolean;
  /** Index of this context line inside O, or -1 for a new line. */
  oIndex: number;
}

/**
 * Build the replacement lines for an O -> N replacement at `pos`.
 * Context lines are written as the file's own matched line; at tier 2 every
 * other line is re-indented from O's first line's leading whitespace to the
 * file's first matched line's leading whitespace (SPEC section 5).
 */
function buildNewLines(fileLines: string[], pos: number, o: string[], n: NItem[], tier: number): string[] {
  const out: string[] = [];
  for (const item of n) {
    if (item.context) {
      out.push(fileLines[pos + item.oIndex]!);
      continue;
    }
    let t = item.text;
    if (tier === 2 && o.length > 0 && t !== '' && t.trim() !== '') {
      const f = leadingOf(fileLines[pos]!);
      const p = leadingOf(o[0]!);
      if (t.startsWith(p)) t = f + t.slice(p.length);
    }
    out.push(t);
  }
  return out;
}

/** Split body items into O items (context + old) and N items (context + new). */
function splitBody(items: BodyItem[]): { o: string[]; n: NItem[] } {
  const o: string[] = [];
  const n: NItem[] = [];
  for (const it of items) {
    if (it.kind === 'context') {
      const oi = o.length;
      o.push(it.text);
      n.push({ text: it.text, context: true, oIndex: oi });
    } else if (it.kind === 'old') {
      o.push(it.text);
    } else {
      n.push({ text: it.text, context: false, oIndex: -1 });
    }
  }
  return { o, n };
}

interface BodyItem {
  kind: 'context' | 'old' | 'new';
  text: string;
  /** A `\` line follows this body line. */
  backslash: boolean;
}

/** The last context or new body item has a `\` line after it. */
function lastContextOrNewBackslash(items: BodyItem[]): boolean {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const it = items[i]!;
    if (it.kind === 'context' || it.kind === 'new') return it.backslash;
  }
  return false;
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC section 9) — as the starter had them
// ---------------------------------------------------------------------------

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null || existsAny(p)) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const f = splitFile(before);
      if (line < 0 || line > f.lines.length) throw new Fail('no-match', p);
      f.lines.splice(line, 0, ...add);
      tree.now.set(p, joinFile(f));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC section 6)
// ---------------------------------------------------------------------------

function stripAB(raw: string): string {
  let s = raw;
  if (s.startsWith('a/') || s.startsWith('b/')) s = s.slice(2);
  return s;
}

function headerPath(line: string): string {
  let s = line.slice(4);
  const tab = s.indexOf('\t');
  if (tab >= 0) s = s.slice(0, tab);
  return stripAB(s.trim());
}

interface Hunk {
  a: number;
  items: BodyItem[];
  line: number; // 1-based header line
}

interface UnifiedSection {
  oldPath: string | null;
  newPath: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

/** Parse body lines starting at `j`; returns items and the index after the body. */
function parseHunkBody(lines: string[], j: number): { items: BodyItem[]; next: number } {
  const raw: string[] = [];
  let k = j;
  while (k < lines.length) {
    const l = lines[k]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[k + 1] ?? '').startsWith('+++ ')) break;
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
      raw.push(l);
      k += 1;
      continue;
    }
    break;
  }
  while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
  const items: BodyItem[] = [];
  for (const l of raw) {
    if (l.startsWith('\\')) {
      if (items.length > 0) items[items.length - 1]!.backslash = true;
      continue;
    }
    if (l === '') items.push({ kind: 'context', text: '', backslash: false });
    else if (l[0] === ' ') items.push({ kind: 'context', text: l.slice(1), backslash: false });
    else if (l[0] === '-') items.push({ kind: 'old', text: l.slice(1), backslash: false });
    else items.push({ kind: 'new', text: l.slice(1), backslash: false });
  }
  return { items, next: k };
}

function parseUnified(lines: string[]): Edit[] {
  const sections: UnifiedSection[] = [];
  let cur: UnifiedSection | null = null;
  let inHeader = false;
  let hasPair = false;
  let renameOld: string | null = null;
  let renameNew: string | null = null;
  let diffOld: string | null = null;
  let diffNew: string | null = null;

  const finishSection = (): void => {
    if (cur === null) return;
    if (cur.oldPath === null && renameOld !== null) cur.oldPath = renameOld;
    if (cur.newPath === null && renameNew !== null) cur.newPath = renameNew;
    if (cur.oldPath === null && diffOld !== null) cur.oldPath = diffOld;
    if (cur.newPath === null && diffNew !== null) cur.newPath = diffNew;
    sections.push(cur);
    cur = null;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      finishSection();
      cur = { oldPath: null, newPath: null, isCreate: false, isDelete: false, hunks: [] };
      diffOld = m[1]!;
      diffNew = m[2]!;
      renameOld = null;
      renameNew = null;
      hasPair = false;
      inHeader = true;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && inHeader && !hasPair) {
        cur.oldPath = headerPath(line);
        cur.newPath = headerPath(lines[i + 1]!);
        hasPair = true;
        i += 2;
        continue;
      }
      finishSection();
      cur = { oldPath: null, newPath: null, isCreate: false, isDelete: false, hunks: [] };
      diffOld = null;
      diffNew = null;
      renameOld = null;
      renameNew = null;
      hasPair = true;
      inHeader = true;
      cur.oldPath = headerPath(line);
      cur.newPath = headerPath(lines[i + 1]!);
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: |$)/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const { items, next } = parseHunkBody(lines, i + 1);
      cur.hunks.push({ a: parseInt(m[1]!, 10), items, line: i + 1 });
      inHeader = false;
      i = next;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) renameOld = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) renameNew = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.isCreate = true;
      else if (line.startsWith('deleted file mode')) cur.isDelete = true;
      // index, old mode, new mode, similarity/dissimilarity index, Index: and any other line: ignored.
      i += 1;
      continue;
    }
    // Outside bodies, lines not part of a section header are ignored (prose, code fences).
    i += 1;
  }
  finishSection();
  if (sections.length === 0) throw new Exit2('error: parse 1');

  const edits: Edit[] = [];
  for (const s of sections) {
    const oldPath = s.oldPath;
    const newPath = s.newPath;
    const isCreate = s.isCreate || oldPath === '/dev/null';
    const isDelete = !isCreate && (s.isDelete || newPath === '/dev/null');
    if (isCreate) {
      const np = newPath!;
      const hunks = s.hunks;
      edits.push((tree) => {
        if (!safe(np)) throw new Fail('unsafe', np);
        if (tree.get(np) !== null || existsAny(np)) throw new Fail('exists', np);
        const made: string[] = [];
        let lastPlusBackslash = false;
        let seenPlus = false;
        for (const h of hunks) {
          for (const it of h.items) {
            if (it.kind === 'new') {
              made.push(it.text);
              seenPlus = true;
              lastPlusBackslash = it.backslash;
            }
          }
        }
        const finalBreak = !seenPlus || !lastPlusBackslash;
        tree.now.set(np, made.length === 0 ? '' : made.join('\n') + (finalBreak ? '\n' : ''));
      });
      continue;
    }
    if (isDelete) {
      const op = oldPath!;
      edits.push((tree) => {
        if (!safe(op)) throw new Fail('unsafe', op);
        if (tree.get(op) === null) throw new Fail('missing', op);
        tree.now.set(op, null);
      });
      continue;
    }
    const isMove = oldPath !== null && newPath !== null && oldPath !== newPath;
    if (isMove) {
      const op = oldPath!;
      const np = newPath!;
      const hunks = s.hunks;
      edits.push((tree) => {
        if (!safe(op)) throw new Fail('unsafe', op);
        if (!safe(np)) throw new Fail('unsafe', np);
        const before = tree.get(op);
        if (before === null) throw new Fail('missing', op);
        if (tree.get(np) !== null || existsAny(np)) throw new Fail('exists', np);
        const state = splitFile(before);
        applyUnifiedHunks(state, hunks, op);
        tree.now.set(op, null);
        tree.now.set(np, joinFile(state));
        MOVES.push([op, np]);
      });
      continue;
    }
    const p = (oldPath ?? newPath)!;
    const hunks = s.hunks;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const state = splitFile(before);
      applyUnifiedHunks(state, hunks, p);
      tree.now.set(p, joinFile(state));
    });
  }
  return edits;
}

/** Apply a section's hunks in order to a file's lines (SPEC section 6). */
function applyUnifiedHunks(state: FileState, hunks: Hunk[], path: string): void {
  let d = 0;
  for (const h of hunks) {
    const { o, n } = splitBody(h.items);
    if (o.length === 0) {
      const at = Math.max(0, Math.min(h.a + d, state.lines.length));
      const runsToEnd = at === state.lines.length;
      const made = n.map((x) => x.text);
      state.lines.splice(at, 0, ...made);
      if (runsToEnd) state.finalBreak = !lastContextOrNewBackslash(h.items);
      d += n.length;
      continue;
    }
    const found = findTier(state.lines, o, 0);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.pos[0]!;
    let bestDist = Math.abs(best - target);
    for (const p of found.pos) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const runsToEnd = best + o.length === state.lines.length;
    const made = buildNewLines(state.lines, best, o, n, found.tier);
    state.lines.splice(best, o.length, ...made);
    if (runsToEnd) state.finalBreak = !lastContextOrNewBackslash(h.items);
    d += n.length - o.length;
  }
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC section 7)
// ---------------------------------------------------------------------------

function parseSearchReplace(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const sIdx = i;
    let eq = -1;
    let end = -1;
    for (let j = sIdx + 1; j < lines.length; j += 1) {
      const t = lines[j]!.trimEnd();
      if (eq < 0 && t === '=======') eq = j;
      else if (t === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
    }
    if (eq < 0 || end < 0 || eq > end) throw new Exit2(`error: parse ${sIdx + 1}`);
    let path: string | null = null;
    for (let j = sIdx - 1; j > prevEnd; j -= 1) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${sIdx + 1}`);
      path = prevPath;
    }
    const oldLines = lines.slice(sIdx + 1, eq);
    const newLines = lines.slice(eq + 1, end);
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null || existsAny(p)) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : `${newLines.join('\n')}\n`);
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const state = splitFile(before);
      const found = findTier(state.lines, oldLines, 0);
      if (found === null) throw new Fail('no-match', p);
      if (found.pos.length !== 1) throw new Fail('ambiguous', p);
      const pos = found.pos[0]!;
      const nItems: NItem[] = newLines.map((t) => ({ text: t, context: false, oIndex: -1 }));
      const made = buildNewLines(state.lines, pos, oldLines, nItems, found.tier);
      state.lines.splice(pos, oldLines.length, ...made);
      tree.now.set(p, joinFile(state));
    });
    prevPath = path;
    prevEnd = end;
    i = end + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC section 8)
// ---------------------------------------------------------------------------

interface V4aChunk {
  anchor: string;
  items: BodyItem[];
  eof: boolean;
}

interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  line: number; // 1-based header line
  moveTo: string | null;
  raw: Array<{ text: string; idx: number }>; // lines after the header, trailing blanks trimmed
}

function parseV4a(lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  const sections: V4aSection[] = [];
  let cur: V4aSection | null = null;
  const push = (): void => {
    if (cur === null) return;
    while (cur.raw.length > 0 && blank(cur.raw[cur.raw.length - 1]!.text)) cur.raw.pop();
    sections.push(cur);
    cur = null;
  };
  for (let i = first + 1; i < last; i += 1) {
    const l = lines[i]!;
    if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) {
      push();
      const kind = l.startsWith('*** Add') ? 'add' : l.startsWith('*** Delete') ? 'delete' : 'update';
      const path = l.slice(l.indexOf(': ') + 2).trim();
      cur = { kind, path, line: i + 1, moveTo: null, raw: [] };
      continue;
    }
    if (cur === null) {
      if (blank(l)) continue;
      throw new Exit2(`error: parse ${i + 1}`);
    }
    cur.raw.push({ text: l, idx: i });
  }
  push();
  if (sections.length === 0) throw new Exit2('error: parse 1');

  const edits: Edit[] = [];
  for (const s of sections) {
    if (s.kind === 'add') {
      const p = s.path;
      const made: string[] = [];
      for (const r of s.raw) {
        if (r.text === '') made.push('');
        else if (r.text.startsWith('+')) made.push(r.text.slice(1));
        else throw new Exit2(`error: parse ${r.idx + 1}`);
      }
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null || existsAny(p)) throw new Fail('exists', p);
        tree.now.set(p, made.length === 0 ? '' : `${made.join('\n')}\n`);
      });
      continue;
    }
    if (s.kind === 'delete') {
      const p = s.path;
      if (s.raw.length > 0) throw new Exit2(`error: parse ${s.raw[0]!.idx + 1}`);
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
      continue;
    }
    // update
    const p = s.path;
    let moveTo: string | null = null;
    const chunks: V4aChunk[] = [];
    let curChunk: V4aChunk | null = null;
    let started = false;
    for (let ri = 0; ri < s.raw.length; ri += 1) {
      const r = s.raw[ri]!;
      const l = r.text;
      if (ri === 0 && l.startsWith('*** Move to: ')) {
        moveTo = l.slice('*** Move to: '.length).trim();
        continue;
      }
      if (l.startsWith('@@')) {
        curChunk = { anchor: l.slice(2).trim(), items: [], eof: false };
        chunks.push(curChunk);
        started = true;
        continue;
      }
      if (l === '*** End of File') {
        if (curChunk === null) {
          curChunk = { anchor: '', items: [], eof: true };
          chunks.push(curChunk);
          started = true;
        } else {
          curChunk.eof = true;
        }
        curChunk = null;
        continue;
      }
      if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
        if (curChunk === null) {
          if (started) throw new Exit2(`error: parse ${r.idx + 1}`);
          curChunk = { anchor: '', items: [], eof: false };
          chunks.push(curChunk);
          started = true;
        }
        if (l === '') curChunk.items.push({ kind: 'context', text: '', backslash: false });
        else if (l[0] === ' ') curChunk.items.push({ kind: 'context', text: l.slice(1), backslash: false });
        else if (l[0] === '-') curChunk.items.push({ kind: 'old', text: l.slice(1), backslash: false });
        else curChunk.items.push({ kind: 'new', text: l.slice(1), backslash: false });
        continue;
      }
      throw new Exit2(`error: parse ${r.idx + 1}`);
    }
    if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${s.line}`);
    const move = moveTo;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (move !== null && !safe(move)) throw new Fail('unsafe', move);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      if (move !== null && (tree.get(move) !== null || existsAny(move))) throw new Fail('exists', move);
      const state = splitFile(before);
      let cursor = 0;
      for (const ch of chunks) {
        if (ch.anchor !== '') {
          const anchorFound = findTier(state.lines, [ch.anchor], cursor);
          if (anchorFound === null) throw new Fail('no-match', p);
          cursor = anchorFound.pos[0]! + 1;
        }
        const { o, n } = splitBody(ch.items);
        if (o.length === 0) {
          const at = ch.eof ? state.lines.length : cursor;
          const made = n.map((x) => x.text);
          state.lines.splice(at, 0, ...made);
          cursor = at + made.length;
          continue;
        }
        const found = findTierFiltered(state.lines, o, cursor, ch.eof);
        if (found === null) throw new Fail('no-match', p);
        const pos = found.pos[0]!;
        const made = buildNewLines(state.lines, pos, o, n, found.tier);
        state.lines.splice(pos, o.length, ...made);
        cursor = pos + made.length;
      }
      const out = joinFile(state);
      if (move !== null) {
        tree.now.set(p, null);
        tree.now.set(move, out);
        MOVES.push([p, move]);
      } else {
        tree.now.set(p, out);
      }
    });
  }
  return edits;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  STRICT = false;
  MOVES = [];
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  STRICT = strict;
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines);
    else edits = parseV4a(lines);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = MOVES.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      MOVES.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Output rows, in byte order of the path (a move sorts by its new path).
  const rows: Array<{ key: string; text: string }> = [];
  const usedOld = new Set<string>();
  const usedNew = new Set<string>();
  for (const [oldP, newP] of MOVES) {
    if (tree.original(oldP) !== null && tree.now.get(oldP) === null && tree.original(newP) === null && tree.now.get(newP) !== null) {
      if (!usedOld.has(oldP) && !usedNew.has(newP)) {
        usedOld.add(oldP);
        usedNew.add(newP);
        rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
      }
    }
  }
  const changed: string[] = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.push(p);
    if (usedOld.has(p) || usedNew.has(p)) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
