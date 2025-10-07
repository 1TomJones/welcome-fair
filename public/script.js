/* socket */
const socket = io({ transports: ['websocket','polling'], upgrade: true });

/* elements */
const joinView = document.getElementById('joinView');
const waitView = document.getElementById('waitView');
const gameView = document.getElementById('gameView');
const nameInput = document.getElementById('nameInput');
const joinBtn = document.getElementById('joinBtn');
const joinMsg = document.getElementById('joinMsg');

const newsBar = document.getElementById('newsBar');
const priceLbl = document.getElementById('priceLbl');
const fairLbl  = document.getElementById('fairLbl');
const posLbl   = document.getElementById('posLbl');
const pnlLbl   = document.getElementById('pnlLbl');

const cvs = document.getElementById('chart');
const ctx = cvs.getContext('2d');
const buyBtn  = document.getElementById('buyBtn');
const sellBtn = document.getElementById('sellBtn');

/* local state */
let myId = null;
let lastPhase = 'lobby';
let prices = [];
let tick = 0;
const markers = []; // { tick, px, side }
const MAX_POINTS = 600; // ~150s @ 4Hz
let lastKnownPos = null; // track server-confirmed position

/* helpers */
function show(el){ el.classList.remove('hidden'); }
function hide(el){ el.classList.add('hidden'); }
function goLobby(){ show(joinView); hide(waitView); hide(gameView); buyBtn.disabled = true; sellBtn.disabled = true; }
function goWaiting(){ hide(joinView); show(waitView); hide(gameView); buyBtn.disabled = true; sellBtn.disabled = true; }
function goGame(){ hide(joinView); hide(waitView); show(gameView); buyBtn.disabled = false; sellBtn.disabled = false; resizeCanvas(); }

/* sizing */
function resizeCanvas(){
  const wrap = document.querySelector('.chart-wrap');
  const bb = wrap.getBoundingClientRect();
  const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  const w = Math.max(280, Math.floor(bb.width));
  const h = Math.max(200, Math.floor(w * 0.45)); // mobile-friendly
  cvs.width = Math.floor(w * dpr);
  cvs.height = Math.floor(h * dpr);
  cvs.style.width = w + 'px';
  cvs.style.height = h + 'px';
  ctx.setTransform(dpr,0,0,dpr,0,0);
  scheduleDraw(); // redraw after resize
}
window.addEventListener('resize', resizeCanvas);

/* drawing */
function draw(){
  const w = cvs.width / (window.devicePixelRatio || 1);
  const h = cvs.height / (window.devicePixelRatio || 1);
  ctx.clearRect(0,0,w,h);

  // grid
  ctx.strokeStyle = "rgba(255,255,255,.07)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i=1;i<=3;i++){
    const y = (h/4)*i; ctx.moveTo(0,y); ctx.lineTo(w,y);
  }
  ctx.stroke();

  if (prices.length < 2) return;

  const view = prices.slice(-MAX_POINTS);
  const lo = Math.min(...view), hi = Math.max(...view);
  const range = Math.max(1e-6, hi - lo);
  const X = (i)=> (i/(view.length-1))*w;
  const Y = (p)=> h - ((p - lo)/range)*h;

  // price line
  ctx.strokeStyle = "#6da8ff";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, Y(view[0]));
  for (let i=1;i<view.length;i++) ctx.lineTo(X(i), Y(view[i]));
  ctx.stroke();

  // markers pinned to tick
  const currentTick = tick;
  const viewLen = view.length;
  const viewStartTick = currentTick - viewLen + 1;

  markers.forEach(m=>{
    const i = m.tick - viewStartTick; // x-index within current view
    if (i < 0 || i >= viewLen) return; // out of view
    const x = X(i);
    const y = Y(m.px);
    ctx.fillStyle = m.side > 0 ? "#2ecc71" : "#ff5c5c";
    ctx.beginPath();
    if (m.side > 0) { // buy arrow up
      ctx.moveTo(x, y-10); ctx.lineTo(x-6, y); ctx.lineTo(x+6, y);
    } else { // sell arrow down
      ctx.moveTo(x, y+10); ctx.lineTo(x-6, y); ctx.lineTo(x+6, y);
    }
    ctx.closePath();
    ctx.fill();
  });

  // last dot
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(X(view.length-1), Y(view[view.length-1]), 2.5, 0, Math.PI*2);
  ctx.fill();
}

function scheduleDraw(){
  if (scheduleDraw._p) return;
  scheduleDraw._p = true;
  requestAnimationFrame(()=>{ scheduleDraw._p = false; draw(); });
}

/* socket */
socket.on('connect', ()=>{ myId = socket.id; });

socket.on('phase', (phase)=>{
  lastPhase = phase;
  if (phase === 'running') goGame();
  else if (phase === 'lobby') goWaiting();
  else goLobby();
});

joinBtn.onclick = ()=>{
  const nm = (nameInput.value || '').trim() || 'Player';
  joinBtn.disabled = true; joinBtn.textContent = 'Joining…';
  socket.emit('join', nm, (res)=>{
    if (res && res.ok) {
      joinMsg.textContent = 'Joined, waiting for host…';
      goWaiting();
    } else {
      joinBtn.disabled = false; joinBtn.textContent = 'Join';
      joinMsg.textContent = 'Join failed. Try again.';
    }
  });
};

socket.on('gameState', (snap)=>{
  // if switching into a new running round, clear chart + markers + position tracker
  if (snap.phase === 'running' && (lastPhase !== 'running' || gameView.classList.contains('hidden'))) {
    prices = [];
    markers.length = 0;
    lastKnownPos = null; // reset so first server pos sets baseline, no retro arrows
    goGame(); // ensures canvas sized
  }
  lastPhase = snap.phase;

  // labels
  priceLbl.textContent = snap.price.toFixed(2);
  fairLbl.textContent  = snap.fair.toFixed(2);

  // news color
  if (snap.news && snap.news.text) {
    newsBar.textContent = snap.news.text;
    const s = snap.news.sign|0;
    newsBar.style.background = s > 0 ? "#12361f" : s < 0 ? "#3a1920" : "#121a2b";
  }

  // UPDATE MY POSITION / PNL + ADD ARROWS ONLY ON REAL POSITION CHANGE
  const me = snap.players ? snap.players[myId] : null;
  if (me) {
    posLbl.textContent = me.position;
    pnlLbl.textContent = (+me.pnl).toFixed(2);

    if (lastKnownPos === null) {
      // first time we see our position this round
      lastKnownPos = me.position|0;
    } else {
      const newPos = me.position|0;
      const delta = newPos - lastKnownPos;
      if (delta !== 0) {
        const side = delta > 0 ? +1 : -1;
        const steps = Math.abs(delta);
        for (let k = 0; k < steps; k++) {
          // pin to this tick+price so it never drifts
          markers.push({ tick: snap.tick|0, px: snap.price, side });
        }
        lastKnownPos = newPos;
        scheduleDraw();
      }
    }
  }

  // data for chart
  tick = snap.tick|0;
  prices.push(snap.price);
  if (prices.length > MAX_POINTS) prices.shift();
  scheduleDraw();

  // enable/disable trading by phase
  const canTrade = snap.phase === 'running' && !snap.paused;
  buyBtn.disabled = !canTrade;
  sellBtn.disabled = !canTrade;
});

/* trades (no local markers here; we only add markers when server confirms position changed) */
function clickCooldown(btn){
  btn.disabled = true;
  setTimeout(()=>{ 
    // only re-enable if trading is allowed (phase may have changed)
    if (lastPhase === 'running') btn.disabled = false;
  }, 140);
}
buyBtn.onclick  = ()=>{ socket.emit('trade', +1); clickCooldown(buyBtn); };
sellBtn.onclick = ()=>{ socket.emit('trade', -1); clickCooldown(sellBtn); };

/* initial */
resizeCanvas();

