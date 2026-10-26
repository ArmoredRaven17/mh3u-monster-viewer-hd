// THE SEVERED PIECE, as MH3U (3DS) moves it -- 3U's own code, notes\sever-em001.md. No GU value is used.
//
// The piece (uEnemyOption, DTI 0xd531c0, vtable 0xb51a94, ctor 0xa0ff40, size 0xea8) exists from spawn, attached to the
// monster; the class's on-action-set hook (slot 52) calls the sever 0x82888c(e, rec 0, 0) on the tail reaction, and the
// shared per-frame updater 0x828ee8 moves sever record n (info + 0x400 + 0xb0 n). The piece's own move (slot 9 0x2abc3c)
// just copies the record's matrix (rec+0x40) and position (rec+0x70) once the record state is >= 2.
//
//   cut (0x82888c): G = monster position info+0x38 + (0, height x S, 0)   [S = info+0x90 x info+0x94, the model scale]
//   state 0 -> 1 on the next update (sever bit set), 1 -> 2 on the one after: SPAWN (0x82e008)
//     P0 = J - (t . Mj)           J, Mj: the monster joint's world matrix (0xa07d48(e, joint)), t: the PIECE's joint +0x78
//                                 (that joint's local translation; INFERRED field meaning), row-vector x 3x3 (0x586abc)
//     R0 = Mj's rotation (x S)    for this one tick the piece is drawn in the joint's orientation
//     V  = (dx / N, dy / N - g / 2 x N, dz / N), d = G - P0;  A = (0, g, 0);  base angles (0, yaw = info+0x84, 0)
//   each later tick, h = 0.5 x [e+0x14] (the frame delta; 2 per 30 fps tick INFERRED, so h = 1):
//     t += h; angles = base + spin curves(t) (0x82ba40, degrees x 182.044 + 0.5, truncated, u16)
//     t >= N: LAND (state 3): P = G, landing effect, then (next tick) a carve point; the piece stays, yaw only (spin ends at 720)
//     else:   P += V h; V += A h   (explicit Euler, position first)
//   rotation = Ry(yaw) Rx(ax) Rz(az) (0x58601c: Z, then X, then Y onto identity) = three.js Euler(ax, ay, az, 'YXZ');
//   the piece's scale is the monster's (piece +0x60 = enemy +0x60).
// Units: game units (the viewer's scene x 100). Angles: u16, 0x10000 = 360 degrees. Water mode (rec+7 == 1, when
// info+0xdc == 2 at the cut) is not modelled here: it doubles N and eases toward G with a bob (0x8508e4, 0x82944c).

const F = Math.fround;
const DEG2U16 = F(182.044449);            // 0x43360b61 (0x82bab8)
const U16 = 2 * Math.PI / 65536;

// The spin curves (0x58493c): (t, deg) rows, ended by a row with t < 0 whose value holds after the last key.
function evalCurve(c, x){
  for (let i = 0; i < c.length; i++){
    const [ti, vi] = c[i];
    if (!(ti >= 0)) return vi;
    if (x >= ti){
      const [tn, vn] = c[i + 1];
      if (tn >= x) return F(vi + F(F(vn - vi) * F(F(x - ti) / F(tn - ti))));
    }
  }
  return c[c.length - 1][1];
}
const spinU16 = (c, t) => c ? (Math.trunc(F(F(evalCurve(c, t) * DEG2U16) + 0.5)) & 0xffff) : 0;

// Ry(y) Rx(x) Rz(z) as a quaternion [x, y, z, w]
function quatYXZ(ax, ay, az){
  const cx = Math.cos(ax / 2), sx = Math.sin(ax / 2), cy = Math.cos(ay / 2), sy = Math.sin(ay / 2);
  const cz = Math.cos(az / 2), sz = Math.sin(az / 2);
  return [sx * cy * cz + cx * sy * sz, cx * sy * cz - sx * cy * sz, cx * cy * sz - sx * sy * cz, cx * cy * cz + sx * sy * sz];
}
// rotate a vector by a unit quaternion
function qrot(q, v){
  const [x, y, z, w] = q, [vx, vy, vz] = v;
  const tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx);
  return [vx + w * tx + y * tz - z * ty, vy + w * ty + z * tx - x * tz, vz + w * tz + x * ty - y * tx];
}

// Per monster: the record 0x828ee8 uses (static table 0xc1c008 -> 0xa33b50: +0x94 joint row, +0x98[0] record, +0x9c
// landing scale), the piece file the class loads, and the tail reaction that cuts (cat 10, id -> table -> motions).
// spin = [x, y, z] curves, degrees over t (READ data). All READ unless the note says otherwise.
const RATH_SPIN = [[[0, 0], [24, 720], [-1, 720]], [[0, 0], [24, 0], [-1, 0]], [[0, 0], [24, 0], [-1, 0]]];
const DIA_SPIN = [[[0, 0], [36, 720], [-1, 720]], [[0, 0], [36, 0], [-1, 0]], [[0, 0], [36, 0], [-1, 0]]];
const uEm002 = (piece, frames) => ({ piece, joint: 143, frames, gravity: -3, height: 20, spin: RATH_SPIN, fxScale: 0.35,
                                    react: [10, 0xca], motions: [120] });
export const SEVER_3U = {
  em001: uEm002('em001_tail', 28),
  em002: uEm002('em002_tail', 24),
  em062: uEm002('em062_tail', 28),
  em063: uEm002('em063_tail', 28),
  em064: uEm002('em064_tail', 24),
  em065: uEm002('em065_tail', 24),
  // uEm005: the same table player row (10, 0xca) -> motion 120; piece path from the format 'enemy\%s\mod\%s_tail' (0x6b5fb5)
  em005: { piece: 'em005_tail', joint: 143, frames: 36, gravity: F(-10 / 3), height: 20, spin: DIA_SPIN, fxScale: 0.35,
           react: [10, 0xca], motions: [120] },
  em053: { piece: 'em053_tail', joint: 143, frames: 36, gravity: F(-10 / 3), height: 20, spin: DIA_SPIN, fxScale: 0.35,
           react: [10, 0xca], motions: [120] },
  // uEm006: lands 40 S up
  em006: { piece: 'em006_tail', joint: 143, frames: 24, gravity: -3, height: 40, spin: RATH_SPIN, fxScale: 0.35,
           react: [10, 0xca], motions: [120] },
  em058: { piece: 'em058_tail', joint: 143, frames: 24, gravity: -3, height: 40, spin: RATH_SPIN, fxScale: 0.35,
           react: [10, 0xca], motions: [120] },
  // uEm059: reaction (10, 0xc6) -> motions 103, 104; its sever arm also sets the monster fade info+0x98 to 1.0 and the
  // piece to its own full alpha (+0xd5d = 0, 0x2ab9f0(piece, 255)), so the piece no longer fades with the monster.
  // OPEN: the table's joint 143 is NOT the piece's root joint (142), so P0 uses 143's local translation (see notes 6).
  em059: { piece: 'em059_tail', joint: 143, frames: 28, gravity: -3, height: 20, spin: RATH_SPIN, fxScale: 0.28,
           react: [10, 0xc6], motions: [103, 104], ownAlpha: true },
  em060: { piece: 'em060_tail', joint: 143, frames: 28, gravity: -3, height: 20, spin: RATH_SPIN, fxScale: 0.28,
           react: [10, 0xc6], motions: [103, 104], ownAlpha: true },
  em061: { piece: 'em061_tail', joint: 143, frames: 28, gravity: -3, height: 20, spin: RATH_SPIN, fxScale: 0.28,
           react: [10, 0xc6], motions: [103, 104], ownAlpha: true },
  // em004, em052 (uEm004) and em026: no sever record (table +0x98 is null) and no 0x82888c call in the class -- no piece.
};

// The landing effect (0x829198..0x829248): group 0x24 (qe bank) by the stage attribute under G (0x95b9a0), at G with y
// replaced by the matching stage height, scale [table+0x9c]+0x28, no rotation. Attribute with none of these bits: num 0,
// which resolves to nothing (trg_resolve.py), so no effect. Resolved nums READ by emulating 0x163904.
export function landingEffect(attr){
  if (attr & 0x1220) return { num: 0x152, efl: 'qe000_301', mask: 0x10, height: 'info+0x120' };
  if (attr & 0x0406) return { num: 0x17b, efl: 'qe001_301', mask: 0x800, height: 'info+0x124' };
  if (attr & 0x2080) return { num: 0x188, efl: 'qe002_301', mask: 0x40, height: 'info+0x128' };
  return null;
}

export class SeverPiece3U {
  // J          [x, y, z] world position of the monster joint `rec.joint` on the spawn tick (game units)
  // jointQuat  [x, y, z, w] that joint's world rotation (unit; the scale is S)
  // t          [x, y, z] the PIECE model's joint `rec.joint` local translation (game units; the glb node x 100)
  // monsterPos [x, y, z] the monster's position (info+0x38) when the cut happened
  // yaw        the monster's yaw (info+0x84) on the spawn tick, u16 (0x10000 = 360 degrees)
  // S          the monster's model scale (info+0x90 x info+0x94)
  // step       60 Hz frames per game tick: [e+0x14]; 2 at 30 fps (INFERRED), 1 to run at 60
  constructor({ J, jointQuat, t, monsterPos, yaw, S = 1, rec, step = 2 }){
    this.rec = rec; this.S = S; this.yaw = yaw & 0xffff; this.h = F(0.5 * step); this.step = step;
    this.jointQuat = jointQuat.slice();
    const off = qrot(jointQuat, t).map(v => v * S);
    this.P0 = [F(J[0] - off[0]), F(J[1] - off[1]), F(J[2] - off[2])];
    this.G = [F(monsterPos[0]), F(monsterPos[1] + F(rec.height * S)), F(monsterPos[2])];     // 0x8289f8..0x828a10
    const N = rec.frames, d = this.G.map((g, i) => F(g - this.P0[i]));
    this.V = [F(d[0] / N), F(F(d[1] / N) - F(F(rec.gravity * 0.5) * N)), F(d[2] / N)];       // 0x82e368..0x82e3ac
    this.A = [0, F(rec.gravity), 0];
    this.P = this.P0.slice(); this.t = 0; this.tick = 0; this.state = 2; this.angles = [0, this.yaw, 0];
  }
  // one game tick of state 2 / 3 / 4 (0x829080.., 0x829358..); returns true on the landing tick
  _tick(){
    const r = this.rec, h = this.h;
    this.tick++;
    if (this.state === 2){
      this.t = F(this.t + h);
      this._spin();
      if (this.t >= r.frames){ this.state = 3; this.P = this.G.slice(); return true; }
      for (let i = 0; i < 3; i++) this.P[i] = F(this.P[i] + F(this.V[i] * h));
      for (let i = 0; i < 3; i++) this.V[i] = F(this.V[i] + F(this.A[i] * h));
      return false;
    }
    // state 3 -> 4 (carve point), then 4: t keeps counting below 1000, spin re-evaluated, position held
    this.state = 4;
    if (this.t < 1000){ this.t = F(this.t + h); this._spin(); }
    return false;
  }
  _spin(){
    const [cx, cy, cz] = this.rec.spin || [];
    this.angles = [spinU16(cx, this.t), (this.yaw + spinU16(cy, this.t)) & 0xffff, spinU16(cz, this.t)];
  }
  // on to 60 Hz frame f counted from the spawn tick (never back); true when the landing tick is passed on the way
  advance(f){
    let landed = false;
    while ((this.tick + 1) * this.step <= f) if (this._tick()) landed = true;
    return landed;
  }
  get landed(){ return this.state >= 3; }
  get landingFrame(){ return Math.ceil(this.rec.frames / this.h) * this.step; }
  // position (game units), rotation [x, y, z, w], scale, and the u16 angles; tick 0 is drawn in the joint's orientation
  pose(){
    const q = this.tick === 0 ? this.jointQuat.slice()
                              : quatYXZ(this.angles[0] * U16, this.angles[1] * U16, this.angles[2] * U16);
    return { position: this.P.slice(), quaternion: q, scale: this.S, angles: this.angles.slice(), state: this.state };
  }
}
