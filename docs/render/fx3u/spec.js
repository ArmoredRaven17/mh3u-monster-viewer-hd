// efx3u_spec.js -- MH3U .efl (rEffectList) runtime, reference translation for the viewer.
//
// Plain functions, no three.js. Every rule below names the 3U ARM11 routine it was read from
// (exefs/code.decompressed.bin VAs). Tags: READ = the consuming instruction was read in 3U code;
// INFERRED = not read (shape of the data, a GU lead, or a viewer choice). Notes and the field tables:
// C:\MH3U-Extract\notes\effects-engine.md.
//
// Scope: generator type 0 (cParticleGeneratorBillboard, 74% of rows) end to end, at CPU level.
// The 3DS hands each live particle to the GPU as a header + sprite record pair (0x49bf00); the PICA programs
// that expand it (VS_PrimitiveGS_P + GS CAP_Primitive, 3U's LtUserShaderPackage.lfx) were disassembled on
// 2026-10-24 (eng2_pica.py), so buildType0Quads's corner/UV/roll/flip/ZOffset maths is READ; drawState() maps
// the blend byte, depth flags and alpha test (READ); nodeMatrix() follows 0x8a0ec4 (READ, tracks excepted).
//
// Units: one step = one 1/60 s game frame (uEffect move 0x89ec00 runs N whole steps per frame).
//
// Usage sketch:
//   setRandomTables(json.u32, json.f32)            // efx3u_rng.json (eng_rng_export.py)
//   const efl = parseEfl(arrayBuffer)              // 3DS LE or Wii U BE, auto-detected
//   const fx  = createEffect(efl, { ean: path => parsedEanOrNull })
//   each 1/60 s: stepEffect(fx, parentWorld4x4 | (joint) => 4x4)   // returns false when the effect has ended
//   draw: for (const g of fx.gens) if (g.type === 0) buildType0Quads(g, {right, up, back}, {texSize})
//         blend/depth/alpha test: drawState(g.gb.state, g.gb.w04)

// ---------------------------------------------------------------------------------------------
// Bytes. Wii U files are big-endian AND pack bitfields from the top bit (MSB-first). A field that
// sits at bits [lo, lo+w) of a 3DS word sits at bits [32-lo-w, 32-lo) of the Wii U word. Verified
// on: header +0x14, row words c0..c3, node +0x00/+0x04, emitter +0x0c/+0x30, type-0 +0x00/+0x18/
// +0x40/+0x50, curve headers (see notes 'Wii U'). Plain u16/u32/f32 fields are just byte-swapped.

function rd(view, be){
  return {
    be,
    u8: o => view.getUint8(o),
    u16: o => view.getUint16(o, !be),
    s16: o => view.getInt16(o, !be),
    u32: o => view.getUint32(o, !be),
    s32: o => view.getInt32(o, !be),
    f32: o => view.getFloat32(o, !be),
    // bitfield at 3DS bits [lo, lo+w) of the 32-bit word at o
    bf: (o, lo, w) => {
      const v = view.getUint32(o, !be);
      const sh = be ? 32 - lo - w : lo;
      return w >= 32 ? v : (v >>> sh) & ((1 << w) - 1);
    },
    str: (o, max = 0x40) => {
      let s = '';
      for (let i = 0; i < max; i++){ const c = view.getUint8(o + i); if (!c) break; s += String.fromCharCode(c); }
      return s;
    },
  };
}
// {base u16, range u16} pair; value = base + rnd % (range + 1)   (0xa00630, READ)
function bitrev32(v){ let o = 0; for (let i = 0; i < 32; i++) if (v & (1 << i)) o |= 1 << (31 - i); return o >>> 0; }
const pairU16 = (r, o) => ({ base: r.u16(o), range: r.u16(o + 2) });
// {base f32, range f32} pair; value = base + range * frand        (vmla pattern, READ at each site)
const pairF = (r, o) => ({ base: r.f32(o), range: r.f32(o + 4) });

// ---------------------------------------------------------------------------------------------
// Random tables. Every draw site does table[(++counter) & 0xfff], the counter advancing whether or
// not the value is used (READ: 0xa00630 callers, 0x3c7a1c, 0x49b754.., 0x291f58..). Two tables in
// .data: u32 at 0xca056c, f32 in [0,1) at 0xca456c (static; exported by eng_rng_export.py).
let RNG_U32 = null, RNG_F32 = null;
export function setRandomTables(u32, f32){ RNG_U32 = Uint32Array.from(u32); RNG_F32 = Float32Array.from(f32); }
function ru32(st, key){ st[key] = (st[key] + 1) >>> 0; return RNG_U32 ? RNG_U32[st[key] & 0xfff] : (Math.random() * 4294967296) >>> 0; }
function rf32(st, key){ st[key] = (st[key] + 1) >>> 0; return RNG_F32 ? RNG_F32[st[key] & 0xfff] : Math.random(); }
const drawU16 = (pair, rnd) => pair.range ? pair.base + (rnd % (pair.range + 1)) : pair.base;   // 0xa00630 READ
const drawF = (pair, f) => Math.fround(pair.base + Math.fround(pair.range * f));

// ---------------------------------------------------------------------------------------------
// .efl (rEffectList::load 0x255c88, resource pass 0x255a5c, generator bind 0x3c7844 / 0x3fe730)

export function parseEfl(buf){
  const view = new DataView(buf instanceof ArrayBuffer ? buf : buf.buffer, buf.byteOffset || 0, buf.byteLength);
  const m0 = view.getUint32(0, true);
  let be;
  if (m0 === 0x004c4645) be = false;                 // 'EFL\0' little-endian (3DS 0x30110616)
  else if (m0 === 0x45464c00) be = true;             // big-endian (Wii U 0x30120306)
  else throw new Error('not an EFL');
  const r = rd(view, be);
  const B = 0x30;                                   // body = file + 0x30 (READ 0x255c88)
  const hdr = {
    version: r.u32(4), bodySize: r.u32(8), rate: r.f32(0xc),          // +0xc -> rl+0x60 (60.0 in every file)
    rowCount: r.u16(0x10), nodeCount: r.u16(0x12),                    // -> rl+0x70 / rl+0x72 (READ)
    flags: [r.bf(0x14, 0, 4), r.bf(0x14, 4, 4), r.bf(0x14, 8, 4)],    // -> rl+0x78 (READ 0x255d38..)
    w20: r.u32(0x20), w24: r.u32(0x24), w28: r.u32(0x28), boundsOff: r.u32(0x2c),
  };
  const rows = [];
  for (let i = 0; i < hdr.rowCount; i++){
    const o = B + 16 * i;
    const row = {
      index: i,
      nodeIndex: r.bf(o, 0, 8), emitterOff: r.bf(o, 8, 24),           // c0 (READ 0x3c7864 / 0x3c788c)
      type: r.bf(o + 4, 0, 8), genOff: r.bf(o + 4, 8, 24),             // c1 (READ 0x3fe758, factory 0x8a0924)
      emitMode: r.bf(o + 8, 0, 4), lifeKind: r.bf(o + 8, 4, 4), lifeOff: r.bf(o + 8, 8, 24),   // c2 (READ 0x3c78a4, 0x3fe7a8)
      motionKind: r.bf(o + 12, 0, 4), variant: r.bf(o + 12, 4, 4), motionOff: r.bf(o + 12, 8, 24), // c3 (READ 0x3fe7c0; variant !=0 -> Lite class, 0x8a09f4)
    };
    row.emitter = row.emitterOff ? parseEmitter(r, B + row.emitterOff) : null;
    row.life = row.lifeOff ? parseLife(r, B + row.lifeOff) : null;
    row.motion = row.motionOff ? parseMotion(r, B + row.motionOff, row.motionKind) : null;
    row.gen = row.genOff ? parseGenerator(r, B + row.genOff, row.type) : null;
    rows.push(row);
  }
  // node table: u32 offsets at body + rowCount*16 (READ: rl+0x76 = rows<<4 at 0x255d78; 0x2910c0)
  const nodes = [];
  for (let i = 0; i < hdr.nodeCount; i++) nodes.push(parseNode(r, B + r.u32(B + hdr.rowCount * 16 + 4 * i)));
  return { be, hdr, rows, nodes, view, r, body: B };
}

// Emitter block (row c0, 0xc0 bytes, generator +0x2c). Offsets READ where an address is given.
export function parseEmitter(r, o){
  return {
    off: o,
    w00: r.u32(o), w04: r.u32(o + 4),
    flags: r.u32(o + 8),               // -> gen+0x84 (0x3c8a90). bit0 kill-on-end (0x412dc8), bit1 re-arm/loop (0x412ddc),
                                       //    bit2 no volume thinning (0x405210), bit9 random wave count (0x40518c)
    maxParticles: r.bf(o + 0xc, 0, 16),// -> gen+0xc8 pool size (0x3fe7f0), cut by volume 5/16 or 9/16 (0x3fe818..)
    c0e: r.bf(o + 0xc, 16, 8), c0f: r.bf(o + 0xc, 24, 8),
    nib30: [r.bf(o + 0x30, 0, 4), r.bf(o + 0x30, 4, 4)],               // -> gen+0xe0 bits (0x413ad0)
    scale: pairF(r, o + 0x40),         // gen+0xf0 = base + range*frand: particle size multiplier (0x413a08)
    count: pairU16(r, o + 0x48),       // particles per wave-frame (0x405238)
    waves: pairU16(r, o + 0x4c),       // number of waves, 0 = forever (0x40516c -> gen+0x1a2)
    interval: pairU16(r, o + 0x50),    // frames a wave lasts, emitting `count` each frame (0x3fdb34)
    period: pairU16(r, o + 0x54),      // pause after a wave (0x4008bc)
    intervalRamp: r.f32(o + 0x58),     // !=0: interval = base + accumulated ramp, clamped to [base, base+range] (0x3fdb7c)
    periodRamp: r.f32(o + 0x5c),       // same for the period (0x400904)
    w78: r.u32(o + 0x78),              // bytes -> gen+0xde/+0xdf/+0xe0 (0x413aac)
    shape: r.u32(o + 0x7c) & 0xff,     // emitter shape 0..4, used only when the list entry +0x1c is set (0x400968) -- INFERRED rarely live
    f80: r.f32(o + 0x80),
    f88: pairF(r, o + 0x88), f90: pairF(r, o + 0x90), f98: pairF(r, o + 0x98),  // -> gen+0x158/+0x15c/+0x160 (0x413a28..) meaning INFERRED
    wa0: r.u16(o + 0xa0),              // -> gen+0xdc (0x413aa4)
    repeatDelay: pairU16(r, o + 0xac), // state 6 re-arm delay (0x40645c / 0x40539c)
    countCurveOff: r.u16(o + 0xb4),    // count from a u16 curve when gen+0xc bit9 (0x4051d4); relative to this block
    stripPath: r.bf(o + 0xb8, 0, 16),  // rEffectStrip path offset (survey; none shipped)
  };
}

// Node block (node table entry, 0x70 bytes; node instance +0x104). READ 0x2910c0 / 0x290eac / 0x291d80.
export function parseNode(r, o){
  return {
    off: o,
    eulerOrder: r.bf(o, 8, 4),         // -> inst+0x10c bits 8..11 (0x291ed0)
    f0: [r.bf(o, 0, 8), r.bf(o, 12, 4), r.bf(o, 16, 4), r.bf(o, 20, 4), r.bf(o, 24, 4), r.bf(o, 28, 4)], // -> inst+0x10c bits 12..31 (0x291ee8, 0x292100..)
    f4: r.be ? bitrev32(r.u32(o + 4)) : r.u32(o + 4),   // 1-bit flags (Wii U mirrored) -> inst+0x110 (0x292168..); bit2 -> inst+0x10c bit1 (0x291114)
    scale: [pairF(r, o + 8), pairF(r, o + 0x10), pairF(r, o + 0x18)],  // inst+0xf0..+0xf8 (0x29223c)
    v20: [r.f32(o + 0x20), r.f32(o + 0x24), r.f32(o + 0x28)], w2c: r.s32(o + 0x2c),   // -> inst+0x80..+0x8c
    quat: [r.f32(o + 0x30), r.f32(o + 0x34), r.f32(o + 0x38), r.f32(o + 0x3c)],      // -> inst+0x90 (0x292080)
    v40: [r.f32(o + 0x40), r.f32(o + 0x44), r.f32(o + 0x48)],                       // -> inst+0xa0 (0x2920a0)
    v4c: [r.s32(o + 0x4c), r.f32(o + 0x50), r.f32(o + 0x54), r.f32(o + 0x58), r.f32(o + 0x5c)], // -> inst+0xac..+0xbc
    // 2026-10-24 (eng2): the node holds TWO transform sets, both READ in uEffect vt+0xe8 = 0x8a0ec4.
    //  A (primary, -> inst+0x00 world matrix): local position +0x20..+0x28 (0x291140 copies inst+0x80 as the
    //    translation), parent joint +0x2c (s32; <0 = the effect's own world, getter vt+0xec 0xa39398), rotation
    //    quaternion +0x30. Rotation mode = node +0x00 bits 16..19, parent-scale mode = bits 20..23.
    //  B (secondary, -> inst+0x40; built only with flag +0x04 bit4, else a copy of A): position +0x40, joint
    //    +0x4c (getter vt+0xf0 0xa39434), quaternion +0x50 (0x29138c); modes = bits 24..27 / 28..31.
    pos: [r.f32(o + 0x20), r.f32(o + 0x24), r.f32(o + 0x28)],                       // A position (was +0x40 before: wrong)
    joint: r.s32(o + 0x2c),
    rotMode: r.bf(o, 16, 4), scaleMode: r.bf(o, 20, 4),
    pos2: [r.f32(o + 0x40), r.f32(o + 0x44), r.f32(o + 0x48)], joint2: r.s32(o + 0x4c),
    quat2: [r.f32(o + 0x50), r.f32(o + 0x54), r.f32(o + 0x58), r.f32(o + 0x5c)],
    rotMode2: r.bf(o, 24, 4), scaleMode2: r.bf(o, 28, 4),
    seed: r.s32(o + 0x60),             // <0: draw one (0x290f94)
    delay: pairU16(r, o + 0x64),       // start delay -> inst+0x11c (+ owner+0x1b8 low16) (0x2923b0)
    scaleTrack: r.u16(o + 0x68), transTrack: r.u16(o + 0x6a),
    rotTrack: r.u16(o + 0x6c), rotMotion: r.u16(o + 0x6e),               // sub-block offsets (0x290eac)
  };
}

// Life block (row c2, 16 bytes, generator +0x34). READ 0x3c7a44 (init), 0x3c7d5c (step).
export function parseLife(r, o){
  return {
    fadeIn: pairU16(r, o), hold: pairU16(r, o + 4), fadeOut: pairU16(r, o + 8),
    curveFlag: r.bf(o + 0xc, 0, 1),
    holdCurveOff: r.bf(o + 0xc, 1, 15) ? o + r.bf(o + 0xc, 1, 15) : 0, // hold from a u16 curve (0x3c7a98)
    sustain: r.bf(o + 0xc, 16, 16),                                     // -> slot+0xc (0x3c7cb0)
  };
}

// Motion block (row c3, generator +0x38). Fields READ in the kind 1/2/... slot init 0x403bb0..0x4040d4
// and per-frame step 0x404b50; meaning of the angle block is INFERRED (vmla triples into 0x3fd608).
export function parseMotion(r, o, kind){
  return {
    kind, off: o,
    flags: r.u32(o),                    // bit 0x28 -> slot+0x44 0x300/0x100, 0x20 -> countdown (0x403c04)
    w04: r.u32(o + 4),
    angle: [pairF(r, o + 0x10), pairF(r, o + 0x18), pairF(r, o + 0x20)],   // launch angles (rad) -> direction, INFERRED
    speed: pairF(r, o + 0x28),          // slot+0x20 initial speed (0x403fac)
    gravity: pairF(r, o + 0x30),        // slot+0x28 per-frame gravity increment x owner+0x1bc (0x403fd0)
    speedCurveOff: r.bf(o + 0x38, 16, 16),   // slot+0x20 from a float curve (0x403f60)
    gravityCurveOff: r.bf(o + 0x3c, 0, 16),                 // slot+0x2c from a curve (0x404004)
    drag: pairF(r, o + 0x40),           // slot+0x24 multiplier on speed and velocity each frame (0x403fbc, 0x404eb8)
  };
}

// Generator blocks. Type 0 complete (fields named); others as raw reads with the sites in the notes.
export function parseGenerator(r, o, type){
  if (type === 0) return parseType0(r, o);
  const g = { type, off: o, header: parseGenHeader(r, o) };
  g.tex = [r.str(o + 0x70), r.str(o + 0xb0), r.str(o + 0xf0)];
  if (type === 5){ g.model = r.str(o + 0x50); g.meanOff = r.bf(o + 0x138, 0, 16); g.mean = g.meanOff ? r.str(o + g.meanOff) : ''; }
  else g.ean = r.str(o + 0x130);
  return g;
}

// Fields every generator type shares (+0x00..+0x6f). READ sites in notes 'generator header'.
function parseGenHeader(r, o){
  return {
    a: r.bf(o, 0, 8), mid: r.bf(o, 8, 16),
    state: r.bf(o, 24, 8),              // draw state index -> particle +0x18 bits 5..12 (0x49b6e0) -> sGpuParticle table (0x5843e4)
    altDraw: r.bf(o, 16, 1),            // bit16: gen+0x42 = 0x18 -> draw 0x49cb1c instead of 0x49bf00 (0x4003c0)
    w04: r.u32(o + 4),                  // plain u32 (Wii U byte-swapped, same value: census eng2_w04.mjs) -> gen+0x88 (0x3c8bc4)
    pivot: (r.u32(o + 4) >>> 16) & 1,   // gen+0x88 bit16: header record carries (spriteW, spriteH, 1.0) = pivot mode (0x49bfc0)
    noDepthTest: (r.u32(o + 4) >>> 7) & 1,  // -> gen+0xec bit3 (0xa0c504) -> particle +0x1c -> DS choice (0x562c50)
    depthWrite: (r.u32(o + 4) >>> 26) & 1,  // -> gen+0xec bit4 (0xa0c4ec)
    zOffset: (r.s32(o + 0xc) << 16) >> 16,      // low16 of the word -> GPU ZOffset (strh 0x49c30c)
    drawSub: r.bf(o + 0x18, 12, 4),     // -> particle +0x18 bits 26..29 (0x49b6f8)
    sizeDamp: r.f32(o + 0x1c),          // size rate *= this each frame (0x400d90)
    size: pairF(r, o + 0x28),           // initial size (0x400bb8)
    sizeRate: pairF(r, o + 0x30),       // size += rate each frame (0x400be4)
    sizeCurveOff: r.bf(o + 0x38, 16, 16),
    w3cCurveOff: r.bf(o + 0x3c, 16, 16),
    colourFlags: r.bf(o + 0x40, 0, 8),  // &0xf lerp A..B by rnd, &0x10 per channel, &0x20 pick A or B (0x3fdc30)
    animCurveMode: r.bf(o + 0x40, 8, 1),// anim curve drives speed (1) or frame (0) (0x405a90)
    colourCurveOff: r.bf(o + 0x40, 16, 16),
    animCurveOff: r.bf(o + 0x44, 0, 16),
    colourA: r.u32(o + 0x48), colourB: r.u32(o + 0x4c),   // u32 RGBA words, A = >>>24 (0x3fe240, 0x49c03c)
    animFlags: r.bf(o + 0x50, 0, 16),   // bit0 play, 1 loop, 2 reverse, 3 kill at end, 0x100/0x200 flip, 0x400/0x800 random flip, 0x1000, 0x2000 no frame blend (0x405998, 0x2367e8, 0xa0b284)
    animSeq: { base: r.bf(o + 0x50, 16, 8), range: r.bf(o + 0x50, 24, 8) },  // ean sequence (0x405b98)
    animStart: pairU16(r, o + 0x54),    // start frame (0xa0be10)
    animSpeed: r.f32(o + 0x58),         // frames per step (0x405b80)
    animMax: r.f32(o + 0x5c),           // frame clamp in curve mode (0x405b50)
    spriteW: r.s32(o + 0x60), spriteH: r.s32(o + 0x64),   // pivot in texels from the frame's left / top edge, used only
                                        // when pivot (w04 bit16); READ: header record -> GS r10.xy (CAP_Primitive 0x0a7)
    w68: r.u32(o + 0x68), f6c: r.f32(o + 0x6c),
  };
}

export function parseType0(r, o){
  const g = parseGenHeader(r, o);
  return Object.assign(g, {
    type: 0, off: o,
    tex: [r.str(o + 0x70), r.str(o + 0xb0), r.str(o + 0xf0)],    // tex0 is what the sprite samples (INFERRED: 1..2 unused here)
    ean: r.str(o + 0x130),
    rot: pairF(r, o + 0x170),           // initial roll, rad (0x49b908)
    spin: pairF(r, o + 0x178),          // roll per step (0x49b898)
    ratio: pairF(r, o + 0x180),         // SprRatio (0x49b9d8); 4.4 fixed, clamped [0,15.9375]. READ in the GS: it scales
                                        // the WIDTH (quad X extent), not the height (CAP_Primitive 0x0ab/0x0b2)
    ratioRate: pairF(r, o + 0x188),     // ratio += rate each step; <0 kills the particle (0x49be90)
    spinDamp: r.f32(o + 0x190),         // spin *= this each step (0x49be50)
    spinRandomSign: r.u32(o + 0x194),   // !=0: random spin direction (0x49b8c8)
    rotCurveOff: r.u32(o + 0x198),      // roll from a float curve (0x49b820 / 0x49bdd0)
  });
}

// ---------------------------------------------------------------------------------------------
// Curves (0x8760a4 float, 0x876208 u16, 0x8766d0 colour; segment search 0x875a3c / 0x875914).
// Header bitfield: [0..7 key count][8][9 fixed colour][..][24..26 time source][27..29 interp][30 loop][31 one-shot]
// Keys: float {u32 t, f32 base, f32 range}; u16 {u32 t, u16 base, u16 range}; colour {u32 t, u32 c0, u32 c1}.
export function parseCurve(r, o, kind){
  const n = r.bf(o, 0, 8);
  const c = { n, fixed: r.bf(o, 9, 1), time: r.bf(o, 24, 3), interp: r.bf(o, 27, 3) << 29 >> 29,
              loop: r.bf(o, 30, 1), once: r.bf(o, 31, 1), keys: [] };
  const stride = kind === 'u16' ? 8 : 12;
  for (let i = 0; i < n; i++){
    const k = o + 4 + stride * i;
    if (kind === 'f32') c.keys.push({ t: r.u32(k), base: r.f32(k + 4), range: r.f32(k + 8) });
    else if (kind === 'u16') c.keys.push({ t: r.u32(k), base: r.u16(k + 4), range: r.u16(k + 6) });
    else c.keys.push({ t: r.u32(k), c0: r.u32(k + 4), c1: r.u32(k + 8) });
  }
  return c;
}
// segment search (0x875a3c READ): returns {i, f, onKey}
function segment(c, t){
  const k = c.keys, n = c.n;
  if (n < 2) return { i: 0, f: 0, onKey: true };
  const t0 = k[0].t, tl = k[n - 1].t;
  if (c.loop){
    if (t < t0) t = tl - ((t0 - t) % (tl - t0));
    else if (t > tl) t = t0 + ((t - tl) % (tl - t0));
  } else {
    if (t <= t0) return { i: 0, f: 0, onKey: true };
    if (t >= tl) return { i: n - 1, f: 0, onKey: true };
  }
  for (let i = 1; i < n; i++){
    if (t === k[i].t) return { i, f: 0, onKey: true };
    if (t < k[i].t) return { i: i - 1, f: (t - k[i - 1].t) / (k[i].t - k[i - 1].t), onKey: false };
  }
  return { i: n - 1, f: 0, onKey: true };
}
// time source (0xa1bae8 READ): 1 generator frames, 2 effect frames, 3 parent effect frames, 4 global, else particle age
export function curveTime(c, gen, p){
  switch (c.time){
    case 1: return gen.frames;
    case 2: case 3: return gen.fx.frames;
    case 4: return gen.fx.frames;          // sys+0x64 global counter -- INFERRED stand-in
    default: return p ? p.age : 0;
  }
}
export function evalCurveF(c, t, rnd){
  const s = segment(c, t), k = c.keys;
  const v = i => Math.fround(k[i].base + Math.fround(k[i].range * rnd));
  if (s.onKey) return v(s.i);
  if (c.interp === 0){                                          // linear (0x87613c READ)
    let j = s.i + 1; if (c.loop && j === c.n - 1) j = 0;        // as read: loop wraps the NEXT key at n-1
    return Math.fround(v(s.i) * (1 - s.f) + v(j) * s.f);
  }
  if (c.interp === 3) return v(s.i);                            // step
  if (c.interp === 1 || c.interp === 2) return Math.fround(v(s.i) * (1 - s.f) + v(s.i + 1) * s.f); // cubic 0x877b58/0x8771ac NOT read: linear stand-in (INFERRED)
  return 0;
}
export function evalCurveU16(c, t, rnd){
  const s = segment(c, t), k = c.keys;
  const v = i => (k[i].range ? k[i].base + (rnd % (k[i].range + 1)) : k[i].base);
  if (s.onKey || c.interp === 3) return v(s.i);
  return Math.round(v(s.i) * (1 - s.f) + v(s.i + 1) * s.f);     // INFERRED (0x876208 tail not read)
}
const lerpRGBA = (a, b, f256) => {                              // per channel a + ((b-a)*f)>>8 (0x8767c4.. READ pattern)
  let o = 0;
  for (let s = 0; s < 32; s += 8){
    const x = (a >>> s) & 0xff, y = (b >>> s) & 0xff;
    o |= ((x + (((y - x) * f256) >> 8)) & 0xff) << s;
  }
  return o >>> 0;
};
export function evalCurveRGBA(c, t, rndByte){
  const s = segment(c, t), k = c.keys;
  const key = i => c.fixed ? k[i].c0 : lerpRGBA(k[i].c0, k[i].c1, rndByte);  // non-fixed path 0x8768c8 not read: INFERRED
  if (s.onKey || c.interp === 3) return key(s.i);
  let j = s.i + 1; if (c.loop && j === c.n - 1) j = 0;
  return lerpRGBA(key(s.i), key(j), Math.floor(s.f * 256));
}

// ---------------------------------------------------------------------------------------------
// .ean (rEffectAnim, load 0x254bc8): data at +0x10 (anim+0x68). Sequence records 32 bytes:
// +0 frame-table offset (from data), +4 u16 frame count (READ 0x236790). Frame records 24 bytes:
// u16 x, y, w, h in texels (READ: the sprite draw packs x,y -> TexCoord, w>>3,h>>3 -> SprWidth/Height,
// 0x49c13c..0x49c3bc), then f32 u0, v0, u1, v1 (data; texels/texture size -- INFERRED use).
// Wii U texel numbers are for its larger textures; the float UVs are identical, so use those.
export function parseEan(buf){
  const view = new DataView(buf instanceof ArrayBuffer ? buf : buf.buffer, buf.byteOffset || 0, buf.byteLength);
  const be = view.getUint32(0, true) !== 0x004e4145;
  const r = rd(view, be);
  const D = 0x10, size = r.u32(8);
  const seqs = [];
  const nseq = r.u32(D) / 32;                                    // INFERRED: first record's offset = table size
  for (let s = 0; s < nseq; s++){
    const so = D + 32 * s, fo = D + r.u32(so), n = r.u16(so + 4);
    const frames = [];
    for (let i = 0; i < n; i++){
      const f = fo + 24 * i;
      frames.push({ x: r.u16(f), y: r.u16(f + 2), w: r.u16(f + 4), h: r.u16(f + 6),
                    u0: r.f32(f + 8), v0: r.f32(f + 12), u1: r.f32(f + 16), v1: r.f32(f + 20) });
    }
    seqs.push({ frames });
  }
  return { be, size, seqs };
}

// ---------------------------------------------------------------------------------------------
// Effect instance. createEffect mirrors uEffect start 0x89e8fc: factory 0x8a07d8 (one generator per
// enabled row), node instances 0x2910c0/0x291d80, then per generator start (vt+0x20/+0x24/+0x3c).

export function createEffect(efl, opts = {}){
  const fx = { efl, frames: 0, alive: true, nodes: [], gens: [], rngState: { c: (opts.seed >>> 0) || 0 } };
  for (let i = 0; i < efl.nodes.length; i++) fx.nodes.push(initNode(fx, efl.nodes[i], i));
  // Row gate (READ 0x89e878, the mask from 0x89f964(effect, efl, mask, -1) -> effect+0x1c8): a row plays only when
  // mask & record[0] != 0, the record being the first word of the row's emitter block (the +0x64 table's 16-byte
  // entries >> 8 are the emitter offsets). Own effects carry 0xffffffff on every row and are requested with 0xffff;
  // the shared bank (qe) gives each row one group bit, so the request's mask picks the rows. opts.mask undefined = all.
  const mask = opts.mask === undefined ? 0xffffffff : opts.mask >>> 0;
  for (const row of efl.rows){
    if (!row.gen) continue;
    if (row.emitter && !((row.emitter.w00 & mask) >>> 0)) continue;
    if (row.type !== 0){ fx.gens.push({ type: row.type, row, unsupported: true, particles: [] }); continue; }
    fx.gens.push(initType0(fx, row, opts.ean ? opts.ean(row.gen.ean) : null));
  }
  return fx;
}

// node instance init (0x291d80 READ for the fields used here)
function initNode(fx, nb, index){
  const st = { c: (nb.seed >= 0 ? nb.seed : ru32(fx.rngState, 'c') & 0xfff) };  // 0x290f94 / 0x292334..
  const scale = nb.scale.map(p => drawF(p, rf32(st, 'c')));                       // 0x29223c
  const delay = drawU16(nb.delay, ru32(st, 'c'));                                 // 0x2923b0
  return { nb, index, state: 0, countdown: 0, age: 0, delay, scale,
           local: { pos: nb.pos.slice(), quat: nb.quat.slice(), scale },
           scaleVec: scale.slice(), sizeScale: Math.max(...scale),   // inst+0xe0..+0xe8 / inst+0xfc (0x291140)
           world: null };
}
// node delay state machine (0x290fec READ): 0 load delay -> 1 count down -> 2 active (age++)
function stepNode(n){
  if (n.state === 0){ n.age = 0; n.countdown = n.delay; n.state = 1; }
  if (n.state === 1){ if (n.countdown){ n.countdown--; return; } n.state = 2; }
  n.age++;
}
// Node world matrix: uEffect vt+0xe8 = 0x8a0ec4, READ (2026-10-24, eng2). Run every step for every
// active node (uEffect move 0x89ec00), so the node FOLLOWS its parent every frame.
//   R = rotation from the quaternion inst+0x90 (0x291140: row-vector rows
//       [1-2(yy+zz), 2(xy+wz), 2(xz-wy)], [2(xy-wz), 1-2(xx+zz), 2(yz+wx)], [2(xz+wy), 2(yz-wx), 1-2(xx+yy)];
//       column-major here = the same numbers). NO scale in the matrix.
//   P = node +0x20..+0x28 (inst+0x80); x node scale (inst+0xe0) only with flag +0x04 bit5 (inst+0x110 0x800).
//   rotMode (node +0x00 bits 16..19): 3 = no parent: W = T(P) R.
//     else parent M = joint matrix of joint (+0x2c), or the effect's world when joint < 0 (0xa39398):
//     scaleMode (bits 20..23): 0 = normalise M's axes and multiply the node scale by the removed lengths
//       (inst+0xe0 *= |axis|, inst+0xfc = max) ; 2 = normalise and drop ; other = M as is.
//     position = M * P (point). rotation: rotMode 2 = R alone (no rotation inheritance);
//       other = M3x3 * R with the axes re-normalised (0x8a14b4).
//   Mirror (owner+0x118 0x4000000 & owner+0xf0 0x800000 & flag bit0): x of P negated, R mirrored, symmetric
//   joint (READ, not implemented here). Rotation tracks (+0x6c) / motion (+0x6e) not applied (0x291724 not read).
// parentWorld: column-major 4x4 for the effect, or a function (joint) -> 4x4 | null (joint < 0 -> effect world).
export function nodeMatrix(n, parentWorld){
  const nb = n.nb || {};
  const [x, y, z, w] = n.local.quat;
  const xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
  const R = [ 1 - 2 * (yy + zz), 2 * (xy + wz), 2 * (xz - wy), 0,
              2 * (xy - wz), 1 - 2 * (xx + zz), 2 * (yz + wx), 0,
              2 * (xz + wy), 2 * (yz - wx), 1 - 2 * (xx + yy), 0,
              0, 0, 0, 1 ];
  n.scaleVec = n.local.scale.slice();                              // inst+0xe0 = drawn scale x owner scale (owner = 1 here)
  let P = n.local.pos.slice();
  if ((nb.f4 >>> 5) & 1) P = P.map((v, i) => v * n.scaleVec[i]); // inst+0x110 0x800 (0x8a1260)
  const rotMode = nb.rotMode | 0, scaleMode = nb.scaleMode | 0;
  let M = typeof parentWorld === 'function' ? (parentWorld(nb.joint ?? -1) || parentWorld(-1)) : parentWorld;
  if (rotMode === 3 || !M){
    n.sizeScale = Math.max(...n.scaleVec);
    R[12] = P[0]; R[13] = P[1]; R[14] = P[2]; return R;
  }
  M = M.slice();
  if (scaleMode === 0 || scaleMode === 2){
    for (let c = 0; c < 3; c++){
      const L = Math.hypot(M[4 * c], M[4 * c + 1], M[4 * c + 2], M[4 * c + 3]);
      if (L > 1.1920929e-7){ for (let k = 0; k < 4; k++) M[4 * c + k] /= L; }    // 0x34000000 guard
      if (scaleMode === 0) n.scaleVec[c] *= L;
    }
  }
  n.sizeScale = Math.max(...n.scaleVec);                           // inst+0xfc (used when scaleMode 0, 0x400dc0)
  const pos = xform(M, P);
  let W;
  if (rotMode === 2) W = R.slice();
  else {
    W = mul4(M, R);
    for (let c = 0; c < 3; c++){
      const L = Math.hypot(W[4 * c], W[4 * c + 1], W[4 * c + 2], W[4 * c + 3]);
      if (L > 1.1920929e-7) for (let k = 0; k < 4; k++) W[4 * c + k] /= L;
    }
  }
  W[3] = W[7] = W[11] = 0; W[12] = pos[0]; W[13] = pos[1]; W[14] = pos[2]; W[15] = 1;
  return W;
}
function mul4(a, b){
  const o = new Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++)
    o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  return o;
}
const xform = (m, v) => [m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12], m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13], m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14]];

// ---------------------------------------------------------------------------------------------
// Type 0 generator

export function initType0(fx, row, ean){
  const gb = row.gen, em = row.emitter;
  const g = {
    type: 0, fx, row, gb, em, ean, node: fx.nodes[row.nodeIndex],
    c44: (gb.off * 7) >>> 0, c48: (gb.off * 13) >>> 0,          // RNG counters (gen+0x44 / +0x48); seeding 0x3fd4ec not read -> INFERRED
    state: 0, countdown: 0, wavesLeft: 0, frames: 0, ended: false, active: true,
    accInterval: 0, accPeriod: 0,
    particles: [], maxParticles: em ? Math.max(1, em.maxParticles) : 1,
  };
  g.scale = em ? drawF(em.scale, rf32(g, 'c48')) : 1;           // gen+0xf0 (0x413a08)
  g.colourCurve = gb.colourCurveOff ? parseCurve(fx.efl.r, gb.off + gb.colourCurveOff, 'rgba') : null;
  g.sizeCurve = gb.sizeCurveOff ? parseCurve(fx.efl.r, gb.off + gb.sizeCurveOff, 'f32') : null;
  g.animCurve = gb.animCurveOff ? parseCurve(fx.efl.r, gb.off + gb.animCurveOff, 'f32') : null;
  g.rotCurve = gb.rotCurveOff ? parseCurve(fx.efl.r, gb.off + gb.rotCurveOff, 'f32') : null;
  g.countCurve = em && em.countCurveOff ? parseCurve(fx.efl.r, em.off + em.countCurveOff, 'u16') : null;
  g.holdCurve = row.life && row.life.holdCurveOff ? parseCurve(fx.efl.r, row.life.holdCurveOff, 'u16') : null;
  // Life sustain (READ 0x40500c, slot 9 0x3fd4ec -> 0x3fd4fc; eng4_t1, notes 17): gen+0x3c bit28 = life +0x0c bit0 for life
  // kinds 1, 2, 5, 6, set for every other kind. While set, a particle's hold does not count down (0x3c7e78): it lives
  // until the generator is ended from outside (endEffect). The life slot 0x3c7d5c is shared by every type.
  g.sustain = [1, 2, 5, 6].includes(row.lifeKind) ? !!(row.life && row.life.curveFlag) : true;
  return g;
}

// End a generator from outside (slot 11, 0x412db8 with how != 0, READ): clears the sustain bit (0x3c8a00), sets
// kill-on-end with emitter flag bit0, stops emitting. The owner's stop (e.g. a shell ending) -- INFERRED caller.
export function endGenerator(g){
  g.sustain = false;
  if (g.em && (g.em.flags & 1)) g.killOnEnd = true;
  g.state = 5; g.ended = true;
}
export function endEffect(fx){ for (const g of fx.gens) if (!g.unsupported) (g.end || endGenerator)(g); }

// Emission: how many particles spawn this step. 0x4063b0 (mode 1) / 0x4050c0 (mode 2), READ.
// state: 0 init, 1 start delay, 2 new wave, 3 emitting, 4 period, 5 done, 6 re-arm.
function emit(g){
  const em = g.em, flags = em ? em.flags : 0;
  const endEmission = (how) => {                                 // 0x412db8 READ
    if (flags & 1) g.killOnEnd = true;                          // gen+0xc |= 0x20000000: life jumps to fade-out
    if ((flags & 2) && !how){ g.state = 6; return; }
    g.state = 5; g.ended = true;
  };
  if (g.row.emitMode === 1){                                    // ---- mode 1: one particle after the delay
    switch (g.state){
      case 0: g.frames = 0; g.countdown = g.node.delay; g.state = 1;   // fallthrough
      case 1:
        if (g.countdown){ g.countdown--; return 0; }
        g.state = 3;                                            // fallthrough
      case 3: endEmission(0); g.frames++; return 1;
      case 5: g.frames++; return 0;
      case 6: g.countdown = drawU16(em.repeatDelay, ru32(g, 'c44')); g.state = 1; g.frames++; return 0;
    }
    return 0;
  }
  let count = 0;                                                // ---- mode 2: waves
  switch (g.state){
    case 0: g.frames = 0; g.countdown = g.node.delay; g.state = 1;     // fallthrough
    case 1:
      if (g.countdown){ g.countdown--; return 0; }
      g.wavesLeft = drawU16(em.waves, ru32(g, 'c44')); g.state = 2;   // fallthrough
    case 2: g.countdown = loadRamp(g, em.interval, em.intervalRamp, 'accInterval'); g.state = 3;  // fallthrough (0x3fdb34)
    case 3: {
      count = g.countCurve ? evalCurveU16(g.countCurve, curveTime(g.countCurve, g, null), 0)
                           : drawU16(em.count, ru32(g, 'c44'));
      // particle-volume thinning (gen+0x4c top nibble = owner volume) skipped: full quality assumed (INFERRED)
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
function loadRamp(g, pair, ramp, acc){                          // 0x3fdb34 / 0x4008bc READ
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
function waveDone(g, endEmission){                              // 0x405330 READ
  if (!g.wavesLeft){ g.state = 2; return; }
  g.wavesLeft--;
  if (g.wavesLeft) g.state = 2; else endEmission(0);
}

// Spawn one type-0 particle (0x49b674 READ; colour 0x3fdc30, size 0x400b80, anim 0x405998/0x236790,
// life 0x3c7a44, motion by kind 0x400724).
function spawnType0(g, frac){
  const gb = g.gb, life = g.row.life;
  const p = { age: 0, dead: false, buf: 0 };
  // texture animation (0x405998 -> 0x13fab0 -> 0x236790)
  let af = gb.animFlags;
  if (af & 0x800 && (ru32(g, 'c48') & 1)) af |= 0x200;
  if (af & 0x400 && (ru32(g, 'c48') & 1)) af |= 0x100;
  p.anim = { flags: af, seq: 0, count: 1, last: 0, frame: 0, speed: 0 };
  if (g.ean){
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
    p.anim.speed = speed - Math.trunc(speed / p.anim.count) * p.anim.count;   // speed mod count (0x2367d0)
  }
  // base colour (0x3fdc30)
  const cf = gb.colourFlags;
  if (cf & 0xf){
    if (cf & 0x10){ const f = [0, 1, 2, 3].map(() => Math.trunc(rf32(g, 'c48') * 256));
                    p.base = 0; for (let s = 0; s < 4; s++) p.base |= (lerpRGBA(gb.colourA, gb.colourB, f[s]) & (0xff << (8 * s))); p.base >>>= 0; }
    else p.base = lerpRGBA(gb.colourA, gb.colourB, Math.trunc(rf32(g, 'c48') * 256));
  } else if (cf & 0x20) p.base = (ru32(g, 'c48') & 1) ? gb.colourA : gb.colourB;
  else p.base = gb.colourA;
  if (g.colourCurve){                                           // colour curve replaces it (0x49b740)
    const u = ru32(g, 'c48'); p.rndByte = (u & 0xff) || (u & 0x100);
    p.base = evalCurveRGBA(g.colourCurve, curveTime(g.colourCurve, g, p), p.rndByte);
    if (!g.colourCurve.once) p.colourCurve = true;
  }
  // size (0x400b80): stored size x gen+0xf4 at draw
  if (g.sizeCurve){
    const rr = rf32(g, 'c48');
    p.size = Math.max(0, evalCurveF(g.sizeCurve, 0, rr));
    if (!g.sizeCurve.once) p.sizeCurve = true;
  } else p.size = Math.max(0, drawF(gb.size, rf32(g, 'c48')));
  p.sizeRate = drawF(gb.sizeRate, rf32(g, 'c48'));
  // roll and spin (0x49b820..0x49b9c4)
  if (g.rotCurve){ p.rotRnd = rf32(g, 'c48'); p.rot = evalCurveF(g.rotCurve, 0, p.rotRnd); p.rotCurve = !g.rotCurve.once; }
  else {
    p.rot = drawF(gb.rot, rf32(g, 'c48'));
    p.spin = drawF(gb.spin, rf32(g, 'c48'));
    if (p.spin !== 0 && gb.spinRandomSign && (ru32(g, 'c48') & 1)) p.spin = -p.spin;
  }
  // ratio (SprRatio) and its rate
  p.ratio = drawF(gb.ratio, rf32(g, 'c48'));
  p.ratioRate = drawF(gb.ratioRate, rf32(g, 'c48'));
  // life slot (0x3c7a44); volume setting 2 = durations unchanged (INFERRED normal quality)
  if (life){
    const w0 = drawU16(life.fadeIn, ru32(g, 'c44'));
    const w1 = g.holdCurve ? evalCurveU16(g.holdCurve, curveTime(g.holdCurve, g, null), ru32(g, 'c44')) : drawU16(life.hold, ru32(g, 'c44'));
    const w2 = drawU16(life.fadeOut, ru32(g, 'c44'));
    p.life = { w0, w1, w2, counter: 0, phase: 0, value: 1, sustain: life.sustain, sustainOn: g.sustain };   // slot bit24 (0x3c7cb0)
    if (w0){ p.life.phase = 1; p.life.value = 1 / (w0 + 1); }
    else if (w1){ p.life.phase = 2; p.life.counter = w1; }
    else { p.life.phase = 3; p.life.counter = w2 || 1; }
  }
  // place (motion kind, 0x400724). Kind 0 = rides the node; 2/8 = launched (partly READ; see notes)
  p.pos = xform(g.node.world, [0, 0, 0]);
  if (g.row.motionKind !== 0 && g.row.motion) launch(g, p);
  p.colour = p.base;
  return p;
}

// Launch for the moving kinds (0x403bb0 READ for speed/drag/gravity; direction INFERRED).
function launch(g, p){
  const m = g.row.motion;
  const a = m.angle.map(pr => drawF(pr, rf32(g, 'c48')));
  // INFERRED: direction = rotate +Y by the three angles (euler order of the node), then the node rotation
  const [rx, ry, rz] = a;
  let d = [0, 1, 0];
  d = [d[0], d[1] * Math.cos(rx) - d[2] * Math.sin(rx), d[1] * Math.sin(rx) + d[2] * Math.cos(rx)];
  d = [d[0] * Math.cos(ry) + d[2] * Math.sin(ry), d[1], -d[0] * Math.sin(ry) + d[2] * Math.cos(ry)];
  d = [d[0] * Math.cos(rz) - d[1] * Math.sin(rz), d[0] * Math.sin(rz) + d[1] * Math.cos(rz), d[2]];
  const W = g.node.world;
  d = [W[0] * d[0] + W[4] * d[1] + W[8] * d[2], W[1] * d[0] + W[5] * d[1] + W[9] * d[2], W[2] * d[0] + W[6] * d[1] + W[10] * d[2]];
  const L = Math.hypot(d[0], d[1], d[2]) || 1; d = d.map(v => v / L);
  const speed = drawF(m.speed, rf32(g, 'c48'));
  p.mot = { speed, drag: drawF(m.drag, rf32(g, 'c48')), gInc: drawF(m.gravity, rf32(g, 'c48')) * (g.fx.scale || 1), g: 0,
            vel: d.map(v => v * speed) };
}

// One step of one particle (0x49bc14 READ, with base parts 0x4003e8, 0x3c7d5c, 0x400cf8, 0x404b50).
function stepType0Particle(g, p){
  const gb = g.gb;
  p.age++;                                                     // 0x97da24 (particle +0x14)
  // motion
  if (g.row.motionKind === 0 || !p.mot) p.pos = xform(g.node.world, [0, 0, 0]);   // kind 0 re-places on the node each step (0x40af34)
  else {                                                       // 0x404b50: pos += (vx, vy - g, vz); then damp; g += gInc
    const m = p.mot;
    p.pos = [p.pos[0] + m.vel[0], p.pos[1] + m.vel[1] - m.g, p.pos[2] + m.vel[2]];
    m.speed *= m.drag; m.vel = m.vel.map(v => v * m.drag);
    m.g += m.gInc;
  }
  // life (0x3c7d5c READ, with the sustain path 0x3c7e44 / 0x3c7e78..0x3c7ee4); killOnEnd = gen+0xc bit 29
  const L = p.life;
  if (L){
    const fadeOut = () => { if (L.w2){ L.phase = 3; L.counter = L.w2; } else L.phase = 4; };
    const sustained = () => g.sustain && L.sustainOn;              // gen+0x3c bit28 && slot +0xc bit24
    if (L.phase === 1){
      L.counter++;
      if (L.counter < L.w0) L.value = (L.counter + 1) / (L.w0 + 1);
      else {
        L.value = 1;
        if (L.w1){ L.phase = 2; L.counter = L.w1; }
        else if (sustained()){ L.phase = 2; L.counter = 1; }        // no hold but sustained -> hold 1
        else fadeOut();
      }
      if (g.killOnEnd && L.phase <= 2) fadeOut();
    } else if (L.phase === 2){
      if (sustained()){                                            // the hold does NOT count down
        if (L.sustain){ L.sustain--; if (!L.sustain) L.counter = 0; }   // sustain countdown, then hold = 0
      } else L.counter--;
      if (!L.counter || g.killOnEnd) fadeOut();
    } else if (L.phase === 3){
      L.counter--;
      if (L.counter){ L.value = L.counter / L.w2; }
      else { L.value = 0; L.phase = 4; }
    }
    if (L.phase === 4) return false;
  }
  // texture animation step (0x4003e8 -> 0x2367e8)
  if (!stepAnim(g, p)) return false;
  // colour: curve, then x envelope by life kind (0x3fe1f0: odd kinds fade alpha, even kinds fade RGB)
  if (p.colourCurve) p.base = evalCurveRGBA(g.colourCurve, curveTime(g.colourCurve, g, p), p.rndByte);
  p.colour = applyEnvelope(p.base, g.row.lifeKind, L ? L.value : 1);
  // size (0x400cf8): curve, or rate with damping; size < 0 kills
  if (p.sizeCurve) p.size = Math.max(0, evalCurveF(g.sizeCurve, curveTime(g.sizeCurve, g, p), p.sizeRate));
  else if (p.sizeRate !== 0){
    const s = p.size + p.sizeRate;
    p.sizeRate = Math.fround(p.sizeRate * gb.sizeDamp);
    if (s < 0){ p.size = 0; return false; }
    p.size = s;
  }
  // roll
  if (p.rotCurve) p.rot = evalCurveF(g.rotCurve, curveTime(g.rotCurve, g, p), p.rotRnd);
  else if (p.spin){ p.rot += p.spin; p.spin = Math.fround(p.spin * gb.spinDamp); }
  // ratio (0x49be90): <0 kills, clamp 15.9375
  if (p.ratioRate !== 0){
    const r = p.ratio + p.ratioRate;
    if (r < 0) return false;
    p.ratio = Math.min(r, 15.9375);
  }
  return true;
}
function applyEnvelope(c, kind, v){
  if (!kind) return c;
  const e = Math.trunc(v * 256);
  if (kind & 1) return ((c & 0x00ffffff) | (((((c >>> 24) * e) >> 8) & 0xff) << 24)) >>> 0;   // alpha
  let o = c & 0xff000000;
  for (let s = 0; s < 24; s += 8) o |= ((((c >>> s) & 0xff) * e) >> 8 & 0xff) << s;          // RGB
  return o >>> 0;
}
// 0x2367e8 READ (curve-driven frame 0x4003e8 READ)
function stepAnim(g, p){
  const a = p.anim;
  if (a.curve && g.animCurve){
    const v = evalCurveF(g.animCurve, curveTime(g.animCurve, g, p), a.rnd);
    if (g.gb.animCurveMode){ a.speed = Math.max(0, v); }
    else { a.frame = Math.min(Math.max(v, 0), g.gb.animMax); return wrapFrame(a); }
  }
  if (!(a.flags & 1)) return true;
  if (a.flags & 4){
    a.frame -= a.speed;
    if (a.frame < 0){
      if (a.flags & 2) a.frame += a.count;
      else { a.frame = 0; if (a.flags & 8) return false; }
    }
    return true;
  }
  a.frame += a.speed;
  if (a.frame >= a.count){
    if (a.flags & 2) a.frame -= a.count;
    else { a.frame = a.last + 0.99999; if (a.flags & 8) return false; }
  }
  return true;
}
function wrapFrame(a){
  if (a.flags & 2){ if (a.frame >= a.count) a.frame -= a.count; return true; }
  if (a.frame >= a.count){ a.frame = a.last + 0.99999; return !(a.flags & 8); }
  return true;
}

// One generator, one step: emission, spawns, particle pass (0x412aa8 READ). Returns false when done.
export function stepType0(g){
  const n = emit(g);                                          // the emitter runs its own start delay (inst+0x11c)
  for (let i = 0; i < n; i++){
    if (g.particles.length >= g.maxParticles) break;          // pool full: the spawn is dropped (0x3fdfb4 returns 0)
    g.particles.push(spawnType0(g, n ? i / n : 0));
  }
  g.particles = g.particles.filter(p => stepType0Particle(g, p));
  // generator alive while emitting or while particles live (0x412ccc READ)
  g.active = !(g.ended && g.particles.length === 0);
  return g.active;
}

// One effect step (uEffect move 0x89ec00 READ): nodes, then generators; the effect dies when no
// generator reports alive (0x89f340 -> 0x25d040).
export function stepEffect(fx, parentWorld){
  if (!fx.alive) return false;
  fx.frames++;
  for (const n of fx.nodes){ stepNode(n); n.world = nodeMatrix(n, parentWorld); }
  let live = 0;
  for (const g of fx.gens){
    if (g.unsupported) continue;
    if (!g.node.world) g.node.world = nodeMatrix(g.node, parentWorld);
    if ((g.step || stepType0)(g)) live++;                          // g.step: another type's update (type1.js ...)
  }
  if (!live) fx.alive = false;
  return fx.alive;
}

// ---------------------------------------------------------------------------------------------
// Draw (2026-10-24, eng2: READ end to end). Per live particle with alpha != 0 the CPU (0x49bf00) writes TWO
// 32-byte records into the prim buffer, 2 vertices per draw entry, prim type 4:
//   header : Position = (gen+0x60, gen+0x64, 1.0) when w04 bit16 (pivot), else all 0; byte 0x1f = 0x0a
//   sprite : Position f32x3, VertexColor u8x4, TexCoord u16x2 (frame x,y), ZOffset s16, Intensity,
//            SprScale u16 (size x 256), SprRot u16 (roll x 4096/2pi & 0xfff), SprWidth/Height u8 (frame w>>3, h>>3),
//            SprRatio u8 (ratio x 16), SprVolume u8 (bit0 = anim 0x100, bit1 = 0x200, bit2 = 0x1000)
// Prim type 4 -> input layout IAPrimitiveSpriteGs (0x5efe102a) and TPrimitive pass 10 "ParticleGS" =
// VS_PrimitiveGS_P + geometry shader CAP_Primitive (table 0xb36fa4 entries 39..47, picked at 0x2a5f3c; key
// word1 bit22 is always set by 0x49c44c, else ParticleGSNT). The programs were disassembled with eng2_pica.py
// (listing eng2_dis_PrimitiveGS_P.txt). Uniforms are uploaded w,z,y,x (every CPU vec4 is read as .wzyx);
// fPrimViewRot = (pi/2,0,0,0) (0x2a6d18 -> CB +0x90), fPrimZOffsetScale = (-prim+0xe8 = -1.0, 0,0,0) (0x2a7368).
// The VS sends the header vertex down the 'assign_vp' path (SprVolume 10 > 8); the GS keeps it in r10..r15
// (GS registers persist between invocations) and expands the next vertex into a camera-facing quad:
//   size   s = SprScale/256 ; ratio k = SprRatio/16 ; W8 = 8*SprWidth, H8 = 8*SprHeight (texels)
//   extents (texels x s): centred X in [-W8/2*k, +W8/2*k], Y in [-H8/2, +H8/2]
//            pivot      X in [-pivX*k, (W8-pivX)*k],    Y in [-(H8-pivY), +pivY]   (pivot from the frame's top-left)
//   angle  a = SprRot*2pi/4096 + pi/2 ; screen offset x' = X sin a - Y cos a, y' = X cos a + Y sin a
//            (= X cos r + Y sin r, -X sin r + Y cos r with r the roll: roll turns the sprite clockwise)
//   world  = particle + x' * cameraRight + y' * cameraUp   (columns 0,1 of fViewI)
//   depth  : z is taken at  corner + ZOffset * zScale(-1) * cameraBack  (column 2 of fViewI), x/y unchanged:
//            shipped ZOffsets are <= 0, so the depth test point is pulled |ZOffset| units toward the camera.
//   UV     : uL = x/W, uR = (x + W8 - 1)/W ; top = (y + 1)/H, bottom = (y + H8)/H   (top-down image coords)
//   corners LB, RB, LT, RT (emit order, strip) get UV (L,B) (R,B) (L,T) (R,T), then SprVolume bit0 swaps
//            L<->R, bit1 swaps B<->T, bit2 rotates the four UVs (new = [old LT, old LB, old RT, old RB]).
//   colour : VertexColor bytes 0..3 = RGBA (o1, 'color' semantic) x 1/256 (c90.y).
// Texel units are the platform's own: the Wii U EAN frames, pivots and sizes are scaled together (eng2_piv.mjs:
// EAN w x2, pivots mostly x2, sizes /2), so the same formula holds with the Wii U numbers (INFERRED for Wii U).
export function buildType0Quads(g, camera, opts = {}){
  // camera: { right:[x,y,z], up:[x,y,z], back:[x,y,z] (optional) } unit vectors in world space.
  // opts.texSize: [W, H] of the texture (texels), for the exact UV inset; else the EAN float UVs are used.
  const out = [];
  const node = g.node || {};
  let mult = g.scale * (g.fx.scale || 1);                        // gen+0xf4 = gen+0xf0 x owner+0x1b0 (x inst+0xfc if scaleMode 0)
  if (node.nb && (node.nb.scaleMode | 0) === 0 && node.sizeScale) mult *= node.sizeScale;
  const R = camera.right, U = camera.up;
  const B = camera.back || [R[1] * U[2] - R[2] * U[1], R[2] * U[0] - R[0] * U[2], R[0] * U[1] - R[1] * U[0]];
  const ds = drawState(g.gb.state, g.gb.w04);
  for (const p of g.particles){
    const a = p.colour >>> 24;
    if (!a) continue;                                            // 0x49c04c READ
    const sprScale = Math.min(0xffff, Math.trunc(p.size * mult * 256)) / 256;          // u16 (0x49c31c)
    const k = Math.min(255, Math.max(0, Math.trunc(p.ratio * 16))) / 16;               // u8 (0x49c3a4)
    const rot = ((Math.trunc(p.rot * 651.8986) & 0xfff) * 2 * Math.PI) / 4096;        // u16 & 0xfff, c90.z
    let fr = null;                                               // frame: 0xa0b284 index, ean record 0x49c13c
    if (g.ean){
      const sq = g.ean.seqs[Math.min(p.anim.seq, g.ean.seqs.length - 1)];
      if (sq && sq.frames.length) fr = sq.frames[Math.min(Math.floor(p.anim.frame), sq.frames.length - 1)];
    }
    const fw = fr ? fr.w : (opts.texSize ? opts.texSize[0] : 64), fh = fr ? fr.h : (opts.texSize ? opts.texSize[1] : 64);
    const W8 = (fw >> 3) << 3, H8 = (fh >> 3) << 3;
    let xL, xR, yB, yT;
    if (g.gb.pivot){ xL = -g.gb.spriteW; xR = W8 - g.gb.spriteW; yB = -(H8 - g.gb.spriteH); yT = g.gb.spriteH; }
    else { xL = -W8 / 2; xR = W8 / 2; yB = -H8 / 2; yT = H8 / 2; }
    xL *= sprScale * k; xR *= sprScale * k; yB *= sprScale; yT *= sprScale;
    const c = Math.cos(rot), s = Math.sin(rot);
    const P = p.pos;
    const corner = (X, Y) => { const xs = X * c + Y * s, ys = -X * s + Y * c;
      return [P[0] + xs * R[0] + ys * U[0], P[1] + xs * R[1] + ys * U[1], P[2] + xs * R[2] + ys * U[2]]; };
    let uL, uR, vT, vB;                                          // top-down image coordinates
    if (fr && opts.texSize){ const [TW, TH] = opts.texSize; uL = fr.x / TW; uR = (fr.x + W8 - 1) / TW; vT = (fr.y + 1) / TH; vB = (fr.y + H8) / TH; }
    else if (fr){ const du = (fr.u1 - fr.u0) / (fr.w || 1), dv = (fr.v1 - fr.v0) / (fr.h || 1);
      uL = fr.u0; uR = fr.u0 + du * (W8 - 1); vT = fr.v0 + dv; vB = fr.v0 + dv * H8; }
    else { uL = 0; uR = 1; vT = 0; vB = 1; }
    let uv = [[uL, vB], [uR, vB], [uL, vT], [uR, vT]];            // LB, RB, LT, RT
    const vol = ((p.anim.flags >> 8) & 1) | (((p.anim.flags >> 9) & 1) << 1) | (((p.anim.flags >> 12) & 1) << 2);
    if (vol & 1) uv = [uv[1], uv[0], uv[3], uv[2]];               // GS 0x06a
    if (vol & 2) uv = [uv[2], uv[3], uv[0], uv[1]];               // GS 0x072
    if (vol & 4) uv = [uv[2], uv[0], uv[3], uv[1]];               // GS 0x079
    const LB = corner(xL, yB), RB = corner(xR, yB), LT = corner(xL, yT), RT = corner(xR, yT);
    out.push({
      corners: [LT, RT, RB, LB],                                  // fan TL, TR, BR, BL (GS strip order LB, RB, LT, RT)
      uvs: [uv[2], uv[3], uv[1], uv[0]],
      rgba: [p.colour & 0xff, (p.colour >>> 8) & 0xff, (p.colour >>> 16) & 0xff, a],
      depthShift: -g.gb.zOffset,                                  // world units toward the camera, depth test only
      depthShiftDir: B,
      state: g.gb.state, drawState: ds, zOffset: g.gb.zOffset, texture: g.gb.tex[0],
    });
  }
  return out;
}

// Draw state of a generator: blend from gb +0x00 bits 24..31, depth from gb +0x04, alpha test fixed.
// Blend (READ): the state byte rides in the particle key (bits 5..12, 0x49b704) and indexes a 32-entry table
// of MFX record words copied from .rodata 0xb3bf68 by the constructor 0x236738 of the sub-object at prim+0x48
// (memcpy 0x80; the only literal refs to 0xb3bf68 are 0x236764 and 0xa0b274, a getter). 0x5843e4 makes the
// entry the current blend state (ctx+0x178 = ctx+0x228[word & 0xfff]); indices > 0x20 fall back to 1.
// The BS records are decoded as nDraw::BlendState's constructor 0x565ed8 reads them (MFX class 5, factory
// jump 0x990980; DS = class 6 -> 0x572fcc and RS = class 7 -> 0x57214c as positive controls):
// w0 = rec+0x14: bits 9..16 RGB src, 17..24 RGB dst, 25..27 RGB equation (PICA value as is);
// w1 = rec+0x18: bits 0..7 alpha src, 8..15 alpha dst, 16..18 alpha equation; factors through .rodata 0xb3c634
// (game enum -> PICA). PICA enums from 3dbrew GPU registers (0x101 BLEND_FUNC). Positive control: BSBlendMinAlpha
// eq 3 (MIN), BSBlendMaxAlpha eq 4 (MAX).
// Depth (READ 0x562c48..0x562d48, same at 0x562ed4): particle +0x1c bit3 = no depth test, bit4 = depth write
// -> DSZTestWrite / DSZTest / DSZWrite / DSDefault. Bit3 <- gb +0x04 bit7, bit4 <- gb +0x04 bit26 (0xa0c4c0).
// Shipped type 0: 5425 rows test-no-write, 26 rows (w04 0x80) no test.
// Alpha test (READ 0x2a5da4): enabled, func 4 (GREATER, game enum), ref = u8(prim+0xd0 x 255) = u8(0.001 x 255)
// = 0 -> fragments with alpha 0 are discarded (prim+0xd0 = 0.001 from the ctor 0x2a7b3c).
// Cull: not read (the GS emits the strip's second triangle with the winding flag set, so both face the same way).
const PICA_FACTOR = ['zero', 'one', 'srcColor', 'oneMinusSrcColor', 'dstColor', 'oneMinusDstColor', 'srcAlpha',
  'oneMinusSrcAlpha', 'dstAlpha', 'oneMinusDstAlpha', 'constantColor', 'oneMinusConstantColor', 'constantAlpha',
  'oneMinusConstantAlpha', 'srcAlphaSaturate'];
const PICA_EQ = ['add', 'subtract', 'reverseSubtract', 'min', 'max'];
const GAME_TO_PICA = [0, 1, 2, 3, 6, 7, 8, 9, 4, 5, 14, 10, 11];          // .rodata 0xb3c634
// [name, w0, w1] of the first 13 records in table 0xb3bf68, words read from LtUserShaderPackage.lfx (mh3u_mrl.rec_words)
const STATE_BS = [
  ['BSBlendAddAlpha', 0x00020802, 0x00104], ['BSBlendBlendAlpha', 0x000a0802, 0x00504],
  ['BSBlendAddColor', 0x00020402, 0x00104], ['BSBlendBlendColor', 0x000a0402, 0x00504],
  ['BSBlendAdd', 0x00020202, 0x00101], ['BSBlendRevSubAlpha', 0x04020802, 0x20104],
  ['BSBlendRevSubBlendAlpha', 0x040a0802, 0x20504], ['BSBlendRevSubColor', 0x04020402, 0x20104],
  ['BSBlendRevSubBlendColor', 0x040a0402, 0x20504], ['BSBlendRevSub', 0x04020202, 0x20101],
  ['BSBlendMinAlpha', 0x06020802, 0x30104], ['BSBlendMaxAlpha', 0x08020802, 0x40104],
  ['BSBlendAddDestColor', 0x00021002, 0x00106],
];
export const BLEND_STATE_NAMES = ['BSBlendAddAlpha', 'BSBlendBlendAlpha', 'BSBlendAddColor', 'BSBlendBlendColor',
  'BSBlendAdd', 'BSBlendRevSubAlpha', 'BSBlendRevSubBlendAlpha', 'BSBlendRevSubColor', 'BSBlendRevSubBlendColor',
  'BSBlendRevSub', 'BSBlendMinAlpha', 'BSBlendMaxAlpha', 'BSBlendAddDestColor', 'BSBlendBlendAddDestColor',
  'BSBlendAddDestColor', 'BSBlendBlendAddDestAlpha', 'BSBlendAddAlphaRGB', 'BSBlendBlendAlphaRGB',
  'BSBlendAddColorRGB', 'BSBlendBlendColorRGB', 'BSBlendAddRGB', 'BSBlendRevSubAlphaRGB', 'BSBlendRevSubBlendAlphaRGB',
  'BSBlendRevSubColorRGB', 'BSBlendRevSubBlendColorRGB', 'BSBlendRevSubRGB', 'BSBlendMinAlphaRGB', 'BSBlendMaxAlphaRGB',
  'BSBlendAddDestColorRGB', 'BSBlendBlendAddDestColorRGB', 'BSBlendAddDestColorRGB', 'BSBlendBlendAddDestAlphaRGB'];
export function decodeBlendRecord(w0, w1){
  const f = e => PICA_FACTOR[GAME_TO_PICA[e] ?? 0];
  return { src: f((w0 >>> 9) & 0xff), dst: f((w0 >>> 17) & 0xff), eq: PICA_EQ[(w0 >>> 25) & 7],
           srcAlpha: f(w1 & 0xff), dstAlpha: f((w1 >>> 8) & 0xff), eqAlpha: PICA_EQ[(w1 >>> 16) & 7] };
}
export function drawState(stateByte, w04 = 0){
  const idx = stateByte > 0x20 ? 1 : stateByte;                  // 0x58440c
  const e = STATE_BS[idx];
  const blend = e ? Object.assign({ name: e[0] }, decodeBlendRecord(e[1], e[2]))
                  : { name: BLEND_STATE_NAMES[idx] || null };    // records 13..31 not transcribed (no shipped type-0 use)
  return { blend, depthTest: !((w04 >>> 7) & 1), depthWrite: !!((w04 >>> 26) & 1),
           alphaTest: { func: 'greater', ref: 0 } };
}
