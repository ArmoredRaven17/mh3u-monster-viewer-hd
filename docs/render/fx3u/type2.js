// efx3u_type2.js -- MH3U generator type 2 (cParticleGeneratorPolygon, block 0x1f0), reference translation.
//
// Companion of efx3u_spec.js (type 0); same rules. Every step names the 3U ARM11 routine it was read from
// (exefs/code.decompressed.bin VAs). READ = the consuming instruction was read; EMU = additionally run in
// unicorn on 3U's own code (eng4_t2_emu.py) and the JS checked against it (eng4_t2_test.mjs); INFERRED = not
// read, with what would make it READ. Notes: notes\effects-engine.md section 18.
//
// What the game draws (READ, 0x48f508 -> 0x489970): ONE quad per live particle, 4 vertices of the input layout
// IAPrimitivePolygon (Position f32x3 @0, VertexColor u8x4 @0xc, TexCoord s16x2 @0x10 (x4096), ZOffset @0x14,
// PlyVolume @0x1f), prim key type 3 -> TPrimitive pass 1 = VS_Primitive_CNZ + PS_Primitive, no geometry shader
// (dispatcher 0x2a5c2c -> 0x2a5cf0, layout word 0x814ba028). There is no ring/disc/fan and no segmentation: the
// "polygon" is a rectangle placed by a per-particle matrix:
//   local corner (plane + anchor, 0x25c9e8)  x  per-corner scale (gb +0x1e0..+0x1ec)
//   x  M = S(size) . R(euler rot, order) . G(generator matrix)          (0x402270, row-vector convention)
//   [billboard modes: M = M . C  or  C . M with C the camera matrix, axis-locked by 0x8764a4]
//   + particle position (translation row replaced, 0x489ca0 / 0x48b0bc).
// Coordinates: the game's row-vector matrices (v' = v . M, rows = images of the x/y/z axes, row 3 = translation)
// are stored here as 16-float arrays in that same memory order, which is the column-major layout of
// efx3u_spec.js (W[0..2] = x axis). So `xformRow(M, v)` = M[0..2]*x + M[4..6]*y + M[8..10]*z + M[12..14].
//
// Usage:
//   import * as S from './spec.js'; import * as T2 from './efx3u_type2.js';
//   T2.setRandomTables(rng.u32, rng.f32)                 // sets this module's AND the spec's tables
//   const g = T2.initType2(fx, row, ean)                 // fx from S.createEffect (nodes); row.type === 2
//   each step: (nodes' world matrices current) T2.stepType2(g) -> live?
//   draw: T2.buildType2Geometry(g, {right, up, back}, opts)

import { parseCurve, evalCurveF, evalCurveU16, evalCurveRGBA, curveTime, drawState,
         setRandomTables as setSpecRandomTables } from './spec.js';

// ---------------------------------------------------------------------------------------------
// Helpers COPIED from efx3u_spec.js (not exported there; keep in step with it): pairU16, pairF, the RNG
// tables/draws, drawU16, drawF, lerpRGBA, applyEnvelope, parseGenHeader, emission (emit/loadRamp/nextWave/
// waveDone), stepAnim/wrapFrame, launch, xform.
const pairU16 = (r, o) => ({ base: r.u16(o), range: r.u16(o + 2) });
const pairF = (r, o) => ({ base: r.f32(o), range: r.f32(o + 4) });
let RNG_U32 = null, RNG_F32 = null;
export function setRandomTables(u32, f32){
  RNG_U32 = Uint32Array.from(u32); RNG_F32 = Float32Array.from(f32);
  setSpecRandomTables(u32, f32);
}
function ru32(st, key){ st[key] = (st[key] + 1) >>> 0; return RNG_U32 ? RNG_U32[st[key] & 0xfff] : (Math.random() * 4294967296) >>> 0; }
function rf32(st, key){ st[key] = (st[key] + 1) >>> 0; return RNG_F32 ? RNG_F32[st[key] & 0xfff] : Math.random(); }
const drawU16 = (pair, rnd) => pair.range ? pair.base + (rnd % (pair.range + 1)) : pair.base;
const drawF = (pair, f) => Math.fround(pair.base + Math.fround(pair.range * f));
const lerpRGBA = (a, b, f256) => {
  let o = 0;
  for (let s = 0; s < 32; s += 8){ const x = (a >>> s) & 0xff, y = (b >>> s) & 0xff; o |= ((x + (((y - x) * f256) >> 8)) & 0xff) << s; }
  return o >>> 0;
};
function applyEnvelope(c, kind, v){                                   // 0x3fe1f0
  if (!kind) return c;
  const e = Math.trunc(v * 256);
  if (kind & 1) return ((c & 0x00ffffff) | (((((c >>> 24) * e) >> 8) & 0xff) << 24)) >>> 0;
  let o = c & 0xff000000;
  for (let s = 0; s < 24; s += 8) o |= ((((c >>> s) & 0xff) * e) >> 8 & 0xff) << s;
  return o >>> 0;
}
const xform = (m, v) => [m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12], m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13], m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14]];

function parseGenHeader(r, o){                                        // copy of efx3u_spec.js parseGenHeader
  return {
    a: r.bf(o, 0, 8), mid: r.bf(o, 8, 16), state: r.bf(o, 24, 8), altDraw: r.bf(o, 16, 1),
    w04: r.u32(o + 4), pivot: (r.u32(o + 4) >>> 16) & 1,
    noDepthTest: (r.u32(o + 4) >>> 7) & 1, depthWrite: (r.u32(o + 4) >>> 26) & 1,
    zOffset: (r.s32(o + 0xc) << 16) >> 16, drawSub: r.bf(o + 0x18, 12, 4),
    sizeDamp: r.f32(o + 0x1c), size: pairF(r, o + 0x28), sizeRate: pairF(r, o + 0x30),
    sizeCurveOff: r.bf(o + 0x38, 16, 16), w3cCurveOff: r.bf(o + 0x3c, 16, 16),
    colourFlags: r.bf(o + 0x40, 0, 8), animCurveMode: r.bf(o + 0x40, 8, 1), colourCurveOff: r.bf(o + 0x40, 16, 16),
    animCurveOff: r.bf(o + 0x44, 0, 16), colourA: r.u32(o + 0x48), colourB: r.u32(o + 0x4c),
    animFlags: r.bf(o + 0x50, 0, 16), animSeq: { base: r.bf(o + 0x50, 16, 8), range: r.bf(o + 0x50, 24, 8) },
    animStart: pairU16(r, o + 0x54), animSpeed: r.f32(o + 0x58), animMax: r.f32(o + 0x5c),
    spriteW: r.s32(o + 0x60), spriteH: r.s32(o + 0x64), w68: r.u32(o + 0x68), f6c: r.f32(o + 0x6c),
  };
}

// ---------------------------------------------------------------------------------------------
// Block (0x1f0 bytes). Type-specific part READ in spawn 0x487e6c, start 0x48f538, step 0x48956c, draw 0x489970,
// 0x3e8cd0 (draw info), 0x3ff614 (rotation init), 0x3ffaa8 (rotation step).
export function parseType2(r, o){
  const g = parseGenHeader(r, o);
  return Object.assign(g, {
    type: 2, off: o,
    tex: [r.str(o + 0x70), r.str(o + 0xb0), r.str(o + 0xf0)],   // tex[0] sampled: INFERRED as type 0 (PS_Primitive tBaseMap)
    ean: r.str(o + 0x130),
    // header +0x18 top byte -> gen+0x4e (strb 0x3c8bd0): READ consumers 0x3ff6ec.. (spin) and 0x40268c (align).
    // 8-bit field: Wii U keeps it in bits 0..7 (mirror rule, census: raw 0x80 <-> 3DS 0x80000000)
    spinOn: (r.bf(o + 0x18, 24, 8) >> 7) & 1,                    // gen+0x4c bit23: draw the spin (else no spin)
    spinRandomSign: r.bf(o + 0x18, 24, 8) & 1,                   // gen+0x4c bit16: random sign (ru32 & 1)
    alignNodeB: (r.bf(o + 0x18, 24, 8) >> 1) & 1,                // gen+0x4c bit17: matrix path A (0 in every shipped row)
    rot: [pairF(r, o + 0x170), pairF(r, o + 0x178), pairF(r, o + 0x180)],   // initial euler (rad) x, y, z (0x3ff814..)
    spin: [pairF(r, o + 0x188), pairF(r, o + 0x190), pairF(r, o + 0x198)],  // euler per step (0x3ff72c..)
    // +0x1a0 4-bit fields (3DS order; Wii U mirrored -- confirmed: 63 of 80 same-name pairs equal, the 17 others
    // differ ONLY in `anchor` and only where 3DS has 9 = texture pivot, which Wii U replaced by fixed anchors)
    plane: r.bf(o + 0x1a0, 0, 4),        // -> gen+0xe0 bits 20..23 (0x48f564): which local plane the quad lies in (0x25cbdc)
    eulerOrder: r.bf(o + 0x1a0, 4, 4),   // -> gen+0xe0 bits 16..19: euler order for 0x132ccc (0x4024a8)
    axis: r.bf(o + 0x1a0, 8, 4),         // -> gen+0xe0 bits 24..27: axis to align (0x875cec); 6 = none (0x402a54)
    f12: r.bf(o + 0x1a0, 12, 4),         // not read by type 2
    anchor: r.bf(o + 0x1a0, 16, 4),      // -> info+0x18 bits 4..7 (0x3e8d3c): corner anchor 0..9 (0x25c9f4)
    billboard: r.bf(o + 0x1a0, 20, 4),   // -> info+0x18 bits 0..3 (0x3e8d10): camera mode (0x489a48, 0x8764a4)
    f24: r.bf(o + 0x1a0, 24, 4),         // -> info+0x18 bits 8..11: path 0x489a74/0x876a74 (0 in every shipped row; not translated)
    bbCameraFirst: r.bf(o + 0x1a0, 28, 1), // -> info+0x18 bit16 (0x3e8d28): billboard product C.P (else P.C) (0x48ad08)
    spinDamp: r.f32(o + 0x1a4),          // spin *= this each step (0x489720 -> 0x3ffc44)
    uvAnimOff: r.u32(o + 0x1a8),         // 0x405e88 / 0x406184 block (0 in every shipped row; not translated)
    rotCurveOff: r.u32(o + 0x1ac),       // vec3 rotation curve 0x876d54 (0 in every shipped row; not translated)
    sizeACurveOff: r.u32(o + 0x1b0),     // half-width from a float curve (0x488054)
    sizeBCurveOff: r.u32(o + 0x1b4),     // half-height from a float curve (0x48816c)
    w1b8: r.u32(o + 0x1b8),              // -> info+0x1c (0x3e8d64); 5000 in every row; consumer not read
    sizeA: pairF(r, o + 0x1c0),          // half-width A  -> particle +0xc0/+0xc4 (0x4880fc)
    sizeB: pairF(r, o + 0x1c8),          // half-height B -> particle +0xc8/+0xcc (0x488210)
    rateA: pairF(r, o + 0x1d0),          // A += rateA each step; A <= 0 kills (0x48978c)
    rateB: pairF(r, o + 0x1d8),          // B += rateB each step; B <= 0 kills (0x489824)
    cornerScale: [r.f32(o + 0x1e0), r.f32(o + 0x1e4), r.f32(o + 0x1e8), r.f32(o + 0x1ec)],  // info+0..+0xc -> corner i x it (0x25ce48)
  });
}

// ---------------------------------------------------------------------------------------------
// Instance
export function initType2(fx, row, ean){
  const r = fx.efl.r;
  const gb = parseType2(r, fx.efl.body + row.genOff), em = row.emitter;
  const g = {
    type: 2, fx, row, gb, em, ean, node: fx.nodes[row.nodeIndex],
    c44: (gb.off * 7) >>> 0, c48: (gb.off * 13) >>> 0,          // RNG counters: seeding 0x3fd4ec not read (INFERRED, as spec)
    state: 0, countdown: 0, wavesLeft: 0, frames: 0, ended: false, active: true, accInterval: 0, accPeriod: 0,
    particles: [], maxParticles: em ? Math.max(1, em.maxParticles) : 1,
    G: null, unsupported: [],
  };
  g.scale = em ? drawF(em.scale, rf32(g, 'c48')) : 1;           // gen+0xf0 (0x413a08)
  const curve = (off, base, kind) => off ? parseCurve(r, base + off, kind) : null;
  g.colourCurve = curve(gb.colourCurveOff, gb.off, 'rgba');
  g.sizeCurve = curve(gb.sizeCurveOff, gb.off, 'f32');
  g.animCurve = curve(gb.animCurveOff, gb.off, 'f32');
  g.curveA = curve(gb.sizeACurveOff, gb.off, 'f32');           // offsets relative to the block (0x488060 add r7, r0, r6)
  g.curveB = curve(gb.sizeBCurveOff, gb.off, 'f32');
  g.countCurve = em && em.countCurveOff ? parseCurve(r, em.off + em.countCurveOff, 'u16') : null;
  g.holdCurve = row.life && row.life.holdCurveOff ? parseCurve(r, row.life.holdCurveOff, 'u16') : null;
  if (gb.rotCurveOff) g.unsupported.push('rotation curve +0x1ac (0x876d54)');
  if (gb.uvAnimOff) g.unsupported.push('uv block +0x1a8 (0x405e88)');
  if (gb.f24) g.unsupported.push('info bits 8..11 path (0x876a74)');
  if (gb.altDraw) g.unsupported.push('alt draw 0x48c3b4 (header bit16)');
  if (gb.alignNodeB) g.unsupported.push('matrix path A (gen+0x4c bit17)');
  // Life sustain (READ 0x40500c; the life slot 0x3c7d5c is shared by every type -- spec.js initType0, notes 17)
  g.sustain = [1, 2, 5, 6].includes(row.lifeKind) ? !!(row.life && row.life.curveFlag) : true;
  return g;
}

// Pre-update 0x400dc0 (READ): gen+0xf4 and the generator matrix G at gen+0xf8.
//   k = gen+0xf0 x owner+0x1b0 ; sv = owner+0x1a0..+0x1a8 x k ; if node scale mode (inst+0x10c bits 20..23) == 0:
//   k *= inst+0xfc, sv *= inst+0xe0..+0xe8. gen+0xf4 = k. G rows 0..2 = node matrix rows 0..2 x sv[i] (or the unit
//   axes 0xd69428.. x sv[i] when gen+0xe4 bit 0x1000 = gb w04 bit 20/21, 0 in every type-2 row); row 3 = node
//   translation. owner+0x1a0 vector: INFERRED (1,1,1) x fx.scale (the spec has one owner scale).
function preUpdate(g){
  const n = g.node, W = n.world;
  let k = g.scale * (g.fx.scale || 1);
  let sv = [k, k, k];
  if (((n.nb && n.nb.scaleMode) | 0) === 0){ k *= n.sizeScale || 1; sv = sv.map((v, i) => v * (n.scaleVec ? n.scaleVec[i] : 1)); }
  g.sizeMul = k;                                                   // gen+0xf4
  const unit = !!(g.gb.w04 & 0x300000);
  const G = new Array(16).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) G[4 * i + j] = (unit ? (i === j ? 1 : 0) : W[4 * i + j]) * sv[i];
  G[12] = W[12]; G[13] = W[13]; G[14] = W[14]; G[15] = 1;
  g.G = G;
}

// Emission (copied from the spec: 0x4063b0 mode 1 / 0x4050c0 mode 2, READ there)
function emit(g){
  const em = g.em, flags = em ? em.flags : 0;
  const endEmission = (how) => { if (flags & 1) g.killOnEnd = true; if ((flags & 2) && !how){ g.state = 6; return; } g.state = 5; g.ended = true; };
  if (g.row.emitMode === 1){
    switch (g.state){
      case 0: g.frames = 0; g.countdown = g.node.delay; g.state = 1;   // fallthrough
      case 1: if (g.countdown){ g.countdown--; return 0; } g.state = 3; // fallthrough
      case 3: endEmission(0); g.frames++; return 1;
      case 5: g.frames++; return 0;
      case 6: g.countdown = drawU16(em.repeatDelay, ru32(g, 'c44')); g.state = 1; g.frames++; return 0;
    }
    return 0;
  }
  switch (g.state){
    case 0: g.frames = 0; g.countdown = g.node.delay; g.state = 1;     // fallthrough
    case 1: if (g.countdown){ g.countdown--; return 0; } g.wavesLeft = drawU16(em.waves, ru32(g, 'c44')); g.state = 2; // fallthrough
    case 2: g.countdown = loadRamp(g, em.interval, em.intervalRamp, 'accInterval'); g.state = 3; // fallthrough
    case 3: {
      const count = g.countCurve ? evalCurveU16(g.countCurve, curveTime(g.countCurve, g, null), 0) : drawU16(em.count, ru32(g, 'c44'));
      g.countdown = (g.countdown - 1) & 0xffff;
      if (g.countdown === 0){ const p = loadRamp(g, em.period, em.periodRamp, 'accPeriod'); if (p){ g.countdown = p; g.state = 4; } else waveDone(g, endEmission); }
      g.frames++; return count;
    }
    case 4: g.countdown = (g.countdown - 1) & 0xffff; if (g.countdown === 0) waveDone(g, endEmission); g.frames++; return 0;
    case 5: g.frames++; return 0;
    case 6: g.countdown = drawU16(em.repeatDelay, ru32(g, 'c44')); g.state = 1; g.frames++; return 0;
  }
  return 0;
}
function loadRamp(g, pair, ramp, acc){
  if (ramp === 0) return drawU16(pair, ru32(g, 'c44'));
  const v = Math.trunc(pair.base + g[acc]);
  if (pair.base > v) return pair.base;
  if (v > pair.base + pair.range) return pair.base + pair.range;
  g[acc] = Math.fround(g[acc] + ramp); return v;
}
function waveDone(g, endEmission){ if (!g.wavesLeft){ g.state = 2; return; } g.wavesLeft--; if (g.wavesLeft) g.state = 2; else endEmission(0); }

// Launch for moving kinds (copy of the spec's; direction INFERRED there)
function launch(g, p){
  const m = g.row.motion;
  const [rx, ry, rz] = m.angle.map(pr => drawF(pr, rf32(g, 'c48')));
  let d = [0, 1, 0];
  d = [d[0], d[1] * Math.cos(rx) - d[2] * Math.sin(rx), d[1] * Math.sin(rx) + d[2] * Math.cos(rx)];
  d = [d[0] * Math.cos(ry) + d[2] * Math.sin(ry), d[1], -d[0] * Math.sin(ry) + d[2] * Math.cos(ry)];
  d = [d[0] * Math.cos(rz) - d[1] * Math.sin(rz), d[0] * Math.sin(rz) + d[1] * Math.cos(rz), d[2]];
  const W = g.node.world;
  d = [W[0] * d[0] + W[4] * d[1] + W[8] * d[2], W[1] * d[0] + W[5] * d[1] + W[9] * d[2], W[2] * d[0] + W[6] * d[1] + W[10] * d[2]];
  const L = Math.hypot(d[0], d[1], d[2]) || 1; d = d.map(v => v / L);
  const speed = drawF(m.speed, rf32(g, 'c48'));
  p.mot = { speed, drag: drawF(m.drag, rf32(g, 'c48')), gInc: drawF(m.gravity, rf32(g, 'c48')) * (g.fx.scale || 1), g: 0, vel: d.map(v => v * speed) };
}

// ---------------------------------------------------------------------------------------------
// Spawn one particle: 0x487e6c (READ), in its order:
//   0x3fde00 base spawn (placement 0x3ff150, motion 0x400724, life 0x3c7a44 -- contents as the spec's type 0, INFERRED order)
//   0x405998 anim config, draw-key words (+0x18/+0x1c, same build as type 0 -> drawState applies), 0x405c00,
//   colour (curve 0x8766d0 or 0x3fdc30) -> +0xf0, x envelope 1.0 -> +0xd0/+0xd4,
//   size 0x400b80 (min 0) -> +0x40/+0x44, rate +0x48,
//   rotation 0x3ff614(gb+0x170, gb+0x188, curve gb+0x1ac) -> euler +0x60/+0x70, spin +0xa0..+0xa8,
//   A: curve +0x1b0 (re-evaluated unless one-shot, rnd kept in +0xf4) or draw(+0x1c0) with rate draw(+0x1d0) -> +0xc0/+0xc4, +0xf4,
//   B: curve +0x1b4 or draw(+0x1c8), rate draw(+0x1d8) -> +0xc8/+0xcc, +0xf8,
//   dir = normalise(motion slot +0..+8) -> +0x80/+0x90 (used only by matrix path C, see stepType2).
function spawnType2(g){
  const gb = g.gb, life = g.row.life;
  const p = { age: 0 };
  if (life){                                                       // life slot (0x3c7a44 READ; as the spec)
    const w0 = drawU16(life.fadeIn, ru32(g, 'c44'));
    const w1 = g.holdCurve ? evalCurveU16(g.holdCurve, curveTime(g.holdCurve, g, null), ru32(g, 'c44')) : drawU16(life.hold, ru32(g, 'c44'));
    const w2 = drawU16(life.fadeOut, ru32(g, 'c44'));
    p.life = { w0, w1, w2, counter: 0, phase: 0, value: 1, sustain: life.sustain || 0, sustainOn: g.sustain };
    if (w0){ p.life.phase = 1; p.life.value = 1 / (w0 + 1); } else if (w1){ p.life.phase = 2; p.life.counter = w1; } else { p.life.phase = 3; p.life.counter = w2 || 1; }
  }
  p.pos = xform(g.node.world, [0, 0, 0]);
  if (g.row.motionKind !== 0 && g.row.motion) launch(g, p);
  // anim (0x405998)
  let af = gb.animFlags;
  if (af & 0x800 && (ru32(g, 'c48') & 1)) af |= 0x200;
  if (af & 0x400 && (ru32(g, 'c48') & 1)) af |= 0x100;
  p.anim = { flags: af, seq: 0, count: 1, last: 0, frame: 0, speed: 0 };
  if (g.ean){
    let start, speed = gb.animSpeed, rnd = 0;
    if (!g.animCurve) start = drawU16(gb.animStart, ru32(g, 'c48'));
    else {
      rnd = rf32(g, 'c48');
      if (gb.animCurveMode){ start = drawU16(gb.animStart, ru32(g, 'c48')); speed = Math.max(0, evalCurveF(g.animCurve, 0, rnd)); }
      else start = Math.min(Math.max(evalCurveF(g.animCurve, 0, rnd), 0), gb.animMax);
      if (!g.animCurve.once){ p.anim.curve = true; p.anim.rnd = rnd; }
    }
    const seq = drawU16(gb.animSeq, ru32(g, 'c48'));
    const s = g.ean.seqs[Math.min(seq, g.ean.seqs.length - 1)];
    p.anim.seq = seq; p.anim.count = s ? s.frames.length : 1; p.anim.last = p.anim.count - 1;
    p.anim.frame = start;
    p.anim.speed = speed - Math.trunc(speed / p.anim.count) * p.anim.count;
  }
  // colour (0x487f6c..0x488024)
  const cf = gb.colourFlags;
  if (g.colourCurve){
    const u = ru32(g, 'c48'); p.rndByte = (u & 0xff) || (u & 0x100);   // 0x487fa0
    p.base = evalCurveRGBA(g.colourCurve, curveTime(g.colourCurve, g, p), p.rndByte);
    if (!g.colourCurve.once) p.colourCurve = true;                       // particle +0x10 |= 0x20000
  } else if (cf & 0xf){
    if (cf & 0x10){ const f = [0, 1, 2, 3].map(() => Math.trunc(rf32(g, 'c48') * 256)); p.base = 0;
      for (let s = 0; s < 4; s++) p.base |= (lerpRGBA(gb.colourA, gb.colourB, f[s]) & (0xff << (8 * s))); p.base >>>= 0; }
    else p.base = lerpRGBA(gb.colourA, gb.colourB, Math.trunc(rf32(g, 'c48') * 256));
  } else if (cf & 0x20) p.base = (ru32(g, 'c48') & 1) ? gb.colourA : gb.colourB;
  else p.base = gb.colourA;
  p.colour = p.base;
  // size 0x400b80 (READ): curve (re-evaluated unless one-shot, flag 0x100000) or base+range*rnd, min 0; rate
  if (g.sizeCurve){ const rr = rf32(g, 'c48'); p.size = Math.max(0, evalCurveF(g.sizeCurve, 0, rr)); p.sizeRnd = rr; p.sizeCurveLive = !g.sizeCurve.once;
    p.sizeRate = p.sizeCurveLive ? rr : drawF(gb.sizeRate, rf32(g, 'c48')); }
  else { p.size = Math.max(0, drawF(gb.size, rf32(g, 'c48'))); p.sizeRate = drawF(gb.sizeRate, rf32(g, 'c48')); }
  // rotation 0x3ff614 (READ; curve branch +0x1ac not translated -- 0 in every shipped row)
  p.rot = gb.rot.map(pr => drawF(pr, rf32(g, 'c48')));            // 0x3ff814..0x3ff848 (x, y, z)
  p.spin = [0, 0, 0];                                              // 0xd69498 = (0,0,0) (EMU: static init 0xa53020)
  if (gb.spinOn){                                                  // gen+0x4c bit23 (0x3ff6f0)
    let sign = 1;
    if (gb.spinRandomSign && (ru32(g, 'c48') & 1)) sign = -1;      // 0x3ff704
    p.spin = gb.spin.map(pr => Math.fround(drawF(pr, rf32(g, 'c48')) * sign));
    p.spinLive = true;                                             // particle +0x10 |= 0x400
  }
  // gen+0xe4 bit 0x800 (0x40e138 add) and gen+0xb8 bit 0x4000 (mirror: negate y, z) not modelled: w04 bit21 = 0
  // in every type-2 row; the mirror flag belongs to the owner (INFERRED off)
  // half extents A, B (0x488054..0x48827c READ)
  const half = (curveC, pair, rate) => {
    if (curveC){
      const rnd = rf32(g, 'c48');
      const v = Math.max(0, evalCurveF(curveC, curveTime(curveC, g, p), rnd));
      if (!curveC.once) return { v, rnd, curve: true, rate: 0 };
      const rt = drawF(rate, rf32(g, 'c48')); return { v, rate: rt, curve: false };
    }
    const v = drawF(pair, rf32(g, 'c48')); const rt = drawF(rate, rf32(g, 'c48'));
    return { v, rate: rt, curve: false };
  };
  p.A = half(g.curveA, gb.sizeA, gb.rateA);
  p.B = half(g.curveB, gb.sizeB, gb.rateB);
  p.dir = dirOf(p);
  return p;
}
// motion-slot vector normalised (0x488280..0x4882f0 READ; slot layout per kind INFERRED: the launched velocity)
function dirOf(p){
  const v = p.mot ? p.mot.vel : [0, 0, 0];
  const L = Math.hypot(v[0], v[1], v[2]);
  return L < 1.1920929e-7 ? v.slice() : v.map(x => x / L);
}

// One particle step: base pass 0x4005b8 (motion, life) then 0x48956c (READ).
function stepParticle(g, p){
  const gb = g.gb;
  p.age++;
  if (g.row.motionKind === 0 || !p.mot) p.pos = xform(g.node.world, [0, 0, 0]);
  else { const m = p.mot; p.pos = [p.pos[0] + m.vel[0], p.pos[1] + m.vel[1] - m.g, p.pos[2] + m.vel[2]];
         m.speed *= m.drag; m.vel = m.vel.map(v => v * m.drag); m.g += m.gInc; }
  const L = p.life;
  if (L){                                                          // 0x3c7d5c (as the spec, with the sustain path)
    const fadeOut = () => { if (L.w2){ L.phase = 3; L.counter = L.w2; } else L.phase = 4; };
    const sustained = () => g.sustain && L.sustainOn;
    if (L.phase === 1){ L.counter++;
      if (L.counter < L.w0) L.value = (L.counter + 1) / (L.w0 + 1);
      else { L.value = 1; if (L.w1){ L.phase = 2; L.counter = L.w1; } else if (sustained()){ L.phase = 2; L.counter = 1; } else fadeOut(); }
      if (g.killOnEnd && L.phase <= 2) fadeOut();
    } else if (L.phase === 2){
      if (sustained()){ if (L.sustain){ L.sustain--; if (!L.sustain) L.counter = 0; } } else L.counter--;
      if (!L.counter || g.killOnEnd) fadeOut(); }
    else if (L.phase === 3){ L.counter--; if (L.counter) L.value = L.counter / L.w2; else { L.value = 0; L.phase = 4; } }
    if (L.phase === 4) return false;
  }
  // 1. anim (p+0xc bit27 -> 0x4003e8; failure kills, 0x4895ac)
  if (g.ean && !stepAnim(g, p)) return false;
  // 2. colour curve (p+0x10 bit 0x20000 -> 0x8766d0, 0x489604)
  if (p.colourCurve) p.base = evalCurveRGBA(g.colourCurve, curveTime(g.colourCurve, g, p), p.rndByte);
  // 3. x envelope (p+0xc bit 0x40 -> 0x3fe1f0 with the life value; INFERRED: bit 0x40 = has a life slot, as type 0)
  p.colour = applyEnvelope(p.base, g.row.lifeKind, L ? L.value : 1);
  // 4. size 0x400cf8 (flags 0x100100): curve, or size += rate, rate *= gb+0x1c; size < 0 kills
  if (p.sizeCurveLive) p.size = Math.max(0, evalCurveF(g.sizeCurve, curveTime(g.sizeCurve, g, p), p.sizeRnd));
  else if (p.sizeRate !== 0){ const s = p.size + p.sizeRate; p.sizeRate = Math.fround(p.sizeRate * gb.sizeDamp); if (s < 0) return false; p.size = s; }
  // 5. rotation 0x3ffaa8 (flags 0x200400): rot += spin; spin *= gb+0x1a4 (x motion slot +0x1c when p+0xc 0x2000:
  //    not modelled, INFERRED off)
  if (p.spinLive){ p.rot = p.rot.map((v, i) => Math.fround(v + p.spin[i])); p.spin = p.spin.map(v => Math.fround(v * gb.spinDamp)); }
  // 6/7. A, B (0x489738..0x489874): curve (clamped >= 0, no death) or += rate with death at <= 0
  for (const [h, c] of [[p.A, g.curveA], [p.B, g.curveB]]){
    if (h.curve) h.v = Math.max(0, evalCurveF(c, curveTime(c, g, p), h.rnd));
    else if (h.rate !== 0){ const v = Math.fround(h.v + h.rate); if (!(v > 0)) return false; h.v = v; }
  }
  // 8. dir refresh from the motion slot (0x489878)
  p.dir = dirOf(p);
  return true;
}
function stepAnim(g, p){                                           // 0x2367e8 / 0x4003e8 (copy of the spec's)
  const a = p.anim;
  if (a.curve && g.animCurve){
    const v = evalCurveF(g.animCurve, curveTime(g.animCurve, g, p), a.rnd);
    if (g.gb.animCurveMode) a.speed = Math.max(0, v);
    else { a.frame = Math.min(Math.max(v, 0), g.gb.animMax);
      if (a.flags & 2){ if (a.frame >= a.count) a.frame -= a.count; return true; }
      if (a.frame >= a.count){ a.frame = a.last + 0.99999; return !(a.flags & 8); }
      return true; }
  }
  if (!(a.flags & 1)) return true;
  if (a.flags & 4){ a.frame -= a.speed; if (a.frame < 0){ if (a.flags & 2) a.frame += a.count; else { a.frame = 0; if (a.flags & 8) return false; } } return true; }
  a.frame += a.speed;
  if (a.frame >= a.count){ if (a.flags & 2) a.frame -= a.count; else { a.frame = a.last + 0.99999; if (a.flags & 8) return false; } }
  return true;
}

// Generator update (slot 18, 0x412aa8, as the spec): pre-update (G), emission, spawns, particle pass. Returns live.
export function stepType2(g){
  if (!g.node.world) return g.active;
  preUpdate(g);
  const n = emit(g);
  for (let i = 0; i < n; i++){
    if (g.particles.length >= g.maxParticles) break;               // 0x3fdfb4 pool full
    g.particles.push(spawnType2(g));
  }
  g.particles = g.particles.filter(p => stepParticle(g, p));
  g.active = !(g.ended && g.particles.length === 0);               // 0x412ccc
  return g.active;
}

// ---------------------------------------------------------------------------------------------
// Geometry (draw 0x489970 READ; matrices EMU-checked)

// Euler -> rotation, 0x132ccc (EMU, all 7 orders): order k = row-vector product of the elementary rotations in the
// order below (first applied first); Rx = [[1,0,0],[0,c,s],[0,-s,c]], Ry = [[c,0,-s],[0,1,0],[s,0,c]],
// Rz = [[c,s,0],[-s,c,0],[0,0,1]]; sin = 0xa46ad4, cos = 0xa45708. Order >= 6: identity.
const EULER_ORDERS = ['XYZ', 'XZY', 'YXZ', 'YZX', 'ZXY', 'ZYX'];
export function eulerMatrix(rot, order){
  const el = { X: (a) => { const c = Math.cos(a), s = Math.sin(a); return [1, 0, 0, 0, c, s, 0, -s, c]; },
               Y: (a) => { const c = Math.cos(a), s = Math.sin(a); return [c, 0, -s, 0, 1, 0, s, 0, c]; },
               Z: (a) => { const c = Math.cos(a), s = Math.sin(a); return [c, s, 0, -s, c, 0, 0, 0, 1]; } };
  const ang = { X: rot[0], Y: rot[1], Z: rot[2] };
  let m = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const seq = EULER_ORDERS[order];
  if (seq) for (const ax of seq) m = mul3(m, el[ax](ang[ax]));
  return m;
}
const mul3 = (a, b) => { const o = new Array(9); for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) o[3 * i + j] = a[3 * i] * b[j] + a[3 * i + 1] * b[3 + j] + a[3 * i + 2] * b[6 + j]; return o; };
// row-vector 4x4 product a.b (16 floats, rows of 4)
const mul4r = (a, b) => { const o = new Array(16); for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) o[4 * i + j] = a[4 * i] * b[j] + a[4 * i + 1] * b[4 + j] + a[4 * i + 2] * b[8 + j] + a[4 * i + 3] * b[12 + j]; return o; };
const xformRow = (m, v) => [m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12], m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13], m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14]];

// Particle matrix 0x402270 (EMU for path B): identity (0xd69568) . S(size) . R(euler, gen+0xe0 bits 16..19), then
//   path A (gen+0x4c bit17): align axis(gen+0xe0 24..27) to node B - node A  -- not shipped, not translated
//   path C (axis != 6, particle flag 0x80, no gen+0xe4 0x1000): align axis to `dir` (flag 0x100: dir already world,
//          else x node 3x3), quaternion, x (gen+0x138 sv) -- not reached: flag 0x80 comes from the emitter-shape
//          placement 0x3ff5f0 (needs emitter +0x7c bit 10, 0 in every type-2 row) or kind-0 spawn 0x4056bc
//          (arg r2 +0x30 bit 24, arg not identified): INFERRED off
//   path B (else): . G (gen+0xf8), translation row := 0xd693e8 = (0,0,0,0).
export function particleMatrix(g, p){
  const gb = g.gb, s = p.size;
  const R = eulerMatrix(p.rot, gb.eulerOrder);
  const M = new Array(16).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) M[4 * i + j] = s * R[3 * i + j];
  M[15] = 1;
  const G = g.G || [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const out = mul4r(M, G);
  out[12] = out[13] = out[14] = out[15] = 0;
  return out;
}

// Camera axis lock 0x8764a4 (READ + EMU), on C = camera matrix rows (0 right, 1 up, 2 back, 3 position).
// modes 2/6: a=0 (X), b=2, c=1; 3/7: a=1 (Y), b=2, c=0; 4/8: a=2 (Z), b=1, c=0; other (1, 5, 9..): C unchanged.
// row a := world axis e_a ; w = e_a x row b (normalised) ; if w == 0: t = e_a x row c, w = e_a x t (normalised),
// u = t ; else u = e_a x w (normalised) ; row b := u ; row c := w.
export function lockCamera(C, mode){
  const tab = { 2: [0, 2, 1], 6: [0, 2, 1], 3: [1, 2, 0], 7: [1, 2, 0], 4: [2, 1, 0], 8: [2, 1, 0] }[mode];
  if (!tab) return C.slice();
  const [a, b, c] = tab, M = C.slice();
  const v = [0, 0, 0]; v[a] = 1;
  const row = k => [M[4 * k], M[4 * k + 1], M[4 * k + 2]];
  const cross = (x, y) => [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
  const norm = x => { const L = Math.hypot(x[0], x[1], x[2]); return L < 1.1920929e-7 ? x : x.map(q => q / L); };
  let w = norm(cross(v, row(b))), u;
  if (w[0] === 0 && w[1] === 0 && w[2] === 0){ const t = cross(v, row(c)); w = norm(cross(v, t)); u = t; }
  else u = norm(cross(v, w));
  const put = (k, x) => { M[4 * k] = x[0]; M[4 * k + 1] = x[1]; M[4 * k + 2] = x[2]; M[4 * k + 3] = 0; };
  put(a, v); put(b, u); put(c, w);
  return M;
}

// Corners 0x25c9e8 (READ + EMU): anchor -> extents (xL, xR, yB, yT) from A (half-width) and B (half-height):
//   0 centred [-A,A]x[-B,B]; 1 [0,2A]x[-2B,0]; 2 [-2A,0]x[-2B,0]; 3 [0,2A]x[0,2B]; 4 [-2A,0]x[0,2B];
//   5 [-A,A]x[-2B,0]; 6 [-A,A]x[0,2B]; 7 [0,2A]x[-B,B]; 8 [-2A,0]x[-B,B];
//   9 texture pivot: px = 2*pivX/frame.w, py = 2*pivY/frame.h (1,1 without a frame); flags 0x100: px = 2-px,
//     0x200: py = 2-py, 0x1000: (px, py) = (py, 2-px); x in [-A*px, A*(2-px)], y in [B*(py-2), B*py];  >= 10: all 0.
// plane -> local corners c0 (xL,yT) c1 (xR,yT) c2 (xL,yB) c3 (xR,yB) placed as
//   0 (0,x,y)  1 (0,-x,y)  2 (-x,0,y)  3 (x,0,y)  4/6 (x,y,0)  5 (-x,y,0)  >= 7: all (0,0,0) (0xd69498).
// Each corner x cornerScale[i], then x M (row vector incl. translation); corner i goes to output slot
// perm[i] = [0,1,2,3], or [1,3,0,2] with anim flag 0x1000 (0x25ce0c).
export function quadCorners(anchor, plane, A, B, scales, M, frame, pivot, flags){
  let xL = 0, xR = 0, yB = 0, yT = 0;
  switch (anchor){
    case 0: xL = -A; xR = A; yB = -B; yT = B; break;
    case 1: xL = 0; xR = 2 * A; yB = -2 * B; yT = 0; break;
    case 2: xL = -2 * A; xR = 0; yB = -2 * B; yT = 0; break;
    case 3: xL = 0; xR = 2 * A; yB = 0; yT = 2 * B; break;
    case 4: xL = -2 * A; xR = 0; yB = 0; yT = 2 * B; break;
    case 5: xL = -A; xR = A; yB = -2 * B; yT = 0; break;
    case 6: xL = -A; xR = A; yB = 0; yT = 2 * B; break;
    case 7: xL = 0; xR = 2 * A; yB = -B; yT = B; break;
    case 8: xL = -2 * A; xR = 0; yB = -B; yT = B; break;
    case 9: {
      let px = 1, py = 1;
      if (frame){ px = Math.fround(Math.fround(pivot[0] / frame.w) * 2); py = Math.fround(Math.fround(pivot[1] / frame.h) * 2); }
      if (flags & 0x100) px = 2 - px;
      if (flags & 0x200) py = 2 - py;
      if (flags & 0x1000){ const t = px; px = py; py = 2 - t; }
      xL = -A * px; xR = (2 - px) * A; yB = (py - 2) * B; yT = B * py; break;
    }
  }
  const P = (x, y) => {
    switch (plane){
      case 0: return [0, x, y]; case 1: return [0, -x, y]; case 2: return [-x, 0, y]; case 3: return [x, 0, y];
      case 4: case 6: return [x, y, 0]; case 5: return [-x, y, 0]; default: return [0, 0, 0];
    }
  };
  const local = [P(xL, yT), P(xR, yT), P(xL, yB), P(xR, yB)];
  const perm = (flags & 0x1000) ? [1, 3, 0, 2] : [0, 1, 2, 3];
  const out = [];
  for (let i = 0; i < 4; i++){ const k = scales[i]; const c = local[i].map(v => v * k); out[perm[i]] = xformRow(M, c); }
  return out;
}

// Frame used by the draw (0x488578..0x488658 READ): with the play flag (1) and no 0x2000, the drawn frame is the
// interpolated frame ROUNDED (fraction >= 0.5 -> next, wrap with loop flag 2, clamp to the last); else
// trunc(frame) of the other buffer (INFERRED: the current one, the buffer phase is not modelled). Interpolation
// fraction gen+0x90 = 1 here (state at the step).
function drawFrame(g, p){
  const a = p.anim, sq = g.ean && g.ean.seqs[Math.min(a.seq, g.ean.seqs.length - 1)];
  if (!sq || !sq.frames.length) return null;
  const last = sq.frames.length - 1;
  let idx;
  if (!(a.flags & 1) || (a.flags & 0x2000)) idx = Math.min(Math.trunc(a.frame), last);
  else {
    const f = a.frame; let i = Math.min(Math.trunc(f), last);
    const next = (a.flags & 2) ? (i >= last ? 0 : i + 1) : (i >= last ? last : i + 1);
    idx = (f - i) >= 0.5 ? next : i;
  }
  return sq.frames[idx];
}

// buildType2Geometry(g, camera, opts) -> draw-ready triangles in game units.
//   camera: { right, up, back } world unit vectors (rows 0..2 of the camera world matrix; INFERRED: 0x5611a4
//           returns ctx+0x404 +0x40, read as the camera's world matrix by consistency with 0x8764a4's axis lock).
//           Used by billboard rows and by the ZOffset shift; defaults to the world axes.
//   opts.ownerAlpha (0..256, default 256): A x it >> 8 (0x489b94); opts.zOffsetShift (default true).
// Per particle (alpha != 0, 0x489ba4): positions of the 4 strip-ordered corners, UVs (top-down image coords,
// quantised like the s16 x4096 TexCoord, VS scale c90.y), colour, indices (0,1,2)(2,1,3).
// Index pattern INFERRED: the draw entry stores 4 vertices and ((4+1)&~1)+2 = 6 indices (0x48a168..), the
// stitched triangle-strip count; the draw call's primitive mode was not read.
export function buildType2Geometry(g, camera = {}, opts = {}){
  const gb = g.gb;
  const R = camera.right || [1, 0, 0], U = camera.up || [0, 1, 0];
  const Bk = camera.back || [R[1] * U[2] - R[2] * U[1], R[2] * U[0] - R[0] * U[2], R[0] * U[1] - R[1] * U[0]];
  const ownerAlpha = opts.ownerAlpha ?? 256;
  const positions = [], uvs = [], rgba = [], indices = [];
  // ZOffset (VS_Primitive_CNZ poly3D 0x000/0x01a..0x01d READ): vertex += fViewI column 2 x (fPrimZOffsetScale.w
  // (-1, prim+0xe8 = 1.0) x ZOffset); ZOffset = gb +0x0c low16 written per vertex (strh 0x48a10c).
  const zs = (opts.zOffsetShift ?? true) ? -gb.zOffset : 0;
  let C = null;
  if (gb.billboard){                                                // 0x489a44: info & 0xf -> 0x876988 + 0x8764a4
    C = [R[0], R[1], R[2], 0, U[0], U[1], U[2], 0, Bk[0], Bk[1], Bk[2], 0, 0, 0, 0, 1];
    C = lockCamera(C, gb.billboard);
  }
  for (const p of g.particles){
    let c = p.colour >>> 0;
    const a = ((c >>> 24) * ownerAlpha) >> 8;                       // 0x489b90
    if (!a) continue;                                               // 0x489ba4
    c = ((c & 0x00ffffff) | (a << 24)) >>> 0;
    let M = particleMatrix(g, p);
    if (C) M = gb.bbCameraFirst ? mul4r(C, M) : mul4r(M, C);       // 0x48ad08 (bit set: C.P; clear: P.C)
    M[12] = p.pos[0]; M[13] = p.pos[1]; M[14] = p.pos[2]; M[15] = 1; // 0x489cb0 / 0x48b0dc
    const fr = drawFrame(g, p);
    const corners = quadCorners(gb.anchor, gb.plane, p.A.v, p.B.v, gb.cornerScale, M,
                                fr ? { w: fr.w, h: fr.h } : null, [gb.spriteW, gb.spriteH], p.anim.flags);
    // UVs 0x488a18..0x488a5c: frame floats (u0,v0,u1,v1) or (0,0,1,1); 0x100 swaps u, 0x200 swaps v;
    // v0 (u0,v0) v1 (u1,v0) v2 (u0,v1) v3 (u1,v1)
    let u0 = 0, v0 = 0, u1 = 1, v1 = 1;
    if (fr){ u0 = fr.u0; v0 = fr.v0; u1 = fr.u1; v1 = fr.v1; }
    if (p.anim.flags & 0x100){ const t = u0; u0 = u1; u1 = t; }
    if (p.anim.flags & 0x200){ const t = v0; v0 = v1; v1 = t; }
    const q = x => Math.trunc(Math.fround(x * 4096)) * 0.00024399906396865845;   // s16 (0x48a0e0) x c90.y
    const quv = [[q(u0), q(v0)], [q(u1), q(v0)], [q(u0), q(v1)], [q(u1), q(v1)]];
    const base = positions.length;
    for (let i = 0; i < 4; i++){
      const w = corners[i];
      positions.push([w[0] + Bk[0] * zs, w[1] + Bk[1] * zs, w[2] + Bk[2] * zs]);
      uvs.push(quv[i]);
      rgba.push([c & 0xff, (c >>> 8) & 0xff, (c >>> 16) & 0xff, c >>> 24]);
    }
    indices.push(base, base + 1, base + 2, base + 2, base + 1, base + 3);
  }
  return { positions, uvs, rgba, indices, quads: positions.length / 4,
           drawState: drawState(gb.state, gb.w04), texture: gb.tex[0], zOffset: gb.zOffset,
           pass: 'TPrimitive pass 1 (VS_Primitive_CNZ + PS_Primitive), layout IAPrimitivePolygon' };
}
