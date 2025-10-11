const socket = io({ transports: ['websocket','polling'], upgrade: true });

/* elements */
const joinView = document.getElementById('joinView');
const waitView = document.getElementById('waitView');
const gameView = document.getElementById('gameView');
const rosterUl = document.getElementById('roster');

const nameInput = document.getElementById('nameInput');
const joinBtn   = document.getElementById('joinBtn');
const joinMsg   = document.getElementById('joinMsg');

const productLbl= document.getElementById('productLbl');
const newsBar   = document.getElementById('newsBar');
const newsText  = document.getElementById('newsText');

const priceLbl  = document.getElementById('priceLbl');
const posLbl    = document.getElementById('posLbl');
const pnlLbl    = document.getElementById('pnlLbl');

const cvs = document.getElementById('chart');
const ctx = cvs.getContext('2d');

const chartModeBadge = document.getElementById('chartModeBadge');
const bookBody = document.getElementById('bookBody');
const bookSpreadLbl = document.getElementById('bookSpread');
const bookModeBadge = document.getElementById('bookModeBadge');

const buyBtn = document.getElementById('buyBtn');
const sellBtn= document.getElementById('sellBtn');

/* state */
let myId = null;
let myJoined = false;
let lastPhase = 'lobby';
let prices = [];
let tick = 0;
const markers = []; // {tick, px, side}
const MAX_POINTS = 600;
let lastKnownPos = null;
let myAvgCost = 0;
let myPos = 0;
let yLo = null, yHi = null;
let currentMode = 'news';
let lastBookSnapshot = null;

/* ui helpers */
function show(e){ e.classList.remove('hidden'); }
function hide(e){ e.classList.add('hidden'); }
function goLobby(){ show(joinView); hide(waitView); hide(gameView); buyBtn.disabled=true; sellBtn.disabled=true; }
function goWaiting(){ hide(joinView); show(waitView); hide(gameView); buyBtn.disabled=true; sellBtn.disabled=true; }
function goGame(){
  hide(joinView);
  hide(waitView);
  show(gameView);
  buyBtn.disabled = false;
  sellBtn.disabled = false;
  resizeCanvas();
}

function resizeCanvas(){
  const wrap = document.querySelector('.chart-wrap');
  const bb = wrap.getBoundingClientRect();
  const dpr = Math.max(1, Math.min(3, window.devicePixelRatio||1));
  const w = Math.max(280, Math.floor(bb.width));
  const h = Math.max(200, Math.floor(w*0.45));
  cvs.width = Math.floor(w*dpr);
  cvs.height = Math.floor(h*dpr);
  cvs.style.width = w+'px';
  cvs.style.height = h+'px';
  ctx.setTransform(dpr,0,0,dpr,0,0);
  scheduleDraw();
}

window.addEventListener('resize', () => {
  resizeCanvas();
  renderOrderBook(lastBookSnapshot);
});

function describeMode(mode){
  return mode === 'orderflow' ? 'Volume' : 'News';
}

function updateModeBadges(mode){
  currentMode = mode === 'orderflow' ? 'orderflow' : 'news';
  const label = `${describeMode(currentMode)} Mode`;
  if (bookModeBadge) {
    bookModeBadge.textContent = label;
    bookModeBadge.dataset.mode = currentMode;
  }
  if (chartModeBadge) {
    chartModeBadge.textContent = label;
    chartModeBadge.dataset.mode = currentMode;
  }
}

function formatExposure(value){
  const num = Number(value || 0);
  const abs = Math.abs(num);
  if (!Number.isFinite(num) || abs < 1e-4) return '0';
  if (abs >= 100) return num.toFixed(0);
  if (abs >= 10) return num.toFixed(1);
  if (abs >= 1) return num.toFixed(2);
  return num.toFixed(3);
}

function formatVolume(value){
  const num = Number(value || 0);
  if (!Number.isFinite(num)) return '0.00';
  if (Math.abs(num) >= 100) return num.toFixed(0);
  if (Math.abs(num) >= 10) return num.toFixed(1);
  return num.toFixed(2);
}

function renderOrderBook(book){
  if (!bookBody) return;
  lastBookSnapshot = book;
  if (!book || ((!book.bids || !book.bids.length) && (!book.asks || !book.asks.length))) {
    bookBody.innerHTML = '<div class="book-empty muted">No resting liquidity</div>';
    if (bookSpreadLbl) bookSpreadLbl.textContent = 'Spread: —';
    return;
  }

  const asks = Array.isArray(book.asks) ? book.asks : [];
  const bids = Array.isArray(book.bids) ? book.bids : [];
  const volumes = [...asks, ...bids].map((lvl) => Number(lvl?.size || 0));
  const maxVol = Math.max(1, ...volumes, 1);

  const rows = [];
  for (let i = asks.length - 1; i >= 0; i -= 1) {
    const level = asks[i];
    const volume = Number(level.size || 0);
    const cum = Number(level.cumulative || 0);
    const width = Math.min(100, (volume / maxVol) * 100);
    const best = level.price === book.bestAsk;
    rows.push(`
      <div class="orderbook-row ask${best ? ' best' : ''}" style="--bar:${width.toFixed(1)}%">
        <span>${formatVolume(volume)}</span>
        <span>${Number(level.price).toFixed(2)}</span>
        <span>${formatVolume(cum)}</span>
      </div>
    `);
  }

  const midPrice = Number(book.lastPrice ?? book.midPrice ?? 0).toFixed(2);
  rows.push(`<div class="orderbook-row mid"><span></span><span>${midPrice}</span><span></span></div>`);

  for (let i = 0; i < bids.length; i += 1) {
    const level = bids[i];
    const volume = Number(level.size || 0);
    const cum = Number(level.cumulative || 0);
    const width = Math.min(100, (volume / maxVol) * 100);
    const best = level.price === book.bestBid;
    rows.push(`
      <div class="orderbook-row bid${best ? ' best' : ''}" style="--bar:${width.toFixed(1)}%">
        <span>${formatVolume(volume)}</span>
        <span>${Number(level.price).toFixed(2)}</span>
        <span>${formatVolume(cum)}</span>
      </div>
    `);
  }

  bookBody.innerHTML = rows.join('');
  requestAnimationFrame(() => {
    const target = Math.max(0, (bookBody.scrollHeight - bookBody.clientHeight) / 2);
    bookBody.scrollTop = target;
  });

  if (bookSpreadLbl) {
    const spread = Number(book.spread);
    bookSpreadLbl.textContent = Number.isFinite(spread) && spread > 0
      ? `Spread: ${spread.toFixed(2)}`
      : 'Spread: —';
  }
}

/* draw */
function draw(){
  const w = cvs.width/(window.devicePixelRatio||1);
  const h = cvs.height/(window.devicePixelRatio||1);
  ctx.clearRect(0,0,w,h);

  // grid
  ctx.strokeStyle = "rgba(255,255,255,.07)";
  ctx.lineWidth=1; ctx.beginPath();
  for(let i=1;i<=3;i++){ const y=(h/4)*i; ctx.moveTo(0,y); ctx.lineTo(w,y); }
  ctx.stroke();

  if(prices.length<2) return;

  const view = prices.slice(-MAX_POINTS);
  const rawLo = Math.min(...view), rawHi = Math.max(...view);
  const pad = Math.max(0.5, (rawHi-rawLo)*0.12);
  const tgtLo = rawLo-pad, tgtHi=rawHi+pad;

  if(yLo===null||yHi===null){ yLo=tgtLo; yHi=tgtHi; }
  if(tgtLo<yLo) yLo=tgtLo; else yLo=yLo+(tgtLo-yLo)*0.05;
  if(tgtHi>yHi) yHi=tgtHi; else yHi=yHi+(tgtHi-yHi)*0.05;

  const X = i=> (i/(view.length-1))*w;
  const Y = p=> h - ((p - yLo)/Math.max(1e-6,(yHi-yLo)))*h;

  // price line
  ctx.strokeStyle="#6da8ff"; ctx.lineWidth=2; ctx.beginPath();
  ctx.moveTo(0, Y(view[0]));
  for(let i=1;i<view.length;i++) ctx.lineTo(X(i), Y(view[i]));
  ctx.stroke();

  // avg line
  if (myPos!==0 && myAvgCost) {
    ctx.save(); ctx.setLineDash([6,4]); ctx.lineWidth=1.5;
    ctx.strokeStyle = myPos>0 ? "#2ecc71" : "#ff5c5c";
    const y=Y(myAvgCost); ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(w,y); ctx.stroke(); ctx.restore();
  }

  // markers
  const viewLen=view.length; const startTick = tick - viewLen + 1;
  for(const m of markers){
    const i = m.tick - startTick; if(i<0||i>=viewLen) continue;
    const x = X(i), y = Y(m.px);
    ctx.fillStyle = m.side>0 ? "#2ecc71" : "#ff5c5c";
    ctx.beginPath();
    if(m.side>0){ ctx.moveTo(x,y-10); ctx.lineTo(x-6,y); ctx.lineTo(x+6,y); }
    else       { ctx.moveTo(x,y+10); ctx.lineTo(x-6,y); ctx.lineTo(x+6,y); }
    ctx.closePath(); ctx.fill();
  }

  // last dot
  ctx.fillStyle="#fff"; ctx.beginPath();
  ctx.arc(X(view.length-1), Y(view[view.length-1]), 2.5, 0, Math.PI*2);
  ctx.fill();
}
function scheduleDraw(){ if(scheduleDraw._p) return; scheduleDraw._p=true; requestAnimationFrame(()=>{scheduleDraw._p=false; draw();}); }

/* socket events */
socket.on('connect', ()=>{ myId = socket.id; });

// Phase info shouldn't move us until we join
socket.on('phase', (phase)=>{
  lastPhase = phase;
  if (!myJoined) { goLobby(); return; }
  if (phase==='running') goGame();
  else if (phase==='lobby') goWaiting();
  else goLobby();
});

joinBtn.onclick = ()=>{
  const nm = (nameInput.value||'').trim() || 'Player';
  joinBtn.disabled = true; joinBtn.textContent = 'Joining…';
  socket.emit('join', nm, (ack)=>{
    if (ack && ack.ok) {
      myJoined = true;
      if (ack.phase === 'lobby') {
        joinMsg.textContent='Joined — waiting for host…';
        goWaiting();
      } else {
        // Late join: seed product + chart at current price
        document.getElementById('productLbl').textContent = ack.productName || 'Demo Asset';
        prices = []; markers.length=0; lastKnownPos=null; yLo=yHi=null;
        tick = 0; prices.push(ack.price ?? ack.fairValue ?? 100);
        buyBtn.disabled = !!ack.paused;
        sellBtn.disabled = !!ack.paused;
        goGame();
        scheduleDraw();
      }
    } else {
      joinBtn.disabled=false; joinBtn.textContent='Join';
      joinMsg.textContent='Join failed. Try again.';
    }
  });
};

socket.on('playerList', (rows)=>{
  // Waiting room roster
  if (!rosterUl) return;
  rosterUl.innerHTML = '';
  rows.forEach(r=>{
    const li = document.createElement('li');
    li.textContent = r.isBot ? `${r.name} 🤖` : r.name;
    rosterUl.appendChild(li);
  });
});

socket.on('priceMode', (mode)=>{
  updateModeBadges(mode);
});

socket.on('orderBook', (book)=>{
  renderOrderBook(book);
});

socket.on('gameStarted', ({ fairValue, productName, paused, price })=>{
  if (!myJoined) return;
  document.getElementById('productLbl').textContent = productName || 'Demo Asset';
  prices = []; markers.length=0; lastKnownPos=null; yLo=yHi=null;
  tick = 0; prices.push(price ?? fairValue ?? 100);
  buyBtn.disabled = !!paused;
  sellBtn.disabled = !!paused;
  goGame();
  scheduleDraw();
  renderOrderBook(null);
});

socket.on('gameReset', ()=>{
  // Return to join and require re-entry of name
  myJoined = false;
  prices=[]; markers.length=0; lastKnownPos=null; myAvgCost=0; myPos=0; yLo=yHi=null;
  nameInput.value = '';
  joinBtn.disabled = false; joinBtn.textContent = 'Join';
  goLobby();
  renderOrderBook(null);
});

socket.on('paused', (isPaused)=>{
  buyBtn.disabled = isPaused || !myJoined || lastPhase!=='running';
  sellBtn.disabled = isPaused || !myJoined || lastPhase!=='running';
});

socket.on('news', ({ text, delta })=>{
  if (!newsText) return;
  newsText.textContent = text || '';
  newsBar.style.background = (delta>0) ? "#12361f" : (delta<0) ? "#3a1920" : "#121a2b";
  newsBar.style.transition = 'opacity .3s ease';
  newsBar.style.opacity = '1';
  setTimeout(()=>{ newsBar.style.opacity='0.8'; }, 16000);
});

// Live price (players no longer see fair)
socket.on('priceUpdate', ({ t, price, priceMode })=>{
  if (!myJoined) return;
  tick++;
  prices.push(price);
  if(prices.length>MAX_POINTS) prices.shift();
  priceLbl.textContent = Number(price).toFixed(2);
  if (priceMode) updateModeBadges(priceMode);
  scheduleDraw();
});

// Per-player live stats: position, pnl, avg cost
socket.on('you', ({ position, pnl, avgCost })=>{
  myPos = Number(position || 0);
  myAvgCost = +avgCost || 0;
  posLbl.textContent = formatExposure(myPos);
  pnlLbl.textContent = Number(pnl || 0).toFixed(2);
  scheduleDraw();
});

// Trade markers (still server-confirmed)
socket.on('tradeMarker', ({ t, side, px, qty })=>{
  if (!myJoined) return;
  const s = (side==='BUY') ? +1 : -1;
  markers.push({ tick, px, side: s, qty: qty || 1 });
  scheduleDraw();
});

socket.on('avgUpdate', ({ avgPx, side, position })=>{
  if (!myJoined) return;
  myAvgCost = avgPx || 0;
  if (typeof position === 'number' && !Number.isNaN(position)) {
    myPos = position;
  } else if (side === 'long') {
    myPos = Math.max(1, Math.abs(myPos));
  } else if (side === 'short') {
    myPos = -Math.max(1, Math.abs(myPos));
  } else {
    myPos = 0;
  }
  posLbl.textContent = formatExposure(myPos);
  scheduleDraw();
});

/* trades with micro-cooldown */
function microCooldown(btn){ btn.disabled=true; setTimeout(()=>{ if(myJoined && lastPhase==='running') btn.disabled=false; }, 140); }
buyBtn.onclick  = ()=>{ if(myJoined && lastPhase==='running') { socket.emit('trade','BUY');  microCooldown(buyBtn); } };
sellBtn.onclick = ()=>{ if(myJoined && lastPhase==='running') { socket.emit('trade','SELL'); microCooldown(sellBtn); } };

/* init */
goLobby();
resizeCanvas();
updateModeBadges('news');
renderOrderBook(null);
