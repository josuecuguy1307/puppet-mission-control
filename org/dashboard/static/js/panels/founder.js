/* MISSION CONTROL v2 — panels/founder.js (F-PANELS)
   Escritorio del Founder: bandeja (3 colas por tipo con conteos REALES),
   lector TL;DR-primero (markdown como texto plano escapado; doc expandible vía
   fetchDoc), respuestas → drafts (responder_decision/responder_pregunta/
   feedback_brief). Diálogo NPC por squad (mensaje_lead) y Diario del Org
   (digest batch del EA). Anti-XSS: solo createElement/textContent. */

import { store, on, TIER_COLORS, TIER_DARK } from "../data.js";
import { abrirPanel } from "../views.js";

let data = null, office = null;
let chatAbierto = null;   // slug del squad con diálogo NPC abierto

export function init(deps){
  data = (deps && deps.data) || null;
  office = (deps && deps.office) || null;
  on("refresh:founder", () => {
    // si el chat sigue montado en el DOM, refrescar el historial real
    if (chatAbierto && document.querySelector(".npc-log")) openChat(chatAbierto);
  });
}

function el(tag, clase, texto){
  const n = document.createElement(tag);
  if (clase) n.className = clase;
  if (texto != null) n.textContent = String(texto);
  return n;
}

/* retrato NPC chico (cara pixel) con paleta de tier */
function retratoNPC(tier){
  const cv = document.createElement("canvas");
  cv.className = "npc-retrato";
  cv.width = 32; cv.height = 32;
  const c = cv.getContext("2d");
  if (!c) return cv;
  c.imageSmoothingEnabled = false;
  const col = TIER_COLORS[tier] || TIER_COLORS.oss;
  const dark = TIER_DARK[tier] || TIER_DARK.oss;
  c.fillStyle = "#1b1410"; c.fillRect(0, 0, 32, 32);
  c.fillStyle = "#f2c9a0"; c.fillRect(8, 6, 16, 16);    // cara
  c.fillStyle = "#4a3320"; c.fillRect(8, 4, 16, 6);     // pelo
  c.fillStyle = "#2b1d12"; c.fillRect(12, 14, 2, 4); c.fillRect(18, 14, 2, 4); // ojos
  c.fillStyle = col; c.fillRect(6, 24, 20, 8);          // hombros (tier)
  c.fillStyle = dark; c.fillRect(6, 24, 20, 2);
  return cv;
}

/* ---------- colas por tipo (shape defensivo de /api/founder) ---------- */
function colas(){
  const f = store.founder;
  const out = { decision: [], pregunta: [], brief: [] };
  if (!f || typeof f !== "object") return null;
  const meter = it => {
    if (!it || typeof it !== "object") return;
    const t = String(it.tipo || "");
    if (t in out) out[t].push(it);
  };
  if (Array.isArray(f.items)) f.items.forEach(meter);
  for (const [k, lista] of [["decisiones", "decision"], ["preguntas", "pregunta"], ["briefs", "brief"]]){
    if (Array.isArray(f[k])) f[k].forEach(it => {
      if (it && typeof it === "object") out[lista].push(it.tipo ? it : { ...it, tipo: lista });
    });
  }
  return out;
}

const TIPO_TXT = { decision: "decisiones (sello)", pregunta: "preguntas (sobre)", brief: "briefs (pila)" };
const TIPO_ICO = { decision: "🪧", pregunta: "✉", brief: "📚" };

/* ---------- bandeja ---------- */
export function openDesk(){
  const body = abrirPanel("Escritorio del Founder", true);
  if (!body) return;
  const c = colas();
  if (!c){
    body.appendChild(el("div", "nodata", "sin datos (/api/founder no responde)"));
    return;
  }
  for (const tipo of ["decision", "pregunta", "brief"]){
    const items = c[tipo];
    const abiertos = items.filter(i => String(i.estado || "abierto") === "abierto");
    const sec = el("div", "fd-cola");
    sec.appendChild(el("h5", null,
      `${TIPO_ICO[tipo]} ${TIPO_TXT[tipo]} — ${items.length} total · ${abiertos.length} abiertas`));
    if (!items.length){
      sec.appendChild(el("div", "nodata", "— vacía —"));
    } else {
      const orden = [...items].sort((a, b) => {
        const ea = String(a.estado || "abierto") === "abierto" ? 0 : 1;
        const eb = String(b.estado || "abierto") === "abierto" ? 0 : 1;
        return ea - eb || String(a.id || "").localeCompare(String(b.id || ""));
      });
      for (const it of orden){
        const row = el("button", "fd-item");
        row.type = "button";
        row.appendChild(el("span", "fd-estado fd-e-" + String(it.estado || "abierto"), String(it.estado || "abierto")));
        row.appendChild(el("b", null, it.titulo || it.id || "?"));
        row.appendChild(el("span", "fd-meta", ` ${it.id || ""}${it.squad ? " · @" + it.squad : ""}`));
        row.addEventListener("click", () => openItem(it.id));
        sec.appendChild(row);
      }
    }
    body.appendChild(sec);
  }
  body.appendChild(el("div", "fd-nota",
    "responder crea un draft — lo aplica tu orquestador y el item pasa a respondido"));
}

/* ---------- lector TL;DR-primero (exportado: el Despacho lo reusa) ---------- */
export async function openItem(id){
  const body = abrirPanel("Item founder", true);
  if (!body) return;
  const volver = el("button", "btn-mc fd-volver", "← volver a la bandeja");
  volver.type = "button";
  volver.addEventListener("click", openDesk);
  body.appendChild(volver);

  if (!id){ body.appendChild(el("div", "nodata", "sin datos (item sin id)")); return; }
  const cargando = el("div", "nodata", "cargando…");
  body.appendChild(cargando);
  const r = data && data.fetchFounderItem ? await data.fetchFounderItem(id) : null;
  cargando.remove();
  if (!r || typeof r !== "object"){
    body.appendChild(el("div", "nodata", "sin datos (item inexistente o server caído)"));
    return;
  }
  const fm = (r.item && typeof r.item === "object") ? r.item
    : (r.fm && typeof r.fm === "object") ? r.fm : r;
  const cuerpo = r.body != null ? r.body : (r.cuerpo != null ? r.cuerpo : null);

  body.appendChild(el("h3", "fd-titulo", fm.titulo || id));
  const meta = el("div", "fd-metas");
  for (const txt of [fm.tipo, fm.squad ? "@" + fm.squad : null, fm.estado, fm.ts, fm.mision]
    .filter(Boolean)) meta.appendChild(el("span", "chip", txt));
  body.appendChild(meta);

  // TL;DR PRIMERO: el body del .md como texto plano escapado (pre-wrap), no HTML
  const tldr = el("pre", "fd-tldr", cuerpo != null && String(cuerpo).trim() ? String(cuerpo) : "sin datos (item sin cuerpo)");
  body.appendChild(tldr);

  if (fm.default) body.appendChild(el("div", "fd-default", "default: " + fm.default));

  if (fm.doc){
    const docBtn = el("button", "btn-mc", "📄 abrir doc: " + fm.doc);
    docBtn.type = "button";
    const docPre = el("pre", "fd-doc");
    docPre.hidden = true;
    docBtn.addEventListener("click", async () => {
      if (!docPre.hidden){ docPre.hidden = true; return; }
      docPre.hidden = false;
      if (r.doc_body != null){ docPre.textContent = String(r.doc_body); return; }
      docPre.textContent = "cargando…";
      const d = data && data.fetchDoc ? await data.fetchDoc(fm.doc) : null;
      const cont = d && (d.body != null ? d.body : (d.contenido != null ? d.contenido : null));
      docPre.textContent = cont != null ? String(cont)
        : "sin datos (doc fuera del guard de /api/doc o ausente)" + (r.nota ? " — " + r.nota : "");
    });
    body.appendChild(docBtn);
    body.appendChild(docPre);
  } else if (r.nota){
    body.appendChild(el("div", "fd-nota", String(r.nota)));
  }

  /* responder según tipo → draft */
  const tipo = String(fm.tipo || "");
  const hint = el("div", "acard-hint", "");
  const form = el("div", "acard-form fd-resp");
  if (tipo === "decision"){
    form.appendChild(el("label", null, "opción elegida (textual, como figura en el item):"));
    const opc = document.createElement("input");
    opc.type = "text"; opc.maxLength = 200;
    form.appendChild(opc);
    form.appendChild(el("label", null, "comentario (opcional):"));
    const com = document.createElement("textarea");
    com.rows = 3; com.maxLength = 1000;
    form.appendChild(com);
    form.appendChild(botonEnviar(hint, "responder_decision", () => {
      const opcion = opc.value.trim();
      if (!opcion) return null;
      const payload = { item: id, opcion };
      if (com.value.trim()) payload.comentario = com.value.trim();
      return payload;
    }, "elige una opción"));
  } else if (tipo === "pregunta"){
    form.appendChild(el("label", null, "tu respuesta:"));
    const ta = document.createElement("textarea");
    ta.rows = 4; ta.maxLength = 2000;
    form.appendChild(ta);
    form.appendChild(botonEnviar(hint, "responder_pregunta", () => {
      const respuesta = ta.value.trim();
      return respuesta ? { item: id, respuesta } : null;
    }, "la respuesta no puede estar vacía"));
  } else if (tipo === "brief"){
    form.appendChild(el("label", null, "feedback sobre el brief:"));
    const ta = document.createElement("textarea");
    ta.rows = 4; ta.maxLength = 2000;
    form.appendChild(ta);
    form.appendChild(botonEnviar(hint, "feedback_brief", () => {
      const feedback = ta.value.trim();
      return feedback ? { item: id, feedback } : null;
    }, "el feedback no puede estar vacío"));
  } else {
    form.appendChild(el("div", "nodata", "tipo desconocido — sin acción de respuesta"));
  }
  body.appendChild(form);
  body.appendChild(hint);

  function botonEnviar(hintEl, tipoCmd, armarPayload, msgVacio){
    const go = el("button", "btn-mc btn-go", "crear draft " + tipoCmd);
    go.type = "button";
    go.addEventListener("click", async () => {
      const payload = armarPayload();
      if (!payload){ hintEl.textContent = msgVacio; return; }
      go.disabled = true;
      hintEl.textContent = "enviando draft…";
      const resp = data && data.sendCommand ? await data.sendCommand(tipoCmd, payload) : null;
      hintEl.textContent = (resp && resp.hint) ? resp.hint : "sin datos (¿corre el server?)";
      go.disabled = false;
    });
    return go;
  }
}

/* ---------- diálogo NPC con el Lead de un squad ---------- */
function chatDe(squad){
  const f = store.founder;
  const chats = f && f.chats && typeof f.chats === "object" ? f.chats : null;
  const arr = chats && chats[squad];
  return Array.isArray(arr) ? arr : [];
}

export function openChat(squad){
  squad = String(squad || "");
  chatAbierto = squad;
  const body = abrirPanel("Diálogo — Lead de " + squad);
  if (!body) return;

  const head = el("div", "npc-head");
  head.appendChild(retratoNPC("opus"));   // los Leads son Opus (§3 jerarquía)
  const who = el("div", "npc-who");
  who.appendChild(el("b", null, "Lead · " + squad));
  who.appendChild(el("div", "fd-nota", "tu mensaje crea un draft mensaje_lead; el Supervisor spawnea al Lead y escribe la respuesta"));
  head.appendChild(who);
  body.appendChild(head);

  const log = el("div", "npc-log");
  const hist = chatDe(squad);
  if (!hist.length){
    log.appendChild(el("div", "nodata", "sin mensajes todavía"));
  } else {
    for (const m of hist){
      if (!m || typeof m !== "object") continue;
      const mine = String(m.de || "") === "operator";
      const bub = el("div", "npc-msg " + (mine ? "npc-me" : "npc-lead"));
      bub.appendChild(el("div", "npc-texto", m.texto || ""));
      bub.appendChild(el("div", "npc-ts", m.ts || ""));
      log.appendChild(bub);
    }
  }
  body.appendChild(log);
  log.scrollTop = log.scrollHeight;

  const hint = el("div", "acard-hint", "");
  const form = el("form", "npc-form");
  const inp = document.createElement("input");
  inp.type = "text"; inp.maxLength = 1000; inp.placeholder = "mensaje para el Lead…";
  const go = el("button", "btn-mc", "ENVIAR ▸");
  go.type = "submit";
  form.appendChild(inp); form.appendChild(go);
  form.addEventListener("submit", async e => {
    e.preventDefault();
    const texto = inp.value.trim();
    if (!texto) return;
    inp.value = "";
    const bub = el("div", "npc-msg npc-me npc-draft");
    bub.appendChild(el("div", "npc-texto", texto));
    bub.appendChild(el("div", "npc-ts", "(draft — lo entrega el Supervisor)"));
    const ph = log.querySelector(".nodata");
    if (ph) ph.remove();
    log.appendChild(bub);
    log.scrollTop = log.scrollHeight;
    go.disabled = true;
    const r = data && data.sendCommand ? await data.sendCommand("mensaje_lead", { squad, texto }) : null;
    hint.textContent = (r && r.hint) ? r.hint : "sin datos (¿corre el server?)";
    go.disabled = false;
  });
  body.appendChild(form);
  body.appendChild(hint);
}

/* ---------- Diario del Org (digest batch del EA) ---------- */
export function openDiario(){
  const body = abrirPanel("Diario del Org");
  if (!body) return;
  const head = el("div", "npc-head");
  head.appendChild(retratoNPC("oss"));   // el EA corre en specialist (oss)
  const who = el("div", "npc-who");
  who.appendChild(el("b", null, "Executive Assistant"));
  who.appendChild(el("div", "fd-nota", "digest entregado al abrir (batch — nunca interrumpe)"));
  head.appendChild(who);
  body.appendChild(head);

  const digest = store.state && store.state.digest && typeof store.state.digest === "object"
    ? store.state.digest : null;
  if (!digest){
    body.appendChild(el("div", "nodata", "sin datos (/api/state sin digest)"));
    return;
  }
  const fila = (label, v) => {
    const row = el("div", "fd-dg-row");
    row.appendChild(el("span", "fd-dg-l", label));
    row.appendChild(el("b", "fd-dg-v", v == null ? "sin datos" : String(v)));
    return row;
  };
  body.appendChild(fila("✅ completadas hoy", digest.completadas_hoy));
  body.appendChild(fila("⚙ en processing", digest.processing));
  body.appendChild(fila("J esperan founder", digest.esperan_founder));

  const tb = el("div", "fd-dg-briefs");
  tb.appendChild(el("h5", null, "Top briefs"));
  const briefs = Array.isArray(digest.top_briefs) ? digest.top_briefs : [];
  if (!briefs.length){
    tb.appendChild(el("div", "nodata", "sin briefs todavía"));
  } else {
    for (const b of briefs){
      const row = el("button", "fd-item");
      row.type = "button";
      const id = typeof b === "string" ? b : (b && b.id);
      const tit = typeof b === "object" && b ? (b.titulo || id) : b;
      row.appendChild(el("b", null, tit || "?"));
      if (id) row.addEventListener("click", () => openItem(id));
      tb.appendChild(row);
    }
  }
  body.appendChild(tb);
}
