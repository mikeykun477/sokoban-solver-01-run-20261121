// Room-split push-optimal Sokoban solver.
//
// Idea (first principles): a Sokoban level's score is decided by PUSHES, not
// moves, and the checker pays 1,000 points only at the push-optimum P*. The
// drawn levels are built from independent rooms (3-4 boxes each, joined by a
// one-square hallway a box can never come back from), so the whole level's
// optimum is the SUM of the rooms' optima. Searching the whole level at once
// meets the PRODUCT of the rooms' state spaces and blows the 60 s budget;
// solving each room on its own keeps every search tiny.
//
// Per room this is A* over PUSH states (Hart-Nilsson-Raphael): a state is the
// sorted box squares plus the player's reachable region (named by its lowest
// square, since the walk inside a region is free), each push costs 1, and the
// heuristic is the minimum-cost assignment of boxes to goals by shortest-path
// distance ignoring other boxes -- admissible, so the first solved state
// popped is push-optimal for that room. Two deadlocks are pruned, both
// provably safe: boxes on dead squares (no pull path to any goal) and frozen
// 2x2 blocks of walls/boxes with a box off its goal. A matching check (no
// finite box-to-goal assignment) prunes a third class of dead states.
//
// Determinism: the search is budgeted by WORK (a state cap), never by the
// wall clock, and every tie is broken by a fixed order, so two runs write
// identical bytes. Fallbacks: if a level does not split into rooms, a
// whole-level A* with a cheaper heuristic runs instead; a level no search
// finishes still gets a (valid, empty) solution file.
//
// Run: node main.ts, with MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR
// (defaults /input and /output). Node 22+ type stripping, stdlib only.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Work budgets (states), never the clock: the two graded executions must agree.
const ROOM_STATE_CAP = 400_000;
const WHOLE_STATE_CAP = 200_000;

type Dir = { dx: number; dy: number; step: string; push: string };
const DIRS: Dir[] = [
  { dx: 0, dy: -1, step: 'u', push: 'U' },
  { dx: 0, dy: 1, step: 'd', push: 'D' },
  { dx: -1, dy: 0, step: 'l', push: 'L' },
  { dx: 1, dy: 0, step: 'r', push: 'R' },
];

interface Board {
  w: number;
  h: number;
  wall: Uint8Array; // 1 = wall (includes the outer frame)
  goals: number[];
  goalSet: Uint8Array;
  boxes: number[];
  player: number;
}

/** Parse XSB text into a board; short rows pad out as walls. */
function parseLevel(text: string): Board {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goalSet = new Uint8Array(w * h);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') {
        goalSet[i] = 1;
        goals.push(i);
      }
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  boxes.sort((a, b) => a - b);
  // The outer frame is a wall whatever the text shows: nothing leaves the board.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  return { w, h, wall, goals, goalSet, boxes, player };
}

/**
 * Live squares: squares from which a lone box can be pulled onto some goal.
 * Pull backwards from the goals: a box on y can be pulled to x (one step along
 * d) when the player can stand at y - d, i.e. both y and y - d are open floor.
 */
function liveSquares(b: Board): Uint8Array {
  const live = new Uint8Array(b.w * b.h);
  const queue = [...b.goals];
  for (const g of b.goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi];
    for (const { dx, dy } of DIRS) {
      const d = dy * b.w + dx;
      const y = x - d;
      if (!b.wall[y] && !b.wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/** Shortest walking distance from every goal, over open floor, ignoring boxes. */
function goalDistances(b: Board): Int32Array[] {
  return b.goals.map((g) => {
    const dist = new Int32Array(b.w * b.h).fill(-1);
    const queue = [g];
    dist[g] = 0;
    for (let qi = 0; qi < queue.length; qi++) {
      const p = queue[qi];
      for (const { dx, dy } of DIRS) {
        const q = p + dy * b.w + dx;
        if (!b.wall[q] && dist[q] < 0) {
          dist[q] = dist[p] + 1;
          queue.push(q);
        }
      }
    }
    return dist;
  });
}

/**
 * Minimum-cost assignment of boxes to goals (DP over goal subsets), or
 * Infinity when no box can reach a distinct goal. Each push moves one box one
 * square, so this total is a lower bound on the pushes still needed.
 */
function assignmentCost(boxes: number[], dists: Int32Array[]): number {
  const n = boxes.length;
  const INF = 1e9;
  const dp = new Float64Array(1 << n).fill(INF);
  dp[0] = 0;
  for (let mask = 0; mask < 1 << n; mask++) {
    const k = popcount(mask); // boxes[0..k) already placed
    if (k >= n || dp[mask] >= INF) continue;
    for (let j = 0; j < n; j++) {
      if (mask & (1 << j)) continue;
      const d = dists[j][boxes[k]];
      if (d < 0) continue;
      const nm = mask | (1 << j);
      const v = dp[mask] + d;
      if (v < dp[nm]) dp[nm] = v;
    }
  }
  const total = dp[(1 << n) - 1];
  return total >= INF ? Infinity : total;
}

function popcount(x: number): number {
  let c = 0;
  while (x) {
    x &= x - 1;
    c++;
  }
  return c;
}

/** Lowest square of the player's reachable region; flood-fills with stamps. */
function regionLow(
  b: Board,
  occupied: Uint8Array,
  from: number,
  seen: Int32Array,
  stamp: number,
  stack: Int32Array,
): number {
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n];
    if (p < low) low = p;
    for (const { dx, dy } of DIRS) {
      const q = p + dy * b.w + dx;
      if (!b.wall[q] && !occupied[q] && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

/** True when the box just pushed to t is stuck in a frozen 2x2 wall/box block. */
function frozenBlock(b: Board, occupied: Uint8Array, t: number): boolean {
  const w = b.w;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const c = a + w;
    const cells = [a, a + 1, c, c + 1];
    if (!cells.every((i) => b.wall[i] || occupied[i])) continue;
    if (cells.some((i) => occupied[i] && !b.goalSet[i])) return true;
  }
  return false;
}

/** Shortest walk (lower-case steps) from `from` to `to` around walls and boxes. */
function walkTo(b: Board, occupied: Uint8Array, from: number, to: number): string {
  if (from === to) return '';
  const prev = new Int32Array(b.w * b.h).fill(-1);
  const how = new Array<string>(b.w * b.h);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    if (p === to) break;
    for (const { dx, dy, step } of DIRS) {
      const q = p + dy * b.w + dx;
      if (b.wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = step;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: push square out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]) s = how[p] + s;
  return s;
}

/** Small deterministic binary heap ordered by (f, deeper g first, lower key). */
class Heap {
  private a: { f: number; g: number; key: number; state: number }[] = [];
  get size(): number {
    return this.a.length;
  }
  private static before(x: { f: number; g: number; key: number }, y: { f: number; g: number; key: number }): boolean {
    return x.f < y.f || (x.f === y.f && (x.g > y.g || (x.g === y.g && x.key < y.key)));
  }
  push(e: { f: number; g: number; key: number; state: number }): void {
    const a = this.a;
    a.push(e);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!Heap.before(a[i], a[p])) break;
      [a[i], a[p]] = [a[p], a[i]];
      i = p;
    }
  }
  pop(): { f: number; g: number; key: number; state: number } {
    const a = this.a;
    const top = a[0];
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= a.length) break;
        if (c + 1 < a.length && Heap.before(a[c + 1], a[c])) c++;
        if (!Heap.before(a[c], a[i])) break;
        [a[i], a[c]] = [a[c], a[i]];
        i = c;
      }
    }
    return top;
  }
}

interface SearchResult {
  pushes: number;
  moves: string;
}

/**
 * Push-optimal A* for one board (a room, or a whole level as fallback).
 * `useNumericKey` needs boxes.length + 1 small enough that the base-size
 * encoding stays exact (true for rooms of <= 4 boxes); the whole-level
 * fallback uses string keys instead.
 */
function searchPushOptimal(board: Board, stateCap: number, useNumericKey: boolean): SearchResult | null {
  const { w, goalSet } = board;
  const size = w * board.h;
  const live = liveSquares(board);
  const dists = goalDistances(board);
  if (board.boxes.some((b) => !live[b])) return null;
  const solved = (boxes: number[]): boolean => boxes.every((b) => goalSet[b]);

  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  // Separate scratch for key computation: a key flood must never overwrite
  // the expansion region's stamps, nor disturb the expansion's occupancy.
  const keyOcc = new Uint8Array(size);
  const keySeen = new Int32Array(size);
  const keyStack = new Int32Array(size);
  let keyStamp = 0;
  const makeKey = (boxes: number[], player: number): number | string =>
    stateKey(board, boxes, player, keyOcc, keySeen, ++keyStamp, keyStack, useNumericKey);

  // State storage: boxes, player square, parent, and the push that made it.
  const sBoxes: number[][] = [board.boxes];
  const sPlayer: number[] = [board.player];
  const sParent: number[] = [-1];
  const sPushFrom: number[] = [-1];
  const sPushDir: number[] = [-1];

  const best = new Map<number | string, number>();
  const startKey = makeKey(board.boxes, board.player);
  best.set(startKey, 0);
  const heap = new Heap();
  const h0 = assignmentCost(board.boxes, dists);
  if (!Number.isFinite(h0) && !solved(board.boxes)) return null;
  heap.push({ f: h0, g: 0, key: typeof startKey === 'number' ? startKey : 0, state: 0 });

  let found = solved(board.boxes) ? 0 : -1;
  while (heap.size > 0 && found < 0) {
    const { g, state: s } = heap.pop();
    const boxes = sBoxes[s];
    // Recompute this state's key (region-low plus boxes); a heap entry whose
    // g no longer matches the recorded best is stale and skipped.
    const myKey = makeKey(boxes, sPlayer[s]);
    if (best.get(myKey) !== g) continue;
    if (solved(boxes)) {
      found = s;
      break;
    }
    for (const b of boxes) occupied[b] = 1;
    regionLow(board, occupied, sPlayer[s], seen, ++stamp, stack);
    const here = stamp;
    for (let bi = 0; bi < boxes.length && found < 0; bi++) {
      const b = boxes[bi];
      for (let di = 0; di < 4; di++) {
        const { dx, dy } = DIRS[di];
        const d = dy * w + dx;
        const t = b + d;
        if (seen[b - d] !== here || board.wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        let child: number[] | null = null;
        let childKey: number | string = -1;
        let childH = Infinity;
        if (!frozenBlock(board, occupied, t)) {
          child = boxes.slice();
          child[bi] = t;
          child.sort((x, y) => x - y);
          childH = assignmentCost(child, dists);
          if (Number.isFinite(childH)) {
            childKey = makeKey(child, b);
          }
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (child === null || !Number.isFinite(childH)) continue;
        if (best.has(childKey)) continue;
        if (sBoxes.length >= stateCap) {
          for (const x of boxes) occupied[x] = 0;
          return null;
        }
        best.set(childKey, g + 1);
        sBoxes.push(child);
        sPlayer.push(b);
        sParent.push(s);
        sPushFrom.push(b);
        sPushDir.push(di);
        heap.push({
          f: g + 1 + childH,
          g: g + 1,
          key: typeof childKey === 'number' ? childKey : 0,
          state: sBoxes.length - 1,
        });
      }
    }
    for (const x of boxes) occupied[x] = 0;
  }
  if (found < 0) return null;

  // Rebuild the move string: walk to each push square, then push.
  const path: number[] = [];
  for (let s = found; s > 0; s = sParent[s]) path.push(s);
  path.reverse();
  let moves = '';
  let player = board.player;
  let boxes = board.boxes;
  for (const s of path) {
    const next = sBoxes[s];
    const from = boxes.find((b) => !next.includes(b))!;
    const to = next.find((b) => !boxes.includes(b))!;
    const di = sPushDir[s];
    const d = DIRS[di].dy * w + DIRS[di].dx;
    for (const b of boxes) occupied[b] = 1;
    moves += walkTo(board, occupied, player, from - d);
    for (const b of boxes) occupied[b] = 0;
    moves += DIRS[di].push;
    player = from;
    boxes = next;
  }
  return { pushes: path.length, moves };
}

/** A state's key: region-low plus sorted boxes (numeric or string form).
 * `scratch` is a caller-owned occupancy array this fills from `boxes` and
 * clears again, so it never disturbs any other occupancy. */
function stateKey(
  board: Board,
  boxes: number[],
  player: number,
  scratch: Uint8Array,
  seen: Int32Array,
  stamp: number,
  stack: Int32Array,
  numeric: boolean,
): number | string {
  for (const b of boxes) scratch[b] = 1;
  const low = regionLow(board, scratch, player, seen, stamp, stack);
  for (const b of boxes) scratch[b] = 0;
  if (!numeric) return low + ':' + boxes.join(',');
  const size = board.w * board.h;
  let k = low;
  for (const b of boxes) k = k * size + b;
  return k;
}

interface Room {
  boxes: number[];
  goals: number[];
  done: boolean;
}

/**
 * Split a level into rooms: cut the dead squares of the player's row (the
 * hallway -- a box there reaches no goal) out of the floor; each remaining
 * component holding boxes is a room. Null when the split is impossible.
 */
function splitRooms(level: Board): Room[] | null {
  const live = liveSquares(level);
  const row = Math.floor(level.player / level.w);
  const cut = new Uint8Array(level.w * level.h);
  for (let i = row * level.w; i < (row + 1) * level.w; i++) {
    if (!level.wall[i] && !live[i]) cut[i] = 1;
  }
  if (level.boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(level.w * level.h).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < level.w * level.h; s++) {
    if (level.wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const { dx, dy } of DIRS) {
        const q = squares[i] + dy * level.w + dx;
        if (!level.wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ boxes: [], goals: [], done: false });
  }
  for (const b of level.boxes) rooms[part[b]].boxes.push(b);
  for (const g of level.goals) {
    if (part[g] < 0) return null;
    rooms[part[g]].goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/** Solve one level: room by room, falling back to a whole-level search. */
function solveLevel(level: Board): string {
  const rooms = splitRooms(level);
  if (rooms !== null) {
    let player = level.player;
    let moves = '';
    for (const room of rooms) {
      // Other rooms' boxes stand as walls (a finished room's boxes sit on its
      // goals, so its goals stand as walls instead).
      const wall = level.wall.slice();
      for (const other of rooms) {
        if (other === room) continue;
        for (const b of other.done ? other.goals : other.boxes) wall[b] = 1;
      }
      const sub: Board = {
        w: level.w,
        h: level.h,
        wall,
        goals: room.goals.slice().sort((a, b) => a - b),
        goalSet: level.goalSet,
        boxes: room.boxes.slice().sort((a, b) => a - b),
        player,
      };
      const solved = searchPushOptimal(sub, ROOM_STATE_CAP, true);
      if (solved === null) return solveWhole(level);
      moves += solved.moves;
      player = endOf(level.w, player, solved.moves);
      room.done = true;
    }
    return moves;
  }
  return solveWhole(level);
}

/** Whole-level fallback with a cheap heuristic and string keys. */
function solveWhole(level: Board): string {
  const solved = searchPushOptimal(level, WHOLE_STATE_CAP, false);
  return solved === null ? '' : solved.moves;
}

/** The player's square after playing `moves` from `from` on a board `w` wide. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves) {
    const c = ch.toLowerCase();
    p += c === 'u' ? -w : c === 'd' ? w : c === 'l' ? -1 : 1;
  }
  return p;
}

for (const id of readdirSync(INPUT_DIR).sort()) {
  const moves = solveLevel(parseLevel(readFileSync(join(INPUT_DIR, id, 'level.txt'), 'utf8')));
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'solution.txt'), `${moves}\n`);
}
