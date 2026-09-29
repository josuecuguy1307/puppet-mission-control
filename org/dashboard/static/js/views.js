/* MISSION CONTROL v2 — views.js (F-PANELS)
   Vistas v2 reimplementadas leyendo el store: pipeline (kanban), canal
   (feed + composer→sendIntake), squads (grid), estado + counters del header.
   También: biblioteca (búsqueda /api/library) y el host del panel lateral
   (#panel-root) que usan los panels. Anti-XSS: TODO interpolado pasa por esc(). */

import {
  store, esc, on, listaSquads, listaMissions, missionsOk, TIER_COLORS,
} from "./data.js";

let data = null;
let vistaActiva = null;

const $ = s => document.querySelector(s);

/* ---------- host del panel lateral (#panel-root) ---------- */
export function abrirPanel(titulo, ancho){
  const root = $("#panel-root");
  if (!root) return null;
  root.textContent = "";
  root.classList.add("abierto");
  root.classList.toggle("panel-ancho", !!ancho);
  const head = document.createElement("div");
  head.className = "panel-head";
  const h = document.createElement("b");
  h.textContent = String(titulo == null ? "" : titulo);
  const x = document.createElement("button");
  x.type = "button";
  x.className = "panel-close";
  x.textContent = "✕";
  x.addEventListener("click", cerrarPanel);
  head.appendChild(h);
  head.appendChild(x);
  const body = document.createElement("div");
  body.className = "panel-body";
  root.appendChild(head);
  root.appendChild(body);
  return body;
}
export function cerrarPanel(){
  const root = $("#panel-root");
  if (root){
    root.classList.remove("abierto");
    root.classList.remove("panel-ancho");
    root.textContent = "";
  }
}

/* ---------- helpers de datos (portados de v2) ---------- */
const tierOf = a => Object.prototype.hasOwnProperty.call(TIER_COLORS, a && a.tier) ? a.tier : "oss";
const norm = s => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");

function sqMatch(sq, val){
  const v = norm(val); if (!v) return false;
  const tokens = new Set(String(val || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  return [sq.slug, ...(sq.aliases || [])].some(cand => {
    const c = norm(cand); if (!c) return false;
    return v === c || tokens.has(String(cand).toLowerCase()) || (c.length >= 6 && v.includes(c));
  });
}
const missionsOf = sq => listaMissions().filter(m => sqMatch(sq, m.squad));

function idCorto(id){
  const m = listaMissions().find(x => x.id === id);
  if (m && m.id_corto) return m.id_corto;
  const r = /-(m\d{3})-/.exec("-" + id + "-");
  return r ? r[1].toUpperCase() : String(id).split("-").slice(3, 4)[0] || id;
}
function hoy(ts){
  const d = new Date(ts * 1000), n = new Date();
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
}

/* ---------- init ---------- */
export function initViews(deps){
  data = (deps && deps.data) || null;
  wireComposer();
  on("refresh:missions", () => { renderCounters(); rerenderSi(["pipeline", "estado", "squads"]); });
  on("refresh:squads", () => { renderCounters(); rerenderSi(["squads", "estado", "canal"]); });
  on("refresh:state", renderCounters);
  on("feed", evs => {
    for (const ev of (evs || [])) appendFeed(ev);
    autoscroll(false);
    if (vistaActiva === "estado") renderEstado();
  });
  on("org_event", ev => { appendOrgEvent(ev); autoscroll(false); });
  const clock = $("#clock");
  if (clock) setInterval(() => {
    clock.textContent = new Date().toLocaleTimeString("es-EC", { hour12: false });
  }, 1000);
  renderCounters();
  renderFeedCompleto();
}

function rerenderSi(vistas){
  if (vistas.includes(vistaActiva)) renderView(vistaActiva);
}

/* ---------- router de vistas (idempotente; main.js decide cuándo) ---------- */
export function renderView(nombre){
  vistaActiva = nombre;
  // toggle defensivo de secciones .view (si main.js ya lo hizo, es idempotente)
  const target = document.getElementById("view-" + nombre);
  if (target){
    document.querySelectorAll(".view").forEach(v => v.classList.toggle("active", v === target));
  }
  try {
    if (nombre === "pipeline") renderPipeline();
    else if (nombre === "canal") renderFeedCompleto();
    else if (nombre === "squads") renderSquads();
    else if (nombre === "estado") renderEstado();
    else if (nombre === "biblioteca") renderBiblioteca();
    renderCounters();
  } catch (e) { /* estado parcial: seguimos */ }
}

/* ---------- counters del header ---------- */
function setTxt(id, v){ const el = document.getElementById(id); if (el) el.textContent = v; }
function renderCounters(){
  const missions = listaMissions(), squads = listaSquads();
  if (!missionsOk() && !missions.length){
    for (const id of ["n-ready", "n-proc", "n-done", "n-work"]) setTxt(id, "–");
    setTxt("chan-working", "–");
    return;
  }
  const ready = missions.filter(m => m.carpeta === "inbox" && m.status_calc === "ready").length;
  const proc = missions.filter(m => m.carpeta === "processing").length;
  const done = missions.filter(m => m.carpeta === "completed" && hoy(m.mtime)).length;
  const work = squads.filter(s => s.estado === "working").length;
  setTxt("n-ready", ready); setTxt("n-proc", proc); setTxt("n-done", done);
  setTxt("n-work", squads.length ? work : "–");
  setTxt("chan-working", squads.length ? work : "–");
}

/* ---------- PIPELINE (kanban) ---------- */
function cardHTML(m, col){
  const lock = (col === "inbox" && m.status_calc === "blocked")
    ? `<div class="card-lock">🔒 espera a: ${esc((m.espera_a || []).map(idCorto).join(", ") || "?")}</div>` : "";
  const founderLock = (m.status_calc === "blocked-on-founder")
    ? `<div class="card-lock">J espera founder: ${esc(m.espera_founder || "?")}</div>` : "";
  const grafo = (m.status_calc === "roto" || m.status_calc === "ciclo" || m.status_calc === "founder-roto")
    ? `<div class="card-lock">⚠ ${esc(m.status_calc)}</div>` : "";
  const dep = (m.depends_on || []).length
    ? `<div class="card-dep">← depende de ${esc(m.depends_on.map(idCorto).join(", "))}</div>` : "";
  const err = m.error ? `<div class="card-lock">⚠ ${esc(m.error)}</div>` : "";
  const bloqueada = m.status_calc === "blocked" || m.status_calc === "blocked-on-founder";
  return `<div class="card col-${esc(col)} ${bloqueada ? "st-blocked" : ""}" title="${esc(m.id)}">
    <div class="card-top"><b>${esc(m.id_corto)}</b><span class="csq">${esc(m.squad || "?")} · ${esc(m.tipo || "?")}</span>
    ${m.lane ? `<span class="lane">${esc(m.lane)}</span>` : ""}</div>
    <div class="card-tit">${esc(m.titulo || "")}</div>${lock}${founderLock}${grafo}${dep}${err}</div>`;
}
function renderPipeline(){
  const missions = listaMissions();
  for (const col of ["inbox", "processing", "completed"]){
    const ms = missions.filter(m => m.carpeta === col)
      .sort((a, b) => col === "completed" ? b.mtime - a.mtime : String(a.id).localeCompare(String(b.id)));
    const el = document.getElementById("cards-" + col);
    if (!el) continue;
    el.innerHTML = ms.length ? ms.map(m => cardHTML(m, col)).join("")
      : `<div class="nodata">${missionsOk() ? "— vacío —" : "sin datos"}</div>`;
  }
  setTxt("p-inbox", missions.filter(m => m.carpeta === "inbox").length || "");
  setTxt("p-proc", missions.filter(m => m.carpeta === "processing").length || "");
  setTxt("p-comp", missions.filter(m => m.carpeta === "completed").length || "");
}

/* ---------- CANAL (feed + composer) ---------- */
const orgEventsCache = [];
function msgHTML(ev){
  const t = ev.iso ? String(ev.iso).slice(11, 19) : "";
  const sq = ev.squad ? `<span class="squadtag">@${esc(ev.squad)}</span>` : "";
  return `<div class="msg tipo-${esc(ev.tipo)}"><div class="meta"><span class="badge">${esc(ev.tipo)}</span>${sq}<span class="time">${esc(t)}</span></div>
   <div class="text">${esc(ev.texto)}</div></div>`;
}
function appendFeed(ev){
  const feed = $("#feed");
  if (!feed || !ev) return;
  const ph = feed.querySelector(".nodata");
  if (ph) ph.remove();
  feed.insertAdjacentHTML("beforeend", msgHTML(ev));
  while (feed.children.length > 300) feed.removeChild(feed.firstChild);
}
function orgEventTexto(ev){
  return [ev.mision, ev.agente, ev.squad, ev.verdict, ev.detalle]
    .filter(Boolean).map(String).join(" · ") || "(evento sin detalle)";
}
function appendOrgEvent(ev){
  if (!ev || typeof ev !== "object") return;
  orgEventsCache.push(ev);
  while (orgEventsCache.length > 100) orgEventsCache.shift();
  const feed = $("#feed");
  if (!feed) return;
  const ph = feed.querySelector(".nodata");
  if (ph) ph.remove();
  const t = ev.ts ? String(ev.ts).slice(11, 19) : "";
  feed.insertAdjacentHTML("beforeend",
    `<div class="msg tipo-org"><div class="meta"><span class="badge">org · ${esc(ev.tipo || "?")}</span><span class="time">${esc(t)}</span></div>
     <div class="text">${esc(orgEventTexto(ev))}</div></div>`);
  while (feed.children.length > 300) feed.removeChild(feed.firstChild);
}
function renderFeedCompleto(){
  const feed = $("#feed");
  if (!feed) return;
  feed.innerHTML = "";
  const evs = Array.isArray(store.feed) ? store.feed : [];
  if (!evs.length && !orgEventsCache.length){
    feed.innerHTML = '<div class="nodata">sin datos</div>';
    return;
  }
  for (const ev of evs) appendFeed(ev);
  for (const ev of orgEventsCache) appendOrgEvent(ev);
  autoscroll(true);
}
function autoscroll(force){
  const f = $("#feed");
  if (!f) return;
  if (force || f.scrollHeight - f.scrollTop - f.clientHeight < 80) f.scrollTop = f.scrollHeight;
}
function wireComposer(){
  const form = $("#composer");
  if (!form) return;
  form.addEventListener("submit", async e => {
    e.preventDefault();
    const inp = $("#composer-in");
    const texto = inp ? inp.value.trim() : "";
    if (!texto) return;
    appendFeed({ tipo: "vos", squad: null, texto, iso: new Date().toISOString() });
    autoscroll(true);
    if (inp) inp.value = "";
    const resp = data && data.sendIntake ? await data.sendIntake(texto) : null;
    appendFeed({
      tipo: "sistema", squad: null,
      texto: (resp && resp.hint) ? resp.hint : "sin datos (¿corre el server?)",
      iso: new Date().toISOString(),
    });
    autoscroll(true);
  });
}

/* ---------- SQUADS (grid) ---------- */
function renderSquads(){
  const g = $("#squads-grid");
  if (!g) return;
  const squads = listaSquads();
  if (!squads.length){ g.innerHTML = '<div class="nodata">sin datos</div>'; return; }
  g.innerHTML = squads.map(sq => {
    const mine = missionsOf(sq);
    const act = sq.mision_activa;
    return `<div class="sq-card">
      <h4>${esc(sq.nombre)}${sq.asiento_fable ? ' <span class="fmark">◆</span>' : ""}</h4>
      <div class="sq-meta">
        <span class="chip">${esc(sq.division)}</span>
        <span class="chip">${esc(sq.regimen)}</span>
        <span class="chip e-${esc(sq.estado || sq.regimen)}">${esc(sq.estado || sq.regimen)}</span>
      </div>
      ${(sq.asientos || []).map(a => `<div class="sq-seat">
        <span class="sp-dot" style="background:${TIER_COLORS[tierOf(a)]}"></span>
        ${esc(a.rol)}${a.agente ? ` <span class="seat-agente">${esc(a.agente)}</span>` : ""} · ${esc(a.modelo)}${a.fable ? " ◆" : ""}${a.j ? " (J)" : ""}</div>`).join("")}
      <div class="sq-missions">
        ${act ? `activa: <b>${esc(act.id_corto)}</b> · ` : ""}inbox ${mine.filter(m => m.carpeta === "inbox").length}
        · completadas ${mine.filter(m => m.carpeta === "completed").length}
      </div></div>`;
  }).join("");
}

/* ---------- ESTADO ---------- */
function renderEstado(){
  const missions = listaMissions(), squads = listaSquads();
  const sinDatos = !missionsOk() && !missions.length;
  const ready = missions.filter(m => m.carpeta === "inbox" && m.status_calc === "ready").length;
  const proc = missions.filter(m => m.carpeta === "processing").length;
  const done = missions.filter(m => m.carpeta === "completed" && hoy(m.mtime)).length;
  const work = squads.filter(s => s.estado === "working").length;
  setTxt("e-ready", sinDatos ? "–" : ready);
  setTxt("e-proc", sinDatos ? "–" : proc);
  setTxt("e-done", sinDatos ? "–" : done);
  setTxt("e-work", squads.length ? work : "–");
  const salud = $("#e-salud");
  if (salud){
    const porEstado = {};
    for (const m of missions) porEstado[m.status_calc] = (porEstado[m.status_calc] || 0) + 1;
    salud.innerHTML = sinDatos ? '<div class="nodata">sin datos</div>'
      : Object.entries(porEstado).map(([k, v]) =>
          `<div class="est-line">${v} misión(es) <span class="st st-${esc(k)}">${esc(k)}</span></div>`).join("")
        || '<div class="nodata">— sin misiones —</div>';
  }
  const chain = $("#e-chain");
  if (chain){
    const fam = missions.filter(m => /-m\d{3}-/.test("-" + m.id + "-"))
      .sort((a, b) => String(a.id_corto).localeCompare(String(b.id_corto)));
    chain.innerHTML = fam.length
      ? fam.map(m => `<span class="map-node st-${esc(m.status_calc)}" title="${esc(m.titulo)}">${esc(m.id_corto)}</span>`)
          .join('<span class="map-arrow">→</span>')
      : '<div class="nodata">sin datos</div>';
  }
  const errsEl = $("#e-errs");
  if (errsEl){
    const errs = missions.filter(m => m.error);
    errsEl.innerHTML = errs.length
      ? errs.map(m => `<div class="est-line">⚠ ${esc(m.id)} <span class="st st-sin-datos">${esc(m.error)}</span></div>`).join("")
      : '<div class="nodata">— ninguna: todos los front-matter parsean —</div>';
  }
  const repsEl = $("#e-reps");
  if (repsEl){
    const reps = (Array.isArray(store.feed) ? store.feed : [])
      .filter(e => e.tipo === "reporte").slice(-5).reverse();
    repsEl.innerHTML = reps.length
      ? reps.map(e => `<div class="rep">${esc(e.iso ? String(e.iso).slice(0, 16).replace("T", " ") : "")} — ${esc(e.texto)}</div>`).join("")
      : '<div class="nodata">sin datos</div>';
  }
}

/* ---------- BIBLIOTECA (búsqueda /api/library + lector /api/doc) ---------- */
let biblioArmada = false;
function renderBiblioteca(){
  const view = document.getElementById("view-biblioteca");
  if (!view) return;
  if (!biblioArmada){
    view.textContent = "";
    const wrap = document.createElement("div");
    wrap.className = "bib-wrap";
    const form = document.createElement("form");
    form.className = "bib-form";
    const inp = document.createElement("input");
    inp.type = "text"; inp.className = "bib-q"; inp.maxLength = 200;
    inp.placeholder = "buscar en artifacts · briefs · reports…";
    const btn = document.createElement("button");
    btn.type = "submit"; btn.className = "btn-mc"; btn.textContent = "BUSCAR";
    form.appendChild(inp); form.appendChild(btn);
    const res = document.createElement("div");
    res.className = "bib-res";
    res.textContent = "sin datos — busca algo para empezar";
    const lector = document.createElement("pre");
    lector.className = "bib-doc"; lector.hidden = true;
    form.addEventListener("submit", async e => {
      e.preventDefault();
      res.textContent = "buscando…";
      lector.hidden = true;
      const r = data && data.searchLibrary ? await data.searchLibrary(inp.value.trim()) : null;
      const items = r && (Array.isArray(r.items) ? r.items : (Array.isArray(r.resultados) ? r.resultados : null));
      res.textContent = "";
      if (!items){ res.textContent = "sin datos (¿corre el server?)"; return; }
      if (!items.length){ res.textContent = "— sin resultados —"; return; }
      for (const it of items){
        const row = document.createElement("div");
        row.className = "bib-item";
        const a = document.createElement("button");
        a.type = "button"; a.className = "bib-path";
        a.textContent = String(it.path || it.ruta || "?");
        a.addEventListener("click", async () => {
          lector.hidden = false;
          lector.textContent = "cargando…";
          const d = data && data.fetchDoc ? await data.fetchDoc(it.path || it.ruta) : null;
          const cuerpo = d && (d.body != null ? d.body : (d.contenido != null ? d.contenido : null));
          // markdown como TEXTO PLANO escapado (pre-wrap), jamás HTML
          lector.textContent = cuerpo != null ? String(cuerpo) : "sin datos (doc fuera del guard o ausente)";
        });
        const sn = document.createElement("div");
        sn.className = "bib-snip";
        sn.textContent = String(it.snippet || it.titulo || "");
        row.appendChild(a); row.appendChild(sn);
        res.appendChild(row);
      }
    });
    wrap.appendChild(form); wrap.appendChild(res); wrap.appendChild(lector);
    view.appendChild(wrap);
    biblioArmada = true;
  }
}
