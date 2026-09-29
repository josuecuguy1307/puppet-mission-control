/* Mapa de la oficina — grid 62×40 (canvas 992×640), tiles 16px.
   PURO: sin DOM en import-time → el self-check BFS corre también en node.
   Conserva los rects + desk-slots de las 4 salas v2 y el dibujo de tiles v2. */

export const TS = 16, GW = 62, GH = 40, LW = GW * TS, LH = GH * TS;
export const T = {VOID:0, COR:1, WOOD:2, WALL:3, DOOR:4, DESK:5, SOLID:6};
export const grid = new Uint8Array(GW * GH);
export const gi = (x, y) => y * GW + x;
export const inb = (x, y) => x >= 0 && y >= 0 && x < GW && y < GH;
export const walkable = t => t === T.COR || t === T.WOOD || t === T.DOOR;

export function frect(x0, y0, x1, y1, t){
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (inb(x, y)) grid[gi(x, y)] = t;
}

/* Salas: las 4 v2 con sus rects/doors ORIGINALES + 5 nuevas (§4.3).
   Pasillos obligatorios: columna 45 y fila 27 (la fila 27 corre x1..45; a la
   derecha de col 45 la ocupa la Enfermería por rect normativo de la SPEC). */
export const ROOMS = {
  "Engineering": {x0:1,  y0:1,  x1:14, y1:26, doors:[[14,13]],           tint:null},
  "R&D":         {x0:31, y0:1,  x1:44, y1:22, doors:[[31,11]],           tint:null},
  "Command":     {x0:16, y0:1,  x1:29, y1:10, doors:[[22,10],[23,10]],   tint:null},
  "Business":    {x0:16, y0:14, x1:29, y1:26, doors:[[22,14],[23,14]],   tint:null},
  "Guerra":      {x0:46, y0:1,  x1:61, y1:12, doors:[[46,6]],            tint:"rgba(120,24,24,.16)"},
  "Armeria":     {x0:46, y0:14, x1:61, y1:22, doors:[[46,18]],           tint:"rgba(90,70,20,.16)"},
  "Enfermeria":  {x0:46, y0:24, x1:61, y1:31, doors:[[46,26]],           tint:"rgba(40,110,110,.14)"},
  "Biblioteca":  {x0:1,  y0:28, x1:14, y1:38, doors:[[8,28]],            tint:"rgba(80,55,15,.18)"},
  "Hall":        {x0:16, y0:28, x1:44, y1:38, doors:[[22,28],[30,28],[38,28]], tint:"rgba(120,95,40,.10)"},
};
export const ROOM_SIGNS = {
  "Engineering":"ENGINEERING", "R&D":"R&D", "Command":"COMMAND", "Business":"BUSINESS",
  "Guerra":"SALA DE GUERRA", "Armeria":"ARMERÍA", "Enfermeria":"ENFERMERÍA",
  "Biblioteca":"BIBLIOTECA", "Hall":"HALL",
};

/* desk-slots v2 intactos (por división) */
export const DESK_SLOTS = {
  "Engineering": [[3,3],[9,3],[3,9],[9,9],[3,15],[9,15],[3,21],[9,21]],
  "R&D":         [[33,3],[39,3],[33,9],[39,9],[33,15],[39,15]],
  "Business":    [[18,16],[24,16],[18,21],[24,21]],
  "Command":     [[21,5]],
};

/* máquina de café reubicada al Hall (lo permite la SPEC) */
export const COFFEE = {x:40, y:30, stand:[[40,31],[41,31]]};
/* plantas v2: (2,31)→(32,24) y (43,31)→(38,24) — caían dentro de Biblioteca/Hall */
export const PLANTS = [[15,2],[30,2],[32,24],[38,24],[44,24],[15,25]];
/* lámparas: las de fila 28 caían sobre salas nuevas → fila 26; + ala derecha (solo dibujo) */
export const LAMPS = [[15,4],[15,12],[15,20],[15,26],[30,4],[30,12],[30,20],[30,26],[45,6],[45,18],[45,30]];

export const FOUNDER_DESK = {x:25, y:3, w:3, chair:{x:26, y:4}};
export const INFIRMARY_BEDS = [{x:49,y:26},{x:53,y:26},{x:57,y:26},{x:49,y:29},{x:53,y:29},{x:57,y:29}];
export const ARMORY_SHELVES = [{x0:48, y:16, x1:59}, {x0:48, y:20, x1:59}];
export const LIB_SHELVES = [{x0:3, y:30, x1:12}, {x0:3, y:33, x1:12}, {x0:3, y:36, x1:12}];
export const MEETING_TABLE = {x0:27, y0:32, x1:33, y1:33,
  spots:[[26,32],[26,33],[34,32],[34,33],[28,31],[30,31],[32,31],[28,34],[30,34],[32,34]]};
export const WAR_WALL = {x:47, y:2, w:13, h:4};                 // tablero mini-DAG (dibujo)
export const HALL_BOARDS = {leader:{x:18, y:28, w:6}, tablon:{x:36, y:28, w:6}};

export function buildMap(){
  grid.fill(T.VOID);
  frect(1, 1, 60, 38, T.COR);
  frect(0, 0, 61, 0, T.WALL); frect(0, 39, 61, 39, T.WALL);     // perímetro x=61 / y=39
  frect(0, 0, 0, 39, T.WALL); frect(61, 0, 61, 39, T.WALL);
  for (const r of Object.values(ROOMS)){
    frect(r.x0, r.y0, r.x1, r.y0, T.WALL); frect(r.x0, r.y1, r.x1, r.y1, T.WALL);
    frect(r.x0, r.y0, r.x0, r.y1, T.WALL); frect(r.x1, r.y0, r.x1, r.y1, T.WALL);
    frect(r.x0 + 1, r.y0 + 1, r.x1 - 1, r.y1 - 1, T.WOOD);
    for (const [dx, dy] of r.doors) grid[gi(dx, dy)] = T.DOOR;
  }
  grid[gi(COFFEE.x, COFFEE.y)] = T.SOLID; grid[gi(COFFEE.x + 1, COFFEE.y)] = T.SOLID;
  for (const [px, py] of PLANTS) grid[gi(px, py)] = T.SOLID;
  for (const b of INFIRMARY_BEDS){ grid[gi(b.x, b.y)] = T.SOLID; grid[gi(b.x + 1, b.y)] = T.SOLID; }
  for (const sh of ARMORY_SHELVES) frect(sh.x0, sh.y, sh.x1, sh.y, T.SOLID);
  for (const sh of LIB_SHELVES) frect(sh.x0, sh.y, sh.x1, sh.y, T.SOLID);
  frect(MEETING_TABLE.x0, MEETING_TABLE.y0, MEETING_TABLE.x1, MEETING_TABLE.y1, T.SOLID);
  frect(FOUNDER_DESK.x, FOUNDER_DESK.y, FOUNDER_DESK.x + FOUNDER_DESK.w - 1, FOUNDER_DESK.y, T.DESK);
  selfCheck();
}

/* tile caminable más cercano al centro de la sala (espiral acotada) */
export function roomCenterWalkable(r){
  const cx = ((r.x0 + r.x1) / 2) | 0, cy = ((r.y0 + r.y1) / 2) | 0;
  const maxR = Math.max(r.x1 - r.x0, r.y1 - r.y0);
  for (let rad = 0; rad <= maxR; rad++)
    for (let dy = -rad; dy <= rad; dy++) for (let dx = -rad; dx <= rad; dx++){
      const x = cx + dx, y = cy + dy;
      if (x <= r.x0 || x >= r.x1 || y <= r.y0 || y >= r.y1) continue;
      if (inb(x, y) && walkable(grid[gi(x, y)])) return {x, y};
    }
  return null;
}

/* Self-check OBLIGATORIO: BFS desde el cruce de pasillos (45,27) al centro de
   CADA sala; sala inalcanzable → console.error (QA lo verifica). */
export function selfCheck(){
  const start = {x:45, y:27};
  const seen = new Uint8Array(GW * GH);
  const q = [gi(start.x, start.y)]; seen[q[0]] = 1;
  while (q.length){
    const cur = q.shift(), cx = cur % GW, cy = (cur / GW) | 0;
    for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]){
      const nx = cx + dx, ny = cy + dy;
      if (!inb(nx, ny)) continue;
      const ni = gi(nx, ny);
      if (seen[ni] || !walkable(grid[ni])) continue;
      seen[ni] = 1; q.push(ni);
    }
  }
  const inalcanzables = [];
  for (const [nombre, r] of Object.entries(ROOMS)){
    const c = roomCenterWalkable(r);
    if (!c || !seen[gi(c.x, c.y)]){
      inalcanzables.push(nombre);
      console.error(`[map] self-check BFS: sala inalcanzable desde el pasillo: ${nombre}`);
    }
  }
  return inalcanzables;
}

/* BFS de caminos (v2, portado) */
export function bfs(sx, sy, tx, ty){
  if (!inb(tx, ty) || !walkable(grid[gi(tx, ty)])) return null;
  if (sx === tx && sy === ty) return [];
  const prev = new Int32Array(GW * GH).fill(-1);
  const q = [gi(sx, sy)]; prev[gi(sx, sy)] = gi(sx, sy);
  const D = [[1,0],[-1,0],[0,1],[0,-1]];
  while (q.length){
    const cur = q.shift(), cx = cur % GW, cy = (cur / GW) | 0;
    for (const [dx, dy] of D){
      const nx = cx + dx, ny = cy + dy;
      if (!inb(nx, ny)) continue;
      const ni = gi(nx, ny);
      if (prev[ni] !== -1 || !walkable(grid[ni])) continue;
      prev[ni] = cur;
      if (nx === tx && ny === ty){
        const path = []; let p = ni;
        while (p !== gi(sx, sy)){ path.push({x: p % GW, y: (p / GW) | 0}); p = prev[p]; }
        return path.reverse();
      }
      q.push(ni);
    }
  }
  return null;
}

/* ---------- dibujo de tiles / decoración (v2 portado; ctx por parámetro) ---------- */
export function vary(x, y, n){ return ((x * 7 + y * 13) % n); }

export function drawTile(c, x, y){
  const t = grid[gi(x, y)], px = x * TS, py = y * TS;
  if (t === T.VOID){ c.fillStyle = "#0d0a07"; c.fillRect(px, py, TS, TS); return; }
  if (t === T.WALL){
    c.fillStyle = "#3a2a1d"; c.fillRect(px, py, TS, TS);
    c.fillStyle = "#4d3826"; c.fillRect(px, py + 3, TS, TS - 6);
    c.fillStyle = "#2a1d12"; c.fillRect(px, py + TS - 2, TS, 2);
    c.fillStyle = "#5d4431"; c.fillRect(px + 1, py + 4, TS - 2, 2);
    return;
  }
  if (t === T.WOOD || t === T.DESK || t === T.SOLID ||
      (t === T.DOOR && y > 1 && grid[gi(x, y - 1)] !== T.COR)){
    const v = vary(x, y, 3);
    c.fillStyle = ["#7a5a39", "#745536", "#6f5234"][v] || "#7a5a39";
    c.fillRect(px, py, TS, TS);
    c.fillStyle = "#5d4429"; c.fillRect(px, py + TS - 1, TS, 1);
    if (vary(x, y, 5) === 2){ c.fillStyle = "#65492c"; c.fillRect(px + 4, py + 6, 3, 2); }
  } else {
    const v = vary(x, y, 2);
    c.fillStyle = v ? "#8b8678" : "#837e70"; c.fillRect(px, py, TS, TS);
    c.fillStyle = "#6e6a5e"; c.fillRect(px, py, TS, 1); c.fillRect(px, py, 1, TS);
  }
  if (t === T.DOOR){
    c.fillStyle = "#8a6a3f"; c.fillRect(px, py, 2, TS); c.fillRect(px + TS - 2, py, 2, TS);
  }
}

export function drawRoomTints(c){
  for (const r of Object.values(ROOMS)){
    if (!r.tint) continue;
    c.fillStyle = r.tint;
    c.fillRect((r.x0 + 1) * TS, (r.y0 + 1) * TS, (r.x1 - r.x0 - 1) * TS, (r.y1 - r.y0 - 1) * TS);
  }
}

export function drawDeskBlock(c, dx, dy, w){
  const px = dx * TS, py = dy * TS;
  c.fillStyle = "#a9743f"; c.fillRect(px + 1, py + 2, w * TS - 2, TS - 4);
  c.fillStyle = "#c08a4e"; c.fillRect(px + 1, py + 2, w * TS - 2, 3);
  c.fillStyle = "#7c5028"; c.fillRect(px + 1, py + TS - 3, w * TS - 2, 2);
  const mx = px + ((w / 2) | 0) * TS;        // monitor en el tile central
  c.fillStyle = "#14100c"; c.fillRect(mx + 2, py - 4, 12, 10);
  c.fillStyle = "#1d2b26"; c.fillRect(mx + 3, py - 3, 10, 7);
  c.fillStyle = "#14100c"; c.fillRect(mx + 6, py + 6, 4, 2);
  c.fillStyle = "#2b2118"; c.fillRect(px + 3, py + 8, 6, 3);          // teclado
  c.fillStyle = "#efe6d6"; c.fillRect(px + w * TS - 8, py + 5, 5, 4); // papeles
  for (let i = 0; i < w; i++){                // sillas (fila de abajo)
    const cx = (dx + i) * TS, cy = (dy + 1) * TS;
    c.fillStyle = "#4a3326"; c.fillRect(cx + 4, cy + 5, 8, 7);
    c.fillStyle = "#5d4431"; c.fillRect(cx + 4, cy + 5, 8, 2);
  }
}

function drawShelfBooks(c, sx, sy, wpx){
  c.fillStyle = "#5d4429"; c.fillRect(sx, sy + 4, wpx, 10);
  const cols = ["#b9534f", "#4a7ab5", "#5a9a5d", "#c8a455", "#7b5fa8"];
  const n = ((wpx - 4) / 4) | 0;
  for (let i = 0; i < n; i++){ c.fillStyle = cols[i % 5]; c.fillRect(sx + 2 + i * 4, sy + 5, 3, 8); }
}

export function drawDecor(c){
  for (const [px_, py_] of PLANTS){
    const px = px_ * TS, py = py_ * TS;
    c.fillStyle = "#a4633a"; c.fillRect(px + 4, py + 8, 8, 6);
    c.fillStyle = "#7a4527"; c.fillRect(px + 4, py + 13, 8, 1);
    c.fillStyle = "#3f7d4a"; c.fillRect(px + 6, py + 1, 4, 8);
    c.fillStyle = "#356b3f"; c.fillRect(px + 2, py + 4, 4, 5);
    c.fillStyle = "#469053"; c.fillRect(px + 10, py + 4, 4, 5);
  }
  const cx = COFFEE.x * TS, cy = COFFEE.y * TS;   // máquina de café (2 tiles, ahora en el Hall)
  c.fillStyle = "#3b3531"; c.fillRect(cx + 1, cy - 6, 30, 21);
  c.fillStyle = "#171311"; c.fillRect(cx + 4, cy - 3, 10, 6);
  c.fillStyle = "#4ade80"; c.fillRect(cx + 26, cy - 3, 3, 3);
  c.fillStyle = "#ef4444"; c.fillRect(cx + 26, cy + 2, 3, 3);
  c.fillStyle = "#efe3d0"; c.fillRect(cx + 7, cy + 7, 6, 5);
  c.fillStyle = "#171311"; c.fillRect(cx + 4, cy + 13, 24, 2);
  for (const r of [ROOMS["Engineering"], ROOMS["R&D"]])           // estantes v2
    drawShelfBooks(c, (r.x0 + 2) * TS, r.y0 * TS, 44);
  for (const sh of LIB_SHELVES)                                   // biblioteca: estantería real
    drawShelfBooks(c, sh.x0 * TS, sh.y * TS - 4, (sh.x1 - sh.x0 + 1) * TS);
  for (const [lx, ly] of LAMPS){                                  // lámparas colgantes
    const px = lx * TS, py = ly * TS;
    c.fillStyle = "#2a2018"; c.fillRect(px + 7, py - 14, 2, 6);
    c.fillStyle = "#c8a455"; c.fillRect(px + 4, py - 9, 8, 4);
    c.fillStyle = "#ffe9a8"; c.fillRect(px + 6, py - 5, 4, 2);
  }
  for (const b of INFIRMARY_BEDS){                                // camillas
    const px = b.x * TS, py = b.y * TS;
    c.fillStyle = "#cfd6d8"; c.fillRect(px + 1, py + 2, 30, 12);
    c.fillStyle = "#9fb3b8"; c.fillRect(px + 1, py + 12, 30, 2);
    c.fillStyle = "#e8eef0"; c.fillRect(px + 2, py + 3, 8, 9);    // almohada
    c.fillStyle = "#4ba3a3"; c.fillRect(px + 11, py + 3, 19, 9);  // manta
  }
  for (const sh of ARMORY_SHELVES){                               // estantes de la armería
    const px = sh.x0 * TS, py = sh.y * TS, w = (sh.x1 - sh.x0 + 1) * TS;
    c.fillStyle = "#4a3622"; c.fillRect(px, py + 2, w, 12);
    c.fillStyle = "#6b4f30"; c.fillRect(px, py + 2, w, 2);
    c.fillStyle = "#2a1d12"; c.fillRect(px, py + 12, w, 2);
  }
  const mt = MEETING_TABLE;                                       // mesa de reuniones del Hall
  c.fillStyle = "#8a5f33";
  c.fillRect(mt.x0 * TS + 2, mt.y0 * TS + 2, (mt.x1 - mt.x0 + 1) * TS - 4, (mt.y1 - mt.y0 + 1) * TS - 4);
  c.fillStyle = "#a9743f";
  c.fillRect(mt.x0 * TS + 4, mt.y0 * TS + 4, (mt.x1 - mt.x0 + 1) * TS - 8, 4);
  const ww = WAR_WALL;                                            // tablero de guerra (fondo)
  c.fillStyle = "#1c1410"; c.fillRect(ww.x * TS, ww.y * TS, ww.w * TS, ww.h * TS);
  c.fillStyle = "#6b4f30";
  c.strokeStyle = "#6b4f30"; c.lineWidth = 2;
  c.strokeRect(ww.x * TS + 1, ww.y * TS + 1, ww.w * TS - 2, ww.h * TS - 2);
  for (const [key, b] of Object.entries(HALL_BOARDS)){            // leaderboard + tablón
    const px = b.x * TS, py = b.y * TS;
    c.fillStyle = "#7a5a3a"; c.fillRect(px, py + 1, b.w * TS, 13);
    c.fillStyle = key === "leader" ? "#23303d" : "#caa468";
    c.fillRect(px + 2, py + 3, b.w * TS - 4, 9);
  }
  const fd = FOUNDER_DESK;                                        // escritorio del Founder
  const fx = fd.x * TS, fy = fd.y * TS;
  c.fillStyle = "#8a4f2a"; c.fillRect(fx + 1, fy + 2, fd.w * TS - 2, TS - 4);
  c.fillStyle = "#b06a3a"; c.fillRect(fx + 1, fy + 2, fd.w * TS - 2, 3);
  c.fillStyle = "#5d3018"; c.fillRect(fx + 1, fy + TS - 3, fd.w * TS - 2, 2);
  c.fillStyle = "#3b2a52"; c.fillRect(fx + fd.w * TS - 14, fy - 2, 10, 8);   // sillón
  c.fillStyle = "#4a3326"; c.fillRect(fd.chair.x * TS + 4, fd.chair.y * TS + 5, 8, 7);
}
