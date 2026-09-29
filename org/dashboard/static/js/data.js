/* MISSION CONTROL v2 — data.js (F-PANELS)
   Única puerta del front a la API: store + fetch inicial + SSE con fallback a
   polling 5s + POSTs. Invariantes:
   - ningún fallo de red lanza: dato ausente queda null → la UI dice "sin datos";
   - un fetch fallido JAMÁS pisa un dato bueno ya cargado;
   - eventos emitidos: "refresh:<clave de store>" · "org_event" · "feed". */

export const store = {
  squads: null, missions: null, agents: null, armory: null,
  dag: null, founder: null, metrics: null, state: null, feed: null,
  despacho: null,
};

/* tabla alias→tier de §3 (misma paleta que el motor) */
export const TIER_COLORS = { fable: "#ffd166", opus: "#a78bfa", sonnet: "#60a5fa", oss: "#2dd4bf" };
export const TIER_DARK   = { fable: "#b8860b", opus: "#6d4fc1", sonnet: "#2f6fc4", oss: "#0f9488" };
/* modelos válidos para reasignar_modelo (tabla de tiers §3) */
export const MODELOS_TIERS = ["fable", "opus", "sonnet", "specialist", "premium", "constructor-code", "explorer-reason"];

export const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g,
  c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const listaSquads   = () => (store.squads && Array.isArray(store.squads.squads)) ? store.squads.squads : [];
export const listaMissions = () => (store.missions && Array.isArray(store.missions.missions)) ? store.missions.missions : [];
export const listaAgentes  = () => (store.agents && Array.isArray(store.agents.agentes)) ? store.agents.agentes : [];
export const missionsOk    = () => !!(store.missions && Array.isArray(store.missions.missions) && !store.missions.error);

/* ---------- emisor de eventos ---------- */
const listeners = new Map();
export function on(evento, cb){
  if (typeof cb !== "function") return;
  if (!listeners.has(evento)) listeners.set(evento, []);
  listeners.get(evento).push(cb);
}
function emit(evento, dato){
  for (const cb of (listeners.get(evento) || [])){
    try { cb(dato); } catch (e) { /* un listener roto no apaga el resto */ }
  }
}

/* ---------- red (defensiva: nunca lanza) ---------- */
async function getJSON(url){
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; }
}
async function postJSON(url, body){
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    let j = null;
    try { j = await r.json(); } catch (e) { j = null; }
    if (j && typeof j === "object") return j;
    if (r.status === 429) return { ok: false, id: null, hint: "rate-limit (429) — espera un minuto" };
    return { ok: false, id: null, hint: `sin datos (HTTP ${r.status})` };
  } catch (e) {
    return { ok: false, id: null, hint: "sin datos (¿corre el server?)" };
  }
}

export async function sendCommand(tipo, payload){
  return postJSON("/api/command", { tipo, payload: payload || {} });
}
export async function sendIntake(texto){
  return postJSON("/api/intake", { texto: String(texto == null ? "" : texto) });
}
export async function fireAlarm(token){
  return postJSON("/api/firealarm", { token: String(token == null ? "" : token), confirmar: true });
}
export async function fetchAgentLog(agente){
  return getJSON("/api/agent-log?agente=" + encodeURIComponent(String(agente == null ? "" : agente)));
}
export async function fetchFounderItem(id){
  return getJSON("/api/founder/item?id=" + encodeURIComponent(String(id == null ? "" : id)));
}
export async function fetchDoc(path){
  return getJSON("/api/doc?path=" + encodeURIComponent(String(path == null ? "" : path)));
}
export async function searchLibrary(q){
  return getJSON("/api/library?q=" + encodeURIComponent(String(q == null ? "" : q)));
}
export async function fetchDespachoBiblioteca(){
  return getJSON("/api/despacho/biblioteca");
}
export async function markDespacho(id, marca, ref){
  return postJSON("/api/despacho/marcar",
    { id: String(id == null ? "" : id), marca: String(marca == null ? "" : marca),
      ref: String(ref == null ? "" : ref) });
}

/* ---------- carga / refresh del store ---------- */
const ENDPOINTS = {
  squads: "/api/squads", missions: "/api/missions", agents: "/api/agents",
  armory: "/api/armory", dag: "/api/dag", founder: "/api/founder",
  metrics: "/api/metrics", state: "/api/state", despacho: "/api/despacho",
};
const huellas = {};

async function refetch(claves, emitirSiempre){
  await Promise.all(claves.map(async k => {
    if (!(k in ENDPOINTS)) return;
    const json = await getJSON(ENDPOINTS[k]);
    if (json === null) return;            // fallo: conservar lo último bueno
    let h = "";
    try { h = JSON.stringify(json); } catch (e) { h = String(Math.random()); }
    const cambio = h !== huellas[k];
    huellas[k] = h;
    store[k] = json;
    if (emitirSiempre || cambio) emit("refresh:" + k);
  }));
}

/* feed v2 (contrato intacto): acumulado en store.feed, dedupe por ts|tipo|texto */
let feedUltimoTs = 0;
const feedVistos = new Set();
async function refrescarFeed(){
  const data = await getJSON("/api/feed?since=" + feedUltimoTs);
  if (!data || !Array.isArray(data.eventos)) return;
  if (!Array.isArray(store.feed)) store.feed = [];
  const nuevos = [];
  for (const ev of data.eventos){
    if (!ev || typeof ev !== "object") continue;
    const key = ev.ts + "|" + ev.tipo + "|" + ev.texto;
    if (feedVistos.has(key)) continue;
    feedVistos.add(key);
    store.feed.push(ev);
    nuevos.push(ev);
    if (typeof ev.ts === "number" && ev.ts > feedUltimoTs) feedUltimoTs = ev.ts;
  }
  if (typeof data.ultimo_ts === "number" && data.ultimo_ts > feedUltimoTs) feedUltimoTs = data.ultimo_ts;
  while (store.feed.length > 400) store.feed.shift();
  if (nuevos.length) emit("feed", nuevos);
}

/* qué claves del store toca cada "que" del SSE (desconocido → todo, conservador) */
function clavesDe(que){
  const q = String(que || "").toLowerCase();
  if (q === "founder") return ["founder", "state", "despacho"];  // items founder alimentan el Despacho
  if (q in ENDPOINTS) return [q];
  if (q.includes("mision") || q.includes("mission")) return ["missions", "dag", "squads", "agents", "metrics", "state", "despacho"];
  if (q.includes("founder")) return ["founder", "state", "despacho"];
  if (q.includes("agent")) return ["agents", "state"];
  if (q.includes("paus")) return ["state"];
  if (q.includes("usage")) return ["agents", "metrics"];
  if (q.includes("security")) return ["metrics"];
  return Object.keys(ENDPOINTS);
}

/* ---------- SSE con fallback automático a polling 5s ---------- */
let es = null, pollTimer = null, sseRetryTimer = null;

function manejarMensaje(raw){
  let msg = null;
  try { msg = JSON.parse(raw); } catch (e) { return; }
  if (!msg || typeof msg !== "object") return;
  if (msg.tipo === "hello"){ pararPolling(); return; }
  if (msg.tipo === "refresh"){
    const que = Array.isArray(msg.que) ? msg.que : [msg.que];
    const claves = new Set();
    for (const q of que) for (const k of clavesDe(q)) claves.add(k);
    refetch([...claves], true);
    refrescarFeed();
    return;
  }
  if (msg.tipo === "org_event" && msg.evento && typeof msg.evento === "object"){
    emit("org_event", msg.evento);
  }
}

function conectarSSE(){
  if (typeof EventSource === "undefined"){ arrancarPolling(); return; }
  try { es = new EventSource("/api/stream"); }
  catch (e) { es = null; arrancarPolling(); return; }
  es.onmessage = e => manejarMensaje(e.data);
  es.onerror = () => {
    try { if (es) es.close(); } catch (e) { /* ya cerrado */ }
    es = null;
    arrancarPolling();
    if (!sseRetryTimer){
      sseRetryTimer = setTimeout(() => { sseRetryTimer = null; conectarSSE(); }, 60000);
    }
  };
}
function arrancarPolling(){
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    await refetch(Object.keys(ENDPOINTS), false);
    await refrescarFeed();
  }, 5000);
}
function pararPolling(){
  if (pollTimer){ clearInterval(pollTimer); pollTimer = null; }
}

/* ---------- bootstrap ---------- */
export async function init(){
  await refetch(Object.keys(ENDPOINTS), true);
  await refrescarFeed();
  conectarSSE();
  return store;
}
