/* MISSION CONTROL v3 — panels/despacho.js
   EL DESPACHO DEL FOUNDER: overlay diegético de pantalla completa. Se entra
   clickeando el escritorio ✉ de la sala COMMAND (main.js onDeskClick). Tres
   zonas (PARA DECIDIR / PARA LEER / DECIDIDO) + BIBLIOTECA de recursos, todas
   leídas de /api/despacho (contrato org/system/DESPACHO.md — plomería real,
   cero datos cableados). Convenciones del mundo: createElement/textContent
   (anti-XSS), papel crema, sombras duras, sello DECIDIDO estampado.
   z-index 85 < #panel-root 90: los lectores existentes abren ENCIMA. */

import { store, on } from "../data.js";
import { abrirPanel, cerrarPanel } from "../views.js";
import { openItem as openFounderItem } from "./founder.js";

let data = null, office = null;
let tab = "escritorio";          // escritorio | biblioteca
let drawerAbierto = false;
let filtroLedger = "operador";   // operador | todas
const REDUCED = !!(window.matchMedia
  && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

export function init(deps){
  data = (deps && deps.data) || null;
  office = (deps && deps.office) || null;
  on("refresh:despacho", () => { if (visible()) renderCuerpo(); });
}

const ov = () => document.getElementById("despacho-ov");
const visible = () => { const o = ov(); return !!(o && !o.hidden); };

function el(tag, clase, texto){
  const n = document.createElement(tag);
  if (clase) n.className = clase;
  if (texto != null) n.textContent = String(texto);
  return n;
}

/* ---------- abrir / cerrar ---------- */
export function open(){
  const o = ov();
  if (!o) return;
  construir(o);
  o.hidden = false;
  o.classList.add("desp-abierta");
  renderCuerpo();
}

export function close(){
  const o = ov();
  if (!o) return;
  o.hidden = true;
  o.classList.remove("desp-abierta");
}

document.addEventListener("keydown", e => {
  if (e.key !== "Escape" || !visible()) return;
  const panel = document.getElementById("panel-root");
  if (panel && panel.classList.contains("abierto")){
    // Esc en cadena: 1º cierra el lector, 2º sale a la oficina — nunca atrapado
    try{ cerrarPanel(); }catch(err){}
    return;
  }
  close();
});

/* ---------- escena: pared (puerta + ventana + retrato + cartel + tabs) ---------- */
function construir(o){
  o.textContent = "";
  const room = el("div", "desp-room");

  const wall = el("div", "desp-wall");
  const door = el("button", "desp-door");
  door.type = "button";
  door.appendChild(el("div", "desp-door-flecha", "↩"));
  door.appendChild(el("div", null, "VOLVER A LA"));
  door.appendChild(el("div", null, "OFICINA"));
  door.title = "volver a la oficina (Esc)";
  door.addEventListener("click", close);
  wall.appendChild(door);
  wall.appendChild(ventana());
  wall.appendChild(retratoFounder());

  const sign = el("div", "desp-sign");
  sign.appendChild(el("h2", null, "✉ DESPACHO DEL FOUNDER"));
  sign.appendChild(el("div", "desp-sub",
    "aquí trabajas tú — el org te deja los papeles solo (org/system/DESPACHO.md)"));
  wall.appendChild(sign);

  const tabs = el("div", "desp-tabs");
  for (const [id, txt] of [["escritorio", "🗂 ESCRITORIO"], ["biblioteca", "📚 BIBLIOTECA"]]){
    const b = el("button", "desp-tab" + (tab === id ? " activa" : ""), txt);
    b.type = "button";
    b.dataset.tab = id;
    b.addEventListener("click", () => {
      tab = id;
      o.querySelectorAll(".desp-tab").forEach(x =>
        x.classList.toggle("activa", x.dataset.tab === id));
      renderCuerpo();
    });
    tabs.appendChild(b);
  }
  wall.appendChild(tabs);
  wall.appendChild(el("div", "desp-score", "SCORE ---"));   // misiones completadas hoy (dato real)
  // regla Chanel de la skill: el reloj se quitó (dato redundante con el del sistema)
  const salir = el("button", "desp-salir", "✕");
  salir.type = "button";
  salir.title = "salir a la oficina (Esc)";
  salir.addEventListener("click", close);
  wall.appendChild(salir);
  room.appendChild(wall);

  const desk = el("div", "desp-desk");
  desk.id = "desp-desk";
  room.appendChild(desk);
  o.appendChild(room);
}

/* ventana pixel-art: noche, luna, skyline (decorativa, procedural como todo el mundo) */
function ventana(){
  const cv = document.createElement("canvas");
  cv.className = "desp-ventana";
  cv.width = 120; cv.height = 68;
  const c = cv.getContext("2d");
  if (!c) return cv;
  c.imageSmoothingEnabled = false;
  c.fillStyle = "#0e1626"; c.fillRect(0, 0, 120, 68);
  c.fillStyle = "#c8d4ec";
  for (const [x, y] of [[9,8],[22,16],[37,6],[51,21],[66,10],[83,18],[104,7],[112,24],[30,30],[74,28]])
    c.fillRect(x, y, 1, 1);
  c.fillStyle = "#efe6d6"; c.fillRect(92, 8, 12, 12);          // luna
  c.fillStyle = "#0e1626"; c.fillRect(89, 5, 9, 9);            // fase
  c.fillStyle = "#141d30";                                      // skyline lejano
  for (const [x, w, h] of [[0,14,18],[16,10,26],[28,16,14],[46,12,22],[60,18,12],[80,10,20],[92,16,10],[110,10,16]])
    c.fillRect(x, 68 - h, w, h);
  c.fillStyle = "#3d4a66";                                      // ventanas encendidas
  for (const [x, y] of [[4,56],[19,48],[33,58],[49,52],[64,60],[83,54],[96,61],[113,56]])
    c.fillRect(x, y, 2, 2);
  c.fillStyle = "#54422f";                                      // travesaños del marco
  c.fillRect(58, 0, 4, 68); c.fillRect(0, 32, 120, 4);
  return cv;
}

/* retrato del founder en la pared (corona dorada — tier fable) */
function retratoFounder(){
  const cv = document.createElement("canvas");
  cv.className = "desp-retrato";
  cv.width = 40; cv.height = 48;
  const c = cv.getContext("2d");
  if (!c) return cv;
  c.imageSmoothingEnabled = false;
  c.fillStyle = "#1b1410"; c.fillRect(0, 0, 40, 48);
  c.fillStyle = "#f2c9a0"; c.fillRect(12, 14, 16, 16);          // cara
  c.fillStyle = "#2b1d12"; c.fillRect(12, 10, 16, 7);           // pelo
  c.fillStyle = "#241c10"; c.fillRect(16, 21, 2, 4); c.fillRect(22, 21, 2, 4); // ojos
  c.fillStyle = "#4a3408"; c.fillRect(8, 32, 24, 12);           // saco
  c.fillStyle = "#ffd166"; c.fillRect(13, 6, 3, 4); c.fillRect(18, 4, 4, 6); c.fillRect(24, 6, 3, 4); // corona
  c.fillRect(8, 32, 24, 2);                                     // ribete dorado
  return cv;
}

/* ---------- cuerpo según tab ---------- */
function renderCuerpo(){
  const sc = document.querySelector("#despacho-ov .desp-score");
  if (sc){
    const dig = store.state && store.state.digest;
    const n = dig && dig.completadas_hoy != null ? Number(dig.completadas_hoy) : null;
    sc.textContent = "SCORE " + (n == null || isNaN(n) ? "---" : String(n).padStart(3, "0"));
  }
  const desk = document.getElementById("desp-desk");
  if (!desk) return;
  desk.textContent = "";
  if (tab === "biblioteca"){ renderBiblioteca(desk); return; }
  renderEscritorio(desk);
}

function renderEscritorio(desk){
  const dp = store.despacho;
  if (!dp || typeof dp !== "object"){
    desk.appendChild(el("div", "nodata", "sin datos (/api/despacho no responde — ¿server viejo? reinicia el dashboard)"));
    return;
  }
  // red local anti-flicker: un item recién sellado (update optimista) no se
  // re-pinta aunque el refetch del server todavía no haya llegado
  const sinSellados = xs => (Array.isArray(xs) ? xs : []).filter(it => it && it.estado !== "decidido");
  const decidir = sinSellados(dp.decidir);
  const leer = sinSellados(dp.leer);

  const cols = el("div", "desp-cols");

  const colD = el("div", "desp-col desp-col-decidir");
  const hD = el("h3");
  hD.appendChild(el("span", null, "🪧 PARA DECIDIR"));
  hD.appendChild(el("b", null, String(decidir.length)));
  hD.appendChild(el("span", "desp-h-nota", "decidir aquí = sello + acción copy-paste"));
  colD.appendChild(hD);
  const pilaD = el("div", "desp-papeles");
  if (!decidir.length){
    const v = el("div", "desp-vacio");
    v.appendChild(el("span", "desp-cafe", "☕"));
    v.appendChild(el("div", null, "nada espera tu decisión hoy"));
    v.appendChild(el("div", "desp-vsub",
      "cuando el org necesite una decisión tuya, el papel aparece aquí solo"));
    pilaD.appendChild(v);
  } else {
    for (const it of decidir) pilaD.appendChild(papel(it, "decidir"));
  }
  colD.appendChild(pilaD);
  cols.appendChild(colD);

  const colL = el("div", "desp-col desp-col-leer");
  const hL = el("h3");
  hL.appendChild(el("span", null, "📚 PARA LEER"));
  hL.appendChild(el("b", null, String(dp.conteos && dp.conteos.leer_sin_leer != null
    ? dp.conteos.leer_sin_leer : leer.length)));
  hL.appendChild(el("span", "desp-h-nota", "puntos clave inline · doc completo a un click"));
  colL.appendChild(hL);
  const pilaL = el("div", "desp-papeles");
  if (!leer.length){
    const v = el("div", "desp-vacio");
    v.appendChild(el("span", "desp-cafe", "📭"));
    v.appendChild(el("div", null, "sin informes nuevos"));
    v.appendChild(el("div", "desp-vsub",
      "un doc aparece aquí cuando arranca con su bloque PUNTOS CLAVE (ver org/system/DESPACHO.md)"));
    pilaL.appendChild(v);
  } else {
    for (const it of leer) pilaL.appendChild(papel(it, "leer"));
  }
  colL.appendChild(pilaL);
  cols.appendChild(colL);
  desk.appendChild(cols);

  desk.appendChild(archivador(dp));
}

const FUENTE_TXT = {
  doc: "INFORME", draft: "DRAFT DE MISIÓN", founder: "ITEM FOUNDER",
  outbox: "BRIEF EN TRÁNSITO", mision: "MISIÓN FRENADA",
};

/* ---------- un papel sobre el escritorio ---------- */
function papel(it, zona){
  const p = el("div", "desp-paper" + (it.estado === "leido" ? " leido" : ""));

  const memb = el("div", "desp-memb");
  if (it.estado === "sin-leer") memb.appendChild(el("span", "desp-dot"));
  memb.appendChild(el("span", null, FUENTE_TXT[it.fuente] || "DOCUMENTO"));
  if (it.origen) memb.appendChild(el("span", null, "· " + it.origen));
  if (zona === "decidir"){
    const u = String(it.urgencia || "esta semana");
    memb.appendChild(el("span", "desp-clip u-" + u.replace(/ /g, "-"),
      u === "hoy" ? "URGENTE · HOY" : u));
  } else {
    memb.appendChild(el("span", "desp-chip-estado " + (it.estado || "sin-leer"),
      it.estado === "leido" ? "leído" : "sin leer"));
  }
  if (it.mtime) memb.appendChild(el("span", "desp-fecha",
    new Date(it.mtime * 1000).toLocaleDateString("es-EC", { day: "2-digit", month: "short" })));
  p.appendChild(memb);

  p.appendChild(el("h4", null, it.titulo || it.id || "?"));

  const puntos = Array.isArray(it.puntos) ? it.puntos : [];
  if (puntos.length){
    const ul = el("ul", "desp-puntos");
    for (const pt of puntos.slice(0, 5))
      ul.appendChild(el("li", null, String(pt).replace(/\*\*/g, "")));  // sin ** crudos
    p.appendChild(ul);
  }

  if (zona === "decidir" && it.decision_pedida)
    p.appendChild(el("div", "desp-pide", "★ se te pide: " + it.decision_pedida));

  if (it.accion){
    const box = el("div", "desp-accion");
    const pre = el("pre", null, it.accion);
    box.appendChild(pre);
    const copy = el("button", "desp-copy", "COPIAR");
    copy.type = "button";
    copy.addEventListener("click", async () => {
      const ok = await copiar(it.accion);
      copy.textContent = ok ? "COPIADO ✓" : "no se pudo";
      setTimeout(() => { copy.textContent = "COPIAR"; }, 1600);
    });
    box.appendChild(copy);
    p.appendChild(box);
  }

  const acts = el("div", "desp-paper-acts");
  if (it.path){
    const b = el("button", "desp-btn", "📄 LEER DOC");
    b.type = "button";
    b.addEventListener("click", () => abrirDoc(it.path, it.titulo));
    acts.appendChild(b);
  }
  if (it.founder_id){
    const b = el("button", "desp-btn", "✉ ABRIR ITEM");
    b.type = "button";
    b.addEventListener("click", () => { try{ openFounderItem(it.founder_id); }catch(e){} });
    acts.appendChild(b);
  }
  if (zona === "leer" && it.estado === "sin-leer"){
    const b = el("button", "desp-btn", "✓ MARCAR LEÍDO");
    b.type = "button";
    b.addEventListener("click", () => marcar(it, "leido", b));
    acts.appendChild(b);
  }
  if (zona === "decidir"){
    const b = el("button", "desp-btn desp-btn-sello", "SELLO: DECIDIDO");
    b.type = "button";
    b.title = "registra la decisión como tomada (queda en el histórico)";
    b.addEventListener("click", () => sellar(it, p, b));
    acts.appendChild(b);
  }
  p.appendChild(acts);
  return p;
}

async function copiar(texto){
  try{
    if (navigator.clipboard && navigator.clipboard.writeText){
      await navigator.clipboard.writeText(String(texto));
      return true;
    }
  }catch(e){ /* fallback abajo */ }
  try{
    const ta = document.createElement("textarea");
    ta.value = String(texto);
    ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }catch(e){ return false; }
}

async function marcar(it, marca, btn){
  if (btn) btn.disabled = true;
  const r = data && data.markDespacho
    ? await data.markDespacho(it.id, marca, String(it.titulo || "").slice(0, 120)) : null;
  if (r && r.ok){
    it.estado = marca;                 // optimista: el SSE confirma enseguida
    renderCuerpo();
  } else if (btn){
    btn.disabled = false;
    btn.textContent = (r && r.hint) || "sin datos (¿corre el server?)";
  }
}

function sellar(it, paperEl_, btn){
  if (btn) btn.disabled = true;
  const fin = async () => {
    const r = data && data.markDespacho
      ? await data.markDespacho(it.id, "decidido", String(it.titulo || "").slice(0, 120)) : null;
    if (!(r && r.ok)){
      if (btn){ btn.disabled = false; btn.textContent = (r && r.hint) || "sin datos (¿corre el server?)"; }
      return;
    }
    it.estado = "decidido";
    if (REDUCED){ renderCuerpo(); return; }
    paperEl_.appendChild(el("div", "desp-sello", "DECIDIDO ✓"));
    setTimeout(renderCuerpo, 950);
  };
  fin();
}

/* ---------- lector de docs en MODO LECTURA ----------
   Panel lateral EXISTENTE encima del despacho (z 90 > 85). El pixel-art es
   para el MUNDO; acá el contenido se LEE: contraste alto, tipografía aireada,
   jerarquía clara y navegación anterior/siguiente sin volver a la lista.
   Anti-XSS intacto: TODO via createElement/textContent — nada de innerHTML. */

function navDocsActual(){
  // lista navegable: las dos bandejas en el orden en pantalla (solo docs con path)
  const dp = store.despacho || {};
  const todos = [...(Array.isArray(dp.decidir) ? dp.decidir : []),
                 ...(Array.isArray(dp.leer) ? dp.leer : [])];
  return todos.filter(it => it && it.path && it.estado !== "decidido")
    .map(it => ({ path: it.path, titulo: it.titulo }));
}

async function abrirDoc(path, titulo, nav){
  const body = abrirPanel(String(titulo || path).slice(0, 60), true);
  if (!body) return;
  body.classList.add("lect-body");

  // navegación: ‹ anterior · n/N · siguiente › — sin volver a la lista
  if (!nav){
    const lista = navDocsActual();
    const idx = lista.findIndex(x => x.path === path);
    if (idx >= 0) nav = { lista, idx };
  }
  if (nav && Array.isArray(nav.lista) && nav.lista.length > 1){
    const fila = el("div", "lect-nav");
    const ant = el("button", "desp-btn", "‹ anterior");
    ant.type = "button";
    ant.disabled = nav.idx <= 0;
    ant.addEventListener("click", () => {
      const it = nav.lista[nav.idx - 1];
      abrirDoc(it.path, it.titulo, { lista: nav.lista, idx: nav.idx - 1 });
    });
    const pos = el("span", "lect-nav-pos", `${nav.idx + 1} / ${nav.lista.length}`);
    const sig = el("button", "desp-btn", "siguiente ›");
    sig.type = "button";
    sig.disabled = nav.idx >= nav.lista.length - 1;
    sig.addEventListener("click", () => {
      const it = nav.lista[nav.idx + 1];
      abrirDoc(it.path, it.titulo, { lista: nav.lista, idx: nav.idx + 1 });
    });
    fila.appendChild(ant); fila.appendChild(pos); fila.appendChild(sig);
    body.appendChild(fila);
  }

  body.appendChild(el("div", "lect-path", path));
  const cont = el("div", "lect-doc");
  cont.appendChild(el("div", "nodata", "cargando…"));
  body.appendChild(cont);

  const d = data && data.fetchDoc ? await data.fetchDoc(path) : null;
  cont.textContent = "";
  if (!d || d.body == null){
    cont.appendChild(el("div", "nodata", "sin datos (doc fuera del guard de /api/doc o ausente)"));
    return;
  }
  renderDocLegible(String(d.body), cont);
}

/* renderer por bloques: frontmatter→metadatos · headings · bullets · tablas/
   fences→pre · párrafos unidos. El ** se pela fuera de los bloques de código. */
function renderDocLegible(texto, root){
  const lines = texto.split("\n");
  const limpiar = s => s.replace(/\*\*/g, "");
  let i = 0;

  if (lines[0] === "---"){                       // frontmatter → metadatos secundarios
    const fin = lines.indexOf("---", 1);
    if (fin > 0){
      const meta = el("div", "lect-meta");
      for (let j = 1; j < fin; j++){
        const m = lines[j].match(/^([\w-]+):\s*(.*)$/);
        if (m){
          const row = el("div", "lect-meta-row");
          row.appendChild(el("span", "lect-meta-k", m[1]));
          row.appendChild(el("span", "lect-meta-v", m[2].replace(/^["']|["']$/g, "")));
          meta.appendChild(row);
        } else if (lines[j].trim()){
          meta.appendChild(el("div", "lect-meta-v", lines[j].trim()));
        }
      }
      root.appendChild(meta);
      i = fin + 1;
    }
  }

  let pre = null, ul = null, parrafo = [], pc = null, fence = false, quote = null;
  const flushParrafo = () => {
    if (!parrafo.length) return;
    (pc || root).appendChild(el("p", "lect-p", limpiar(parrafo.join(" "))));
    parrafo = [];
  };
  for (; i < lines.length; i++){
    const raw = lines[i], s = raw.trim();
    if (!s.startsWith(">")) quote = null;   // cualquier otro bloque corta la cita
    if (s.startsWith("```")){
      flushParrafo(); ul = null;
      fence = !fence;
      if (fence){ pre = el("pre", "lect-pre"); (pc || root).appendChild(pre); }
      else pre = null;
      continue;
    }
    if (fence){ if (pre) pre.textContent += raw + "\n"; continue; }
    if (s.startsWith("|")){                       // tabla: monoespaciado tal cual
      flushParrafo(); ul = null;
      if (!pre){ pre = el("pre", "lect-pre"); (pc || root).appendChild(pre); }
      pre.textContent += raw + "\n";
      continue;
    }
    pre = null;
    if (!s){ flushParrafo(); ul = null; continue; }
    const h = s.match(/^(#{1,6})\s+(.*)$/);
    if (h){
      flushParrafo(); ul = null;
      const texto_h = limpiar(h[2]);
      if (/^PUNTOS CLAVE/i.test(texto_h)){        // el bloque va DESTACADO arriba
        pc = el("div", "lect-pc");
        pc.appendChild(el("div", "lect-pc-h", "★ " + texto_h));
        root.appendChild(pc);
      } else {
        pc = null;
        root.appendChild(el("div", "lect-h lect-h" + Math.min(h[1].length, 3), texto_h));
      }
      continue;
    }
    if (s === "---"){ flushParrafo(); ul = null; pc = null; continue; }
    if (/Decisi[oó]n que se te pide/i.test(s)){
      flushParrafo(); ul = null;
      (pc || root).appendChild(el("div", "lect-decision", limpiar(s)));
      continue;
    }
    if (s.startsWith("- ") || s.startsWith("* ")){
      flushParrafo();
      if (!ul){ ul = el("ul", "lect-ul"); (pc || root).appendChild(ul); }
      ul.appendChild(el("li", null, limpiar(s.slice(2))));
      continue;
    }
    if (s.startsWith(">")){
      flushParrafo(); ul = null;
      const txt = limpiar(s.replace(/^>+\s?/, ""));
      if (quote && quote.parentNode === (pc || root)){
        quote.textContent += " " + txt;     // líneas > consecutivas = UNA cita
      } else {
        quote = el("div", "lect-quote", txt);
        (pc || root).appendChild(quote);
      }
      continue;
    }
    quote = null;
    ul = null;
    parrafo.push(s);
  }
  flushParrafo();
}

/* ---------- archivador DECIDIDO ---------- */
function archivador(dp){
  const dr = el("div", "desp-drawer");
  const head = el("button", "desp-drawer-head");
  head.type = "button";
  head.appendChild(el("span", null, (drawerAbierto ? "▼" : "▶") + " 🗄 DECIDIDO — histórico"));
  head.appendChild(el("b", null, String((dp.decidido || []).length)));
  head.appendChild(el("span", "desp-h-nota", "qué decidiste, cuándo, y qué lo pedía"));
  head.addEventListener("click", () => { drawerAbierto = !drawerAbierto; renderCuerpo(); });
  dr.appendChild(head);
  if (!drawerAbierto) return dr;

  const body = el("div", "desp-drawer-body");
  const filtros = el("div", "desp-filtros");
  for (const [id, txt] of [["operador", "SOLO TUS DECISIONES"], ["todas", "TODAS (org incluido)"]]){
    const f = el("button", "desp-filtro" + (filtroLedger === id ? " activa" : ""), txt);
    f.type = "button";
    f.addEventListener("click", () => { filtroLedger = id; renderCuerpo(); });
    filtros.appendChild(f);
  }
  body.appendChild(filtros);

  const entradas = (Array.isArray(dp.decidido) ? dp.decidido : []).filter(e =>
    filtroLedger === "todas" || e.es_operador);
  if (!entradas.length){
    body.appendChild(el("div", "nodata", "sin decisiones registradas"));
  } else {
    for (const e of entradas){
      const row = el("div", "desp-ledger-row");
      row.appendChild(el("span", "desp-lfecha", e.fecha || "?"));
      row.appendChild(el("span",
        "desp-lquien" + (e.es_operador ? " operador" : ""), e.quien || "?"));
      if (e.fuente === "sello") row.appendChild(el("span", "desp-lsello", "DECIDIDO"));
      row.appendChild(el("span", "desp-ldec", e.decision || ""));
      const sub = [e.porque, e.fase].filter(Boolean).join("  ·  ");
      if (sub) row.appendChild(el("span", "desp-lpor", sub));
      if (e.fuente === "founder" && e.ref){
        row.style.cursor = "pointer";
        row.title = "abrir el item que lo pedía";
        row.addEventListener("click", () => { try{ openFounderItem(e.ref); }catch(err){} });
      } else if (e.fuente === "sello" && /\.md$/.test(String(e.ref || ""))){
        row.style.cursor = "pointer";
        row.title = "abrir el doc que lo pedía";
        row.addEventListener("click", () => abrirDoc(e.ref, e.decision));
      }
      body.appendChild(row);
    }
  }
  dr.appendChild(body);
  return dr;
}

/* ---------- biblioteca: recursos reales usados por el org ---------- */
const LOMOS = ["#ffd166", "#a78bfa", "#60a5fa", "#2dd4bf", "#f5a623", "#ef8c8c", "#9ccc65"];
const lomoDe = s => {
  let h = 0;
  for (const ch of String(s || "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return LOMOS[h % LOMOS.length];
};
const librosAbiertos = new Set();

async function renderBiblioteca(desk){
  const wrap = el("div", "desp-bib");
  const head = el("div", "desp-bib-head");
  head.appendChild(el("span", null, "📚 BIBLIOTECA DEL ORG"));
  head.appendChild(el("b", null, "…"));
  head.appendChild(el("span", null, "recursos que el org usó — por documento y equipo"));
  const doms = el("div", "desp-bib-doms");
  head.appendChild(doms);
  wrap.appendChild(head);
  const estante = el("div", "desp-estante");
  estante.appendChild(el("div", "nodata", "cargando estante…"));
  wrap.appendChild(estante);
  desk.appendChild(wrap);

  const b = data && data.fetchDespachoBiblioteca ? await data.fetchDespachoBiblioteca() : null;
  estante.textContent = "";
  if (!b || !Array.isArray(b.docs)){
    estante.appendChild(el("div", "nodata", "sin datos (/api/despacho/biblioteca no responde — ¿server viejo?)"));
    return;
  }
  head.querySelector("b").textContent = String(b.total || 0);
  for (const d of (b.dominios || []).slice(0, 6))
    doms.appendChild(el("span", "desp-dom", `${d.dominio} ×${d.n}`));
  if (!b.docs.length){
    estante.appendChild(el("div", "nodata", b.error || "sin datos (ningún doc con links)"));
    return;
  }
  const navLista = b.docs.map(d2 => ({ path: d2.path, titulo: d2.titulo }));
  b.docs.forEach((doc, idx) => estante.appendChild(libro(doc, navLista, idx)));
}

function libro(doc, navLista, navIdx){
  const card = el("div", "desp-libro");
  const head = el("button", "desp-libro-head");
  head.type = "button";
  const lomo = el("span", "desp-lomo");
  lomo.style.background = lomoDe(doc.squad);
  head.appendChild(lomo);
  const tit = el("div", "desp-libro-tit");
  tit.appendChild(el("b", null, doc.titulo || doc.path));
  tit.appendChild(el("div", "desp-libro-meta",
    [doc.squad ? "equipo: " + doc.squad : null, doc.mision ? "misión: " + doc.mision : null]
      .filter(Boolean).join("  ·  ") || doc.path));
  head.appendChild(tit);
  head.appendChild(el("span", "desp-libro-n", `${doc.n} 🔗`));
  card.appendChild(head);

  const body = el("div", "desp-libro-body");
  body.hidden = !librosAbiertos.has(doc.path);
  head.addEventListener("click", () => {
    body.hidden = !body.hidden;
    if (body.hidden) librosAbiertos.delete(doc.path);
    else librosAbiertos.add(doc.path);
  });

  const abrir = el("button", "desp-btn", "📄 ABRIR DOC");
  abrir.type = "button";
  abrir.addEventListener("click", () => abrirDoc(doc.path, doc.titulo,
    navLista ? { lista: navLista, idx: navIdx } : null));
  body.appendChild(abrir);
  for (const r of (doc.recursos || [])){
    const rec = el("div", "desp-rec");
    // defensa en profundidad: solo http(s) clickeable (los docs los escriben agentes)
    if (/^https?:\/\//i.test(String(r.url || ""))){
      const a = document.createElement("a");
      a.href = r.url; a.target = "_blank"; a.rel = "noopener noreferrer";
      a.textContent = r.texto || r.dominio || r.url;
      rec.appendChild(a);
    } else {
      rec.appendChild(el("b", null, r.texto || r.url || "?"));
    }
    if (r.contexto) rec.appendChild(el("span", "desp-rec-ctx", r.contexto));
    const meta = el("div", "desp-rec-meta");
    if (r.dominio) meta.appendChild(el("span", "desp-rec-dom", r.dominio));
    if (r.verificado) meta.appendChild(el("span", "desp-rec-ver", "verificado ✓"));
    rec.appendChild(meta);
    body.appendChild(rec);
  }
  card.appendChild(body);
  return card;
}
