/* MODO JUGADOR — engine/player.js (skill despacho-retro-rpg)
   El founder es un personaje controlable DENTRO del mundo-canvas existente:
   paso discreto por tiles (flechas/WASD), colisión contra la grilla viva de
   map.js (paredes/muebles/escritorios) + NPCs, e interacción con [Espacio/
   Enter] que dispara los handlers que YA existen (cero plomería nueva).
   MODO DUAL: el mouse (MODO MANDO) queda intacto; Esc siempre vuelve a mando.
   Render: canvas overlay propio sobre #office — el motor del mundo NO se toca.
   Anti-XSS: createElement/textContent. GBA puro: steps(), 2 frames, sin ease. */

import * as M from "./map.js";
import { getSpritesSnapshot, getArmoryHits } from "./office.js";
import { openConfirm } from "../panels/armory.js";
import { cerrarPanel } from "../views.js";

let cbs = {};                       // los MISMOS handlers que usa el mouse (main.js)
let activo = false;
let px = M.FOUNDER_DESK.chair.x, py = M.FOUNDER_DESK.chair.y;   // spawn: TU silla
let facing = "down";                // down | up | left | right
let pasoT = 0;                      // ts del último paso (cooldown GBA)
let animHasta = 0;                  // mientras now<animHasta, pierna alternada
let cv = null, ctx = null, indicador = null, dlg = null, dlgTimer = null, typeTimer = null;
let rafId = null;
const COOLDOWN = 140;               // ms por tile — cadencia GBA
const REDUCED = !!(window.matchMedia
  && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

const DIRS = {
  ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right",
  w: "up", s: "down", a: "left", d: "right", W: "up", S: "down", A: "left", D: "right",
};
const DELTA = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

export function init(deps){
  cbs = (deps && deps.cbs) || {};
  const stage = document.getElementById("stage");
  const office = document.getElementById("office");
  if (!stage || !office) return;

  cv = document.createElement("canvas");
  cv.id = "player-cv";
  cv.width = M.LW; cv.height = M.LH;
  cv.dataset.modo = "off";
  stage.appendChild(cv);
  ctx = cv.getContext("2d");
  if (ctx) ctx.imageSmoothingEnabled = false;

  indicador = document.createElement("div");
  indicador.id = "player-a";
  indicador.textContent = "A";
  indicador.hidden = true;
  stage.appendChild(indicador);   // a #stage: el motor LIMPIA #overlay al reconstruir

  dlg = document.createElement("div");
  dlg.id = "player-dlg";
  dlg.hidden = true;
  stage.appendChild(dlg);

  const btn = document.getElementById("player-toggle");
  if (btn) btn.addEventListener("click", toggle);

  // fase de CAPTURA: el player decide ANTES que los handlers de despacho/paneles,
  // así un mismo Esc nunca cierra dos cosas a la vez (bug cazado en walkthrough)
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("office:navigate", () => salir());   // navegar = volver a mando
}

export const isActive = () => activo;
export function toggle(){ if (activo) salir(); else entrar(); }

/* la alarma REAL interrumpe el modo jugador con la caja PELIGRO */
export function onAlarm(){
  if (!activo) return;
  salir();
  mostrarDlg("⚠ PELIGRO", "ORG EN PAUSA — pausa real del org. Vuelves al MODO MANDO.", true);
}

function vistaOficina(){
  const v = document.getElementById("view-oficina");
  return !!(v && v.classList.contains("active"));
}
const despachoVisible = () => { const d = document.getElementById("despacho-ov"); return !!(d && !d.hidden); };
const panelAbierto = () => { const p = document.getElementById("panel-root"); return !!(p && p.classList.contains("abierto")); };
const alarmaVisible = () => { const a = document.getElementById("alarm-modal"); return !!(a && !a.hidden); };
function algoEncima(){ return despachoVisible() || panelAbierto() || alarmaVisible(); }

export function entrar(){
  if (activo || !cv || !vistaOficina()) return;
  // la grilla viva la construye el motor; si el org está vacío no hay mundo
  if (!M.walkable(M.grid[M.gi(px, py)])){
    const c = M.roomCenterWalkable(M.ROOMS["Command"]);
    if (!c) return;                       // sin mundo construido: no hay juego
    px = c.x; py = c.y;
  }
  activo = true;
  document.body.classList.add("modo-jugador");
  cv.dataset.modo = "on";
  cv.dataset.tile = px + "," + py;
  actualizarBoton();
  mostrarDlg("MODO JUGADOR", "camina con flechas/WASD · [A]=Espacio para hablar · Esc vuelve al mando", false);
  loop();
}

export function salir(){
  if (!activo) return;
  activo = false;
  document.body.classList.remove("modo-jugador");
  if (cv){ cv.dataset.modo = "off"; if (ctx) ctx.clearRect(0, 0, M.LW, M.LH); }
  if (indicador) indicador.hidden = true;
  if (rafId){ cancelAnimationFrame(rafId); rafId = null; }
  actualizarBoton();
}

function actualizarBoton(){
  const btn = document.getElementById("player-toggle");
  if (btn){
    btn.textContent = activo ? "🕹 JUGADOR" : "🎮 MANDO";
    btn.classList.toggle("on", activo);
    btn.setAttribute("aria-pressed", activo ? "true" : "false");
  }
}

/* ---------- input ---------- */
function onKey(e){
  const tag = (document.activeElement && document.activeElement.tagName) || "";
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

  if (e.key === "Escape"){
    if (despachoVisible() || alarmaVisible()) return;  // su propio Esc/botón manda
    if (panelAbierto()){
      // en modo jugador, Esc cierra el panel (los paneles no tienen Esc propio:
      // sin esto quedás atrapado — bug cazado en el walkthrough)
      if (activo){ try{ cerrarPanel(); }catch(err){} e.preventDefault(); }
      return;
    }
    if (activo){ salir(); e.preventDefault(); }
    return;
  }
  const dir = DIRS[e.key];
  if (!activo){
    // una flecha activa el modo jugador (solo en la oficina, sin overlays)
    if (dir && vistaOficina() && !algoEncima()){
      e.preventDefault();
      entrar();
    }
    return;
  }
  if (algoEncima()) return;              // con un panel abierto, el teclado es de él
  if (dir){
    e.preventDefault();
    mover(dir);
    return;
  }
  if (e.key === " " || e.key === "Enter"){
    e.preventDefault();
    interactuar();
  }
}

function mover(dir){
  const now = performance.now();
  if (now - pasoT < COOLDOWN) return;
  pasoT = now;
  if (facing !== dir){ facing = dir; return; }   // GBA: primero girás, después caminás
  const [dx, dy] = DELTA[dir];
  const nx = px + dx, ny = py + dy;
  if (bloqueado(nx, ny)){ bump(); return; }
  px = nx; py = ny;
  animHasta = now + 120;                          // 2 frames de caminata
  if (cv) cv.dataset.tile = px + "," + py;
}

function bloqueado(tx, ty){
  if (!M.inb(tx, ty) || !M.walkable(M.grid[M.gi(tx, ty)])) return true;
  for (const sp of getSpritesSnapshot()){         // NPCs sólidos (ellos siguen su vida)
    const sx = Math.round(sp.x / M.TS), sy = Math.round((sp.y + 8) / M.TS);
    if (sx === tx && sy === ty) return true;
  }
  return false;
}

function bump(){
  if (cv && !REDUCED){
    cv.classList.remove("player-bump");
    void cv.offsetWidth;                          // reinicia la animación
    cv.classList.add("player-bump");
  }
  blip();
}

/* blip corto de pared — respeta el toggle global de sonido (juice.js) */
let actx = null;
function blip(){
  try{
    if (localStorage.getItem("mcv2-sonido") !== "on") return;
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = "square"; o.frequency.value = 110;
    g.gain.setValueAtTime(.04, actx.currentTime);
    g.gain.exponentialRampToValueAtTime(.001, actx.currentTime + .07);
    o.connect(g); g.connect(actx.destination);
    o.start(); o.stop(actx.currentTime + .08);
  }catch(e){ /* sin audio: el bump visual alcanza */ }
}

/* ---------- interacción: NPC ADYACENTE (prioridad) o el tile que MIRÁS ----------
   Los NPCs se mueven suave entre tiles (deambulan): matching por DISTANCIA al
   centro del player (≤ ~1.5 tiles), no por tile exacto — bug cazado en walkthrough. */
function objetivo(){
  const ccx = px * M.TS + 8, ccy = py * M.TS + 12;
  let mejor = null, mejorD = 1e9;
  for (const sp of getSpritesSnapshot()){
    const d = Math.abs(sp.x + 8 - ccx) + Math.abs(sp.y + 12 - ccy);
    if (d <= 26 && d < mejorD){ mejorD = d; mejor = sp; }
  }
  if (mejor)
    return { tipo: mejor.kind === "lead" ? "lead" : "agente", sp: mejor,
             tx: Math.round(mejor.x / M.TS), ty: Math.round((mejor.y + 8) / M.TS) };
  const [dx, dy] = DELTA[facing];
  const tx = px + dx, ty = py + dy;
  if (!M.inb(tx, ty)) return null;
  const fd = M.FOUNDER_DESK;
  if (ty === fd.y && tx >= fd.x && tx < fd.x + fd.w) return { tipo: "despacho", tx, ty };
  for (const h of getArmoryHits()){
    if (((h.px / M.TS) | 0) === tx && ((h.py / M.TS) | 0) === ty)
      return { tipo: "item", it: h.it, tx, ty };
  }
  for (const sh of M.LIB_SHELVES)
    if (ty === sh.y && tx >= sh.x0 && tx <= sh.x1) return { tipo: "biblioteca", tx, ty };
  const ww = M.WAR_WALL;
  if (tx >= ww.x && tx < ww.x + ww.w && ty >= ww.y && ty < ww.y + ww.h)
    return { tipo: "guerra", tx, ty };
  return null;
}

function interactuar(){
  const o = objetivo();
  if (!o) return;
  if (o.tipo === "agente"){
    const quien = o.sp.agente || "agente";
    const mis = o.sp.mision && (o.sp.mision.id_corto || o.sp.mision.id);
    mostrarDlg(quien, mis ? `⚙ trabajando en ${mis} — te muestro mi carta.` : "en mi escritorio — te muestro mi carta.", false);
    try{ cbs.onSpriteClick && cbs.onSpriteClick({ agente: o.sp.agente, squad: o.sp.squad }); }catch(e){}
  } else if (o.tipo === "lead"){
    mostrarDlg("LEAD de " + o.sp.squad, "«¿qué necesitas, jefe?»", false);
    try{ cbs.onLeadClick && cbs.onLeadClick({ squad: o.sp.squad }); }catch(e){}
  } else if (o.tipo === "despacho"){
    mostrarDlg("TU ESCRITORIO", "entrando al Despacho…", false);
    try{ cbs.onDeskClick && cbs.onDeskClick({}); }catch(e){}
  } else if (o.tipo === "item"){
    mostrarDlg("ARMERÍA", `${o.it && o.it.id ? o.it.id : "item"} — vitrina del arsenal.`, false);
    try{ openConfirm({ item_id: o.it && o.it.id, accion: "equipar_tool" }); }catch(e){}
  } else if (o.tipo === "biblioteca"){
    mostrarDlg("BIBLIOTECA", "abriendo el archivo del org…", false);
    window.dispatchEvent(new CustomEvent("office:navigate", { detail: { view: "biblioteca" } }));
  } else if (o.tipo === "guerra"){
    mostrarDlg("SALA DE GUERRA", "abriendo el tablero de campaña…", false);
    window.dispatchEvent(new CustomEvent("office:navigate", { detail: { view: "guerra" } }));
  }
}

/* ---------- caja de diálogo RPG inferior (typewriter en el 1er mensaje) ---------- */
function mostrarDlg(hablante, texto, peligro){
  if (!dlg) return;
  if (dlgTimer){ clearTimeout(dlgTimer); dlgTimer = null; }
  if (typeTimer){ clearInterval(typeTimer); typeTimer = null; }
  dlg.textContent = "";
  dlg.classList.toggle("peligro", !!peligro);
  const quien = document.createElement("b");
  quien.textContent = hablante;
  const cuerpo = document.createElement("span");
  dlg.appendChild(quien);
  dlg.appendChild(cuerpo);
  dlg.hidden = false;
  if (REDUCED){
    cuerpo.textContent = texto;
  } else {
    let i = 0;
    typeTimer = setInterval(() => {
      i += 1;
      cuerpo.textContent = texto.slice(0, i);
      if (i >= texto.length){ clearInterval(typeTimer); typeTimer = null; }
    }, 28);
  }
  dlgTimer = setTimeout(() => { dlg.hidden = true; }, 3400);
}

/* ---------- render: avatar + indicador A (canvas overlay propio) ---------- */
function loop(){
  if (!activo) return;
  if (!vistaOficina()){ salir(); return; }
  dibujar(performance.now());
  rafId = requestAnimationFrame(loop);
}

function dibujar(now){
  if (!ctx) return;
  ctx.clearRect(0, 0, M.LW, M.LH);
  const x = px * M.TS, y = py * M.TS - 8;
  const frame = now < animHasta ? (((now / 60) | 0) % 2) : 0;
  drawFounderDude(ctx, x, y, facing, frame);

  const o = objetivo();
  if (indicador){
    if (o){
      indicador.hidden = false;
      indicador.style.left = ((o.tx * M.TS + M.TS / 2) / M.LW * 100) + "%";
      indicador.style.top = ((o.ty * M.TS - 14) / M.LH * 100) + "%";
    } else indicador.hidden = true;
  }
}

/* sprite ORIGINAL del founder (16×24): traje tinta, camisa papel, corona oro.
   La referencia es el marcador ✉ del escritorio — mismo lenguaje, otro rango. */
function drawFounderDude(c, x, y, dir, frame){
  c.fillStyle = "rgba(0,0,0,.35)"; c.fillRect(x + 2, y + 22, 12, 3);     // sombra
  c.fillStyle = "#20243A";                                               // piernas traje
  if (frame){ c.fillRect(x + 3, y + 17, 4, 6); c.fillRect(x + 9, y + 18, 4, 5); }
  else { c.fillRect(x + 3, y + 18, 4, 5); c.fillRect(x + 9, y + 17, 4, 6); }
  c.fillStyle = "#20243A"; c.fillRect(x + 2, y + 9, 12, 9);              // saco
  c.fillStyle = "#F8F8E8"; c.fillRect(x + 6, y + 10, 4, 5);              // camisa
  c.fillStyle = "#F8C830"; c.fillRect(x + 2, y + 9, 12, 1);              // ribete oro
  c.fillStyle = "#E03028"; c.fillRect(x + 7, y + 11, 2, 3);              // corbata
  c.fillStyle = "#f2c9a0"; c.fillRect(x + 4, y + 1, 8, 8);               // cara
  c.fillStyle = "#2b1d12";                                               // pelo
  if (dir === "up"){ c.fillRect(x + 4, y + 1, 8, 7); }                   // de espaldas
  else c.fillRect(x + 4, y + 1, 8, 3);
  c.fillStyle = "#20243A";                                               // ojos según dir
  if (dir === "down"){ c.fillRect(x + 5, y + 5, 2, 2); c.fillRect(x + 9, y + 5, 2, 2); }
  else if (dir === "left"){ c.fillRect(x + 4, y + 5, 2, 2); }
  else if (dir === "right"){ c.fillRect(x + 10, y + 5, 2, 2); }
  c.fillStyle = "#F8C830";                                               // corona (3 puntas)
  c.fillRect(x + 3, y - 3, 10, 2);
  c.fillRect(x + 3, y - 5, 2, 2); c.fillRect(x + 7, y - 6, 2, 3); c.fillRect(x + 11, y - 5, 2, 2);
}
