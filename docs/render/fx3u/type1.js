// efx3u_type1.js -- MH3U generator type 1 (cParticleGeneratorPolyline, block 0x200), reference translation.
//
// Same rules as efx3u_spec.js: every step names the 3U ARM11 routine (exefs/code.decompressed.bin VA) it was
// read from. READ = the consuming instruction was read; INFERRED = not read (says what would make it READ).
// Notes: C:\MH3U-Extract\notes\effects-engine.md section 17.
//
// What the game does (READ, 2026-10-24, eng4):
//   - vtable 0xb623b4: init 0x494eb8, start 0x49a268, spawn 0x494774, pass 0x494f18 (per particle 0x494ff8),
//     draw 0x49a230 -> 0x495aa0 (gen+0x42 == 1: EAN bound, header bit16 clear).
//   - Each particle owns N points (+0x170 bits 8..15). Their shape comes from the "line kind" (+0x170 bits 0..7),
//     dispatched by 0x403b40 (spawn) / 0x404604 (step). Every em001 row is kind 4 (init 0x40b604, step 0x40d4c8):
//     a STRAIGHT segment of length L along one axis, rotated by an euler triple, scaled by the particle size and
//     the node matrix, rebuilt every step (0x40b660). Kinds 0..3, 5, 6 are not read (no em001 row uses them).
//   - The CPU writes per particle one header record (RMode 10, ZOffset) + N 32-byte point records (position,
//     colour, width, two texel UVs, tangent) into the prim buffer, prim type 2 -> IAPrimitivePolylineGs, TPrimitive
//     pass 6 "PolylineGS" = VS_PrimitiveGS_PlC + GS CAP_Polyline (disassembled with eng2_pica.py:
//     eng4_t1_dis_PolylineGS.txt). The GS expands the points into a CAMERA-FACING RIBBON (triangle strip, 2 vertices
//     per point): side = normalize((P - cameraPos) x tangent) * width/2; '+' side gets UV a, '-' side UV b.
//
// Usage sketch (the effect driver lives in efx3u_spec.js; createEffect marks type-1 rows unsupported):
//   const g = initType1(fx, row, eanOrNull)          // replaces fx.gens' placeholder for that row
//   each step, after the nodes' world matrices are updated: stepType1(g)  -> false when the generator is done
//   draw: buildType1Geometry(g, { pos, right, up, back }, { texSize })

import { parseCurve, evalCurveF, evalCurveRGBA, curveTime, drawState } from './spec.js';

// ---------------------------------------------------------------------------------------------
// Helpers COPIED from efx3u_spec.js (not exported there; same code, same READ/INFERRED status):
// pairU16, pairF, ru32, rf32, drawU16, drawF, lerpRGBA, applyEnvelope, stepAnim/wrapFrame, xform, the emitter
// state machine (emit/loadRamp/nextWave/waveDone), base colour 0x3fdc30 (spawnType0 colour block), the anim
// config of spawnType0 (0x405998), and parseGenHeader.
const pairU16 = (r, o) => ({ base: r.u16(o), range: r.u16(o + 2) });
const pairF = (r, o) => ({ base: r.f32(o), range: r.f32(o + 4) });
let RNG_U32 = null, RNG_F32 = null;
// The spec keeps its tables private; pass the same efx3u_rng.json arrays here too.
export function setRandomTables(u32, f32){ RNG_U32 = Uint32Array.from(u32); RNG_F32 = Float32Array.from(f32); }
function ru32(st, key){ st[key] = (st[key] + 1) >>> 0; return RNG_U32 ? RNG_U32[st[key] & 0xfff] : (Math.random() * 4294967296) >>> 0; }
function rf32(st, key){ st[key] = (st[key] + 1) >>> 0; return RNG_F32 ? RNG_F32[st[key] & 0xfff] : Math.random(); }
const drawU16 = (pair, rnd) => pair.range ? pair.base + (rnd % (pair.range + 1)) : pair.base;   // 0xa00630 READ
const drawF = (pair, f) => Math.fround(pair.base + Math.fround(pair.range * f));
const lerpRGBA = (a, b, f256) => {
  let o = 0;
  for (let s = 0; s < 32; s += 8){
    const x = (a >>> s) & 0xff, y = (b >>> s) & 0xff;
    o |= ((x + (((y - x) * f256) >> 8)) & 0xff) << s;
  }
  return o >>> 0;
};
function applyEnvelope(c, kind, v){                               // 0x3fe1f0
  if (!kind) return c;
  const e = Math.trunc(v * 256);
  if (kind & 1) return ((c & 0x00ffffff) | (((((c >>> 24) * e) >> 8) & 0xff) << 24)) >>> 0;
  let o = c & 0xff000000;
  for (let s = 0; s < 24; s += 8) o |= ((((c >>> s) & 0xff) * e) >> 8 & 0xff) << s;
  return o >>> 0;
}
const xform = (m, v) => [m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12], m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13], m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14]];

function parseGenHeader(r, o){                                     // spec parseGenHeader (copied)
  return {
    a: r.bf(o, 0, 8), state: r.bf(o, 24, 8), altDraw: r.bf(o, 16, 1),
    w04: r.u32(o + 4),
    zOffset: (r.s32(o + 0xc) << 16) >> 16,
    drawSub: r.bf(o + 0x18, 12, 4),
    flags18hi: r.bf(o + 0x18, 24, 8),   // -> gen+0x4e (strb 0x3c8bd0) = gen+0x4c bits 16..23: bit16 random spin sign,
                                        //    bit17 aim from the node, bit23 spin from +0x1c8 (READ 0x3ff978, 0x402684)
    sizeDamp: r.f32(o + 0x1c),
    size: pairF(r, o + 0x28), sizeRate: pairF(r, o + 0x30),
    sizeCurveOff: r.bf(o + 0x38, 16, 16),
    colourFlags: r.bf(o + 0x40, 0, 8), animCurveMode: r.bf(o + 0x40, 8, 1), colourCurveOff: r.bf(o + 0x40, 16, 16),
    animCurveOff: r.bf(o + 0x44, 0, 16),
    colourA: r.u32(o + 0x48), colourB: r.u32(o + 0x4c),
    animFlags: r.bf(o + 0x50, 0, 16), animSeq: { base: r.bf(o + 0x50, 16, 8), range: r.bf(o + 0x50, 24, 8) },
    animStart: pairU16(r, o + 0x54), animSpeed: r.f32(o + 0x58), animMax: r.f32(o + 0x5c),
  };
}

// ---------------------------------------------------------------------------------------------
// Block fields. 3DS bit positions; r.bf mirrors them for the Wii U (MSB-first) files. Checked field by field on
// em001_000/002/007/054 (3DS 0x204 <-> Wii U 0x04020000; +0x1e0 0x02000642 <-> 0x24600200; +0x1a8 0x02300000 <-> 0x230).
export function parseType1(r, o){
  const h = parseGenHeader(r, o);
  return Object.assign(h, {
    type: 1, off: o,
    tex: [r.str(o + 0x70), r.str(o + 0xb0), r.str(o + 0xf0)],
    ean: r.str(o + 0x130),
    // +0x170 (spawn 0x4947a8..0x4947f4, alloc 0x494eb8 -> 0x406a58)
    kind: r.bf(o + 0x170, 0, 8),          // line kind -> particle +0x7c (dispatch 0x403b40 / 0x404604)
    points: r.bf(o + 0x170, 8, 8),        // N points -> particle +0x7d
    colourSplit: r.bf(o + 0x170, 16, 8),  // -> +0x7e, the split point of the colour gradient (0x4953cc)
    widthSplit: r.bf(o + 0x170, 24, 8),   // -> +0x9c, the split point of the width gradient (0x4957c8)
    // +0x174
    colourGrad: r.bf(o + 0x174, 0, 4),    // -> +0x7c bits 24..27: !=0 = two colours, gradient mode (0x4953ec, 0x495524)
    widthGrad: r.bf(o + 0x174, 4, 4),     // -> +0x9c bits 8..11: !=0 = two widths, gradient mode (0x49579c, 0x4957dc)
    f174b8: r.bf(o + 0x174, 8, 4),        // -> +0x7c bits 28..31 (0x494818); no reader found in the kind-4 path
    builder: r.bf(o + 0x174, 12, 4),      // !=0 -> other point builders 0x4031a4/0x4000a4 + 0x4976fc (draw 0x495b68), NOT read
    colourA2: r.u32(o + 0x178), colourB2: r.u32(o + 0x17c),   // second colour pair -> gen+0x170/+0x174 (start 0x49a3c4)
    width: pairF(r, o + 0x180), widthRate: pairF(r, o + 0x188),     // width A and its per-step add (0x494c00, 0x4952bc)
    width2: pairF(r, o + 0x190), width2Rate: pairF(r, o + 0x198),   // width B (0x494d3c, 0x495354)
    uvRatio: pairF(r, o + 0x1a0),         // only WITHOUT an EAN (0x494868: x texture aspect -> particle +0x98), not drawn here
    colour2CurveOff: r.bf(o + 0x1a8, 0, 16),  // colour B from a colour curve (0x494a3c)
    widthCurveOff: r.bf(o + 0x1a8, 16, 16),   // width A from a float curve (0x494b3c)
    width2CurveOff: r.bf(o + 0x1ac, 0, 16),   // width B curve (0x494c74)
    noEanCurveOff: r.bf(o + 0x1ac, 16, 16),   // without an EAN only (0x4948cc, 0x495054 -> 0x406184), NOT read
    // kind 4 / 6 sub-block (+0x1b0 = 'sub' in 0x40f280 / 0x40f670 / 0x3ff864 / 0x40b660)
    angle: [pairF(r, o + 0x1b0), pairF(r, o + 0x1b8), pairF(r, o + 0x1c0)],   // euler angles, rad (0x3ff8cc)
    spin: [pairF(r, o + 0x1c8), pairF(r, o + 0x1d0), pairF(r, o + 0x1d8)],    // added to the angles each step, only
                                          //  with header +0x18 bit31 (0x3ff978, 0x3ffd74)
    axis: r.bf(o + 0x1e0, 0, 4),          // -> gen+0xe0 bits 20..23 (start 0x49a2fc): line axis, 0x875cec table
    eulerOrder: r.bf(o + 0x1e0, 4, 4),    // -> gen+0xe0 bits 16..19: euler order for 0x132ccc
    alignAxis: r.bf(o + 0x1e0, 8, 4),     // -> gen+0xe0 bits 24..27: 6 = no aim (0x402a4c); else aim along the
                                          //  velocity (0x402a3c..), NOT transcribed
    lengthCurveOff: r.bf(o + 0x1e0, 16, 16),  // length from a float curve (0x40f324)
    spinDamp: r.f32(o + 0x1e4),           // spin *= this each step (0x3ffd90 caller 0x40f768)
    length: pairF(r, o + 0x1e8), lengthRate: pairF(r, o + 0x1f0),   // (0x40f3d8, 0x40f390)
    lengthDamp: r.f32(o + 0x1f8),         // rate *= this each step (0x40f718)
    angleCurveOff: r.u32(o + 0x1fc),      // vec3 curve for the angles (0x3ff8a0 -> 0x876d54), NOT transcribed
  });
}

// Axis table 0x875cec (READ; the +X/+Y/+Z vectors are .bss constants 0xd694c8/d8/e8, values read back from the
// game's own static initialisers in unicorn: eng4_t1_axes.py). Index 6 = +Z, >= 7 = zero (0xd69498).
const AXES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1], [0, 0, 1]];
// Euler -> 3x3, row-vector (p' = p M). 0x132ccc, READ by running it in unicorn for orders 0..6 (eng4_t1_euler.py):
// 0 X*Y*Z, 1 X*Z*Y, 2 Y*X*Z, 3 Y*Z*X, 4 Z*X*Y, 5 Z*Y*X; >= 6 = identity (copy of 0xd69568).
const ORDERS = ['xyz', 'xzy', 'yxz', 'yzx', 'zxy', 'zyx'];
function eulerRows(a, order){
  const R = {
    x: (c => [[1, 0, 0], [0, Math.cos(c), Math.sin(c)], [0, -Math.sin(c), Math.cos(c)]])(a[0]),
    y: (c => [[Math.cos(c), 0, -Math.sin(c)], [0, 1, 0], [Math.sin(c), 0, Math.cos(c)]])(a[1]),
    z: (c => [[Math.cos(c), Math.sin(c), 0], [-Math.sin(c), Math.cos(c), 0], [0, 0, 1]])(a[2]),
  };
  const o = ORDERS[order];
  if (!o) return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  return mul3(mul3(R[o[0]], R[o[1]]), R[o[2]]);
}
function mul3(a, b){ return [0, 1, 2].map(i => [0, 1, 2].map(j => a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j])); }
const vrow = (v, M) => [0, 1, 2].map(j => v[0] * M[0][j] + v[1] * M[1][j] + v[2] * M[2][j]);

// ---------------------------------------------------------------------------------------------
export function initType1(fx, row, ean){
  const r = fx.efl.r;
  const gb = parseType1(r, row.gen ? row.gen.off : row.genOff + fx.efl.body);
  const em = row.emitter;
  const g = {
    type: 1, fx, row, gb, em, ean, node: fx.nodes[row.nodeIndex],
    c44: (gb.off * 7) >>> 0, c48: (gb.off * 13) >>> 0,          // RNG counters (gen+0x44 / +0x48); seeding 0x3fd4ec not read -> INFERRED
    state: 0, countdown: 0, wavesLeft: 0, frames: 0, ended: false, active: true,
    accInterval: 0, accPeriod: 0,
    particles: [], maxParticles: em ? Math.max(1, em.maxParticles) : 1,
  };
  // only kind 4 is read; the draw only runs with an EAN bound and header bit16 clear (start 0x49a354: gen+0x42 = 1)
  g.unsupported = gb.kind !== 4 ? 'line kind ' + gb.kind + ' not read'
                : gb.builder ? '+0x174 bits 12..15 builder not read'
                : (gb.w04 >>> 17) & 1 ? 'w04 bit17 draw path (0x495ba0/0x496298) not read' : null;
  g.drawable = !!ean && !gb.altDraw;                            // gen+0x42: 1 draws (0x495aa0); 0x19 / 0xc / 0x23 not read
  g.scale = em ? drawF(em.scale, rf32(g, 'c48')) : 1;           // gen+0xf0 (0x413a08)
  const curve = (off, kind) => off ? parseCurve(r, gb.off + off, kind) : null;   // offsets are from the block
  g.colourCurve = curve(gb.colourCurveOff, 'rgba');
  g.colour2Curve = curve(gb.colour2CurveOff, 'rgba');
  g.sizeCurve = curve(gb.sizeCurveOff, 'f32');
  g.animCurve = curve(gb.animCurveOff, 'f32');
  g.widthCurve = curve(gb.widthCurveOff, 'f32');
  g.width2Curve = curve(gb.width2CurveOff, 'f32');
  g.lengthCurve = curve(gb.lengthCurveOff, 'f32');
  g.countCurve = em && em.countCurveOff ? parseCurve(r, em.off + em.countCurveOff, 'u16') : null;
  g.holdCurve = row.life && row.life.holdCurveOff ? parseCurve(r, row.life.holdCurveOff, 'u16') : null;
  // Life sustain (READ 0x40500c, run at start by slot 9 0x3fd4ec -> 0x3fd4fc): gen+0x3c bit28 = life +0x0c bit0 for
  // life kinds 1, 2, 5, 6; set for every other kind. While set, a particle's hold never counts down (0x3c7e78):
  // it lives until the generator is ended with how != 0 (0x412db8 -> 0x3c8a00 clears the bit) -> endType1().
  // The spec's type-0 life lacks this path (it matters for em001_000 rows 3, 4, 5 and em001_054 row 0).
  g.sustain = [1, 2, 5, 6].includes(row.lifeKind) ? !!(row.life && row.life.curveFlag) : true;
  return g;
}

// End emission from outside (slot 11, 0x412db8 with how != 0, READ): clears the sustain bit (0x3c8a00), sets
// kill-on-end with emitter flag bit0, and stops emitting (state 5; flag bit1 re-arm only when how == 0). Who calls
// it with how != 0: the pre-update (0x400fa4 / 0x400fbc, when 0x3c7f68 returns 2 or 3) -- INFERRED to be the
// owner's stop request (e.g. the fireball shell ending); not traced further.
export function endType1(g){
  g.sustain = false;
  if (g.em && (g.em.flags & 1)) g.killOnEnd = true;
  g.state = 5; g.ended = true;
}

// Pre-update (slot 16, 0x400dc0 READ): gen+0xf4 size multiplier, gen+0xf8 = node rotation rows x scale vector
// (owner +0x1a0 vector = 1 here, x gen+0xf0 x owner+0x1b0, x node scale inst+0xe0 when node scale mode 0).
// gen+0xe4 bit 0x1000 would use the world axes instead (0x400e34); its source was not traced -> INFERRED clear.
function preUpdate(g){
  const n = g.node, W = n.world, fxs = g.fx.scale || 1;
  const s3 = g.scale * fxs;
  const mode0 = n.nb && (n.nb.scaleMode | 0) === 0;
  g.mult = mode0 && n.sizeScale ? s3 * n.sizeScale : s3;         // gen+0xf4
  const sv = [0, 1, 2].map(k => s3 * (mode0 && n.scaleVec ? n.scaleVec[k] : 1));
  g.G = [0, 1, 2].map(k => [W[4 * k] * sv[k], W[4 * k + 1] * sv[k], W[4 * k + 2] * sv[k]]);   // rows (row-vector)
}

// ---------------------------------------------------------------------------------------------
// Emission: copied from efx3u_spec.js emit() (0x4063b0 / 0x4050c0, READ).
function emit(g){
  const em = g.em, flags = em ? em.flags : 0;
  const endEmission = (how) => {
    if (flags & 1) g.killOnEnd = true;
    if ((flags & 2) && !how){ g.state = 6; return; }
    g.state = 5; g.ended = true;
  };
  if (g.row.emitMode === 1){
    switch (g.state){
      case 0: g.frames = 0; g.countdown = g.node.delay; g.state = 1;   // fallthrough
      case 1:
        if (g.countdown){ g.countdown--; return 0; }
        g.state = 3;                                                // fallthrough
      case 3: endEmission(0); g.frames++; return 1;
      case 5: g.frames++; return 0;
      case 6: g.countdown = drawU16(em.repeatDelay, ru32(g, 'c44')); g.state = 1; g.frames++; return 0;
    }
    return 0;
  }
  let count = 0;
  switch (g.state){
    case 0: g.frames = 0; g.countdown = g.node.delay; g.state = 1;     // fallthrough
    case 1:
      if (g.countdown){ g.countdown--; return 0; }
      g.wavesLeft = drawU16(em.waves, ru32(g, 'c44')); g.state = 2;   // fallthrough
    case 2: g.countdown = loadRamp(g, em.interval, em.intervalRamp, 'accInterval'); g.state = 3;  // fallthrough
    case 3: {
      count = g.countCurve ? evalCurveU16Lite(g.countCurve, curveTime(g.countCurve, g, null)) : drawU16(em.count, ru32(g, 'c44'));
      g.countdown = (g.countdown - 1) & 0xffff;
      if (g.countdown === 0) nextWave(g, endEmission);
      g.frames++; return count;
    }
    case 4:
      g.countdown = (g.countdown - 1) & 0xffff;
      if (g.countdown === 0) waveDone(g, endEmission);
      g.frames++; return 0;
    case 5: g.frames++; return 0;
    case 6: g.countdown = drawU16(em.repeatDelay, ru32(g, 'c44')); g.state = 1; g.frames++; return 0;
  }
  return 0;
}
function evalCurveU16Lite(c, t){ const k = c.keys; let i = 0; while (i + 1 < c.n && k[i + 1].t <= t) i++; return k[i] ? k[i].base : 0; } // step stand-in (INFERRED)
function loadRamp(g, pair, ramp, acc){
  if (ramp === 0) return drawU16(pair, ru32(g, 'c44'));
  const v = Math.trunc(pair.base + g[acc]);
  if (pair.base > v) return pair.base;
  if (v > pair.base + pair.range) return pair.base + pair.range;
  g[acc] = Math.fround(g[acc] + ramp);
  return v;
}
function nextWave(g, endEmission){
  const p = loadRamp(g, g.em.period, g.em.periodRamp, 'accPeriod');
  if (p){ g.countdown = p; g.state = 4; return; }
  waveDone(g, endEmission);
}
function waveDone(g, endEmission){
  if (!g.wavesLeft){ g.state = 2; return; }
  g.wavesLeft--;
  if (g.wavesLeft) g.state = 2; else endEmission(0);
}

// Base colour 0x3fdc30 (A pair gb +0x48/+0x4c) and 0x4009b0 (B pair +0x178/+0x17c): same body, READ; copied
// from spawnType0's colour block.
function baseColour(g, cA, cB){
  const cf = g.gb.colourFlags;
  if (cf & 0xf){
    if (cf & 0x10){
      const f = [0, 1, 2, 3].map(() => Math.trunc(rf32(g, 'c48') * 256));
      let o = 0; for (let s = 0; s < 4; s++) o |= (lerpRGBA(cA, cB, f[s]) & (0xff << (8 * s)));
      return o >>> 0;
    }
    return lerpRGBA(cA, cB, Math.trunc(rf32(g, 'c48') * 256));
  }
  if (cf & 0x20) return (ru32(g, 'c48') & 1) ? cA : cB;
  return cA;
}

// Texture animation config: spec spawnType0's anim block (0x405998 -> 0x97daf0 -> 0x236790), copied.
function spawnAnim(g, p){
  const gb = g.gb;
  let af = gb.animFlags;
  if (af & 0x800 && (ru32(g, 'c48') & 1)) af |= 0x200;
  if (af & 0x400 && (ru32(g, 'c48') & 1)) af |= 0x100;
  p.anim = { flags: af, seq: 0, count: 1, last: 0, frame: 0, speed: 0 };
  if (!g.ean) return;
  let start, speed = gb.animSpeed, rnd = 0;
  if (!g.animCurve){ start = drawU16(gb.animStart, ru32(g, 'c48')); }
  else {
    rnd = rf32(g, 'c48');
    if (gb.animCurveMode){ start = drawU16(gb.animStart, ru32(g, 'c48')); speed = Math.max(0, evalCurveF(g.animCurve, 0, rnd)); }
    else { start = Math.min(Math.max(evalCurveF(g.animCurve, 0, rnd), 0), gb.animMax); }
    if (!g.animCurve.once){ p.anim.curve = true; p.anim.rnd = rnd; }
  }
  const seq = drawU16(gb.animSeq, ru32(g, 'c48'));
  const s = g.ean.seqs[Math.min(seq, g.ean.seqs.length - 1)];
  p.anim.seq = seq; p.anim.count = s ? s.frames.length : 1; p.anim.last = p.anim.count - 1;
  p.anim.frame = start;
  p.anim.speed = speed - Math.trunc(speed / p.anim.count) * p.anim.count;
}
function stepAnim(g, p){                                          // 0x4003e8 -> 0x2367e8 (spec copy)
  const a = p.anim;
  if (a.curve && g.animCurve){
    const v = evalCurveF(g.animCurve, curveTime(g.animCurve, g, p), a.rnd);
    if (g.gb.animCurveMode){ a.speed = Math.max(0, v); }
    else { a.frame = Math.min(Math.max(v, 0), g.gb.animMax); return wrapFrame(a); }
  }
  if (!(a.flags & 1)) return true;
  if (a.flags & 4){
    a.frame -= a.speed;
    if (a.frame < 0){ if (a.flags & 2) a.frame += a.count; else { a.frame = 0; if (a.flags & 8) return false; } }
    return true;
  }
  a.frame += a.speed;
  if (a.frame >= a.count){ if (a.flags & 2) a.frame -= a.count; else { a.frame = a.last + 0.99999; if (a.flags & 8) return false; } }
  return true;
}
function wrapFrame(a){
  if (a.flags & 2){ if (a.frame >= a.count) a.frame -= a.count; return true; }
  if (a.frame >= a.count){ a.frame = a.last + 0.99999; return !(a.flags & 8); }
  return true;
}

// ---------------------------------------------------------------------------------------------
// Spawn one particle (0x494774 READ), in the game's order (the RNG counter gen+0x48 advances in this order).
function spawnType1(g){
  const gb = g.gb, life = g.row.life;
  const p = { age: 0, buf: 0 };
  spawnAnim(g, p);                                               // 0x405998 / 0x97daf0
  // flip / rotate bits -> particle +0x1c (0x494900..0x494940): anim 0x100 -> 0x2000, 0x200 -> 0x4000, 0x1000 -> 0x8000
  // colour A (0x494978): colour curve gb +0x40 high16 with a random byte, else 0x3fdc30
  if (g.colourCurve){
    const u = ru32(g, 'c48'); p.rndByte = (u & 0xff) || (u & 0x100);
    p.base = evalCurveRGBA(g.colourCurve, curveTime(g.colourCurve, g, p), p.rndByte);
    p.colourCurve = !g.colourCurve.once;                         // particle +0x10 0x20000
  } else p.base = baseColour(g, gb.colourA, gb.colourB);
  // colour B (0x494a30): only with +0x174 bits 0..3; curve +0x1a8 low16 or 0x4009b0; else = A (0x494b00)
  if (gb.colourGrad){
    if (g.colour2Curve){
      const u = ru32(g, 'c48'); p.rndByte2 = (u & 0xff) || (u & 0x100);
      p.base2 = evalCurveRGBA(g.colour2Curve, curveTime(g.colour2Curve, g, p), p.rndByte2);
      p.colour2Curve = !g.colour2Curve.once;                     // +0x10 0x40000
    } else p.base2 = baseColour(g, gb.colourA2, gb.colourB2);
  } else p.base2 = p.base;
  // size (0x400b80): +0x28 pair (or the +0x38 curve), rate +0x30
  if (g.sizeCurve){
    const rr = rf32(g, 'c48');
    p.size = Math.max(0, evalCurveF(g.sizeCurve, curveTime(g.sizeCurve, g, p), rr));
    if (!g.sizeCurve.once){ p.sizeCurve = true; p.sizeRate = rr; }            // +0x10 0x100000, rnd kept in +0x48
    else { p.sizeRate = drawF(gb.sizeRate, rf32(g, 'c48')); }
  } else {
    p.size = Math.max(0, drawF(gb.size, rf32(g, 'c48')));
    p.sizeRate = drawF(gb.sizeRate, rf32(g, 'c48'));
  }
  // widths (0x494b3c..0x494db0): width A = +0x180 pair (or curve +0x1a8 high16), rate +0x188; B likewise
  const width = (cv, pr, rate) => {
    if (cv){
      const rnd = rf32(g, 'c48');
      const v = Math.max(0, evalCurveF(cv, curveTime(cv, g, p), rnd));
      if (!cv.once) return { v, curve: true, rnd };                            // +0x10 0x1000000 / 0x2000000
      return { v, rate: drawF(rate, rf32(g, 'c48')) };
    }
    const v = drawF(pr, rf32(g, 'c48'));
    return { v, rate: drawF(rate, rf32(g, 'c48')) };                          // rate != 0 -> +0x10 bit0 / bit1
  };
  p.wA = width(g.widthCurve, gb.width, gb.widthRate);
  p.wB = gb.widthGrad ? width(g.width2Curve, gb.width2, gb.width2Rate) : Object.assign({}, p.wA);
  // kind init (0x403b40 -> kind 4 0x40b604 -> 0x40f280 -> 0x3ff864, then 0x40b660)
  const L = {};
  if (gb.angleCurveOff) L.unsupportedAngleCurve = true;          // 0x876d54 vec3 curve: NOT transcribed (angles = pairs)
  L.A = gb.angle.map(pr => drawF(pr, rf32(g, 'c48')));          // 0x3ff8cc..0x3ff8fc
  L.B = [0, 0, 0]; L.spinOn = false;
  if (gb.flags18hi & 0x80){                                      // gen+0x4c bit 23 (0x3ff978)
    let sgn = 1;
    if (gb.flags18hi & 1) sgn = (ru32(g, 'c48') & 1) ? -1 : 1;   // gen+0x4c bit 16 (0x3ff988)
    L.B = gb.spin.map(pr => drawF(pr, rf32(g, 'c48')) * sgn);
    L.spinOn = true;                                            // particle +0x10 0x400
  }
  if (g.lengthCurve){                                           // 0x40f324
    const rnd = rf32(g, 'c48');
    L.len = Math.max(0, evalCurveF(g.lengthCurve, curveTime(g.lengthCurve, g, p), rnd));
    if (!g.lengthCurve.once){ L.curve = true; L.rnd = rnd; }    // +0x10 0x400000
    else L.rate = drawF(gb.lengthRate, rf32(g, 'c48'));
  } else {
    L.len = drawF(gb.length, rf32(g, 'c48'));                    // 0x40f3d8
    L.rate = drawF(gb.lengthRate, rf32(g, 'c48'));               // 0x40f390; != 0 -> +0x10 0x200
  }
  p.line = L;
  // life slot (0x4033c8 -> 0x3c7a44), as the spec
  if (life){
    const w0 = drawU16(life.fadeIn, ru32(g, 'c44'));
    const w1 = g.holdCurve ? evalCurveU16Lite(g.holdCurve, curveTime(g.holdCurve, g, null)) : drawU16(life.hold, ru32(g, 'c44'));
    const w2 = drawU16(life.fadeOut, ru32(g, 'c44'));
    // sustain (0x3c7cb0 READ): slot +0xc low16 = life +0x0c high16 (sustain countdown), slot bit24 = gen+0x3c bit28
    p.life = { w0, w1, w2, counter: 0, phase: 0, value: 1, sustain: life.sustain, sustainOn: g.sustain };
    if (w0){ p.life.phase = 1; p.life.value = 1 / (w0 + 1); }
    else if (w1){ p.life.phase = 2; p.life.counter = w1; }
    else { p.life.phase = 3; p.life.counter = w2 || 1; }
  }
  // position: motion kind 0 rides the node (0x40af34). Other kinds: not handled for type 1 (none in em001) -> INFERRED.
  p.pos = xform(g.node.world, [0, 0, 0]);
  p.colour = applyEnvelope(p.base, g.row.lifeKind, p.life ? p.life.value : 1);   // x envelope 1.0 at spawn (0x494a20)
  p.colour2 = applyEnvelope(p.base2, g.row.lifeKind, p.life ? p.life.value : 1);
  setWidths(g, p);
  buildPoints(g, p);                                             // 0x40b660 with r3 = 1
  return p;
}

// Width draw values (0x494c60 / 0x4952e4): particle +0xa4 = width A x size x gen+0xf4; +0xac = width B x same.
function setWidths(g, p){
  const s = p.size * g.mult;
  p.drawWA = p.wA.v * s; p.drawWB = p.wB.v * s;
}

// Kind-4 points (0x40b660 READ): t_i = L * i / (N-1) along AXES[axis]; offset_i = (axis * t_i) * M3 with
// M3 = S(size) * E(angles, order) * G (row vectors; 0x402270 builds S*E at 0x402314..0x402494, then x gen+0xf8 at
// 0x402f24, translation zeroed 0x4030e0). size = particle +0x40 (NOT x gen+0xf4: the node scale is in G).
// The aim path (alignAxis != 6 with particle +0xc 0x80, or header +0x18 bit25) is NOT transcribed.
function buildPoints(g, p){
  const gb = g.gb, N = gb.points, L = p.line;
  const axis = AXES[gb.axis] || [0, 0, 0];
  const E = eulerRows(L.A, gb.eulerOrder);
  const M = mul3(E.map(r => r.map(v => v * p.size)), g.G);
  const step = N > 1 ? Math.fround(L.len / (N - 1)) : 0;        // vdiv s5 = len / (N-1) (0x40b798)
  p.points = [];
  for (let i = 0; i < N; i++){
    const t = Math.fround(step * i);
    p.points.push(vrow([axis[0] * t, axis[1] * t, axis[2] * t], M));
  }
}

// Kind-4 step (0x40d4c8 -> 0x40f670 READ, then 0x40b660). Returns false when the length reaches <= 0.
function stepLine(g, p){
  const L = p.line, gb = g.gb;
  if (L.curve) L.len = Math.max(0, evalCurveF(g.lengthCurve, curveTime(g.lengthCurve, g, p), L.rnd));
  else if (L.rate){
    L.len = Math.fround(L.len + L.rate);
    L.rate = Math.fround(L.rate * gb.lengthDamp);
    if (L.len <= 0) return false;                                // 0x40f734 movls r0, #0
  }
  if (L.spinOn){                                                 // 0x3ffc60: angles += spin, spin *= +0x1e4
    L.A = L.A.map((a, k) => Math.fround(a + L.B[k]));
    L.B = L.B.map(b => Math.fround(b * gb.spinDamp));
  }
  buildPoints(g, p);
  return true;
}

// One particle step: base pass (motion, life) then 0x494ff8 (anim, colours, envelope, size, widths, line).
function stepType1Particle(g, p){
  const gb = g.gb;
  p.age++;
  p.pos = xform(g.node.world, [0, 0, 0]);                        // motion kind 0 (0x40af34)
  const L = p.life;                                              // life 0x3c7d5c, READ again here WITH the sustain path
  if (L){                                                        //  (0x3c7e44, 0x3c7e78..0x3c7ee4) the spec's copy lacks
    const fadeOut = () => { if (L.w2){ L.phase = 3; L.counter = L.w2; } else L.phase = 4; };
    const sustained = () => g.sustain && L.sustainOn;            // gen+0x3c bit28 && slot +0xc bit24
    if (L.phase === 1){
      L.counter++;
      if (L.counter < L.w0) L.value = (L.counter + 1) / (L.w0 + 1);
      else {
        L.value = 1;
        if (L.w1){ L.phase = 2; L.counter = L.w1; }
        else if (sustained()){ L.phase = 2; L.counter = 1; }      // 0x3c7e44: no hold but sustained -> hold 1
        else fadeOut();
      }
      if (g.killOnEnd && L.phase <= 2) fadeOut();               // 0x3c7e18
    } else if (L.phase === 2){
      if (sustained()){                                          // 0x3c7e8c: the hold does NOT count down
        if (L.sustain){ L.sustain--; if (!L.sustain) L.counter = 0; }   // sustain countdown, then hold = 0
      } else L.counter--;
      if (!L.counter || g.killOnEnd) fadeOut();                  // 0x3c7eb4..0x3c7edc
    } else if (L.phase === 3){
      L.counter--;
      if (L.counter){ L.value = L.counter / L.w2; } else { L.value = 0; L.phase = 4; }
    }
    if (L.phase === 4) return false;
  }
  if (!stepAnim(g, p)) return false;                             // 0x495020 (particle +0xc bit27 = EAN bound)
  if (p.colourCurve) p.base = evalCurveRGBA(g.colourCurve, curveTime(g.colourCurve, g, p), p.rndByte);      // 0x4950ac
  if (p.colour2Curve) p.base2 = evalCurveRGBA(g.colour2Curve, curveTime(g.colour2Curve, g, p), p.rndByte2); // 0x495104
  if (!gb.colourGrad && !p.colour2Curve) p.base2 = p.base;
  p.colour = applyEnvelope(p.base, g.row.lifeKind, L ? L.value : 1);                                       // 0x495184
  p.colour2 = gb.colourGrad ? applyEnvelope(p.base2, g.row.lifeKind, L ? L.value : 1) : p.colour;          // 0x4951c0 / 0x4951e8
  // size (0x400cf8): curve, or rate with damping; < 0 kills
  if (p.sizeCurve) p.size = Math.max(0, evalCurveF(g.sizeCurve, curveTime(g.sizeCurve, g, p), p.sizeRate));
  else if (p.sizeRate !== 0){
    const s = Math.fround(p.size + p.sizeRate);
    p.sizeRate = Math.fround(p.sizeRate * gb.sizeDamp);
    if (s < 0){ p.size = 0; return false; }
    p.size = s;
  }
  // widths (0x495248..0x4953a0): curve (clamp >= 0) or += rate, <= 0 kills
  for (const [w, cv] of [[p.wA, g.widthCurve], [gb.widthGrad ? p.wB : null, g.width2Curve]]){
    if (!w) continue;
    if (w.curve) w.v = Math.max(0, evalCurveF(cv, curveTime(cv, g, p), w.rnd));
    else if (w.rate){ w.v = Math.fround(w.v + w.rate); if (w.v <= 0) return false; }
  }
  if (!gb.widthGrad) p.wB = Object.assign({}, p.wA);
  setWidths(g, p);
  return stepLine(g, p);                                         // tail call 0x404604 (kind 4)
}

// One generator step (slot 18 0x412aa8 -> pre-update 0x400dc0, emission, spawns, pass 0x494f18). Needs
// g.node.world for this step (the caller runs the node update first, as uEffect move 0x89ec00 does).
export function stepType1(g){
  if (g.unsupported) return false;
  preUpdate(g);
  const n = emit(g);
  for (let i = 0; i < n; i++){
    if (g.particles.length >= g.maxParticles) break;            // pool full (0x3fdfb4)
    g.particles.push(spawnType1(g));
  }
  g.particles = g.particles.filter(p => stepType1Particle(g, p));
  g.active = !(g.ended && g.particles.length === 0);            // 0x412ccc
  return g.active;
}

// ---------------------------------------------------------------------------------------------
// Draw (0x495aa0 path 0x49701c READ; shaders VS_PrimitiveGS_PlC + CAP_Polyline READ).
// Per particle (skipped when both colour alphas are 0 after x owner alpha, 0x495510 / 0x495730):
//   header record: zeros, RMode (byte 0x1c) = 10, ZOffset (+0x14) = gb +0x0c low16.
//   point i record: Position = particle pos + offset_i (0x3fe128) [+ the global offset 0xca8914+0xd18, not modelled],
//     VertexColor (+0x0c) = colour_i, TexCoord (+0x10) = UV a (texels), ZOffset/PlnWidth (+0x14/+0x16) = width_i split
//     into int-32768 and frac*65535-32768 (VS decodes (z+32768) + (w+32768)/65535, then x0.5), TexCoord1 (+0x18) = UV b,
//     RMode 0, PlnTangent (+0x1d) = normalised tangent x 127.5 (ends one-sided, middle p[i+1]-p[i-1]).
//   colour_i = A + ((B-A) * trunc(f_i*256) >> 8) per channel; width_i = wA + (wB-wA)*f_i, f_i by gradient mode
//     (0 or i==0: 0; 1: i/(N-1); 2: tent peaking at split; 3: 0 to split then ramp; 4: ramp to split then 1; else 1).
//   UV (texels, EAN frame x,y,w,h; flipU = anim 0x100, flipV = anim 0x200, rot = anim 0x1000):
//     U0,U1 = flipU ? x+w-1, x-1 : x, x+w ;  V0,V1 = flipV ? y+h-1, y-1 : y, y+h
//     plain: a = (U0, V0 + i*dV), b = (U1, same), dV = (V1-V0)/(N-1)   (V runs ALONG the line, U across)
//     rot  : a = (U1-1 + i*(U0-U1+1)/(N-1), V0), b = (U1 + i*(U0+1-U1)/(N-1), V1)
//     each accumulated in f32 and truncated to s32 (vcvt.s32.f32 0x49740c..).
//   EAN frame: nearest frame (frac >= 0.5 -> next, wrap if loop else clamp; 0x4959d4..0x495a60).
// GS (CAP_Polyline): triangle strip [0+, 0-, 1+, 1-, ...]; side_i = normalize((P_i - cameraPos) x T_i) * width_i/2;
//   '+' vertex = P + side with UV a, '-' vertex = P - side with UV b; colour bytes /256. Depth: z taken at
//   vertex + ZOffset*(-1)*cameraBack (as type 0). UV = texel / texture size, V top-down (VS stores 1 - y/H).
// Not read: fPrimStatus0/1 (perspective + textured branch assumed, as type 0), TexEnv (modulate assumed), cull.
export function buildType1Geometry(g, camera, opts = {}){
  const out = { positions: [], uvs: [], rgba: [], indices: [], drawState: drawState(g.gb.state, g.gb.w04),
                texture: g.gb.tex[0], depthShift: -g.gb.zOffset, depthShiftDir: camera.back || null,
                records: 0, emitted: 0, particles: [] };
  if (!g.drawable || g.unsupported) return out;
  const gb = g.gb, N = gb.points, ownerA = opts.ownerAlpha ?? 256;
  if (N < 2) return out;
  for (const p of g.particles){
    // colours with owner alpha (0x495714 / 0x4954fc)
    const withA = c => ((c & 0x00ffffff) | ((((c >>> 24) * ownerA) >> 8 & 0xff) << 24)) >>> 0;
    const cA = withA(p.colour), cB = gb.colourGrad ? withA(p.colour2) : cA;
    if (!(cA >>> 24) && !(cB >>> 24)) continue;
    const f = (mode, split, i) => {
      const n1 = N - 1;
      if (i === 0 || mode === 0) return 0;
      switch (mode){
        case 1: return i < n1 ? i / n1 : 1;
        case 2: if (i === n1) return 0; if (i < split) return i / split; if (i === split) return 1; return (n1 - i) / (n1 - split);
        case 3: return i <= split ? 0 : (i - split) / (n1 - split);
        case 4: return i < split ? i / split : 1;
        default: return 1;
      }
    };
    const P = p.points.map(o => [p.pos[0] + o[0], p.pos[1] + o[1], p.pos[2] + o[2]]);
    const cols = [], widths = [];
    for (let i = 0; i < N; i++){
      cols.push(gb.colourGrad ? lerpRGBA(cA, cB, Math.trunc(f(gb.colourGrad, gb.colourSplit, i) * 256)) : cA);
      widths.push(gb.widthGrad ? p.drawWA + (p.drawWB - p.drawWA) * f(gb.widthGrad, gb.widthSplit, i) : p.drawWA);
    }
    // EAN frame (nearest)
    let fr = null;
    if (g.ean){
      const sq = g.ean.seqs[Math.min(p.anim.seq, g.ean.seqs.length - 1)];
      if (sq && sq.frames.length){
        const a = p.anim; let idx = Math.trunc(a.frame);
        if ((a.flags & 1) && !(a.flags & 0x2000)){
          idx = Math.min(idx, a.last);
          const next = idx >= a.last ? ((a.flags & 2) ? 0 : a.last) : idx + 1;
          if (a.frame - idx >= 0.5) idx = next;
        }
        fr = sq.frames[Math.min(Math.max(idx, 0), sq.frames.length - 1)];
      }
    }
    const fx0 = fr ? fr.x : 0, fy0 = fr ? fr.y : 0, fw = fr ? fr.w : 1, fh = fr ? fr.h : 1;
    const flipU = p.anim.flags & 0x100, flipV = p.anim.flags & 0x200, rot = p.anim.flags & 0x1000;
    const U0 = flipU ? fx0 + fw - 1 : fx0, U1 = flipU ? fx0 - 1 : fx0 + fw;
    const V0 = flipV ? fy0 + fh - 1 : fy0, V1 = flipV ? fy0 - 1 : fy0 + fh;
    const k = Math.fround(1 / (N - 1));
    let ax, ay, bx, by, dax, day, dbx, dby;
    if (!rot){ ax = U0; ay = V0; bx = U1; by = V0; dax = 0; day = Math.fround((V1 - V0) * k); dbx = 0; dby = day; }
    else { ax = U1 - 1; ay = V0; bx = U1; by = V1; dax = Math.fround((U0 - (U1 - 1)) * k); day = 0; dbx = Math.fround((U0 + 1 - U1) * k); dby = 0; }
    const toUV = (x, y) => {
      if (opts.texSize) return [x / opts.texSize[0], y / opts.texSize[1]];
      if (fr) return [fr.u0 + (x - fr.x) * (fr.u1 - fr.u0) / (fr.w || 1), fr.v0 + (y - fr.y) * (fr.v1 - fr.v0) / (fr.h || 1)];
      return [x, y];
    };
    const base = out.positions.length / 1;
    for (let i = 0; i < N; i++){
      // tangent (0x497488..0x497560)
      let T;
      if (i === 0) T = sub(P[1], P[0]);
      else if (i === N - 1) T = sub(P[i], P[i - 1]);
      else T = add(sub(P[i + 1], P[i]), sub(P[i], P[i - 1]));
      T = norm(T).map(v => Math.trunc(v * 127.5) / 128);        // s8 bytes, VS x 1/128 (c90.z)
      // width through the record encoding (0x497450..0x497484, VS 0x01b..0x020)
      const w = widths[i], wi = Math.floor(w), wf = Math.trunc((w - wi) * 65535 - 32768);
      const half = 0.5 * ((Math.trunc(wi - 32768) + 32768) + (wf + 32768) / 65535);
      const view = camera.pos ? sub(P[i], camera.pos) : (camera.back ? camera.back.map(v => -v) : [0, 0, -1]);
      const side = norm(cross(view, T)).map(v => v * half);
      const ua = toUV(Math.trunc(ax), Math.trunc(ay)), ub = toUV(Math.trunc(bx), Math.trunc(by));
      const c = cols[i], rgba = [c & 0xff, (c >>> 8) & 0xff, (c >>> 16) & 0xff, c >>> 24];
      out.positions.push(add(P[i], side), sub(P[i], side));
      out.uvs.push(ua, ub);
      out.rgba.push(rgba, rgba);
      ax = Math.fround(ax + dax); ay = Math.fround(ay + day); bx = Math.fround(bx + dbx); by = Math.fround(by + dby);
    }
    for (let i = 0; i + 1 < N; i++){                              // strip -> triangles, one winding
      const a = base + 2 * i;
      out.indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    out.records += N + 1; out.emitted += 2 * N;
    out.particles.push({ first: base, count: 2 * N, widthA: p.drawWA, length: p.line.len, size: p.size });
  }
  return out;
}
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function norm(v){ const L = Math.hypot(v[0], v[1], v[2]); return L > 1.1920929e-7 ? v.map(x => x / L) : v; }
