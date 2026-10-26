// MH3U monster effects in three.js: 3U's own effect code, hand-translated (spec.js, a synced copy of the reference
// module C:\MH3U-Extract\scratch_fx\efx3u_spec.js; notes\effects-engine.md), driven and drawn here.
//
// Raven, 2026-10-24: implement MH3U's effects, translating 3U's own code (not GU's emulation); the HD viewer reads
// the Wii U effect files (big-endian), walked in the in-app list order from Rathian.
//
// Units. An effect runs in GAME units, as the ROM does. The models are shipped at 1/100 of that, so a joint's world
// matrix M (viewer units) becomes S(100) . M . S(0.01) for the effect, and every vertex comes back x 0.01.
// Time. The effect steps in whole 1/60 s game frames (uEffect move 0x89ec00 runs N whole steps per frame).
//
// The quad (CAP_Primitive geometry shader), the blend table and the depth/alpha state are READ (spec.js, drawState and
// buildType0Quads), the ZOffset depth shift included. Not done here: node joints >= 0 (a node parented to another joint falls back to the effect's own world).
import * as THREE from 'three';
import * as S from './spec.js';
import * as T1 from './type1.js';          // type 1, the polyline (scratch_fx\efx3u_type1.js, notes\effects-engine.md 17)
import * as T2 from './type2.js';          // type 2, the flat quad (scratch_fx\efx3u_type2.js, notes\effects-engine.md 18)
import { getTexture } from '../assets.js';

const GAME = 100, STEP = 1 / 60;
// COLOUR SPACE. The PICA has no sRGB: the game multiplies texel x vertex colour as stored and the screen shows the
// result (as GU's effects, MHGU viewer render/rom/effect/primshader.js). The viewer decodes the texture and encodes
// the output, so the vertex colour is decoded too: decode(t) x decode(c) = decode(t x c) (pure power curve), and the
// screen shows t x c again. Alpha is not a colour and stays raw. Sums (additive blending) run on decoded values,
// where the game adds stored ones -- that difference stays. Effects skip the viewer's tone mapping (toneMapped false).
const LIN = Float32Array.from({ length: 256 }, (_, i) => THREE.ColorManagement.enabled ? new THREE.Color().setRGB(i / 255, 0, 0, THREE.SRGBColorSpace).r : i / 255);

// the game's draw state (spec.js drawState: blend table 0xb3bf68, depth from gb +0x04, alpha test GREATER 0) as a
// three.js material; texture x vertex colour as the sprite shader combines them
const FACTOR = { zero: THREE.ZeroFactor, one: THREE.OneFactor, srcColor: THREE.SrcColorFactor,
  oneMinusSrcColor: THREE.OneMinusSrcColorFactor, dstColor: THREE.DstColorFactor, oneMinusDstColor: THREE.OneMinusDstColorFactor,
  srcAlpha: THREE.SrcAlphaFactor, oneMinusSrcAlpha: THREE.OneMinusSrcAlphaFactor, dstAlpha: THREE.DstAlphaFactor,
  oneMinusDstAlpha: THREE.OneMinusDstAlphaFactor, srcAlphaSaturate: THREE.SrcAlphaSaturateFactor };
const EQUATION = { add: THREE.AddEquation, subtract: THREE.SubtractEquation, reverseSubtract: THREE.ReverseSubtractEquation,
  min: THREE.MinEquation, max: THREE.MaxEquation };
function material(ds, map){
  const b = ds.blend;
  const mat = new THREE.MeshBasicMaterial({ map, vertexColors: true, transparent: true, side: THREE.DoubleSide, toneMapped: false,
                                            depthTest: ds.depthTest, depthWrite: ds.depthWrite, alphaTest: 1 / 512 });
  if (b && b.src){
    mat.blending = THREE.CustomBlending;
    mat.blendSrc = FACTOR[b.src]; mat.blendDst = FACTOR[b.dst]; mat.blendEquation = EQUATION[b.eq];
    // The game's alpha factors (b.srcAlpha / dstAlpha / eqAlpha) write a framebuffer alpha the console never shows. The
    // viewer's canvas IS composited by its alpha (premultiplied: the page shows through where the scene is clear), so
    // following them turned every additive sprite's square into an opaque patch. Instead the canvas alpha gets what
    // makes the composite match the colour blend: a blend over the destination (dst = 1 - srcAlpha) covers it
    // ('over': a + d(1 - a)); anything else (additive, subtractive) adds light to whatever is behind, page included,
    // and leaves the alpha as it is.
    const over = b.dst === 'oneMinusSrcAlpha';
    mat.blendSrcAlpha = over ? THREE.OneFactor : THREE.ZeroFactor;
    mat.blendDstAlpha = over ? THREE.OneMinusSrcAlphaFactor : THREE.OneFactor;
    mat.blendEquationAlpha = THREE.AddEquation;
  }
  mat.userData.drawState = ds;
  // ZOffset (READ, the GS in spec.js buildType0Quads): x/y are the corner's, the DEPTH is taken at the corner moved
  // `zshift` units toward the camera (column 2 of the view inverse = view-space +z). Dust spawned inside a foot
  // (ZOffset -100) tests its depth a metre nearer and so shows in front of the leg it starts in.
  mat.onBeforeCompile = sh => {
    sh.vertexShader = 'attribute float zshift;\n' + sh.vertexShader.replace('#include <project_vertex>',
      '#include <project_vertex>\n{ vec4 zc = projectionMatrix * (mvPosition + vec4(0.0, 0.0, zshift, 0.0)); gl_Position.z = zc.z / zc.w * gl_Position.w; }');
  };
  mat.customProgramCacheKey = () => 'fx3u-zshift';
  return mat;
}
let rngReady = null;
// the shared archives every monster draws from (effects/bank_<name>.json, wiiu_effects_export.py bank:<name>): the
// common bank (qe) the class code and .esq request with a row mask -- ground dust and the like
const BANKS = ['qe'];
let banksReady = null;

export class Fx3uRuntime {
  constructor(scene){
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = 'fx3u';
    scene.add(this.group);
    this.set = null;                 // effects/<em>.json
    this.files = new Map();          // 'efl:' / 'ean:' + game path -> parsed efl / ean (the monster's set and the banks)
    this.textures = new Map();       // game path -> texture
    this.bankKeys = new Set();       // the keys above that belong to a shared bank (kept when the monster changes)
    this.groundFlags = 0;            // info+0x140, the floor under the monster (the Ground control)
    this.live = [];
    this.acc = 0;
    this.last = null;
    this.stats = { started: 0, ended: 0, quads: 0 };
  }
  // the monster's effect set (effects/<em>.json), or null when it has none
  async load(em){
    this.clear();
    if (!rngReady) rngReady = fetch('effects/rng.json').then(r => r.json()).then(j => { S.setRandomTables(j.u32, j.f32); T1.setRandomTables(j.u32, j.f32); T2.setRandomTables(j.u32, j.f32); });
    await rngReady;
    if (!banksReady) banksReady = this.loadBanks();
    await banksReady;
    const res = await fetch('effects/' + em + '.json');
    this.set = res.ok ? await res.json() : null;
    for (const k of [...this.files.keys()]) if (!this.bankKeys.has(k)) this.files.delete(k);
    for (const k of [...this.textures.keys()]) if (!this.bankKeys.has('tex:' + k)) this.textures.delete(k);
    // THE WHOLE SET IS LOADED UP FRONT (a monster's is a few hundred KB), so a request starts on the very frame the
    // game makes it rather than after a fetch
    if (this.set){
      const jobs = [];
      for (const [path, f] of Object.entries(this.set.files)){
        const kind = /\.efl$/.test(f) ? 'efl' : /\.ean$/.test(f) ? 'ean' : null;
        if (kind) jobs.push(fetch(f).then(r => r.arrayBuffer()).then(b => this.files.set(kind + ':' + path, kind === 'efl' ? S.parseEfl(b) : S.parseEan(b))));
      }
      for (const [path, r] of Object.entries(this.set.resources)) if (r.tex) jobs.push(getTexture(r.tex).then(t => this.textures.set(path, t)));
      await Promise.all(jobs);
    }
    return this.set;
  }
  // the shared banks, loaded once and kept across monsters
  async loadBanks(){
    this.bank = { files: {}, resources: {} };
    for (const name of BANKS){
      const r = await fetch('effects/bank_' + name + '.json');
      if (!r.ok) continue;
      const b = await r.json();
      Object.assign(this.bank.files, b.files); Object.assign(this.bank.resources, b.resources);
    }
    const jobs = [];
    for (const [path, f] of Object.entries(this.bank.files)){
      const kind = /\.efl$/.test(f) ? 'efl' : /\.ean$/.test(f) ? 'ean' : null;
      if (kind){ this.bankKeys.add(kind + ':' + path);
        jobs.push(fetch(f).then(r => r.arrayBuffer()).then(b => this.files.set(kind + ':' + path, kind === 'efl' ? S.parseEfl(b) : S.parseEan(b)))); }
    }
    for (const [path, r] of Object.entries(this.bank.resources)) if (r.tex){ this.bankKeys.add('tex:' + path);
      jobs.push(getTexture(r.tex).then(t => this.textures.set(path, t))); }
    await Promise.all(jobs);
  }
  // a texture or model path, in the monster's own set or a shared bank
  resource(path){ return (this.set && this.set.resources[path]) || (this.bank && this.bank.resources[path]) || null; }
  async parsed(gamePath, kind){
    const key = kind + ':' + gamePath;
    if (this.files.has(key)) return this.files.get(key);
    const f = this.set && this.set.files[gamePath];
    let out = null;
    if (f){
      const buf = await (await fetch(f)).arrayBuffer();
      out = kind === 'efl' ? S.parseEfl(buf) : S.parseEan(buf);
    }
    this.files.set(key, out);
    return out;
  }
  async texture(gamePath){
    const r = this.set && this.set.resources[gamePath];
    return r && r.tex ? getTexture(r.tex) : null;
  }
  // play one effect list on a joint (an Object3D whose matrixWorld is the parent), with a local offset in game units.
  // Synchronous: the set is preloaded (load), so the effect exists from this frame on.
  play(eflPath, joint, opts = {}){
    const efl = this.files.get('efl:' + eflPath);
    if (!efl){ this.stats.missing = (this.stats.missing || 0) + 1; return null; }
    const eans = new Map();
    for (const row of efl.rows) if (row.gen && row.gen.ean && !eans.has(row.gen.ean)) eans.set(row.gen.ean, this.files.get('ean:' + row.gen.ean) || null);
    const fx = S.createEffect(efl, { ean: p => eans.get(p) || null, seed: opts.seed, mask: opts.mask });
    if (opts.scale) fx.scale = opts.scale;                        // owner +0x1b0: the request's scale (sprite size)
    // the other types' generators: createEffect leaves them as placeholders, their own module builds and steps them
    fx.gens = fx.gens.map(g => {
      if (!g.row || ![1, 2].includes(g.type)) return g;
      const ean = g.row.gen && g.row.gen.ean ? eans.get(g.row.gen.ean) || null : null;
      if (g.type === 1){ const t = T1.initType1(fx, g.row, ean); t.step = T1.stepType1; t.end = T1.endType1; return t; }
      const t = T2.initType2(fx, g.row, ean); t.step = T2.stepType2; return t;      // ended as type 0 (spec endGenerator)
    });
    const inst = { fx, joint, offset: opts.offset || [0, 0, 0], path: eflPath, meshes: [], loop: !!opts.loop };
    for (const g of fx.gens){
      if (![0, 1, 2].includes(g.type) || g.unsupported || (g.type === 1 && !g.drawable)){ inst.meshes.push(null); continue; }
      const tex = (this.textures && this.textures.get(g.gb.tex[0])) || null;
      const geo = new THREE.BufferGeometry();
      const mat = material(S.drawState(g.gb.state, g.gb.w04), tex);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      mesh.userData.fxGen = g;
      this.group.add(mesh);
      inst.meshes.push(mesh);
    }
    this.live.push(inst);
    this.stats.started++;
    return inst;
  }
  // the parent matrix in game units: S(100) . M . T(offset/100) . S(0.01)
  parentGame(inst){
    const m = new THREE.Matrix4();
    if (inst.joint){ inst.joint.updateWorldMatrix(true, false); m.copy(inst.joint.matrixWorld); }
    const o = inst.offset;
    m.multiply(new THREE.Matrix4().makeTranslation(o[0] / GAME, o[1] / GAME, o[2] / GAME));
    m.multiply(new THREE.Matrix4().makeScale(1 / GAME, 1 / GAME, 1 / GAME));
    m.premultiply(new THREE.Matrix4().makeScale(GAME, GAME, GAME));
    return m.elements.slice();     // column-major, as spec.js reads it
  }
  // advance every live effect by the whole game frames in `dt` seconds
  step(dt){
    this.acc = Math.min(this.acc + dt, 0.25);
    while (this.acc >= STEP){
      this.acc -= STEP;
      this.stepShells();
      for (const inst of this.live.slice()){
        const world = this.parentGame(inst);
        const alive = S.stepEffect(inst.fx, j => j < 0 ? world : null);
        if (!alive) this.end(inst);
      }
    }
  }
  end(inst){
    for (const m of inst.meshes) if (m){ this.group.remove(m); m.geometry.dispose(); m.material.dispose(); }
    this.live.splice(this.live.indexOf(inst), 1);
    this.stats.ended++;
  }
  clear(){ this.shells = []; this.prevKey = null; for (const inst of this.live.slice()) this.end(inst); }
  // write this frame's quads into each generator's mesh
  draw(camera){
    camera.updateMatrixWorld();
    const e = camera.matrixWorld.elements;
    const cam = { right: [e[0], e[1], e[2]], up: [e[4], e[5], e[6]], back: [e[8], e[9], e[10]],
                  pos: [e[12] * GAME, e[13] * GAME, e[14] * GAME] };      // game units, for the polyline's side vector
    let quads = 0;
    for (const inst of this.live){
      inst.fx.gens.forEach((g, i) => {
        const mesh = inst.meshes[i];
        if (!mesh) return;
        const r = this.resource(g.gb.tex[0]);
        if (g.type === 1){ quads += this.drawGeometry(T1.buildType1Geometry(g, cam, { texSize: r && r.size }), mesh, true); return; }
        // type 2's ZOffset moves the whole vertex (VS_Primitive_CNZ), already in its positions: no depth-only shift
        if (g.type === 2){ quads += this.drawGeometry(T2.buildType2Geometry(g, cam, { texSize: r && r.size }), mesh, false); return; }
        const qs = S.buildType0Quads(g, cam, { texSize: r && r.size });
        quads += qs.length;
        const n = qs.length;
        const pos = new Float32Array(n * 12), uv = new Float32Array(n * 8), col = new Float32Array(n * 16), zs = new Float32Array(n * 4), idx = [];
        qs.forEach((q, k) => {
          for (let c = 0; c < 4; c++){
            pos.set(q.corners[c].map(v => v / GAME), k * 12 + c * 3);
            uv.set(q.uvs[c], k * 8 + c * 2);
            col.set([LIN[q.rgba[0]], LIN[q.rgba[1]], LIN[q.rgba[2]], q.rgba[3] / 255], k * 16 + c * 4);
            zs[k * 4 + c] = (q.depthShift || 0) / GAME;
          }
          idx.push(k * 4, k * 4 + 1, k * 4 + 2, k * 4, k * 4 + 2, k * 4 + 3);
        });
        const geo = mesh.geometry;
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
        geo.setAttribute('color', new THREE.BufferAttribute(col, 4));
        geo.setAttribute('zshift', new THREE.BufferAttribute(zs, 1));
        geo.setIndex(idx);
      });
    }
    this.stats.quads = quads;
    return quads;
  }
  // a type module's triangles (game-unit positions, uvs, colour bytes, indices) into the generator's mesh;
  // depthOnly: its ZOffset moves only the depth-test point (type 1, as type 0)
  drawGeometry(o, mesh, depthOnly){
    const n = o.positions.length;
    const pos = new Float32Array(n * 3), uv = new Float32Array(n * 2), col = new Float32Array(n * 4), zs = new Float32Array(n);
    for (let k = 0; k < n; k++){
      const P = o.positions[k], c = o.rgba[k];
      pos[3 * k] = P[0] / GAME; pos[3 * k + 1] = P[1] / GAME; pos[3 * k + 2] = P[2] / GAME;
      uv[2 * k] = o.uvs[k][0]; uv[2 * k + 1] = o.uvs[k][1];
      col[4 * k] = LIN[c[0]]; col[4 * k + 1] = LIN[c[1]]; col[4 * k + 2] = LIN[c[2]]; col[4 * k + 3] = c[3] / 255;
      zs[k] = depthOnly ? (o.depthShift || 0) / GAME : 0;
    }
    const geo = mesh.geometry;
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 4));
    geo.setAttribute('zshift', new THREE.BufferAttribute(zs, 1));
    geo.setIndex(o.indices);
    return o.indices.length / 6;
  }
  // stop an effect from outside, as its owner does (spec.js endEffect, 0x412db8): it stops emitting, a sustained
  // particle's hold is let go, and what is left fades out on its own
  release(inst){ if (inst && this.live.includes(inst)) S.endEffect(inst.fx); }
  // ---- triggers (effects/<em>.json `triggers`, from 3U's class code: notes\effects-<em>.md) -------------------------
  // bind(joint, root): joint(gid) -> the Object3D a capsule or effect hangs off, root() -> the monster's root object
  // ground() -> the floor's height (the viewer's floor grid), where a shell meets the ground
  bind(joint, root, ground, rage){ this.jointOf = joint; this.rootOf = root; this.groundOf = ground; this.rageOf = rage; }
  // The motion frame the game counts for the clip on screen. A clip is Motion[N] / Motion[N]_start / Motion[N]_loop;
  // a _loop clip starts at the motion's loop frame (effects/<em>.json `motions`, from the .lmt).
  motionFrame(listId, clip, time){
    const m = /^Motion\[(\d+)\](?:_(start|loop))?$/.exec(clip || '');
    if (!m) return null;
    const idx = +m[1], mot = ((this.set && this.set.motions) || {})[listId] || {};
    const loop = (mot[idx] || [0, 0])[1];
    return { list: +listId, index: idx, frame: time * 60 + (m[2] === 'loop' && loop > 0 ? loop : 0) };
  }
  // Called every frame with the clip on screen. A trigger fires ONCE when its frame is crossed (0x1983fc, mode 0); a
  // clip that starts over (its frame went back) starts the crossing test over too.
  tick(listId, clip, time){
    const trg = this.set && this.set.triggers;
    if (!trg || !this.jointOf) return;
    const mf = this.motionFrame(listId, clip, time);
    if (!mf){ this.prevKey = null; return; }
    const key = listId + '|' + clip;
    if (key !== this.prevKey || mf.frame < this.prevFrame){
      // a new clip, or the clip started over: what the last pass started is ended from outside (a viewer choice -- the
      // game's owner objects end their effects when their action ends; looping rows would otherwise pile up)
      if (this.prevKey !== null && this.prevKey !== undefined) for (const inst of this.live) this.release(inst);
      this.prevFrame = -1;
    }
    this.prevKey = key;
    const crossed = f => this.prevFrame < f && f <= mf.frame;
    const at = t => t.motion[0] === mf.list && t.motion[1] === mf.index;
    for (const t of trg.clips || []) if (at(t) && crossed(t.frame) && this.onGround(t.ground)) for (const efl of t.efl) this.request(efl, t);
    for (const s of trg.shells || []) for (const [mot, f, pitch, yaw] of s.launch || [])
      if (mot[0] === mf.list && mot[1] === mf.index && crossed(f)) this.launch(s, pitch | 0, yaw | 0);
    this.rageTick(trg.rage, mf);
    this.prevFrame = mf.frame;
  }
  // em001_000 -> effect\efl\em\<monster>\em001_000 ; qe000_301 -> effect\efl\qe\qe000\qe000_301 (the shared bank)
  // THE RAGE EMISSION (class C, notes\effects-em001.md 3b, READ unless marked): while the monster is enraged
  // (0x82adb0: info+0x954 == 1 -- the viewer's Rage control) and the motion is not one of `skipMotions` (list 0),
  // every `every` frames (0x8532a0(this, 10, 0): INFERRED every 10) a draw from the enemy's random stream picks:
  // skip when 0 <= (v & 0xffff) - 0x8000 < 0x5555, else kind 6 (em001_034) when that value >= 0x6e39 unsigned, else
  // kind 0 (em001_030). The stream 0x584d68(info+0x7a8) is not read (INFERRED random): the viewer draws Math.random.
  // Placed at the joint plus the offset turned by the facing, as the class's other placed requests.
  rageTick(rage, mf){
    if (!rage || !this.rageOf || !this.rageOf()) return;
    if (mf.list === 0 && (rage.skipMotions || []).includes(mf.index)) return;
    const every = rage.every || 10, n = Math.floor(mf.frame / every);
    if (n === this.rageLast) return;
    this.rageLast = n;
    const v = (Math.random() * 65536) | 0, d = (v - 0x8000) >>> 0;
    if (d < 0x5555) return;
    const efl = d >= 0x6e39 ? rage.efl[1] : rage.efl[0];
    this.request(efl, { joint: rage.joint, offset: rage.offset, place: 'spawn' });
  }
  // THE GROUND (the viewer's Ground control): the word info+0x140 the class code and the .esq reader test. A request
  // behind a ground test fires only on the floor it names (wiiu_effects_export.py ground_rule).
  onGround(rule){
    if (!rule) return true;
    const f = this.groundFlags | 0;
    if (rule.and6) return rule.and6.includes(f & 6);                              // slot 53 (0x686210)
    if (rule.esq) return rule.esq === ((f & 0x1220) || !f ? 'sec0' : f & 0x406 ? 'sec1' : f & 0x2080 ? 'sec2' : null);   // 0x332e8c
    return true;
  }
  pathOf(efl){
    return /^qe\d{3}_/.test(efl) ? ['effect', 'efl', 'qe', efl.slice(0, 5), efl].join('\\')
                                 : ['effect', 'efl', 'em', this.set.monster, efl].join('\\');
  }
  // one class request: 'follow' rides the joint every frame (0x1a8118); 'spawn' is placed once, at the joint's position
  // plus the offset turned by the monster's facing (0x1a8f68)
  // A request with no joint (255 in the .esq) is placed at the monster's own position. `mask` picks a shared-bank
  // file's rows (0x89e878); `scale` is the request's (owner +0x1b0).
  request(efl, t){
    const joint = t.joint === null || t.joint === undefined ? this.rootOf() : this.jointOf(t.joint);
    if (!joint) return null;
    const opts = { mask: t.mask === null || t.mask === undefined ? undefined : t.mask, scale: t.scale };
    if (t.place === 'follow') return this.play(this.pathOf(efl), joint, Object.assign(opts, { offset: t.offset }));
    return this.play(this.pathOf(efl), this.pinned(joint, t.offset), opts);
  }
  pinned(joint, offset){
    const root = this.rootOf();
    joint.updateWorldMatrix(true, false); root.updateWorldMatrix(true, false);
    const q = new THREE.Quaternion(); root.matrixWorld.decompose(new THREE.Vector3(), q, new THREE.Vector3());
    const p = new THREE.Vector3().setFromMatrixPosition(joint.matrixWorld)
      .add(new THREE.Vector3(...offset).multiplyScalar(1 / GAME).applyQuaternion(q));
    const o = new THREE.Object3D();
    o.matrixAutoUpdate = false;
    o.matrixWorld.compose(p, q, new THREE.Vector3(1, 1, 1));
    o.updateWorldMatrix = () => {};
    return o;
  }
  // The fireball (uShell005, notes\effects-em001.md 3c): launched from its joint at the offset turned by the joint,
  // flying `speed` game units a frame for `life` frames, carrying its effect. Direction (READ, 0x9d1974 / 0x586b2c):
  // velocity (0,0,speed) turned about X by the pitch, then about Y by the yaw; pitch = the enemy's own pitch (+0xde0,
  // taken as 0: INFERRED) + the site's u16 (0x10000 = a full turn, positive tips +Z down), yaw = the monster's facing.
  launch(s, pitchU16 = 0, yawU16 = 0){
    const joint = this.jointOf(s.joint);
    if (!joint) return;
    joint.updateWorldMatrix(true, false);
    const root = this.rootOf(); root.updateWorldMatrix(true, false);
    const q = new THREE.Quaternion(); root.matrixWorld.decompose(new THREE.Vector3(), q, new THREE.Vector3());
    const pos = new THREE.Vector3(...s.offset).multiplyScalar(1 / GAME).applyMatrix4(joint.matrixWorld);
    // 0x586b2c: about X by the pitch, then about Y by the yaw ((0, 0x4000, 0) turns (0,0,120) into (120,0,0): READ)
    const T = Math.PI * 2 / 65536;
    const aim = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), (yawU16 & 0xffff) * T)
      .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), (pitchU16 & 0xffff) * T));
    const dir = new THREE.Vector3(0, 0, 1).applyQuaternion(aim).applyQuaternion(q);
    const o = new THREE.Object3D();
    o.position.copy(pos); o.quaternion.copy(q);
    const shell = { s, o, dir, left: s.life | 0, inst: null };
    (this.shells || (this.shells = [])).push(shell);
    shell.inst = this.play(this.pathOf(s.efl), o, {});
  }
  // The shell stops on expiry (0x9c9ea4) or on ANY collision (0x9ca584); its hit effect plays only on a hit, with the
  // request's scale and the yaw turned half round (yaw + 0x8000). The viewer has no stage, so the ground is the floor
  // the viewer stands the monster on (the floor grid's height): a viewer stand-in for the stage collision, not read.
  stepShells(){
    for (const sh of (this.shells || []).slice()){
      sh.o.position.addScaledVector(sh.dir, sh.s.speed / GAME);
      const ground = this.groundY();
      const hit = ground !== null && sh.o.position.y <= ground;
      if (hit) sh.o.position.y = ground;
      sh.o.updateMatrixWorld(true);
      if (--sh.left > 0 && !hit) continue;
      this.shells.splice(this.shells.indexOf(sh), 1);
      // the shell's effect is ended from outside (0x412db8): its flame stops and fades where the shell stopped
      if (sh.inst) this.release(sh.inst);
      if (hit) for (const efl of sh.s.hit.efl || [])
        this.play(this.pathOf(efl), this.pinnedAt(sh.o.position, Math.PI), { scale: sh.s.hit.scale || 1 });
    }
  }
  groundY(){ return this.groundOf ? this.groundOf() : null; }
  // a fixed spot, facing the monster's way turned by `yaw` (radians)
  pinnedAt(p, yaw = 0){
    const root = this.rootOf();
    const q = new THREE.Quaternion();
    if (root){ root.updateWorldMatrix(true, false); root.matrixWorld.decompose(new THREE.Vector3(), q, new THREE.Vector3()); }
    q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw));
    const o = new THREE.Object3D(); o.matrixAutoUpdate = false;
    o.matrixWorld.compose(p.clone(), q, new THREE.Vector3(1, 1, 1)); o.updateWorldMatrix = () => {};
    return o;
  }
  // the loop's hook: real time in, whole game frames stepped, quads drawn
  frame(camera){
    const now = performance.now() / 1000;
    const dt = this.last === null ? 0 : now - this.last;
    this.last = now;
    if (this.live.length || (this.shells && this.shells.length)){ this.step(dt); this.draw(camera); }
  }
}
