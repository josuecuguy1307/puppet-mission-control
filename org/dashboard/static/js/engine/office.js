/* Motor de la oficina viva — canvas 2D pixel (tiles 16px, BFS, sprites).
   API del contrato §4.2: clave de sprite = `${squad}/${agente}`.
   Los DATOS solo cambian objetivos: nada visual sin dato real detrás. */

import * as M from "./map.js";
import {TIER_COLORS, tierOf, drawDude, drawParticle, tickParticles, mkConfetti} from "./sprites.js";

const norm = s => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
const REDUCED = typeof matchMedia === "function" &&
  matchMedia("(prefers-reduced-motion: reduce)").matches;
const SPEED = 84;

let cv = null, ctx = null, ovEl = null, cbs = {};
let mapCv = null;
let built = false;
let store = null, squads = [], missions = [], agents = [];
let desks = [], sprites = [];
const spriteByKey = new Map();
let particles = [];
let paused = false;
let heat = {on: false, metrics: null};
let meetingSet = new Set();
let armoryHits = [];          // {it, px, py, w, h}
let armoryExtra = 0;
let warMiniHit = null;        // rect px del tablero mini (click → vista guerra)
let founderCounts = {briefs: 0, preguntas: 0, decisiones: 0};
let drag = null;              // {tipo:"item", it, x, y}
let camasLibres = [];
const overlayEls = {badges: {}, bubbles: {}, boardOv: null, leaderOv: null, heatNote: null, tip: null};
let queue = [];               // cola de reacciones fuera de vista (se reproduce al volver)
let wasVisible = true;
let lastFrame = 0;

/* ---------- helpers de datos (defensivos: estado parcial jamás crashea) ---------- */
function unwrap(v, key){
  if (Array.isArray(v)) return v;
  if (v && Array.isArray(v[key])) return v[key];
  return [];
}
const keyOf = (agente, squad) => `${squad}/${agente}`;
function findSprite(agente, squad){
  if (agente != null){
    const sp = spriteByKey.get(keyOf(agente, squad));
    if (sp) return sp;
  }
  return sprites.find(s => s.squad === squad && (agente == null || s.agente === agente)) || null;
}
const visible = () => !!cv && !document.hidden && cv.offsetParent !== null;
function queueOrRun(fn){
  if (visible()) fn();
  else if (queue.length < 200) queue.push(fn);   // se acumula aunque no tickee (§4.2)
}

/* ---------- construcción ---------- */
function pickSeats(seatList){
  if (seatList.length <= 3) return seatList;
  const isL = a => /lead|supervisor/i.test(a.rol || ""), isR = a => /reviewer/i.test(a.rol || "");
  const lead = seatList.find(isL), rev = seatList.find(isR);
  const worker = seatList.find(a => !isL(a) && !isR(a));
  return [lead, worker, rev].filter(Boolean);
}
function kindOf(a){
  if (/reviewer/i.test(a.rol || "")) return "reviewer";
  if (/lead|supervisor/i.test(a.rol || "")) return "lead";
  return "worker";
}
function seatsDe(sq){
  const deApi = agents.filter(a => a && a.squad === sq.slug);
  if (deApi.length) return deApi;
  return (sq.asientos || []).map(a => ({
    agente: a.agente || null, rol: a.rol, tier: a.tier, modelo: a.modelo,
    compartido: !!a.compartido, fable: !!a.fable, j: !!a.j,
    tools: [], estado_agente: "activo", mision_actual: null, stats: null,
  }));
}

function buildOffice(){
  M.buildMap();
  desks = []; sprites = []; spriteByKey.clear();
  camasLibres = M.INFIRMARY_BEDS.slice();
  const byDiv = {};
  for (const sq of squads) (byDiv[sq.division] = byDiv[sq.division] || []).push(sq);
  for (const [div, slots] of Object.entries(M.DESK_SLOTS)){
    const list = byDiv[div] || [];
    list.forEach((sq, i) => {
      if (i >= slots.length) return;
      const [dx, dy] = slots[i], w = sq.slug === "command" ? 4 : 3;
      M.frect(dx, dy, dx + w - 1, dy, M.T.DESK);
      const seats = pickSeats(seatsDe(sq));
      const off = sq.slug === "command" ? 1 : 0;
      const chairs = seats.map((_, k) => ({x: dx + off + k, y: dy + 1}));
      desks.push({sq, x: dx, y: dy, w, chairs});
      seats.forEach((a, k) => {
        if (sprites.length >= 60) return;             // cap duro v2
        const home = chairs[k];
        const sp = {
          key: keyOf(a.agente, sq.slug), agente: a.agente || null, squad: sq.slug,
          rol: a.rol || "?", kind: kindOf(a), tier: tierOf(a.tier),
          modelo: a.modelo || "sin datos", compartido: !!a.compartido,
          fable: !!a.fable || tierOf(a.tier) === "fable", j: !!a.j,
          tools: Array.isArray(a.tools) ? a.tools : [],
          estado_agente: a.estado_agente || "activo", mision: a.mision_actual || null,
          home, x: home.x * M.TS, y: home.y * M.TS - 8,
          path: [], pause: 1000 + Math.random() * 2000,
          mode: "sleep", want: "sleep", typing: false, working: false,
          frame: 0, ft: 0, dir: "d", check: 0, reject: 0, error: 0, flash: 0, jump: 0,
          lying: false, bed: null, meetSpot: null, forceRoute: null,
          room: M.ROOMS[div] || M.ROOMS["Business"],
        };
        sprites.push(sp);
        if (sp.agente) spriteByKey.set(sp.key, sp);
      });
    });
  }
  M.selfCheck();   // re-chequeo con escritorios colocados
  prerender();
  buildOverlays();
  built = true;
}

function prerender(){
  mapCv = document.createElement("canvas"); mapCv.width = M.LW; mapCv.height = M.LH;
  const c = mapCv.getContext("2d");
  for (let y = 0; y < M.GH; y++) for (let x = 0; x < M.GW; x++) M.drawTile(c, x, y);
  M.drawRoomTints(c);
  for (const d of desks) M.drawDeskBlock(c, d.x, d.y, d.w);
  M.drawDecor(c);
}

/* ---------- overlays HTML (todo contenido va por textContent — anti-XSS §0.5) ---------- */
const pX = px => (px / M.LW * 100) + "%", pY = py => (py / M.LH * 100) + "%";
function buildOverlays(){
  ovEl.textContent = "";
  for (const [nombre, r] of Object.entries(M.ROOMS)){
    const sign = document.createElement("div");
    sign.className = "room-sign"; sign.textContent = M.ROOM_SIGNS[nombre] || nombre.toUpperCase();
    sign.style.left = pX((r.x0 + r.x1 + 1) / 2 * M.TS); sign.style.top = pY(r.y0 * M.TS + 8);
    ovEl.appendChild(sign);
  }
  for (const d of desks){
    const cx = (d.x + d.w / 2) * M.TS, ty = d.y * M.TS;
    const placa = document.createElement("div");
    placa.className = "placa";
    placa.textContent = d.sq.nombre || d.sq.slug;
    if (d.sq.asiento_fable){
      const f = document.createElement("span"); f.className = "fmark"; f.textContent = " ◆";
      placa.appendChild(f);
    }
    placa.style.left = pX(cx); placa.style.top = pY(ty - 8);
    ovEl.appendChild(placa);
    const badge = document.createElement("div");
    badge.className = "obadge";
    badge.style.left = pX(cx); badge.style.top = pY(ty - 26);
    ovEl.appendChild(badge);
    overlayEls.badges[d.sq.slug] = badge;
    const bub = document.createElement("div");
    bub.style.cssText = `position:absolute;left:${pX(cx)};top:${pY(ty - 40)};pointer-events:none`;
    ovEl.appendChild(bub);
    overlayEls.bubbles[d.sq.slug] = bub;
  }
  const fplaca = document.createElement("div");                     // escritorio del Founder
  fplaca.className = "placa placa-founder";
  fplaca.textContent = "✉ FOUNDER";
  fplaca.style.left = pX((M.FOUNDER_DESK.x + 1.5) * M.TS);
  fplaca.style.top = pY(M.FOUNDER_DESK.y * M.TS - 8);
  ovEl.appendChild(fplaca);
  const board = document.createElement("div");                      // tablón del Hall
  board.id = "board-ov"; board.textContent = "sin datos";
  board.style.left = pX((M.HALL_BOARDS.tablon.x + 0.2) * M.TS);
  board.style.top = pY(M.HALL_BOARDS.tablon.y * M.TS + 3);
  board.addEventListener("click", () =>
    window.dispatchEvent(new CustomEvent("office:board-click")));
  ovEl.appendChild(board);
  overlayEls.boardOv = board;
  const leader = document.createElement("div");                     // leaderboard de pared
  leader.id = "leader-ov"; leader.textContent = "XP: sin datos todavía";
  leader.style.left = pX((M.HALL_BOARDS.leader.x + 0.2) * M.TS);
  leader.style.top = pY(M.HALL_BOARDS.leader.y * M.TS + 3);
  leader.addEventListener("click", () =>
    window.dispatchEvent(new CustomEvent("office:leader-click")));
  ovEl.appendChild(leader);
  overlayEls.leaderOv = leader;
  const hn = document.createElement("div");
  hn.className = "heat-note"; hn.style.display = "none";
  hn.style.left = pX(2 * M.TS); hn.style.top = pY(38 * M.TS);
  ovEl.appendChild(hn);
  overlayEls.heatNote = hn;
}

function renderBoardOv(){
  const b = overlayEls.boardOv; if (!b) return;
  if (!missions.length){ b.textContent = "sin datos"; return; }
  const hoyD = new Date();
  const esHoy = ts => { const d = new Date(ts * 1000);
    return d.getFullYear() === hoyD.getFullYear() && d.getMonth() === hoyD.getMonth() && d.getDate() === hoyD.getDate(); };
  const ready = missions.filter(m => m.carpeta === "inbox" && m.status_calc === "ready").length;
  const proc = missions.filter(m => m.carpeta === "processing").length;
  const done = missions.filter(m => m.carpeta === "completed" && esHoy(m.mtime)).length;
  b.textContent = `🟡${ready} ⚙${proc} ✅${done}`;
}
function renderLeaderOv(){
  const el = overlayEls.leaderOv; if (!el) return;
  const conXp = agents.filter(a => a && a.stats && a.stats.xp > 0)
    .sort((a, b) => b.stats.xp - a.stats.xp).slice(0, 3);
  el.textContent = conXp.length
    ? "XP: " + conXp.map(a => `${a.agente} ${a.stats.xp}`).join(" · ")
    : "XP: sin datos todavía";
  el.title = "leaderboard (historia desde 2026-06-10)";
}

/* ---------- applyData: los datos SOLO cambian objetivos ---------- */
export function applyData(s){
  store = s || store;
  if (!store) return;
  squads = unwrap(store.squads, "squads");
  missions = unwrap(store.missions, "missions");
  agents = unwrap(store.agents, "agentes");
  if (!built && squads.length && cv) buildOffice();
  if (!built) return;

  const bySlug = {};
  for (const sq of squads) bySlug[sq.slug] = sq;
  for (const sp of sprites){
    const sq = bySlug[sp.squad];
    const rec = sp.agente
      ? agents.find(a => a && a.agente === sp.agente && a.squad === sp.squad)
      : null;
    if (rec){
      const nuevoTier = tierOf(rec.tier);
      if (nuevoTier !== sp.tier){ sp.flash = 2500; sp.tier = nuevoTier; }   // tier_change real
      sp.modelo = rec.modelo || sp.modelo;
      sp.tools = Array.isArray(rec.tools) ? rec.tools : sp.tools;
      sp.estado_agente = rec.estado_agente || "activo";
      sp.mision = rec.mision_actual || null;
      sp.compartido = !!rec.compartido;
    }
    const st = sq ? (sq.estado || sq.regimen || "frio") : "frio";
    sp.working = st === "working";
    if (sp.estado_agente === "cuarentena"){
      if (!sp.bed) asignarCama(sp);
    } else if (sp.bed){ liberarCama(sp); }
    if (sp.bed || sp.meetSpot || sp.forceRoute) continue;   // estados especiales mandan
    if (sp.estado_agente === "pausado"){ sp.want = "sleep"; sp.typing = false; continue; }
    if (paused){ sp.want = sp.mode === "wander" ? "sit" : sp.want; sp.typing = false; continue; }
    if (st === "working"){ sp.want = "sit"; sp.typing = (sp.kind === "worker") && !REDUCED; }
    else if (st === "caliente"){ sp.want = REDUCED ? "sit" : "wander"; sp.typing = false; }
    else { sp.want = "sleep"; sp.typing = false; }
  }
  for (const d of desks){
    d.sq = bySlug[d.sq.slug] || d.sq;
    const b = overlayEls.badges[d.sq.slug];
    if (b){
      const act = d.sq.mision_activa;
      b.classList.toggle("show", !!act);
      if (act) b.textContent = act.id_corto;
    }
  }
  founderCounts = contarFounder();
  layoutArmoria();
  layoutWarMini();
  renderBoardOv();
  renderLeaderOv();
  const working = squads.filter(q => q.estado === "working").map(q => q.slug);
  meetingNow(working.length >= 2 ? working : []);
}

function contarFounder(){
  const items = unwrap(store && store.founder, "items");
  const c = {briefs: 0, preguntas: 0, decisiones: 0};
  for (const it of items){
    if (!it || it.estado !== "abierto") continue;
    if (it.tipo === "brief") c.briefs++;
    else if (it.tipo === "pregunta") c.preguntas++;
    else if (it.tipo === "decision") c.decisiones++;
  }
  // el Despacho (DESPACHO.md) es superset de la bandeja: si responde, sus
  // conteos mandan en las pilas del escritorio (decidir→sello, leer→pila)
  const dp = store && store.despacho;
  if (dp && dp.conteos && !dp.error){
    c.decisiones = Math.max(c.decisiones, dp.conteos.decidir || 0);
    c.briefs = Math.max(c.briefs, dp.conteos.leer_sin_leer || 0);
  }
  return c;
}

/* ---------- armería: estantes con items reales (drag → onItemDrop) ---------- */
function layoutArmoria(){
  armoryHits = []; armoryExtra = 0;
  const items = store && store.armory ? unwrap(store.armory, "items") : [];
  if (!items.length) return;
  const orden = [...items].sort((a, b) => (b.equipable === true) - (a.equipable === true));
  const slots = [];
  for (const sh of M.ARMORY_SHELVES)
    for (let x = sh.x0; x <= sh.x1; x++) slots.push({x, y: sh.y});
  orden.forEach((it, i) => {
    if (i >= slots.length){ armoryExtra++; return; }
    const s = slots[i];
    armoryHits.push({it, px: s.x * M.TS + 2, py: s.y * M.TS + 1, w: 12, h: 12});
  });
}
function colorItem(id){
  let h = 0; const s = String(id);
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return ["#b9534f", "#4a7ab5", "#5a9a5d", "#c8a455", "#7b5fa8", "#2dd4bf"][h % 6];
}
function drawItemIcon(c, hit){
  const {it, px, py} = hit;
  c.fillStyle = colorItem(it.id); c.fillRect(px, py, 12, 12);
  c.fillStyle = "#14100c";
  const clase = it.clase || "tool";
  if (clase === "mcp" || clase === "belt-mcp"){ c.fillRect(px + 3, py + 2, 2, 5); c.fillRect(px + 7, py + 2, 2, 5); c.fillRect(px + 3, py + 7, 6, 3); }
  else if (clase === "skill"){ c.fillRect(px + 2, py + 2, 8, 8); c.fillStyle = "#efe6d6"; c.fillRect(px + 4, py + 3, 4, 6); }
  else { c.fillRect(px + 2, py + 5, 8, 2); c.fillRect(px + 8, py + 2, 2, 8); }
  if (it.sensible){ c.fillStyle = "#ffd166"; c.fillRect(px + 8, py + 8, 4, 4); c.fillStyle = "#14100c"; c.fillRect(px + 9, py + 9, 2, 2); }
  if (it.equipable === false){ c.globalAlpha = .45; c.fillStyle = "#0d0a07"; c.fillRect(px, py, 12, 12); c.globalAlpha = 1; }
}

/* ---------- mini-DAG en la pared de la Sala de Guerra ---------- */
let warMiniBoxes = [];
function layoutWarMini(){
  warMiniBoxes = [];
  const dag = store && store.dag;
  const nodos = dag ? unwrap(dag, "nodos") : [];
  const crit = new Set(dag && Array.isArray(dag.camino_critico) ? dag.camino_critico : []);
  const ww = M.WAR_WALL;
  warMiniHit = {px: ww.x * M.TS, py: ww.y * M.TS, w: ww.w * M.TS, h: ww.h * M.TS};
  const perRow = ((ww.w * M.TS - 8) / 15) | 0;
  nodos.slice(0, perRow * 3).forEach((n, i) => {
    warMiniBoxes.push({
      x: ww.x * M.TS + 4 + (i % perRow) * 15,
      y: ww.y * M.TS + 5 + ((i / perRow) | 0) * 19,
      st: n.status_calc || n.status || "sin-datos",
      crit: crit.has(n.id),
    });
  });
}
const ST_COLOR = {completed:"#4ade80", processing:"#f5a623", ready:"#ffd166", blocked:"#6b6258",
  "blocked-on-founder":"#c8a455", roto:"#ef4444", ciclo:"#ef4444", "founder-roto":"#ef4444", "sin-datos":"#555"};
function drawWarMini(c){
  if (!warMiniBoxes.length){
    c.fillStyle = "#8a8178"; c.font = "9px monospace";
    c.fillText("sin datos", M.WAR_WALL.x * M.TS + 6, M.WAR_WALL.y * M.TS + 16);
    return;
  }
  for (const b of warMiniBoxes){
    c.fillStyle = ST_COLOR[b.st] || "#555"; c.fillRect(b.x, b.y, 11, 13);
    if (b.crit){ c.strokeStyle = "#ffd166"; c.lineWidth = 2; c.strokeRect(b.x - 1, b.y - 1, 13, 15); }
  }
}

/* ---------- enfermería ---------- */
function asignarCama(sp){
  const bed = camasLibres.shift();
  if (!bed) return;
  sp.bed = bed; sp.lying = false; sp.meetSpot = null; sp.forceRoute = null;
  const stand = {x: bed.x, y: bed.y + 1};
  if (REDUCED){ acostar(sp); return; }
  const p = M.bfs(Math.round(sp.x / M.TS), Math.round((sp.y + 8) / M.TS), stand.x, stand.y);
  if (p) sp.path = p; else acostar(sp);
}
function acostar(sp){
  sp.lying = true; sp.path = [];
  sp.x = sp.bed.x * M.TS + 4; sp.y = sp.bed.y * M.TS;
}
function liberarCama(sp){
  if (sp.bed) camasLibres.push(sp.bed);
  sp.bed = null; sp.lying = false; sp.path = [];
}

/* ---------- API de reacciones (§4.2) — fuera de vista se ENCOLAN ---------- */
export function showBubble(agente, squad, texto){
  queueOrRun(() => {
    const host = overlayEls.bubbles[squad] ||
      overlayEls.bubbles[(findSprite(agente, squad) || {}).squad];
    if (!host) return;
    const div = document.createElement("div");
    div.className = "obubble";
    div.textContent = String(texto || "").slice(0, 110) || "…";
    host.appendChild(div);
    setTimeout(() => div.remove(), 6300);
  });
}
export function showError(agente, squad){
  queueOrRun(() => {
    const sp = findSprite(agente, squad);
    if (sp) sp.error = 5000;
    else showBubble(agente, squad, "⚠ alerta");
  });
}
export function showReject(agente, squad){
  queueOrRun(() => {
    const sp = findSprite(agente, squad);
    if (!sp){ showBubble(agente, squad, "✗ rechazado por el Reviewer"); return; }
    sp.reject = 6000;
    // caminar de vuelta al escritorio: si ya está, paseo corto a la puerta y regreso
    const cx = Math.round(sp.x / M.TS), cy = Math.round((sp.y + 8) / M.TS);
    const enCasa = cx === sp.home.x && cy === sp.home.y;
    if (REDUCED){ sp.path = []; return; }
    if (enCasa && sp.room && sp.room.doors.length){
      const [dx, dy] = sp.room.doors[0];
      sp.forceRoute = [{x: dx, y: dy}, {x: sp.home.x, y: sp.home.y}];
    } else {
      sp.forceRoute = [{x: sp.home.x, y: sp.home.y}];
    }
  });
}
export function walkToInfirmary(agente, squad){
  queueOrRun(() => {
    const sp = findSprite(agente, squad);
    if (sp && !sp.bed) asignarCama(sp);
  });
}
export function celebrate(misionId){
  queueOrRun(() => {
    const m = missions.find(x => x.id === misionId);
    let cx = M.LW / 2, cy = M.LH / 2, slug = null;
    if (m && m.squad){
      const d = desks.find(dd => norm(dd.sq.slug) === norm(m.squad) ||
        (dd.sq.aliases || []).some(a => norm(a) === norm(m.squad)));
      if (d){ cx = (d.x + d.w / 2) * M.TS; cy = d.y * M.TS; slug = d.sq.slug; }
    }
    particles.push(...mkConfetti(cx, cy));
    if (!REDUCED) for (const sp of sprites) if (slug && sp.squad === slug) sp.jump = 1800;
    if (slug) showBubble(null, slug, `🎉 ${(m && m.id_corto) || misionId} completada`);
  });
}
export function meetingNow(squadSlugs){
  const set = new Set(Array.isArray(squadSlugs) ? squadSlugs : []);
  meetingSet = set;
  let i = 0;
  for (const sp of sprites){
    if (sp.kind !== "lead" || sp.bed) continue;
    if (set.has(sp.squad)){
      if (!sp.meetSpot && i < M.MEETING_TABLE.spots.length){
        const [x, y] = M.MEETING_TABLE.spots[i++];
        sp.meetSpot = {x, y};
        if (REDUCED){ sp.x = x * M.TS; sp.y = y * M.TS - 8; sp.path = []; }
      } else if (sp.meetSpot) i++;
    } else if (sp.meetSpot){
      sp.meetSpot = null; sp.path = [];
    }
  }
}
/* snapshots de SOLO LECTURA para el MODO JUGADOR (engine/player.js):
   posiciones de NPCs (colisión + interacción) e items de la armería. */
export function getSpritesSnapshot(){
  return sprites.map(sp => ({ x: sp.x, y: sp.y, kind: sp.kind, agente: sp.agente,
                              squad: sp.squad, tier: sp.tier, mision: sp.mision || null,
                              working: !!sp.working }));
}
export function getArmoryHits(){
  return armoryHits.map(h => ({ px: h.px, py: h.py, it: h.it }));
}

export function setPausedMode(on){
  paused = !!on;                       // inmediato en toda vista (NO se encola)
  if (paused) for (const sp of sprites){ sp.typing = false; }
}
export function setHeatOverlay(on, metrics){
  heat = {on: !!on, metrics: metrics || null};
  const hn = overlayEls.heatNote;
  if (hn){
    hn.style.display = heat.on && !heat.metrics ? "block" : "none";
    hn.textContent = "heatmap: sin datos (actividad lane-gateway)";
  }
}

/* ---------- tick (estado de juego; los datos ya fijaron `want`) ---------- */
function randomRoomTile(s){
  const r = s.room;
  for (let i = 0; i < 24; i++){
    const x = r.x0 + 1 + ((Math.random() * (r.x1 - r.x0 - 1)) | 0);
    const y = r.y0 + 1 + ((Math.random() * (r.y1 - r.y0 - 1)) | 0);
    if (M.walkable(M.grid[M.gi(x, y)])) return {x, y};
  }
  return s.home;
}
function setPath(s, t){
  const cx = Math.round(s.x / M.TS), cy = Math.round((s.y + 8) / M.TS);
  const p = M.bfs(cx, cy, t.x, t.y);
  if (p) s.path = p;
}
function step(s, dt){
  const n = s.path[0], tx = n.x * M.TS, ty = n.y * M.TS - 8;
  const dx = tx - s.x, dy = ty - s.y, dist = Math.hypot(dx, dy), st = SPEED * dt / 1000;
  if (dist <= st){ s.x = tx; s.y = ty; s.path.shift(); }
  else { s.x += dx / dist * st; s.y += dy / dist * st; }
  s.ft += dt; if (s.ft > 150){ s.frame = 1 - s.frame; s.ft = 0; }
  s.mode = "walk";
  if (Math.abs(dx) > Math.abs(dy)) s.dir = dx > 0 ? "r" : "l"; else s.dir = dy > 0 ? "d" : "u";
}

function tick(dt){
  for (const s of sprites){
    for (const k of ["check", "reject", "error", "flash", "jump"])
      if (s[k] > 0) s[k] = Math.max(0, s[k] - dt);
    if (s.lying) continue;
    if (paused){ s.mode = s.mode === "walk" ? "sit" : s.mode; continue; }   // org en pausa: congelados
    if (s.bed){                                       // camino a la camilla
      if (!s.path.length){ acostar(s); continue; }
      step(s, dt); continue;
    }
    if (s.forceRoute){                                // p.ej. rechazo: ida y vuelta
      if (!s.path.length){
        const next = s.forceRoute.shift();
        if (!next){ s.forceRoute = null; continue; }
        setPath(s, next);
        if (!s.path.length){ s.forceRoute = null; continue; }
      }
      step(s, dt); continue;
    }
    if (s.meetSpot){                                  // mesa de reuniones (trigger real)
      const at = Math.round(s.x / M.TS) === s.meetSpot.x && Math.round((s.y + 8) / M.TS) === s.meetSpot.y;
      if (at){ s.mode = "stand"; s.path = []; continue; }
      if (!s.path.length) setPath(s, s.meetSpot);
      if (s.path.length && !REDUCED) step(s, dt);
      else { s.x = s.meetSpot.x * M.TS; s.y = s.meetSpot.y * M.TS - 8; s.path = []; }
      continue;
    }
    const atHome = Math.abs(s.x - s.home.x * M.TS) < 2 && Math.abs(s.y - (s.home.y * M.TS - 8)) < 2;
    if (s.want === "sit" || s.want === "sleep"){
      if (atHome){ s.mode = s.want; s.path = []; }
      else if (!s.path.length) setPath(s, s.home);
    } else {
      if (s.mode === "sit" || s.mode === "sleep"){ s.mode = "wander"; s.pause = 400; }
      if (!s.path.length){
        if (s.pause > 0) s.pause -= dt;
        else {
          let target;                       // 12% de las veces: viaje a la máquina de café
          if (Math.random() < 0.12){
            const cs = M.COFFEE.stand[(Math.random() * M.COFFEE.stand.length) | 0];
            target = {x: cs[0], y: cs[1]};
          } else target = randomRoomTile(s);
          setPath(s, target);
          s.pause = 900 + Math.random() * 2600;
        }
      }
    }
    if (s.path.length && !REDUCED) step(s, dt);
    else if (s.mode === "walk") s.mode = s.want === "wander" ? "wander" : s.want;
    if (s.mode === "sleep" && Math.random() < dt / 1600)
      particles.push({x: s.x + 12, y: s.y - 4, vy: -8, a: 1, txt: "z"});
    const onCoffee = M.COFFEE.stand.some(([qx, qy]) =>
      Math.round(s.x / M.TS) === qx && Math.round((s.y + 8) / M.TS) === qy);
    if (onCoffee && !s.path.length && Math.random() < dt / 900)
      particles.push({x: M.COFFEE.x * M.TS + 10, y: M.COFFEE.y * M.TS - 8, vy: -10, a: .8, txt: "~"});
  }
  tickParticles(particles, dt);
}

/* ---------- dibujo ---------- */
function drawHeat(c){
  if (!heat.on) return;
  const act = heat.metrics && heat.metrics.actividad_gateway;
  if (!act) return;
  let max = 1;
  const suma = {};
  for (const [slug, serie] of Object.entries(act)){
    suma[slug] = (Array.isArray(serie) ? serie : []).reduce((t, p) => t + (p && p.n || 0), 0);
    if (suma[slug] > max) max = suma[slug];
  }
  for (const d of desks){
    const v = suma[d.sq.slug] || 0;
    if (!v) continue;
    c.fillStyle = `rgba(255,120,30,${(0.10 + 0.4 * v / max).toFixed(3)})`;
    c.fillRect(d.x * M.TS - 4, d.y * M.TS - 8, d.w * M.TS + 8, 2.6 * M.TS);
  }
}
function drawDeskCalor(c, now){
  for (const d of desks){
    const st = d.sq.estado || d.sq.regimen || "frio";
    // calor por escritorio: working cálida brillante · caliente media · frío azulada
    const glow = st === "working" ? "rgba(255,190,80,.20)"
      : st === "caliente" ? "rgba(255,170,90,.10)" : "rgba(90,140,200,.08)";
    c.fillStyle = glow;
    c.fillRect(d.x * M.TS - 2, d.y * M.TS - 6, d.w * M.TS + 4, 2.4 * M.TS);
    if (st !== "working") continue;
    const mx = (d.x + ((d.w / 2) | 0)) * M.TS, my = d.y * M.TS;
    c.fillStyle = (REDUCED || (now / 480 | 0) % 2) ? "#48f08a" : "#173324";
    c.fillRect(mx + 3, my - 3, 10, 7);
  }
}
function drawFounderDesk(c){
  const fd = M.FOUNDER_DESK, fx = fd.x * M.TS, fy = fd.y * M.TS;
  const pilas = [["briefs", "#efe6d6"], ["preguntas", "#8ec4f8"], ["decisiones", "#fcd34d"]];
  pilas.forEach(([k, col], i) => {
    const n = Math.min(founderCounts[k], 6);
    for (let j = 0; j < n; j++){
      c.fillStyle = col; c.fillRect(fx + 3 + i * 14, fy + 9 - j * 2, 10, 2);
      c.fillStyle = "rgba(0,0,0,.25)"; c.fillRect(fx + 3 + i * 14, fy + 10 - j * 2, 10, 1);
    }
  });
  const total = founderCounts.briefs + founderCounts.preguntas + founderCounts.decisiones;
  if (total > 0){                                   // sobre + sello si hay pendientes
    c.fillStyle = "#efe6d6"; c.fillRect(fx + fd.w * M.TS - 13, fy + 4, 9, 6);
    c.fillStyle = "#b9534f"; c.fillRect(fx + fd.w * M.TS - 11, fy + 6, 3, 3);
  }
}
function drawPausedFx(c, now){
  if (!paused) return;
  c.fillStyle = "rgba(190,30,30,.14)"; c.fillRect(0, 0, M.LW, M.LH);
  const on = REDUCED || ((now / 600 | 0) % 2);
  c.fillStyle = on ? "#ef4444" : "#5b1414";
  c.fillRect(M.LW / 2 - 5, 4, 10, 8);
  c.font = "bold 12px monospace"; c.fillStyle = on ? "#ffb4b4" : "#c98";
  c.fillText("⏸ ORG EN PAUSA", M.LW / 2 - 52, 26);
}

function loop(now){
  requestAnimationFrame(loop);
  const dt = Math.min(50, now - lastFrame); lastFrame = now;
  const vis = visible();
  if (vis && !wasVisible && queue.length){            // al volver: reproducir cola
    const q = queue; queue = [];
    for (const fn of q){ try{ fn(); }catch(e){ /* reacción fallida: seguimos */ } }
  }
  wasVisible = vis;
  if (!built || !vis) return;                        // no tickea oculto; la cola igual acumula
  tick(dt);
  ctx.clearRect(0, 0, M.LW, M.LH);
  ctx.drawImage(mapCv, 0, 0);
  drawDeskCalor(ctx, now);
  drawHeat(ctx);
  drawFounderDesk(ctx);
  for (const h of armoryHits) drawItemIcon(ctx, h);
  if (armoryExtra > 0){
    ctx.fillStyle = "#c8a455"; ctx.font = "9px monospace";
    ctx.fillText(`+${armoryExtra}`, (M.ARMORY_SHELVES[1].x1) * M.TS, (M.ARMORY_SHELVES[1].y + 2) * M.TS);
  }
  drawWarMini(ctx);
  for (const s of [...sprites].sort((a, b) => a.y - b.y)){
    const jy = s.jump > 0 && !REDUCED ? -Math.abs(Math.sin(now / 120)) * 5 : 0;
    if (jy){ ctx.save(); ctx.translate(0, jy); }
    drawDude(ctx, s, now);
    if (jy) ctx.restore();
  }
  ctx.font = "9px monospace";
  for (const p of particles) drawParticle(ctx, p);
  if (drag && drag.tipo === "item"){
    drawItemIcon(ctx, {it: drag.it, px: drag.x - 6, py: drag.y - 6});
  }
  drawPausedFx(ctx, now);
}

/* ---------- mouse: tooltip, clicks, drag de items ---------- */
function canvasXY(e){
  const r = cv.getBoundingClientRect();
  return {x: (e.clientX - r.left) / r.width * M.LW, y: (e.clientY - r.top) / r.height * M.LH};
}
function hitSprite(x, y){
  for (const s of [...sprites].sort((a, b) => b.y - a.y))
    if (x >= s.x - 2 && x <= s.x + 18 && y >= s.y - 6 && y <= s.y + 26) return s;
  return null;
}
function hitItem(x, y){
  for (const h of armoryHits)
    if (x >= h.px - 2 && x <= h.px + h.w + 2 && y >= h.py - 2 && y <= h.py + h.h + 2) return h;
  return null;
}
function inRect(x, y, r){
  return x >= r.x0 * M.TS && x <= (r.x1 + 1) * M.TS && y >= r.y0 * M.TS && y <= (r.y1 + 1) * M.TS;
}
function hitFounderDesk(x, y){
  const fd = M.FOUNDER_DESK;
  return x >= fd.x * M.TS - 4 && x <= (fd.x + fd.w) * M.TS + 4 &&
         y >= fd.y * M.TS - 8 && y <= (fd.y + 2) * M.TS;
}

function tipLinea(parent, texto, bold){
  const div = document.createElement("div");
  if (bold){ const b = document.createElement("b"); b.textContent = texto; div.appendChild(b); }
  else div.textContent = texto;
  parent.appendChild(div);
}
function mostrarTooltip(e, build){
  const tip = overlayEls.tip;
  tip.textContent = "";
  build(tip);
  const sr = cv.parentElement.getBoundingClientRect();
  tip.style.left = Math.min(e.clientX - sr.left + 14, sr.width - 270) + "px";
  tip.style.top = (e.clientY - sr.top + 14) + "px";
  tip.style.display = "block";
}

function onMove(e){
  const {x, y} = canvasXY(e);
  if (drag){ drag.x = x; drag.y = y; return; }
  const it = hitItem(x, y);
  if (it){
    mostrarTooltip(e, tip => {
      tipLinea(tip, it.it.nombre || it.it.id, true);
      tipLinea(tip, `clase: ${it.it.clase || "sin datos"} · origen: ${it.it.origen || "sin datos"}`);
      tipLinea(tip, it.it.equipable ? "arrástralo a un agente para equipar (crea draft)"
                                    : "no equipable (informativo)");
      if (it.it.sensible) tipLinea(tip, "🔒 requiere confirmación del Supervisor");
    });
    cv.style.cursor = it.it.equipable ? "grab" : "default";
    return;
  }
  const sp = hitSprite(x, y);
  if (sp){
    mostrarTooltip(e, tip => {
      tipLinea(tip, `${sp.rol} · ${sp.modelo}${sp.fable ? " ◆" : ""}${sp.j ? " (J)" : ""}`, true);
      const d = desks.find(dd => dd.sq.slug === sp.squad);
      const st = d ? (d.sq.estado || d.sq.regimen || "frio") : "frio";
      const act = d && d.sq.mision_activa;
      const estadoTxt = sp.estado_agente === "cuarentena" ? "en cuarentena (enfermería)"
        : sp.estado_agente === "pausado" ? "pausado"
        : st === "working" ? "trabajando en " + (act ? act.id_corto : "su misión")
        : st === "caliente" ? "idle (deambulando)" : st === "mixto" ? "frío (mixto)" : "frío";
      tipLinea(tip, `${(d && d.sq.nombre) || sp.squad} — ${estadoTxt}`);
      tipLinea(tip, sp.agente ? `agente: ${sp.agente}${sp.compartido ? " (asiento compartido entre squads)" : ""}`
                              : "agente: sin datos");
      tipLinea(tip, sp.tools.length
        ? `cinturón: ${sp.tools.slice(0, 6).join(", ")}${sp.tools.length > 6 ? ` +${sp.tools.length - 6}` : ""} — declarado en frontmatter, montaje no garantizado (regla F5)`
        : "cinturón: sin datos");
    });
    cv.style.cursor = "pointer";
    return;
  }
  if (hitFounderDesk(x, y) || (warMiniHit && x >= warMiniHit.px && x <= warMiniHit.px + warMiniHit.w &&
      y >= warMiniHit.py && y <= warMiniHit.py + warMiniHit.h) || inRect(x, y, M.ROOMS["Biblioteca"])){
    cv.style.cursor = "pointer";
  } else cv.style.cursor = "default";
  overlayEls.tip.style.display = "none";
}

let downAt = null;
function onDown(e){
  const {x, y} = canvasXY(e);
  downAt = {x, y};
  const it = hitItem(x, y);
  if (it && it.it.equipable) drag = {tipo: "item", it: it.it, x, y};   // SOLO equipable:true
}
function onUp(e){
  const {x, y} = canvasXY(e);
  if (drag && drag.tipo === "item"){
    const moved = downAt && Math.hypot(x - downAt.x, y - downAt.y) > 4;
    const sp = hitSprite(x, y);
    const item = drag.it; drag = null;
    if (moved && sp){
      if (sp.agente && cbs.onItemDrop) cbs.onItemDrop({item_id: item.id, agente: sp.agente, squad: sp.squad});
      else showBubble(null, sp.squad, "este asiento no tiene agente real (sin datos)");
    }
    if (moved) return;
  }
  drag = null;
  if (!downAt || Math.hypot(x - downAt.x, y - downAt.y) > 6){ downAt = null; return; }
  downAt = null;
  const sp = hitSprite(x, y);
  if (sp){
    if (sp.kind === "lead"){ if (cbs.onLeadClick) cbs.onLeadClick({squad: sp.squad}); }
    else if (cbs.onSpriteClick) cbs.onSpriteClick({agente: sp.agente, squad: sp.squad});
    return;
  }
  if (hitFounderDesk(x, y)){ if (cbs.onDeskClick) cbs.onDeskClick({}); return; }
  if (warMiniHit && x >= warMiniHit.px && x <= warMiniHit.px + warMiniHit.w &&
      y >= warMiniHit.py && y <= warMiniHit.py + warMiniHit.h){
    window.dispatchEvent(new CustomEvent("office:navigate", {detail: {view: "guerra"}}));
    return;
  }
  if (inRect(x, y, M.ROOMS["Biblioteca"])){
    window.dispatchEvent(new CustomEvent("office:navigate", {detail: {view: "biblioteca"}}));
  }
}

/* ---------- tablero de guerra completo (vista guerra; MISMO render reusado) ---------- */
const warState = new WeakMap();   // canvas → {layout, drag}
export function renderWarBoard(canvas){
  if (!canvas) return;
  let st = warState.get(canvas);
  if (!st){
    st = {layout: null, drag: null};
    warState.set(canvas, st);
    canvas.addEventListener("mousedown", e => warDown(canvas, st, e));
    canvas.addEventListener("mousemove", e => warMove(canvas, st, e));
    canvas.addEventListener("mouseup", e => warUp(canvas, st, e));
    canvas.addEventListener("mouseleave", () => { st.drag = null; pintarWar(canvas, st); });
  }
  st.layout = layoutWar();
  canvas.width = st.layout.w; canvas.height = st.layout.h;
  pintarWar(canvas, st);
}

function layoutWar(){
  const dag = store && store.dag;
  const nodos = dag ? unwrap(dag, "nodos") : [];
  const aristas = dag && Array.isArray(dag.aristas) ? dag.aristas : [];
  const crit = dag && Array.isArray(dag.camino_critico) ? dag.camino_critico : [];
  const critSet = new Set(crit);
  const dockSquads = squads.map(q => q.slug);
  const idx = {}; nodos.forEach((n, i) => idx[n.id] = i);
  const preds = {};                                  // a depende de de: arista [de,a]
  for (const ar of aristas){
    if (!Array.isArray(ar) || ar.length < 2) continue;
    (preds[ar[1]] = preds[ar[1]] || []).push(ar[0]);
  }
  const depth = {};
  const enCiclo = new Set(nodos.filter(n => (n.status_calc || n.status) === "ciclo").map(n => n.id));
  const calc = (id, seen) => {                       // profundidad sin ciclos (guard con `seen`)
    if (depth[id] != null) return depth[id];
    if (seen.has(id) || enCiclo.has(id)) return 0;
    seen.add(id);
    let d = 0;
    for (const p of preds[id] || []) if (idx[p] != null) d = Math.max(d, calc(p, seen) + 1);
    depth[id] = d; return d;
  };
  for (const n of nodos) calc(n.id, new Set());
  const cols = {};
  const boxes = nodos.map(n => {
    const d = enCiclo.has(n.id) ? 0 : (depth[n.id] || 0);
    const fila = (cols[d] = (cols[d] || 0) + 1) - 1;
    return {id: n.id, n, x: 24 + d * 196, y: 30 + fila * 76, w: 168, h: 58,
            st: n.status_calc || n.status || "sin-datos", crit: critSet.has(n.id), ciclo: enCiclo.has(n.id)};
  });
  const maxX = boxes.reduce((t, b) => Math.max(t, b.x + b.w), 220);
  const maxY = boxes.reduce((t, b) => Math.max(t, b.y + b.h), 200);
  const dockX = maxX + 40;
  const dock = dockSquads.map((slug, i) => ({slug, x: dockX, y: 48 + i * 30, w: 150, h: 24}));
  return {boxes, dock, critIds: crit, aristas,
          w: Math.max(dockX + 174, 760), h: Math.max(maxY + 30, 48 + dockSquads.length * 30 + 20)};
}

function pintarWar(canvas, st){
  const c = canvas.getContext("2d");
  const L = st.layout;
  c.fillStyle = "#14100b"; c.fillRect(0, 0, canvas.width, canvas.height);
  if (!L || !L.boxes.length){
    c.fillStyle = "#8a8178"; c.font = "13px monospace";
    c.fillText("sin datos (esperando /api/dag)", 24, 40);
    return;
  }
  c.font = "11px monospace";
  const byId = {}; for (const b of L.boxes) byId[b.id] = b;
  const critPares = new Set();
  for (let i = 0; i + 1 < L.critIds.length; i++) critPares.add(L.critIds[i] + "→" + L.critIds[i + 1]);
  for (const ar of L.aristas){                       // flecha de→a (a depende de de)
    if (!Array.isArray(ar)) continue;
    const A = byId[ar[0]], B = byId[ar[1]];
    if (!A || !B) continue;
    const esCrit = critPares.has(ar[0] + "→" + ar[1]);
    c.strokeStyle = esCrit ? "#ffd166" : "#5a4f40"; c.lineWidth = esCrit ? 2.5 : 1.5;
    const x1 = A.x + A.w, y1 = A.y + A.h / 2, x2 = B.x, y2 = B.y + B.h / 2;
    c.beginPath(); c.moveTo(x1, y1);
    c.bezierCurveTo(x1 + 24, y1, x2 - 24, y2, x2, y2); c.stroke();
    c.fillStyle = esCrit ? "#ffd166" : "#5a4f40";
    c.beginPath(); c.moveTo(x2, y2); c.lineTo(x2 - 8, y2 - 4); c.lineTo(x2 - 8, y2 + 4); c.fill();
  }
  for (const b of L.boxes){
    if (st.drag && st.drag.id === b.id) continue;
    pintarCaja(c, b, b.x, b.y);
  }
  c.fillStyle = "#c8a455"; c.font = "bold 11px monospace";
  c.fillText("ASIGNAR A SQUAD ▾ (arrastra una caja ready)", L.dock.length ? L.dock[0].x : 24, 30);
  for (const d of L.dock){
    c.fillStyle = "#241e19"; c.fillRect(d.x, d.y, d.w, d.h);
    c.strokeStyle = "#54422f"; c.lineWidth = 1.5; c.strokeRect(d.x, d.y, d.w, d.h);
    c.fillStyle = "#d8cdbb"; c.font = "11px monospace";
    c.fillText(d.slug, d.x + 8, d.y + 16);
  }
  if (st.drag){
    const b = byId[st.drag.id];
    if (b) pintarCaja(c, b, st.drag.x - b.w / 2, st.drag.y - b.h / 2, true);
  }
  c.fillStyle = "#8a8178"; c.font = "10px monospace";
  c.fillText("🔒 blocked · ⚙ processing · ✦ ready · J blocked-on-founder · dorado = camino crítico", 24, canvas.height - 10);
}

function pintarCaja(c, b, x, y, ghost){
  if (ghost) c.globalAlpha = .75;
  const col = ST_COLOR[b.st] || "#555";
  c.fillStyle = "#1f1812"; c.fillRect(x, y, b.w, b.h);
  if (b.st === "ready" && !ghost){                    // brillo ready
    c.save(); c.shadowColor = "#ffd166"; c.shadowBlur = 10;
    c.strokeStyle = "#ffd166"; c.lineWidth = 2; c.strokeRect(x, y, b.w, b.h); c.restore();
  }
  c.strokeStyle = b.crit ? "#ffd166" : col; c.lineWidth = b.crit ? 3 : 2;
  c.strokeRect(x, y, b.w, b.h);
  c.fillStyle = col; c.fillRect(x, y, b.w, 4);
  c.fillStyle = "#f0e6d8"; c.font = "bold 12px monospace";
  c.fillText(String(b.n.id_corto || b.id).slice(0, 18), x + 8, y + 20);
  c.fillStyle = "#8a8178"; c.font = "10px monospace";
  c.fillText(String(b.n.squad || "squad sin datos").slice(0, 20), x + 8, y + 34);
  c.fillStyle = col;
  c.fillText(b.st + (b.ciclo ? " ⚠" : ""), x + 8, y + 50);
  const gx = x + b.w - 18, gy = y + 10;
  if (b.st === "blocked"){                            // candado
    c.fillStyle = "#8a8178"; c.fillRect(gx, gy + 4, 12, 8);
    c.strokeStyle = "#8a8178"; c.lineWidth = 2;
    c.beginPath(); c.arc(gx + 6, gy + 4, 4, Math.PI, 0); c.stroke();
  } else if (b.st === "processing"){                  // engranaje
    c.strokeStyle = "#f5a623"; c.lineWidth = 2;
    c.beginPath(); c.arc(gx + 6, gy + 7, 5, 0, Math.PI * 2); c.stroke();
    c.fillStyle = "#f5a623"; c.fillRect(gx + 4, gy + 5, 4, 4);
  } else if (b.st === "ready"){
    c.fillStyle = "#ffd166"; c.font = "12px monospace"; c.fillText("✦", gx, gy + 12);
  } else if (b.st === "blocked-on-founder"){
    c.fillStyle = "#ffd166"; c.font = "bold 13px monospace"; c.fillText("J", gx + 2, gy + 12);
  } else if (b.st === "completed"){
    c.fillStyle = "#4ade80"; c.font = "12px monospace"; c.fillText("✓", gx, gy + 12);
  }
  if (ghost) c.globalAlpha = 1;
}

function warXY(canvas, e){
  const r = canvas.getBoundingClientRect();
  return {x: (e.clientX - r.left) / r.width * canvas.width,
          y: (e.clientY - r.top) / r.height * canvas.height};
}
function warDown(canvas, st, e){
  if (!st.layout) return;
  const {x, y} = warXY(canvas, e);
  for (const b of st.layout.boxes)
    if (b.st === "ready" && x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h){
      st.drag = {id: b.id, x, y};                     // solo cajas ready se arrastran
      pintarWar(canvas, st);
      return;
    }
}
function warMove(canvas, st, e){
  if (!st.drag) return;
  const {x, y} = warXY(canvas, e);
  st.drag.x = x; st.drag.y = y;
  pintarWar(canvas, st);
}
function warUp(canvas, st, e){
  if (!st.drag) return;
  const {x, y} = warXY(canvas, e);
  const id = st.drag.id; st.drag = null;
  for (const d of st.layout.dock)
    if (x >= d.x && x <= d.x + d.w && y >= d.y && y <= d.y + d.h){
      if (cbs.onBoxDrag) cbs.onBoxDrag({mision_id: id, squad_destino: d.slug});
      break;
    }
  pintarWar(canvas, st);
}

/* ---------- init ---------- */
export function initOffice(opts){
  cv = opts.canvas; ovEl = opts.overlay;
  cbs = {onSpriteClick: opts.onSpriteClick, onItemDrop: opts.onItemDrop,
         onBoxDrag: opts.onBoxDrag, onLeadClick: opts.onLeadClick, onDeskClick: opts.onDeskClick};
  ctx = cv.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  cv.width = M.LW; cv.height = M.LH;
  overlayEls.tip = document.getElementById("tooltip");
  cv.addEventListener("mousemove", onMove);
  cv.addEventListener("mousedown", onDown);
  cv.addEventListener("mouseup", onUp);
  cv.addEventListener("mouseleave", () => { overlayEls.tip.style.display = "none"; drag = null; });
  lastFrame = performance.now();
  requestAnimationFrame(loop);
}
