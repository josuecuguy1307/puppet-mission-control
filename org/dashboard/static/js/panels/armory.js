/* MISSION CONTROL v2 — panels/armory.js (F-PANELS)
   Vista armería (#view-armeria): items REALES de /api/armory con sprite por
   sprite_hint, clase/origen/aliases, equipado_por, 🔒 sensibles. Equipables
   arrastrables (dataTransfer "application/x-puppet-item") + panel de
   confirmación equipar/desequipar → sendCommand (acción SIEMPRE gateada:
   apply --confirm del Supervisor). Recibe onItemDrop del office vía main.js.
   Anti-XSS: solo createElement/textContent. */

import { store, on, listaAgentes } from "../data.js";
import { abrirPanel } from "../views.js";

let data = null, office = null;

export function init(deps){
  data = (deps && deps.data) || null;
  office = (deps && deps.office) || null;
  on("refresh:armory", () => { if (vistaActiva()) render(); });
  on("refresh:agents", () => { if (vistaActiva()) render(); });
}

function vistaActiva(){
  const v = document.getElementById("view-armeria");
  return !!(v && v.classList.contains("active"));
}

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

/* sprite procedural 16x16 escalado x2 según sprite_hint + clase */
const PALETA_SPRITE = ["#ffd166", "#a78bfa", "#60a5fa", "#2dd4bf", "#f5a623", "#ef8a8a", "#7ef0a5"];
function dibujarSprite(cv, item){
  cv.width = 32; cv.height = 32;
  const c = cv.getContext("2d");
  if (!c) return;
  c.imageSmoothingEnabled = false;
  const h = hashDe(item.sprite_hint || item.id);
  const col = PALETA_SPRITE[h % PALETA_SPRITE.length];
  const S = 2, P = (x, y, w, hh, color) => { c.fillStyle = color; c.fillRect(x * S, y * S, w * S, hh * S); };
  c.fillStyle = "#1b1410"; c.fillRect(0, 0, 32, 32);
  const clase = String(item.clase || "");
  if (clase === "mcp" || clase === "belt-mcp"){           // enchufe MCP
    P(6, 2, 4, 3, col); P(5, 5, 6, 5, col); P(6, 10, 4, 4, "#8a8178");
    P(6, 1, 1, 2, "#e8ddcc"); P(9, 1, 1, 2, "#e8ddcc");
  } else if (clase === "skill"){                          // libro
    P(3, 3, 10, 11, col); P(4, 4, 8, 9, "#241e19"); P(5, 6, 6, 1, col); P(5, 8, 6, 1, col);
  } else {                                                // herramienta
    P(7, 2, 2, 9, "#8a8178"); P(5, 1, 6, 3, col); P(6, 11, 4, 3, col);
  }
  if (item.sensible) P(12, 12, 3, 3, "#ef4444");          // marca roja: sensible
}

/* ---------- vista ---------- */
export function render(){
  const view = document.getElementById("view-armeria");
  if (!view) return;
  view.textContent = "";
  const wrap = el("div", "arm-wrap");
  const a = store.armory;
  const items = a && Array.isArray(a.items) ? a.items : null;
  const belts = a && Array.isArray(a.belts) ? a.belts : [];

  const head = el("div", "arm-head");
  head.appendChild(el("h3", null, "⚔ ARMERÍA"));
  head.appendChild(el("div", "arm-sub", items
    ? `${items.length} items reales (fuentes: frontmatters de .claude/agents/ + .mcp.json + org/belts/) · ` +
      `${items.filter(i => i.equipable).length} equipables · ${items.filter(i => i.sensible).length} sensibles 🔒`
    : "sin datos"));
  head.appendChild(el("div", "arm-nota",
    "equipar/desequipar crea un DRAFT gateado: lo aplica el Supervisor con apply --confirm " +
    "(el agente propone, el humano aprueba)"));
  wrap.appendChild(head);

  if (!items){
    wrap.appendChild(el("div", "nodata", "sin datos (/api/armory no responde)"));
    view.appendChild(wrap);
    return;
  }
  if (!items.length){
    wrap.appendChild(el("div", "nodata", "— armería vacía —"));
  }

  const grid = el("div", "arm-grid");
  for (const item of items) grid.appendChild(itemCard(item));
  wrap.appendChild(grid);

  if (belts.length){
    const bsec = el("div", "arm-belts");
    bsec.appendChild(el("h4", null, "Cinturones por campo (informativo — org/belts/)"));
    for (const b of belts){
      const row = el("div", "arm-belt-row");
      row.appendChild(el("b", null, b.nombre || b.id || "?"));
      const its = Array.isArray(b.items) ? b.items : [];
      row.appendChild(el("span", "arm-belt-n",
        its.length ? ` · ${its.length} items: ${its.map(x => typeof x === "string" ? x : (x && x.id) || "?").join(", ")}` : " · sin items parseados"));
      bsec.appendChild(row);
    }
    wrap.appendChild(bsec);
  }
  view.appendChild(wrap);
}

function itemCard(item){
  const card = el("div", "arm-item" + (item.equipable ? " equipable" : "") + (item.sensible ? " sensible" : ""));
  const cv = document.createElement("canvas");
  cv.className = "arm-sprite";
  dibujarSprite(cv, item);
  card.appendChild(cv);

  const info = el("div", "arm-info");
  const nom = el("div", "arm-nombre");
  nom.appendChild(el("b", null, item.nombre || item.id || "?"));
  if (item.sensible){
    const lock = el("span", "arm-lock", " 🔒");
    lock.title = "sensible: requiere confirmación del Supervisor";
    nom.appendChild(lock);
  }
  info.appendChild(nom);
  if (item.id && item.id !== item.nombre) info.appendChild(el("div", "arm-id", item.id));
  const meta = el("div", "arm-meta");
  meta.appendChild(el("span", "chip", item.clase || "?"));
  if (item.origen) meta.appendChild(el("span", "chip", item.origen));
  meta.appendChild(el("span", "chip " + (item.equipable ? "chip-ok" : "chip-off"),
    item.equipable ? "equipable" : "no equipable"));
  info.appendChild(meta);
  const aliases = Array.isArray(item.aliases) ? item.aliases.filter(Boolean) : [];
  if (aliases.length) info.appendChild(el("div", "arm-aliases", "aliases: " + aliases.join(", ")));

  const eq = Array.isArray(item.equipado_por) ? item.equipado_por : [];
  const eqRow = el("div", "arm-eq");
  if (eq.length){
    eqRow.appendChild(el("span", "arm-eq-l", "equipado por: "));
    for (const e of eq){
      const chip = el("button", "arm-eq-chip", `${(e && e.agente) || "?"} @${(e && e.squad) || "?"}`);
      chip.type = "button";
      chip.title = "click: desequipar a este agente";
      chip.addEventListener("click", () =>
        openConfirm({ item_id: item.id, agente: e && e.agente, squad: e && e.squad, accion: "desequipar_tool" }));
      eqRow.appendChild(chip);
    }
  } else {
    eqRow.appendChild(el("span", "arm-eq-l nodata", "nadie lo tiene equipado"));
  }
  info.appendChild(eqRow);
  card.appendChild(info);

  if (item.equipable){
    // drag real (el drop sobre la oficina lo maneja office.js → onItemDrop)
    card.draggable = true;
    card.addEventListener("dragstart", ev => {
      try {
        ev.dataTransfer.setData("application/x-puppet-item", String(item.id || ""));
        ev.dataTransfer.setData("text/plain", String(item.id || ""));
        ev.dataTransfer.effectAllowed = "copy";
      } catch (e) { /* dataTransfer no disponible */ }
    });
    const btn = el("button", "btn-mc arm-btn", "equipar…");
    btn.type = "button";
    btn.addEventListener("click", () => openConfirm({ item_id: item.id, accion: "equipar_tool" }));
    card.appendChild(btn);
  }
  return card;
}

/* ---------- confirmación equipar/desequipar (drafts gateados) ---------- */
export function openConfirm(info){
  info = info || {};
  const body = abrirPanel("Equipar / desequipar");
  if (!body) return;
  const items = (store.armory && Array.isArray(store.armory.items)) ? store.armory.items : [];
  const item = items.find(i => i.id === info.item_id) || null;

  const fic = el("div", "arm-conf-item");
  if (item){
    const cv = document.createElement("canvas");
    cv.className = "arm-sprite";
    dibujarSprite(cv, item);
    fic.appendChild(cv);
  }
  fic.appendChild(el("b", null, info.item_id || "?"));
  body.appendChild(fic);

  if (!item){
    body.appendChild(el("div", "nodata", "sin datos (item fuera del catálogo de /api/armory)"));
  } else if (!item.equipable){
    body.appendChild(el("div", "arm-warn", "este item NO es equipable (clase " + (item.clase || "?") + ")"));
  }
  if (item && item.sensible){
    body.appendChild(el("div", "arm-warn", "🔒 sensible: requiere confirmación del Supervisor"));
  }
  body.appendChild(el("div", "arm-nota",
    "acción gateada SIEMPRE: queda en para-supervisor/ hasta apply --confirm"));

  const f = el("div", "acard-form");
  f.appendChild(el("label", null, "agente:"));
  const sel = document.createElement("select");
  const vistos = new Set();
  for (const ag of listaAgentes()){
    if (!ag || !ag.agente || vistos.has(ag.agente + "|" + ag.squad)) continue;
    vistos.add(ag.agente + "|" + ag.squad);
    const o = document.createElement("option");
    o.value = ag.agente;
    o.textContent = `${ag.agente} (${ag.rol || "?"} · ${ag.squad || "?"})`;
    if (info.agente && ag.agente === info.agente && (!info.squad || ag.squad === info.squad)) o.selected = true;
    sel.appendChild(o);
  }
  if (!sel.options.length){
    const o = document.createElement("option");
    o.value = ""; o.textContent = "sin datos (/api/agents vacío)";
    sel.appendChild(o);
  }
  f.appendChild(sel);

  f.appendChild(el("label", null, "acción:"));
  const acc = document.createElement("select");
  for (const t of ["equipar_tool", "desequipar_tool"]){
    const o = document.createElement("option");
    o.value = t; o.textContent = t;
    if (info.accion === t) o.selected = true;
    acc.appendChild(o);
  }
  f.appendChild(acc);

  const hint = el("div", "acard-hint", "");
  const go = el("button", "btn-mc btn-go", "crear draft");
  go.type = "button";
  go.addEventListener("click", async () => {
    const agente = sel.value;
    if (!agente){ hint.textContent = "elige un agente real"; return; }
    go.disabled = true;
    hint.textContent = "enviando draft…";
    const r = data && data.sendCommand
      ? await data.sendCommand(acc.value, { agente, tool: info.item_id })
      : null;
    hint.textContent = (r && r.hint) ? r.hint : "sin datos (¿corre el server?)";
    go.disabled = false;
  });
  f.appendChild(go);
  body.appendChild(f);
  body.appendChild(hint);
}

/* drop de item sobre un agente en la oficina (ruteado por main.js) */
export function onItemDrop(info){
  info = info || {};
  openConfirm({ item_id: info.item_id, agente: info.agente, squad: info.squad, accion: "equipar_tool" });
}
