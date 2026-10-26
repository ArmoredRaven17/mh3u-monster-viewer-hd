// attack-hitboxes.js -- THE MONSTER'S ATTACK SHAPES, as 3U's own code arms and sizes them (Raven, 2026-10-24: "add in everything
// shared, the animation options GU uses" -- the MHGU viewer's Attack Hitboxes option; 3U ships the same pair of files). Drawn as the
// hit-zone capsules are (render/monster.js zoneCapsules: 0 sphere, 1 a capsule on one joint, 2 a capsule between two), one group per
// armed record, coloured by what it can hit. notes/attack-em001.md (C:\MH3U-Extract), exporter wiiu_attack_export.py.
//
// THE DATA (docs/attack-hitshapes.json, per monster; every field READ from 3U's loaders / users unless the notes say otherwise):
//   records[id] = [start, duration, kind, set, elementBits, power, +8, +0xa, +0xb, statusBits, 0, statusValue, ...raw]
//     -- em_hitdata00.htd, 0x20-byte records (loader 0x951e10); power on the hunter p - p*d/(d+80) (0x98660c)
//   sets[n] = [[j0, j1, code, offMask, r, o0x, o0y, o0z, o1x, o1y, o1z, +6], ...] -- em_hitsize00.hts, 0x28-byte shapes
//     (0x952050), built by 0x9852a8 through the .bdd joint lookup 0x199bac; offMask hides a shape while that state bit is set
//   arms['<list>|Motion[N]'] = [[slot, id, flags, gate, action, from, to, mask, site, e1], ...] -- 0x844a40(enemy, slot, id, flags),
//     the window [max(start, arm), start + duration] in the motion's frames (3U's arm and tick code run frame by frame), the target
//     mask from the flags (0x17 by default; bit 0 = the hunters, bit 1 = monsters), action 'cat/id' or 'pf53' (the per-frame hook)
// 3U differs from GU: one table (no ids >= 1000), the mask from the arm flags only, no third shape type, the element word is not
// GU's (no element names here: shown as bits), one status word.
import * as THREE from 'three';
import { zoneCapsules } from './monster.js';

let DATA = null, loading = null;
export function loadAttackData(base = ''){
  if (DATA) return Promise.resolve(DATA);
  if (!loading) loading = fetch(base + 'attack-hitshapes.json').then(r => r.json()).then(d => (DATA = d)).catch(() => (DATA = {}));
  return loading;
}
export function attackDataFor(monId){ return DATA && DATA[monId] || null; }
export function hasAttackData(monId){ const D = attackDataFor(monId); return !!(D && D.arms && Object.keys(D.arms).length); }

// the clip's armed records: [{ id, slot, flags, action, rec, mask, win, set, shapes }]. A motion several actions play arms per
// action; the viewer shows the FIRST listed action's (the effects' rule, wiiu_effects_export.py) plus the per-frame hook's.
export function armedFor(monId, clipKey){
  const D = attackDataFor(monId);
  if (!D || !D.arms) return [];
  let arms = D.arms[clipKey] || [];
  const first = (arms.find(a => a[4] && a[4] !== 'pf53') || [])[4];
  if (first) arms = arms.filter(a => a[4] === first || a[4] === 'pf53' || !a[4]);
  const out = [];
  for (const [slot, id, flags, gate, action, from, to, mask] of arms){
    const rec = D.records[id];
    if (!rec){ out.push({ id, slot, flags, action, why: 'no record' }); continue; }
    out.push({ id, slot, flags, action, rec, mask, win: to > from ? [from, to] : null, set: rec[3], shapes: (D.sets[rec[3]] || []) });
  }
  return out;
}
export function describeText(a){
  if (!a.rec) return 'record ' + a.id + ': ' + (a.why || 'no record');
  const r = a.rec, hx = v => '0x' + (v >>> 0).toString(16);
  const hits = [(a.mask & 1) && 'the hunters', (a.mask & 2) && 'monsters', (a.mask & 0x14) && 'other targets'].filter(Boolean);
  return ['Attack record ' + a.id + ', slot ' + a.slot + ', shape set ' + r[3] + (a.win ? ', frames ' + a.win[0] + '-' + a.win[1] : '')
          + (a.action ? ', action ' + a.action : ''),
          'Power ' + r[5] + ', element bits ' + hx(r[4]) + ' (names not read)',
          (r[9] || r[11]) ? 'Status bits ' + hx(r[9]) + ', value ' + r[11] + ' (names not read)' : 'No status',
          'Kind ' + hx(r[2]) + ', hits ' + (hits.join(', ') || 'nothing listed')].join(String.fromCharCode(10));
}
export const ATTACK_COLOURS = { hunter: [1.0, 0.25, 0.2], monster: [1.0, 0.62, 0.15], other: [0.25, 0.7, 1.0], off: [0.6, 0.6, 0.6] };

// THE OVERLAY: one zoneCapsules group per armed record of the playing clip; update() shows / colours them for the frame
export function buildAttackHitboxes(root, monId, boneNodes){
  const group = new THREE.Group(); group.name = 'attack-hitboxes';
  const items = [];
  let clipKey = null;
  const clear = () => { for (const it of items){ group.remove(it.g); it.g.userData.dispose(); } items.length = 0; };
  const setClip = key => {
    if (key === clipKey) return;
    clipKey = key; clear();
    for (const a of armedFor(monId, key)){
      if (!a.shapes || !a.shapes.length) continue;
      // zoneCapsules' record: [slot, id, shape, joint a, joint b, r, a.xyz, b.xyz]; the offMask rides along for update()
      const byMask = new Map();
      for (const sh of a.shapes.filter(sh => [0, 1, 2].includes(sh[2]))){
        const row = [a.slot, a.id, sh[2], sh[0], sh[2] === 2 ? sh[1] : sh[0], sh[4], sh[5], sh[6], sh[7], sh[8], sh[9], sh[10]];
        if (!byMask.has(sh[3])) byMask.set(sh[3], []);
        byMask.get(sh[3]).push(row);
      }
      for (const [offMask, rows] of byMask){
        const g = zoneCapsules(root, rows, { color: ATTACK_COLOURS.off, boneNodes });
        group.add(g);
        items.push({ a, g, offMask, skipped: g.userData.skipped | 0 });
      }
    }
  };
  // opts: { mode: 'armed' | 'all', off: the state bits (+0x8b6) that hide a shape with that bit in its offMask }
  const update = (key, frame, opts = {}) => {
    setClip(key);
    let armed = 0;
    const rows = [];
    for (const it of items){
      const a = it.a, on = !!a.win && frame >= a.win[0] && frame < a.win[1];
      const hidden = !!(it.offMask & (opts.off | 0));
      const kind = (a.mask & 1) ? 'hunter' : (a.mask & 2) ? 'monster' : 'other';
      if (on && !hidden) armed++;
      it.g.userData.setColor(ATTACK_COLOURS[on ? kind : 'off']);
      it.g.visible = !hidden && (on || opts.mode === 'all');
      rows.push({ id: a.id, slot: a.slot, set: a.set, mask: a.mask, kind, on, hidden, win: a.win, action: a.action, skipped: it.skipped });
    }
    group.userData.last = { key, frame, armed, rows };
    return group.userData.last;
  };
  // the shape under a screen point: { a, text } or null (the hover tooltip in index.html)
  const pick = (px, py, cam, w, h) => {
    let best = null;
    const V = cam.position.constructor;
    const P = new V(), Q = new V(), E = new V(), right = new V().setFromMatrixColumn(cam.matrixWorld, 0);
    const scr = v => { const t = v.clone().project(cam); return t.z > 1 ? null : [(t.x + 1) / 2 * w, (1 - t.y) / 2 * h]; };
    for (const it of items){
      if (!it.g.visible) continue;
      for (const sh of it.g.userData.readback()){
        P.fromArray(sh.A); Q.fromArray(sh.B);
        const a = scr(P), b = scr(Q), e = scr(E.copy(P).addScaledVector(right, sh.r));
        if (!a || !b || !e) continue;
        const rpx = Math.hypot(e[0] - a[0], e[1] - a[1]);
        const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
        const t = L > 0 ? Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / L)) : 0;
        const d = Math.hypot(px - a[0] - t * dx, py - a[1] - t * dy);
        if (d <= rpx && (!best || d - rpx < best.score)) best = { a: it.a, score: d - rpx };
      }
    }
    return best ? { a: best.a, text: describeText(best.a) } : null;
  };
  group.userData.pick = pick;
  group.userData.update = update;
  group.userData.dispose = () => clear();
  return group;
}
