/* MISSION CONTROL v2 — panels/agent-card.js (F-PANELS)
   Carta de agente estilo juego: retrato pixel por tier, stats REALES de
   /api/agents (null → "sin datos"), XP/nivel/barra, cinturón con leyenda F5,
   log tail y 3 acciones → drafts vía sendCommand. Anti-XSS: solo
   createElement/textContent — cero innerHTML. */

import { TIER_COLORS, TIER_DARK, MODELOS_TIERS, listaAgentes } from "../data.js";
import { abrirPanel } from "../views.js";

let data = null, office = null;

export function init(deps){
  data = (deps && deps.data) || null;
  office = (deps && deps.office) || null;
}

/* ---------- helpers DOM (textContent SIEMPRE) ---------- */
function el(tag, clase, texto){
  const n = document.createElement(tag);
  if (clase) n.className = clase;
  if (texto != null) n.textContent = String(texto);
  return n;
}

function hashDe(s){
  let h = 0;
  for (const c of String(s || "")) h = ((h << 5) - h + c.charCodeAt(0)) | 0;
  return Math.abs(h);
}

/* retrato pixel 16x24 escalado x4, paleta del tier */
function dibujarRetrato(cv, tier, nombre){
  const c = cv.getContext("2d");
  if (!c) return;
  cv.width = 64; cv.height = 96;
  c.imageSmoothingEnabled = false;
  const col = TIER_COLORS[tier] || TIER_COLORS.oss;
  const dark = TIER_DARK[tier] || TIER_DARK.oss;
  const h = hashDe(nombre);
  const skin = ["#f2c9a0", "#e0b186", "#c99a6f"][h % 3];
  const hair = ["#4a3320", "#2b2118", "#6b4a2a", "#3a3a3a"][h % 4];
  // S=4 px por celda; +2 filas de aire arriba para la coronita fable
  const S = 4, P = (x, y, w, hh, color) => { c.fillStyle = color; c.fillRect(x * S, (y + 2) * S, w * S, hh * S); };
  c.fillStyle = "#0d0a07"; c.fillRect(0, 0, 64, 96);
  P(3, 19, 4, 5, "#2b2118"); P(9, 19, 4, 5, "#2b2118");        // piernas
  P(2, 9, 12, 10, col); P(2, 9, 12, 2, dark);                  // cuerpo
  P(0, 11, 2, 5, dark); P(14, 11, 2, 5, dark);                 // brazos
  P(4, 1, 8, 8, skin); P(4, 0, 8, 3, hair);                    // cabeza
  P(6, 4, 1, 2, "#2b1d12"); P(9, 4, 1, 2, "#2b1d12");          // ojos
  if (tier === "fable"){                                       // coronita ◆
    P(4, -1, 8, 1, "#ffd166"); P(5, -2, 2, 1, "#ffd166"); P(9, -2, 2, 1, "#ffd166");
  }
}

function fmtUltimaActividad(v){
  if (v == null || v === "") return null;
  if (typeof v === "number"){
    const ms = v > 1e12 ? v : v * 1000;
    try { return new Date(ms).toLocaleString("es-EC", { hour12: false }); } catch (e) { return String(v); }
  }
  return String(v);
}

const ETIQUETA_SCHED = "sin datos (esperando SCHEDULER-V2)";
const STATS_FILAS = [
  ["runs", "corridas (gateway)"],
  ["tokens_in", "tokens in"],
  ["tokens_out", "tokens out"],
  ["ultima_actividad", "última actividad"],
  ["completadas", "misiones completadas"],
  ["aprobados", "reviews aprobadas"],
  ["rechazados", "reviews rechazadas"],
  ["tasa_aprobacion", "tasa de aprobación"],
  ["latencia_media", "latencia media"],
  ["intentos", "intentos"],
];
const SOLO_SCHEDULER = new Set(["latencia_media", "intentos"]);

function valorStat(k, v){
  if (v == null) return SOLO_SCHEDULER.has(k) ? ETIQUETA_SCHED : "sin datos";
  if (k === "ultima_actividad") return fmtUltimaActividad(v) || "sin datos";
  if (k === "tasa_aprobacion" && typeof v === "number")
    return v <= 1 ? Math.round(v * 100) + "%" : String(v);
  return String(v);
}

function buscarAgente(agente, squad){
  const lista = listaAgentes();
  return lista.find(a => a.agente === agente && a.squad === squad)
    || lista.find(a => a.agente === agente)
    || null;
}

/* ---------- carta ---------- */
export function open(agente, squad){
  const body = abrirPanel("Carta de agente");
  if (!body) return;
  const a = buscarAgente(agente, squad);
  if (!a){
    body.appendChild(el("div", "nodata",
      `sin datos (${agente || "?"} no aparece en /api/agents)`));
    return;
  }
  const tier = Object.prototype.hasOwnProperty.call(TIER_COLORS, a.tier) ? a.tier : "oss";
  const st = (a.stats && typeof a.stats === "object") ? a.stats : {};

  /* cabecera: retrato + identidad */
  const head = el("div", "acard-head");
  const cv = document.createElement("canvas");
  cv.className = "acard-retrato";
  dibujarRetrato(cv, tier, a.agente || a.rol);
  head.appendChild(cv);
  const idbox = el("div", "acard-id");
  idbox.appendChild(el("div", "acard-nombre", a.agente || "(sin agente asignado)"));
  idbox.appendChild(el("div", "acard-rol", `${a.rol || "?"} · ${a.squad || "?"}`));
  const tchip = el("span", `chip-tier chip-tier-${tier}`, tier);
  tchip.style.borderColor = TIER_COLORS[tier];
  tchip.style.color = TIER_COLORS[tier];
  idbox.appendChild(tchip);
  idbox.appendChild(el("div", "acard-modelo",
    `modelo: ${a.modelo || "sin datos"}` + (a.model_override ? ` · override: ${a.model_override}` : "")));
  idbox.appendChild(el("div", `acard-estado est-${a.estado_agente || "activo"}`,
    `estado: ${a.estado_agente || "activo"}`));
  if (a.compartido) idbox.appendChild(el("div", "acard-compartido", "(asiento compartido entre squads)"));
  head.appendChild(idbox);
  body.appendChild(head);

  /* misión actual */
  const mis = el("div", "acard-sec");
  mis.appendChild(el("h5", null, "Misión actual"));
  const ma = a.mision_actual;
  if (!ma) mis.appendChild(el("div", "nodata", "sin misión activa"));
  else if (typeof ma === "string") mis.appendChild(el("div", "acard-mision", ma));
  else mis.appendChild(el("div", "acard-mision",
    `${ma.id_corto || ma.id || "?"}${ma.titulo ? " · " + ma.titulo : ""}`));
  body.appendChild(mis);

  /* XP / nivel / barra */
  const xp = Number(st.xp) || 0;
  const nivel = Number(st.nivel) || (1 + Math.floor(Math.sqrt(xp / 10)));
  const base = 10 * (nivel - 1) * (nivel - 1), tope = 10 * nivel * nivel;
  const frac = tope > base ? Math.max(0, Math.min(1, (xp - base) / (tope - base))) : 0;
  const xpSec = el("div", "acard-sec");
  xpSec.appendChild(el("h5", null, `Nivel ${nivel} · ${xp} XP`));
  const barra = el("div", "acard-xpbar");
  const fill = el("div", "acard-xpfill");
  fill.style.width = Math.round(frac * 100) + "%";
  barra.appendChild(fill);
  xpSec.appendChild(barra);
  xpSec.appendChild(el("div", "acard-nota", "XP = 10×completadas + 5×aprobados (historia desde 2026-06-10)"));
  body.appendChild(xpSec);

  /* stats reales */
  const statsSec = el("div", "acard-sec");
  statsSec.appendChild(el("h5", null, "Stats"));
  const grid = el("div", "acard-stats");
  for (const [k, label] of STATS_FILAS){
    grid.appendChild(el("div", "acard-stat-k", label));
    grid.appendChild(el("div", "acard-stat-v", valorStat(k, st[k])));
  }
  statsSec.appendChild(grid);
  if (a.compartido) statsSec.appendChild(el("div", "acard-nota", "stats org-wide (asiento compartido entre squads)"));
  body.appendChild(statsSec);

  /* cinturón */
  const beltSec = el("div", "acard-sec");
  beltSec.appendChild(el("h5", null, "Cinturón"));
  const tools = Array.isArray(a.tools) ? a.tools : [];
  const skills = Array.isArray(a.skills) ? a.skills : [];
  if (!tools.length && !skills.length){
    beltSec.appendChild(el("div", "nodata", "sin datos"));
  } else {
    const chips = el("div", "acard-belt");
    for (const t of tools) chips.appendChild(el("span", "chip-belt", t));
    for (const s of skills) chips.appendChild(el("span", "chip-belt chip-skill", s));
    beltSec.appendChild(chips);
  }
  beltSec.appendChild(el("div", "acard-nota",
    "declarado en frontmatter — montaje no garantizado (regla F5)"));
  body.appendChild(beltSec);

  /* log tail */
  const logSec = el("div", "acard-sec");
  logSec.appendChild(el("h5", null, "Log"));
  const logCont = el("div", "acard-log", "");
  const logBtn = el("button", "btn-mc", "cargar log");
  logBtn.type = "button";
  logBtn.addEventListener("click", async () => {
    logBtn.disabled = true;
    logCont.textContent = "cargando…";
    const r = data && data.fetchAgentLog ? await data.fetchAgentLog(a.agente) : null;
    renderLog(logCont, r);
    logBtn.disabled = false;
  });
  logSec.appendChild(logBtn);
  logSec.appendChild(logCont);
  body.appendChild(logSec);

  /* acciones (3) → drafts */
  const accSec = el("div", "acard-sec");
  accSec.appendChild(el("h5", null, "Acciones (crean drafts — los ejecuta el Supervisor)"));
  const hint = el("div", "acard-hint", "");
  const formHost = el("div", "acard-form-host");
  const botones = el("div", "acard-acciones");

  const bModelo = el("button", "btn-mc", "⇄ reasignar modelo");
  bModelo.type = "button";
  bModelo.addEventListener("click", () => formReasignar(formHost, a, hint));
  const bNudge = el("button", "btn-mc", "✉ nudge");
  bNudge.type = "button";
  bNudge.addEventListener("click", () => formNudge(formHost, a, hint));
  const pausado = a.estado_agente === "pausado";
  const bPausa = el("button", "btn-mc", pausado ? "▶ reanudar" : "⏸ pausar");
  bPausa.type = "button";
  bPausa.addEventListener("click", () => formPausa(formHost, a, hint, pausado));
  botones.appendChild(bModelo); botones.appendChild(bNudge); botones.appendChild(bPausa);
  accSec.appendChild(botones);
  accSec.appendChild(formHost);
  accSec.appendChild(hint);
  body.appendChild(accSec);
}

function renderLog(cont, r){
  cont.textContent = "";
  if (!r || typeof r !== "object"){
    cont.textContent = "sin datos (¿corre el server?)";
    return;
  }
  let algo = false;
  for (const [k, v] of Object.entries(r)){
    if (v == null) continue;
    algo = true;
    cont.appendChild(el("div", "acard-log-k", k));
    const pre = el("pre", "acard-log-pre");
    if (Array.isArray(v)) pre.textContent = v.map(x => typeof x === "string" ? x : JSON.stringify(x)).join("\n") || "(vacío)";
    else if (typeof v === "string") pre.textContent = v || "(vacío)";
    else pre.textContent = JSON.stringify(v, null, 1);
    cont.appendChild(pre);
  }
  if (!algo) cont.textContent = "sin datos";
}

/* ---------- formularios de acción ---------- */
async function mandar(hint, btn, tipo, payload){
  btn.disabled = true;
  hint.textContent = "enviando draft…";
  const r = data && data.sendCommand ? await data.sendCommand(tipo, payload) : null;
  hint.textContent = (r && r.hint) ? r.hint : "sin datos (¿corre el server?)";
  btn.disabled = false;
}

function formReasignar(host, a, hint){
  host.textContent = "";
  const f = el("div", "acard-form");
  f.appendChild(el("label", null, "modelo nuevo (tabla de tiers §3):"));
  const sel = document.createElement("select");
  for (const m of MODELOS_TIERS){
    const o = document.createElement("option");
    o.value = m; o.textContent = m;
    sel.appendChild(o);
  }
  const go = el("button", "btn-mc btn-go", "crear draft reasignar_modelo");
  go.type = "button";
  go.addEventListener("click", () =>
    mandar(hint, go, "reasignar_modelo", { agente: a.agente, squad: a.squad, modelo_nuevo: sel.value }));
  f.appendChild(sel); f.appendChild(go);
  host.appendChild(f);
}

function formNudge(host, a, hint){
  host.textContent = "";
  const f = el("div", "acard-form");
  f.appendChild(el("label", null, "mensaje (≤500 — lo entrega el Supervisor en sesión):"));
  const ta = document.createElement("textarea");
  ta.maxLength = 500; ta.rows = 3;
  const go = el("button", "btn-mc btn-go", "crear draft nudge");
  go.type = "button";
  go.addEventListener("click", () => {
    const mensaje = ta.value.trim();
    if (!mensaje){ hint.textContent = "el nudge necesita un mensaje"; return; }
    mandar(hint, go, "nudge", { agente: a.agente, squad: a.squad, mensaje });
  });
  f.appendChild(ta); f.appendChild(go);
  host.appendChild(f);
}

function formPausa(host, a, hint, pausado){
  host.textContent = "";
  const f = el("div", "acard-form");
  f.appendChild(el("label", null, "motivo (opcional):"));
  const inp = document.createElement("input");
  inp.type = "text"; inp.maxLength = 200;
  const tipo = pausado ? "reanudar_agente" : "pausar_agente";
  const go = el("button", "btn-mc btn-go", `crear draft ${tipo}`);
  go.type = "button";
  go.addEventListener("click", () => {
    const payload = { agente: a.agente, squad: a.squad };
    const motivo = inp.value.trim();
    if (motivo) payload.motivo = motivo;
    mandar(hint, go, tipo, payload);
  });
  f.appendChild(inp); f.appendChild(go);
  host.appendChild(f);
}
