/* MISSION CONTROL v2 — panels/juice.js (F-PANELS)
   El jugo: beeps WebAudio (default OFF, persistido en localStorage),
   leaderboard de XP reales, tablón → abre el canal, heatmap toggle →
   office.setHeatOverlay, celebración real al ver una transición a completed.
   Honestidad: sin XP → "sin datos todavía"; nada suena sin evento real. */

import { store, on, listaAgentes, TIER_COLORS } from "../data.js";
import { abrirPanel } from "../views.js";

let data = null, office = null;
let audioCtx = null;
let sonido = false;
let heatOn = false;
let completadasVistas = null;   // null = todavía sin snapshot (no celebrar historia)

const LS_KEY = "mcv2-sonido";

export function init(deps){
  data = (deps && deps.data) || null;
  office = (deps && deps.office) || null;
  try { sonido = localStorage.getItem(LS_KEY) === "on"; } catch (e) { sonido = false; }
  wireSoundToggle();
  wireHeatToggle();
  snapshotCompletadas();
  on("refresh:missions", vigilarCompletadas);
  on("refresh:metrics", () => {
    if (heatOn && office && typeof office.setHeatOverlay === "function"){
      try { office.setHeatOverlay(true, store.metrics); } catch (e) { /* motor parcial */ }
    }
  });
  on("org_event", sonidoDeEvento);
}

/* ---------- WebAudio (generado, cero assets) ---------- */
function ensureAudio(){
  if (audioCtx) return audioCtx;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    audioCtx = AC ? new AC() : null;
  } catch (e) { audioCtx = null; }
  return audioCtx;
}
function beep(frecuencias, durMs, tipo){
  if (!sonido) return;
  const ctx = ensureAudio();
  if (!ctx) return;
  try {
    if (ctx.state === "suspended") ctx.resume();
    let t = ctx.currentTime;
    const paso = (durMs || 120) / 1000;
    for (const f of (frecuencias || [440])){
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = tipo || "square";
      o.frequency.value = f;
      g.gain.setValueAtTime(0.06, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + paso);
      o.connect(g); g.connect(ctx.destination);
      o.start(t); o.stop(t + paso);
      t += paso;
    }
  } catch (e) { /* audio bloqueado: silencio honesto */ }
}
const SONIDOS = {
  ok: () => beep([880, 1175], 110, "triangle"),
  fanfare: () => beep([660, 880, 990, 1320], 140, "square"),
  rechazo: () => beep([220, 160], 180, "sawtooth"),
  alarma: () => beep([440, 330, 440, 330], 160, "square"),
  click: () => beep([660], 60, "triangle"),
};

function sonidoDeEvento(ev){
  if (!ev || typeof ev !== "object") return;
  if (ev.tipo === "review_verdict") (ev.verdict === "rechazado" ? SONIDOS.rechazo : SONIDOS.ok)();
  else if (ev.tipo === "pausa_org") SONIDOS.alarma();
  else if (ev.tipo === "reanudacion_org") SONIDOS.ok();
  else if (ev.tipo === "cuarentena") SONIDOS.rechazo();
}

/* ---------- toggles del header ---------- */
function pintarSoundBtn(btn){
  btn.textContent = sonido ? "🔊 sonido on" : "🔇 sonido off";
  btn.setAttribute("aria-pressed", sonido ? "true" : "false");
}
function wireSoundToggle(){
  const btn = document.getElementById("sound-toggle");
  if (!btn) return;
  pintarSoundBtn(btn);
  btn.addEventListener("click", () => {
    sonido = !sonido;
    try { localStorage.setItem(LS_KEY, sonido ? "on" : "off"); } catch (e) { /* sin storage */ }
    ensureAudio();          // crear el contexto EN el gesto del usuario
    pintarSoundBtn(btn);
    SONIDOS.click();
  });
}
function wireHeatToggle(){
  const t = document.getElementById("overlay-eff-toggle");
  if (!t) return;
  const aplicar = () => {
    if (office && typeof office.setHeatOverlay === "function"){
      try { office.setHeatOverlay(heatOn, store.metrics); } catch (e) { /* motor parcial */ }
    }
  };
  if (t.tagName === "INPUT" && t.type === "checkbox"){
    t.addEventListener("change", () => { heatOn = !!t.checked; aplicar(); });
  } else {
    t.addEventListener("click", () => {
      heatOn = !heatOn;
      t.setAttribute("aria-pressed", heatOn ? "true" : "false");
      t.classList.toggle("activo", heatOn);
      aplicar();
    });
  }
}

/* ---------- celebración REAL: transición a completed observada ---------- */
function setCompletadas(){
  const ms = (store.missions && Array.isArray(store.missions.missions)) ? store.missions.missions : null;
  if (!ms) return null;
  return new Set(ms.filter(m => m.carpeta === "completed").map(m => m.id));
}
function snapshotCompletadas(){
  completadasVistas = setCompletadas();   // historia previa: NO se celebra
}
function vigilarCompletadas(){
  const ahora = setCompletadas();
  if (!ahora) return;
  if (completadasVistas === null){ completadasVistas = ahora; return; }
  for (const id of ahora){
    if (completadasVistas.has(id)) continue;
    if (office && typeof office.celebrate === "function"){
      try { office.celebrate(id); } catch (e) { /* motor parcial */ }
    }
    SONIDOS.fanfare();
    toast(`🎉 misión ${idCorto(id)} completada`);
  }
  completadasVistas = ahora;
}
function idCorto(id){
  const r = /-(m\d{3})-/.exec("-" + String(id) + "-");
  return r ? r[1].toUpperCase() : String(id);
}
function toast(texto){
  const t = document.createElement("div");
  t.className = "juice-toast";
  t.textContent = String(texto);
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 4500);
}

/* ---------- leaderboard (XP reales) ---------- */
export function openLeaderboard(){
  const body = abrirPanel("Leaderboard");
  if (!body) return;
  const sub = document.createElement("div");
  sub.className = "fd-nota";
  sub.textContent = "XP = 10×completadas + 5×aprobados (historia desde 2026-06-10)";
  body.appendChild(sub);

  const agentes = listaAgentes();
  // dedupe por agente (los compartidos aparecen por asiento con stats org-wide)
  const porAgente = new Map();
  for (const a of agentes){
    if (!a || !a.agente) continue;
    if (!porAgente.has(a.agente)) porAgente.set(a.agente, a);
  }
  const filas = [...porAgente.values()]
    .map(a => ({ a, xp: Number(a.stats && a.stats.xp) || 0 }))
    .filter(f => f.xp > 0)
    .sort((x, y) => y.xp - x.xp);

  if (!filas.length){
    const nd = document.createElement("div");
    nd.className = "nodata";
    nd.textContent = "sin datos todavía";
    body.appendChild(nd);
    return;
  }
  const maxXp = filas[0].xp || 1;
  filas.slice(0, 15).forEach((f, i) => {
    const row = document.createElement("div");
    row.className = "lb-row";
    const rk = document.createElement("span");
    rk.className = "lb-rank";
    rk.textContent = "#" + (i + 1);
    const dot = document.createElement("span");
    dot.className = "lb-dot";
    dot.style.background = TIER_COLORS[f.a.tier] || TIER_COLORS.oss;
    const nom = document.createElement("span");
    nom.className = "lb-nombre";
    nom.textContent = `${f.a.agente}${f.a.compartido ? " (compartido)" : ""}`;
    const niv = document.createElement("span");
    niv.className = "lb-nivel";
    niv.textContent = `nv ${Number(f.a.stats && f.a.stats.nivel) || 1} · ${f.xp} XP`;
    const barra = document.createElement("div");
    barra.className = "lb-bar";
    const fill = document.createElement("div");
    fill.className = "lb-fill";
    fill.style.width = Math.max(4, Math.round(f.xp / maxXp * 100)) + "%";
    barra.appendChild(fill);
    row.appendChild(rk); row.appendChild(dot); row.appendChild(nom);
    row.appendChild(niv); row.appendChild(barra);
    body.appendChild(row);
  });
}

/* ---------- tablón de anuncios → abre el canal ---------- */
export function openTablon(){
  const b = document.querySelector('.navbtn[data-view="canal"]');
  if (b){ b.click(); return; }
  // fallback si la navegación no es por .navbtn: main.js puede escuchar esto
  try { window.dispatchEvent(new CustomEvent("mcv2:nav", { detail: { view: "canal" } })); } catch (e) { /* sin efecto */ }
}
