/* Bootstrap del dashboard (§4.2): conecta datos (data.js), vistas (views.js),
   paneles (panels/*) y el motor de la oficina (engine/office.js).
   Sin lógica inline en el HTML: todo entra por acá. */

import * as data from "./data.js";
import * as views from "./views.js";
import * as office from "./engine/office.js";
import * as player from "./engine/player.js";
import * as agentCard from "./panels/agent-card.js";
import * as armory from "./panels/armory.js";
import * as warroom from "./panels/warroom.js";
import * as founder from "./panels/founder.js";
import * as despacho from "./panels/despacho.js";
import * as juice from "./panels/juice.js";

const $ = s => document.querySelector(s);
let activeView = "oficina";

function setView(nombre){
  activeView = nombre;
  document.querySelectorAll(".navbtn").forEach(b =>
    b.classList.toggle("active", b.dataset.view === nombre));
  document.querySelectorAll(".view").forEach(v =>
    v.classList.toggle("active", v.id === "view-" + nombre));
  try{ views.renderView(nombre); }catch(e){ /* estado parcial: seguimos */ }
  try{
    if (nombre === "armeria") armory.render();
    else if (nombre === "guerra") warroom.render();   // chrome + office.renderWarBoard(#war-board)
  }catch(e){ /* idem */ }
}

function setPaused(on){
  office.setPausedMode(on);
  document.body.classList.toggle("alarma", !!on);
  const b = $("#paused-banner");
  if (b) b.hidden = !on;
  if (on){ try{ player.onAlarm(); }catch(e){} }   // la pausa real interrumpe el modo jugador
}

/* ---------- alarma de incendio (modal: consecuencias → token → "PAUSAR") ---------- */
function abrirAlarma(){
  const modal = $("#alarm-modal");
  modal.hidden = false;
  $("#alarm-token").value = ""; $("#alarm-confirm").value = "";
  $("#alarm-result").textContent = "";
}
function cerrarAlarma(){ $("#alarm-modal").hidden = true; }
async function activarAlarma(e){
  e.preventDefault();
  const res = $("#alarm-result");
  if ($("#alarm-confirm").value.trim() !== "PAUSAR"){
    res.textContent = "escribe exactamente PAUSAR para confirmar"; return;
  }
  const token = $("#alarm-token").value.trim();
  if (!token){ res.textContent = "falta el token (org/dashboard/.alarm-token)"; return; }
  res.textContent = "enviando…";
  try{
    const r = await data.fireAlarm(token);
    if (r && r.ok){
      res.textContent = "🚨 org pausado — la reanudación va por draft reanudar_org";
      setPaused(true);
      setTimeout(cerrarAlarma, 1600);
    } else res.textContent = (r && (r.hint || r.detail || r.error)) || "rechazado (¿token?)";
  }catch(err){ res.textContent = "sin datos (¿corre el server?)"; }
}

/* ---------- reacciones de la oficina ante eventos REALES del org ---------- */
function onOrgEvent(e){
  const ev = (e && e.evento) || e || {};
  switch (ev.tipo){
    case "review_verdict":
      if (ev.verdict === "rechazado"){
        office.showReject(ev.agente, ev.squad);
        office.showBubble(ev.agente, ev.squad, `✗ ${ev.mision || ""}: ${ev.detalle || "rechazado"}`);
      } else if (ev.verdict === "aprobado" && ev.mision){
        office.celebrate(ev.mision);
      }
      break;
    case "cuarentena":
      office.walkToInfirmary(ev.agente, ev.squad);
      break;
    case "pausa_org": setPaused(true); break;        // overlay global INMEDIATO en toda vista
    case "reanudacion_org": setPaused(false); break;
    case "founder_item":
    case "founder_respuesta":
      office.applyData(data.store);                  // refresco de la bandeja del founder
      break;
    case "tier_change":
      office.applyData(data.store);                  // applyData detecta el cambio → flash
      break;
    case "nudge":
      office.showBubble(ev.agente, ev.squad, `👉 ${ev.detalle || "nudge"}`);
      break;
    case "lead_msg":
      office.showBubble(null, ev.squad, `💬 ${ev.detalle || "mensaje del Lead"}`);
      break;
    case "command_applied":
      office.showBubble(ev.agente, ev.squad, `✅ comando aplicado${ev.detalle ? ": " + ev.detalle : ""}`);
      break;
    default: if (ev.squad) office.showBubble(ev.agente, ev.squad, ev.detalle || ev.tipo || "");
  }
}

/* ---------- arranque ---------- */
async function boot(){
  await data.init();

  // handlers COMPARTIDOS: el mouse (MODO MANDO) y el player (MODO JUGADOR)
  // disparan exactamente la misma plomería
  const onSpriteClick = ({agente, squad}) => { try{ agentCard.open(agente, squad); }catch(e){} };
  const onLeadClick = ({squad}) => { try{ founder.openChat(squad); }catch(e){} };
  // el escritorio ✉ abre EL DESPACHO (overlay diegético). Con server viejo
  // open() NO lanza: degrada adentro; el fallback solo si revienta de verdad
  const onDeskClick = () => {
    try{ despacho.open(); }catch(e){ try{ founder.openDesk(); }catch(e2){} }
  };

  office.initOffice({
    canvas: $("#office"),
    overlay: $("#overlay"),
    onSpriteClick,
    onLeadClick,
    onDeskClick,
    onItemDrop: async (info) => {
      // panel de confirmación de la armería si existe; si no, draft directo
      if (typeof armory.onItemDrop === "function"){ try{ armory.onItemDrop(info); return; }catch(e){} }
      try{
        const r = await data.sendCommand("equipar_tool", {agente: info.agente, tool: info.item_id});
        office.showBubble(info.agente, info.squad, (r && r.hint) || "sin datos (¿corre el server?)");
      }catch(e){ office.showBubble(info.agente, info.squad, "sin datos (¿corre el server?)"); }
    },
    onBoxDrag: async (info) => {
      if (typeof warroom.onBoxDrag === "function"){ try{ warroom.onBoxDrag(info); return; }catch(e){} }
      try{
        const r = await data.sendCommand("asignar_mision", {mision: info.mision_id, squad: info.squad_destino});
        office.showBubble(null, info.squad_destino, (r && r.hint) || "sin datos (¿corre el server?)");
      }catch(e){ office.showBubble(null, info.squad_destino, "sin datos (¿corre el server?)"); }
    },
  });

  try{ player.init({ cbs: { onSpriteClick, onLeadClick, onDeskClick } }); }catch(e){ /* sin modo jugador: el mando sigue */ }
  try{ views.initViews({data}); }catch(e){ /* vistas degradadas: la oficina sigue */ }
  const deps = {data, office};
  for (const p of [agentCard, armory, warroom, founder, despacho, juice]){
    try{ if (typeof p.init === "function") p.init(deps); }catch(e){ /* panel degradado */ }
  }

  office.applyData(data.store);
  if (data.store && data.store.state && data.store.state.paused) setPaused(true);

  // refrescos: cualquier cambio real re-aplica datos al motor y re-pinta la vista activa
  const QUES = ["missions", "founder", "agents", "squads", "state", "paused", "usage",
                "security", "metrics", "armory", "dag", "feed", "despacho"];
  for (const q of QUES){
    try{
      data.on("refresh:" + q, () => {
        office.applyData(data.store);
        if (q === "paused" || q === "state"){
          const p = data.store && data.store.state && data.store.state.paused;
          if (p != null) setPaused(!!p);
        }
        try{ views.renderView(activeView); }catch(e){}
      });
    }catch(e){ /* token de refresh no soportado por data.js: seguimos */ }
  }
  try{ data.on("org_event", onOrgEvent); }catch(e){}

  // navegación
  document.querySelectorAll(".navbtn").forEach(b =>
    b.addEventListener("click", () => setView(b.dataset.view)));
  window.addEventListener("office:navigate", e =>
    setView((e.detail && e.detail.view) || "oficina"));

  // chrome del shell
  $("#fire-alarm-btn").addEventListener("click", abrirAlarma);
  $("#alarm-cancel").addEventListener("click", cerrarAlarma);
  $("#alarm-form").addEventListener("submit", activarAlarma);
  setInterval(() => {
    $("#clock").textContent = new Date().toLocaleTimeString("es-EC", {hour12: false});
  }, 1000);

  setView("oficina");
}

boot();
