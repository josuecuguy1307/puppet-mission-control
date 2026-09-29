/* MISSION CONTROL v2 — panels/warroom.js (F-PANELS)
   Chrome de la Sala de Guerra (#war-side): leyenda de estados (§2.6), lista de
   nodos con espera_a, camino crítico textual. El TABLERO lo dibuja el motor:
   office.renderWarBoard(#war-board). onBoxDrag (ruteado por main.js) abre la
   confirmación de asignar_mision → draft. Anti-XSS: solo createElement. */

import { store, on, listaSquads } from "../data.js";
import { abrirPanel } from "../views.js";

let data = null, office = null;

export function init(deps){
  data = (deps && deps.data) || null;
  office = (deps && deps.office) || null;
  on("refresh:dag", () => { if (vistaActiva()) render(); });
  on("refresh:missions", () => { if (vistaActiva()) render(); });
}

function vistaActiva(){
  const v = document.getElementById("view-guerra");
  return !!(v && v.classList.contains("active"));
}

function el(tag, clase, texto){
  const n = document.createElement(tag);
  if (clase) n.className = clase;
  if (texto != null) n.textContent = String(texto);
  return n;
}

const ICONOS = {
  ready: "✦", processing: "⚙", completed: "✓", blocked: "🔒",
  "blocked-on-founder": "J", roto: "⚠", ciclo: "⟳", "founder-roto": "⚠J",
};
const LEYENDA = [
  ["ready", "✦ ready — brillo (asignable)"],
  ["processing", "⚙ processing — engranaje"],
  ["completed", "✓ completed"],
  ["blocked", "🔒 blocked — candado (espera deps)"],
  ["blocked-on-founder", "J bloqueado por el responsable — espera su respuesta"],
  ["roto", "⚠ roto — dep inexistente"],
  ["ciclo", "⟳ ciclo — dependencia circular (fuera del camino crítico)"],
  ["founder-roto", "⚠J founder-roto — espera_founder apunta a item inexistente"],
];

function nodoCorto(n){
  if (!n) return "?";
  if (n.id_corto) return String(n.id_corto);
  const id = String(n.id || n);
  const r = /-(m\d{3})-/.exec("-" + id + "-");
  return r ? r[1].toUpperCase() : id;
}

export function render(){
  // el tablero DAG es el MISMO render del motor (drag de cajas vive allá)
  const board = document.getElementById("war-board");
  if (board && office && typeof office.renderWarBoard === "function"){
    try { office.renderWarBoard(board); } catch (e) { /* motor parcial: seguimos */ }
  }
  const side = document.getElementById("war-side");
  if (!side) return;
  side.textContent = "";

  side.appendChild(el("h3", "war-h", "⚔ SALA DE GUERRA"));

  const ley = el("div", "war-leyenda");
  ley.appendChild(el("h5", null, "Leyenda"));
  for (const [st, txt] of LEYENDA) ley.appendChild(el("div", `war-leg war-st-${st}`, txt));
  side.appendChild(ley);

  const dag = store.dag;
  const nodos = dag && Array.isArray(dag.nodos) ? dag.nodos : null;

  const cc = el("div", "war-cc");
  cc.appendChild(el("h5", null, "Camino crítico"));
  const camino = dag && Array.isArray(dag.camino_critico) ? dag.camino_critico : null;
  if (!nodos) cc.appendChild(el("div", "nodata", "sin datos (/api/dag no responde)"));
  else if (!camino || !camino.length) cc.appendChild(el("div", "nodata", "— vacío (nada pendiente encadenado) —"));
  else {
    const porId = new Map(nodos.map(n => [n.id, n]));
    cc.appendChild(el("div", "war-cc-chain",
      camino.map(id => nodoCorto(porId.get(id) || { id })).join(" → ")));
    cc.appendChild(el("div", "war-nota", "cadena más larga de nodos NO completed (ciclos excluidos)"));
  }
  side.appendChild(cc);

  const lst = el("div", "war-nodos");
  lst.appendChild(el("h5", null, nodos ? `Nodos (${nodos.length})` : "Nodos"));
  if (!nodos){
    lst.appendChild(el("div", "nodata", "sin datos"));
  } else if (!nodos.length){
    lst.appendChild(el("div", "nodata", "— sin misiones —"));
  } else {
    const enCamino = new Set(camino || []);
    for (const n of nodos){
      const st = String(n.status_calc || n.status || "?");
      const row = el("div", "war-nodo war-st-" + st + (enCamino.has(n.id) ? " war-critico" : ""));
      row.title = String(n.id || "");
      row.appendChild(el("span", "war-ico", ICONOS[st] || "·"));
      row.appendChild(el("b", null, nodoCorto(n)));
      row.appendChild(el("span", "war-sq", ` ${n.squad || "?"} · ${st}`));
      const espera = Array.isArray(n.espera_a) ? n.espera_a : [];
      if (espera.length){
        const porId = new Map(nodos.map(x => [x.id, x]));
        row.appendChild(el("div", "war-espera",
          "espera a: " + espera.map(id => nodoCorto(porId.get(id) || { id })).join(", ")));
      }
      if (n.espera_founder) row.appendChild(el("div", "war-espera", "J espera founder: " + n.espera_founder));
      if (n.titulo) row.appendChild(el("div", "war-tit", String(n.titulo)));
      lst.appendChild(row);
    }
  }
  side.appendChild(lst);

  side.appendChild(el("div", "war-nota",
    "arrastra una caja ✦ ready hasta el escritorio de un squad para proponer asignar_mision (draft)"));
}

/* drag de caja ready → escritorio de squad (ruteado por main.js desde office) */
export function onBoxDrag(info){
  info = info || {};
  const body = abrirPanel("Asignar misión");
  if (!body) return;
  const mision = String(info.mision_id || "");
  const squad = String(info.squad_destino || "");
  body.appendChild(el("div", "war-conf-l", "misión:"));
  body.appendChild(el("b", "war-conf-v", mision || "?"));
  body.appendChild(el("div", "war-conf-l", "squad destino:"));
  body.appendChild(el("b", "war-conf-v", squad || "?"));

  const nodos = (store.dag && Array.isArray(store.dag.nodos)) ? store.dag.nodos : [];
  const nodo = nodos.find(n => n.id === mision);
  const st = nodo ? String(nodo.status_calc || nodo.status || "?") : null;
  if (st && st !== "ready"){
    body.appendChild(el("div", "arm-warn",
      `⚠ esta misión está "${st}" — solo las ready en inbox son asignables; el Supervisor puede rechazar el draft`));
  }
  const squadOk = listaSquads().some(s => s.slug === squad);
  if (squad && !squadOk){
    body.appendChild(el("div", "arm-warn", `⚠ squad "${squad}" no está en squads.json`));
  }
  body.appendChild(el("div", "war-nota",
    "setea SOLO squad: — agente: queda TBD para el Supervisor"));

  const hint = el("div", "acard-hint", "");
  const fila = el("div", "acard-acciones");
  const go = el("button", "btn-mc btn-go", "crear draft asignar_mision");
  go.type = "button";
  go.addEventListener("click", async () => {
    go.disabled = true;
    hint.textContent = "enviando draft…";
    const r = data && data.sendCommand
      ? await data.sendCommand("asignar_mision", { mision, squad })
      : null;
    hint.textContent = (r && r.hint) ? r.hint : "sin datos (¿corre el server?)";
    go.disabled = false;
  });
  fila.appendChild(go);
  body.appendChild(fila);
  body.appendChild(hint);
}
