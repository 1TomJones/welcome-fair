const socket = io({ transports: ['websocket','polling'], upgrade: true });

/* ---- elements ---- */
const joinView = document.getElementById('joinView');
const waitView = document.getElementById('waitView');
const gameView = document.getElementById('gameView');

const nameInput = document.getElementById('nameInput');
const joinBtn   = document.getElementById('joinBtn');
const joinMsg   = document.getElementById('joinMsg');

const newsBar   = document.getElementById('newsBar');
const priceLbl  = document.getElementById('priceLbl');
const fairLbl   = document.getElementById('fairLbl');
const posLbl    = document.getElementById('posLbl');
const pnlLbl    = document.getElementById('pnlLbl');

const buyBtn    = document.getElementById('buyBtn');
const sellBtn   = document.getElementById('sellBtn');

const cvs = document.getElementById('chart');
const ctx = cvs.getContext('2d');

/* ---- state ---- */
let myId = null;
let prices = [];
let tick   = 0;
const markers = []; // {tick, px, side}
const MAX_POINTS = 600;  // 600 @ 4Hz ≈ 150s on-screen

/* ---- UI helpers ---- */
function show(el){ el.classList.remove('hidden'); }
function hide(el){ el.classList.add('hidden'); }

function goLobby(){
  show(joinView); hide(waitView); hide(gameView);
  buyBtn.disabled = true; sellBtn.disabled = true;
}
function goWaiting(){
  hide(joinView); show(waitView); hide(gameView);
  buyBtn.disabled = true; sellBtn.disabled = true;
}
function goGame(){
  hide(joinView); hide(waitView); show(gameView);
  buyBtn.disabled = false; sellBtn.disabled = false;
}

/* ---- sizing ---- */
function resizeCanvas(){
  const wrap = document.querySelector('.chart-wrap');
  const bb = wrap.getBoundingClientRect();
  const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  const w = Math.max(280, Math.floor(bb.width));
  const h = Math.max(200, Math.floor(w*0.45)); // mobile-friendly ratio
  cvs.width = Math.floor(w * dpr);
  cvs.height= Math.floor(h * dpr);
  cvs.style.width = w + "px";
  cvs.style.height= h + "px";
  ctx.setTransform(dpr,0,0,dpr,0,0);
}
window.addEventListener('resize', resizeCanvas);

/* ---- chart ---- */
function scheduleDraw(){
  if (scheduleDraw._p) return;
  scheduleDraw._p = true;
  requestAnimationFrame(()=>{ scheduleDraw._p = false; draw(); });
}
function draw(){
  const w = cvs.width / (window.devicePixelRatio||1);
  const h = cvs.height/ (window.devicePixelRatio||1);
  ctx.clearRect(0,0,w,h);

  // grid
  ctx.strokeStyle = "rgba(255,255,255,.07)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let g=1; g<=3; g++){
    const y = (h/4)*g; ctx.moveTo(0,y); ctx.lineTo(w,y);
  }
  ctx.stroke();

  if (prices.length < 2) return;
  const view = prices.slice(-MAX_POINTS);
  const lo = Math.min(...view), hi = Math.max(...view);
  const range = Math.max(1e-6, hi - lo);
  const X = (i)=> (i/(view.length-1))*w;
  const Y = (p)=> h - ((p - lo)/range)*h;

  // line
  ctx.strokeStyle = "#6da8ff";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, Y(view[0]));
  for (let i=1;i<view.length;i++) ctx.lineTo(X(i), Y(view[i]));
  ctx.stroke();

  // markers aligned by tick
  const currentTick = tick;
  const viewLen = view.length;
  const viewStartTick = currentTick - viewLen + 1;
  for (const m of markers) {
    const i = m.tick - viewStartTick;
    if (i < 0 || i >= viewLen) continue;
    const x = X(i), y = Y(m.px);
    drawArrow(x,y, m.side>0);
  }
}
function drawArrow(x,y,isBuy){
  ctx.fillStyle = isBuy ? "#2ecc71" : "#ff5c5c";
  const w=8,h=12;
  ctx.beginPath();
  if (isBuy){ ctx.moveTo(x, y-h); ctx.lineTo(x-w/2, y); ctx.lineTo(x+w/2, y); }
  else      { ctx.moveTo(x, y+h); ctx.lineTo(x-w/2, y); ctx.lineTo(x+w/2, y); }
  ctx.closePath(); ctx.fill();
}

/* ---- socket ---- */
socket.on('connect', ()=>{ myId = socket.id; });
socket.on('phase', (phase)=>{
  if (phase === 'running') { goGame(); resizeCanvas(); }
  else if (phase === 'lobby') { goWaiting(); }
  else { goLobby(); }
});

joinBtn.onclick = () => {
  const nm = (nameInput.value || '').trim() || 'Player';
  joinBtn.disabled = true; joinBtn.textContent = 'Joining…';
  socket.emit('join', nm, (res)=>{
    if (res && res.ok) {
      joinMsg.textContent = 'Joined! Waiting for host…';
      goWaiting();
    } else {
      joinBtn.disabled = false; joinBtn.textContent = 'Join';
      joinMsg.textContent = 'Join failed. Try again.';
    }
  });
};

socket.on('gameState', (snap)=>{
  // if we were in waiting room and the round is running, switch view
  if (snap.phase === 'running' && gameView.classList.contains('hidden')) {
    goGame(); resizeCanvas();
  }
  // labels
  priceLbl.textContent = snap.price.toFixed(2);
  fairLbl.textContent  = snap.fair.toFixed(2);
  if (snap.players && snap.players[myId]) {
    const me = snap.players[myId];
    posLbl.textContent = me.position;
    pnlLbl.textContent = (+me.pnl).toFixed(2);
  }
  // news
  if (snap.news && snap.news.text) {
    newsBar.textContent = snap.news.text;
    const s = snap.news.sign|0;
    newsBar.style.background = s>0 ? "#12361f" : s<0 ? "#3a1920" : "#121a2b";
  }
  // data
  tick = snap.tick|0;
  prices.push(snap.price);
  if (prices.length>MAX_POINTS) prices.shift();
  scheduleDraw();

  // disable buttons when not running
  const canTrade = snap.phase === 'running';
  buyBtn.disabled = !canTrade; sellBtn.disabled = !canTrade;
});

buyBtn.onclick  = ()=>{ socket.emit('trade', +1); markers.push({ tick, px: prices[prices.length-1]||0, side:+1 }); scheduleDraw(); };
sellBtn.onclick = ()=>{ socket.emit('trade', -1); markers.push({ tick, px: prices[prices.length-1]||0, side:-1 }); scheduleDraw(); };

/* initial */
resizeCanvas();
