/* Sprites procedurales pixel (~16×24, 2 frames) — drawDude v2 portado + estados
   nuevos: ✗ rechazo, "!" error, flash de tier_change, camilla (enfermería). */

export const TIER_COLORS = {fable:"#ffd166", opus:"#a78bfa", sonnet:"#60a5fa", oss:"#2dd4bf"};
export const TIER_DARK   = {fable:"#b8860b", opus:"#6d4fc1", sonnet:"#2f6fc4", oss:"#0f9488"};
export const tierOf = t => Object.prototype.hasOwnProperty.call(TIER_COLORS, t) ? t : "oss";

/* s: {x,y,tier,mode,want,typing,frame,dir,check,reject,error,flash,lying,working} */
export function drawDude(c, s, t){
  const x = Math.round(s.x), y = Math.round(s.y);
  const skin = "#f2c9a0", hair = "#4a3320";
  let col = TIER_COLORS[tierOf(s.tier)], dark = TIER_DARK[tierOf(s.tier)];
  if (s.flash > 0 && ((t / 120) | 0) % 2){ col = "#ffffff"; dark = "#cccccc"; }  // flash tier_change

  if (s.lying){                                      // camilla: acostado horizontal
    c.fillStyle = col;  c.fillRect(x + 6, y + 4, 16, 8);
    c.fillStyle = dark; c.fillRect(x + 6, y + 4, 3, 8);
    c.fillStyle = skin; c.fillRect(x - 1, y + 3, 8, 8);
    c.fillStyle = hair; c.fillRect(x - 1, y + 3, 3, 8);
    c.fillStyle = "#2b1d12"; c.fillRect(x + 3, y + 5, 1, 1); c.fillRect(x + 3, y + 8, 1, 1);
    c.fillStyle = "#4ba3a3"; c.fillRect(x + 9, y + 2, 14, 11);   // manta encima
    drawBadges(c, s, x, y - 6);
    return;
  }

  const sleeping = s.mode === "sleep", sitting = s.mode === "sit", walking = s.mode === "walk";
  if (!sleeping && !sitting){                       // piernas (2 frames)
    c.fillStyle = "#2b2118";
    if (walking && s.frame){ c.fillRect(x + 3, y + 19, 4, 5); c.fillRect(x + 9, y + 17, 4, 5); }
    else if (walking){ c.fillRect(x + 3, y + 17, 4, 5); c.fillRect(x + 9, y + 19, 4, 5); }
    else { c.fillRect(x + 3, y + 18, 4, 5); c.fillRect(x + 9, y + 18, 4, 5); }
  }
  c.fillStyle = col;                                 // cuerpo
  c.fillRect(x + 2, y + 9, 12, sleeping || sitting ? 11 : 10);
  c.fillStyle = dark; c.fillRect(x + 2, y + 9, 12, 2);
  if (s.typing && s.working){                        // bracitos tipeando (solo con misión real)
    const j = (t / 90 | 0) % 2;
    c.fillStyle = skin; c.fillRect(x, y + 11 + j, 3, 3); c.fillRect(x + 13, y + 12 - j, 3, 3);
  } else if (!sleeping){
    c.fillStyle = dark; c.fillRect(x, y + 11, 2, 5); c.fillRect(x + 14, y + 11, 2, 5);
  }
  const hy = sleeping ? y + 3 : y;                   // cabeza (dormido: caída)
  c.fillStyle = skin; c.fillRect(x + 4, hy + 1, 8, 8);
  c.fillStyle = hair; c.fillRect(x + 4, hy, 8, 3);
  if (!sleeping && (sitting || s.dir === "u")){      // de espaldas: nuca
    c.fillStyle = hair; c.fillRect(x + 4, hy, 8, 6);
  } else if (!sleeping){
    c.fillStyle = "#2b1d12"; c.fillRect(x + 6, hy + 4, 1, 2); c.fillRect(x + 9, hy + 4, 1, 2);
  }
  if (tierOf(s.tier) === "fable"){                   // coronita ◆
    c.fillStyle = "#ffd166";
    c.fillRect(x + 4, hy - 2, 8, 2); c.fillRect(x + 5, hy - 4, 2, 2); c.fillRect(x + 9, hy - 4, 2, 2);
  }
  drawBadges(c, s, x, hy);
}

function drawBadges(c, s, x, hy){
  if (s.check > 0){                                  // ✓ verde del Reviewer (5s)
    c.fillStyle = "#4ade80";
    c.fillRect(x + 4, hy - 8, 2, 2); c.fillRect(x + 6, hy - 6, 2, 2);
    c.fillRect(x + 8, hy - 8, 2, 2); c.fillRect(x + 10, hy - 10, 2, 2);
  }
  if (s.reject > 0){                                 // ✗ rojo: review_verdict rechazado real
    c.fillStyle = "#ef4444";
    c.fillRect(x + 4, hy - 10, 2, 2); c.fillRect(x + 6, hy - 8, 2, 2); c.fillRect(x + 8, hy - 6, 2, 2);
    c.fillRect(x + 10, hy - 10, 2, 2); c.fillRect(x + 8, hy - 8, 0, 0);
    c.fillRect(x + 8, hy - 8, 2, 2); c.fillRect(x + 10, hy - 6, 2, 2); c.fillRect(x + 4, hy - 6, 2, 2);
    c.fillRect(x + 6, hy - 8, 2, 2);
  }
  if (s.error > 0){                                  // "!" ámbar: alerta real
    c.fillStyle = "#f5a623";
    c.fillRect(x + 7, hy - 12, 3, 6); c.fillRect(x + 7, hy - 4, 3, 2);
  }
}

/* ---------- partículas ---------- */
/* p: {x,y,vx?,vy,a,txt?|col?,sz?} — txt = glifo de texto; col = confetti cuadrado */
export function drawParticle(c, p){
  c.globalAlpha = Math.max(0, p.a);
  if (p.col){ c.fillStyle = p.col; c.fillRect(p.x, p.y, p.sz || 3, p.sz || 3); }
  else { c.fillStyle = p.tint || "#e8ddcc"; c.font = (p.sz || 9) + "px monospace"; c.fillText(p.txt, p.x, p.y); }
  c.globalAlpha = 1;
}

export function tickParticles(particles, dt){
  for (let i = particles.length - 1; i >= 0; i--){
    const p = particles[i];
    p.x += (p.vx || 0) * dt / 1000;
    p.y += p.vy * dt / 1000;
    if (p.g) p.vy += p.g * dt / 1000;
    p.a -= dt / (p.vida || 2400);
    if (p.a <= 0) particles.splice(i, 1);
  }
}

const CONFETTI = ["#ffd166", "#4ade80", "#60a5fa", "#ef4444", "#a78bfa", "#2dd4bf"];
export function mkConfetti(x, y, n = 26){
  const out = [];
  for (let i = 0; i < n; i++)
    out.push({x: x + (Math.random() - .5) * 30, y: y - 6, vx: (Math.random() - .5) * 60,
              vy: -40 - Math.random() * 60, g: 120, a: 1, vida: 2000 + Math.random() * 1200,
              col: CONFETTI[i % CONFETTI.length], sz: 2 + (Math.random() * 2 | 0)});
  return out;
}
