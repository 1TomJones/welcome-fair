const socket = io({ transports: ['websocket','polling'], upgrade: true });

/* elements */
const joinView       = document.getElementById('joinView');
const waitView       = document.getElementById('waitView');
const gameView       = document.getElementById('gameView');
const rosterUl       = document.getElementById('roster');
const nameInput      = document.getElementById('nameInput');
const joinBtn        = document.getElementById('joinBtn');
const joinMsg        = document.getElementById('joinMsg');
const productLbl     = document.getElementById('productLbl');
const newsBar        = document.getElementById('newsBar');
const newsText       = document.getElementById('newsText');
const priceLbl       = document.getElementById('priceLbl');
const posLbl         = document.getElementById('posLbl');
const pnlLbl         = document.getElementById('pnlLbl');
const avgLbl         = document.getElementById('avgLbl');
const chartModeBadge = document.getElementById('chartModeBadge');
const tradeModeBadge = document.getElementById('tradeModeBadge');
const bookBody       = document.getElementById('bookBody');
const bookSpreadLbl  = document.getElementById('bookSpread');
const bookModeBadge  = document.getElementById('bookModeBadge');

const cvs            = document.getElementById('chart');
const ctx            = cvs.getContext('2d');

const buyBtn         = document.getElementById('buyBtn');
const sellBtn        = document.getElementById('sellBtn');
const quantityInput  = document.getElementById('quantityInput');
const priceInput     = document.getElementById('priceInput');
const limitPriceRow  = document.getElementById('limitPriceRow');
const cancelAllBtn   = document.getElementById('cancelAllBtn');
const tradeStatus    = document.getElementById('tradeStatus');
const openOrdersList = document.getElementById('openOrders');
const orderTypeRadios= Array.from(document.querySelectorAll('input[name="orderType"]'));
const chatLog        = document.getElementById('chatLog');
const chatForm       = document.getElementById('chatForm');
const chatInput      = document.getElementById('chatInput');

/* state */
let myId = null;
let myJoined = false;
let lastPhase = 'lobby';
let prices = [];
let tick = 0;
const markers = [];
const MAX_POINTS = 600;
let myAvgCost = 0;
let myPos = 0;
let yLo = null;
let yHi = null;
let currentMode = 'news';
let lastBookSnapshot = null;
let myOrders = [];
let orderType = 'market';
const chatMessages = [];
let statusTimer = null;

/* ui helpers */
function show(node){ if(node) node.classList.remove('hidden'); }
function hide(node){ if(node) node.classList.add('hidden'); }

function setTradingEnabled(enabled){
  const controls = [buyBtn, sellBtn, quantityInput, priceInput];
  controls.forEach((el) => { if (el) el.disabled = !enabled; });
  orderTypeRadios.forEach((radio) => { radio.disabled = !enabled; });
}

function goLobby(){
  show(joinView); hide(waitView); hide(gameView);
  setTradingEnabled(false);
}
function goWaiting(){
  hide(joinView); show(waitView); hide(gameView);
  setTradingEnabled(false);
}
function goGame(){
  hide(joinView); hide(waitView); show(gameView);
  setTradingEnabled(true);
  resizeCanvas();
}

function resizeCanvas(){
  const wrap = document.querySelector('.chart-wrap');
  if (!wrap) return;
  const bb = wrap.getBoundingClientRect();
  const dpr = Math.max(1, Math.min(3, window.devicePixelRatio||1));
  const w = Math.max(320, Math.floor(bb.width));
  const h = Math.max(220, Math.floor(w*0.45));
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
  if (tradeModeBadge) {
    tradeModeBadge.textContent = label;
    tradeModeBadge.dataset.mode = currentMode;
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

  const ownLevels = new Set((myOrders || []).map((order) => `${order.side}:${Number(order.price).toFixed(2)}`));
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
    const own = ownLevels.has(`SELL:${Number(level.price).toFixed(2)}`);
    const manual = Number(level.manual || 0);
    const manualChip = manual > 0.01 ? `<span class="manual-chip">${formatVolume(manual)}</span>` : '';
    const cls = `orderbook-row ask${best ? ' best' : ''}${own ? ' own' : ''}`;
    rows.push(`
      <div class="${cls}" style="--bar:${width.toFixed(1)}%">
        <span>${formatVolume(volume)}${manualChip}</span>
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
    const own = ownLevels.has(`BUY:${Number(level.price).toFixed(2)}`);
    const manual = Number(level.manual || 0);
    const manualChip = manual > 0.01 ? `<span class="manual-chip">${formatVolume(manual)}</span>` : '';
    const cls = `orderbook-row bid${best ? ' best' : ''}${own ? ' own' : ''}`;
    rows.push(`
      <div class="${cls}" style="--bar:${width.toFixed(1)}%">
        <span>${formatVolume(volume)}${manualChip}</span>
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

function renderOrders(orders){
  myOrders = Array.isArray(orders) ? orders : [];
  if (cancelAllBtn) cancelAllBtn.disabled = !myOrders.length;
  if (!openOrdersList) return;
  if (!myOrders.length) {
    openOrdersList.innerHTML = '<li class="muted empty-order">No resting orders</li>';
    return;
  }
  const rows = myOrders.map((order) => {
    const sideLabel = order.side === 'BUY' ? 'Bid' : 'Ask';
    const sideClass = order.side === 'BUY' ? 'side-buy' : 'side-sell';
    const qty = formatVolume(order.remaining);
    const price = Number(order.price || 0).toFixed(2);
    return `
      <li>
        <span class="${sideClass}">${sideLabel} ${qty}</span>
        <span>${price}</span>
        <button type="button" class="order-cancel" data-cancel="${order.id}">✕</button>
      </li>
    `;
  }).join('');
  openOrdersList.innerHTML = rows;
}

function updateTradeStatus(message, tone = 'info'){
  if (!tradeStatus) return;
  tradeStatus.textContent = message || '';
  tradeStatus.dataset.tone = tone;
  if (statusTimer) clearTimeout(statusTimer);
  if (message) {
    statusTimer = setTimeout(() => {
      tradeStatus.textContent = '';
      tradeStatus.dataset.tone = 'info';
    }, 5000);
  }
}

function explainReason(reason){
  switch (reason) {
    case 'position-limit': return 'Position limit reached.';
    case 'bad-price': return 'Enter a valid limit price.';
    case 'bad-quantity': return 'Enter a positive quantity.';
    case 'no-liquidity': return 'No liquidity at that price.';
    case 'not-active': return 'Market is not active.';
    default: return 'Order rejected.';
  }
}

function inferredLimitPrice(side){
  if (lastBookSnapshot) {
    if (side === 'BUY') {
      return Number(lastBookSnapshot.bestBid ?? lastBookSnapshot.midPrice ?? lastBookSnapshot.lastPrice ?? prices.at(-1) ?? 100);
    }
    return Number(lastBookSnapshot.bestAsk ?? lastBookSnapshot.midPrice ?? lastBookSnapshot.lastPrice ?? prices.at(-1) ?? 100);
  }
  return Number(prices.at(-1) ?? 100);
}

function throttleButtons(){
  [buyBtn, sellBtn].forEach((btn) => {
    if (!btn) return;
    btn.disabled = true;
    setTimeout(() => {
      if (myJoined && lastPhase === 'running') btn.disabled = false;
    }, 220);
  });
}

function submitOrder(side){
  if (!myJoined || lastPhase !== 'running') return;
  const qty = Number(quantityInput?.value || 0);
  if (!Number.isFinite(qty) || qty <= 0) {
    updateTradeStatus('Enter a positive quantity.', 'error');
    return;
  }

  const payload = { side, quantity: qty, type: orderType };
  if (orderType === 'limit') {
    let px = Number(priceInput?.value || 0);
    if (!Number.isFinite(px) || px <= 0) {
      px = inferredLimitPrice(side);
      if (Number.isFinite(px)) {
        priceInput.value = Number(px).toFixed(2);
      }
    }
    if (!Number.isFinite(px) || px <= 0) {
      updateTradeStatus('Set a valid limit price.', 'error');
      return;
    }
    payload.price = px;
  }

  updateTradeStatus('Submitting…', 'info');
  throttleButtons();

  socket.emit('submitOrder', payload, (resp) => {
    if (!resp || !resp.ok) {
      updateTradeStatus(explainReason(resp?.reason), 'error');
      return;
    }

    if (resp.type === 'market') {
      if (resp.filled > 0) {
        const px = Number(resp.price || 0).toFixed(2);
        updateTradeStatus(`Filled ${formatVolume(resp.filled)} @ ${px}`, 'success');
      } else {
        updateTradeStatus('Order completed.', 'success');
      }
      quantityInput.value = '1';
    } else {
      if (resp.filled > 0) {
        const px = Number(resp.price || 0).toFixed(2);
        updateTradeStatus(`Filled ${formatVolume(resp.filled)} @ ${px}`, 'success');
      } else {
        updateTradeStatus('Order resting.', 'info');
      }
      if (resp.resting?.price) {
        priceInput.value = Number(resp.resting.price).toFixed(2);
      }
    }
  });
}

function cancelOrders(ids){
  socket.emit('cancelOrders', ids || [], (resp) => {
    if (resp?.canceled?.length) {
      updateTradeStatus(`Cancelled ${resp.canceled.length} order(s).`, 'info');
    } else {
      updateTradeStatus('No orders to cancel.', 'error');
    }
  });
}

function addChatMessage(message){
  if (!message) return;
  chatMessages.push(message);
  if (chatMessages.length > 150) chatMessages.shift();
  renderChat();
}

function renderChat(){
  if (!chatLog) return;
  chatLog.innerHTML = '';
  chatMessages.forEach((msg) => {
    const row = document.createElement('div');
    row.className = 'msg';
    const strong = document.createElement('strong');
    strong.textContent = msg.from || 'Player';
    const span = document.createElement('span');
    span.textContent = `: ${msg.text || ''}`;
    row.appendChild(strong);
    row.appendChild(span);
    chatLog.appendChild(row);
  });
  chatLog.scrollTop = chatLog.scrollHeight;
}

/* draw */
function draw(){
  const w = cvs.width/(window.devicePixelRatio||1);
  const h = cvs.height/(window.devicePixelRatio||1);
  ctx.clearRect(0,0,w,h);

  ctx.strokeStyle = 'rgba(255,255,255,.07)';
  ctx.lineWidth = 1; ctx.beginPath();
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

  ctx.strokeStyle='#6da8ff'; ctx.lineWidth=2; ctx.beginPath();
  ctx.moveTo(0, Y(view[0]));
  for(let i=1;i<view.length;i++) ctx.lineTo(X(i), Y(view[i]));
  ctx.stroke();

  if (myPos!==0 && myAvgCost) {
    ctx.save(); ctx.setLineDash([6,4]); ctx.lineWidth=1.5;
    ctx.strokeStyle = myPos>0 ? '#2ecc71' : '#ff5c5c';
    const y=Y(myAvgCost); ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(w,y); ctx.stroke(); ctx.restore();
  }

  const viewLen=view.length; const startTick = tick - viewLen + 1;
  for(const m of markers){
    const i = m.tick - startTick; if(i<0||i>=viewLen) continue;
    const x = X(i), y = Y(m.px);
    ctx.fillStyle = m.side>0 ? '#2ecc71' : '#ff5c5c';
    ctx.beginPath();
    if(m.side>0){ ctx.moveTo(x,y-10); ctx.lineTo(x-6,y); ctx.lineTo(x+6,y); }
    else       { ctx.moveTo(x,y+10); ctx.lineTo(x-6,y); ctx.lineTo(x+6,y); }
    ctx.closePath(); ctx.fill();
  }

  ctx.fillStyle='#fff'; ctx.beginPath();
  ctx.arc(X(view.length-1), Y(view[view.length-1]), 2.5, 0, Math.PI*2);
  ctx.fill();
}
function scheduleDraw(){ if(scheduleDraw._p) return; scheduleDraw._p=true; requestAnimationFrame(()=>{scheduleDraw._p=false; draw();}); }

/* socket events */
socket.on('connect', ()=>{ myId = socket.id; });

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
      if (ack.orders) renderOrders(ack.orders);
      if (ack.phase === 'lobby') {
        joinMsg.textContent='Joined — waiting for host…';
        goWaiting();
      } else {
        productLbl.textContent = ack.productName || 'Demo Asset';
        prices = []; markers.length=0; myAvgCost=0; myPos=0; yLo=yHi=null; tick = 0;
        prices.push(ack.price ?? ack.fairValue ?? 100);
        if (ack.paused) setTradingEnabled(false); else setTradingEnabled(true);
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
  if (!rosterUl) return;
  rosterUl.innerHTML = '';
  rows.forEach((r)=>{
    const li = document.createElement('li');
    li.textContent = r.isBot ? `${r.name} 🤖` : r.name;
    rosterUl.appendChild(li);
  });
});

socket.on('priceMode', (mode)=>{ updateModeBadges(mode); });

socket.on('orderBook', (book)=>{ renderOrderBook(book); });

socket.on('gameStarted', ({ fairValue, productName, paused, price })=>{
  if (!myJoined) return;
  productLbl.textContent = productName || 'Demo Asset';
  prices = []; markers.length=0; myAvgCost=0; myPos=0; yLo=yHi=null; tick = 0;
  prices.push(price ?? fairValue ?? 100);
  if (paused) setTradingEnabled(false); else setTradingEnabled(true);
  goGame();
  scheduleDraw();
  renderOrderBook(null);
  renderOrders([]);
});

socket.on('gameReset', ()=>{
  myJoined = false;
  prices=[]; markers.length=0; myAvgCost=0; myPos=0; yLo=yHi=null; tick = 0;
  nameInput.value = '';
  joinBtn.disabled = false; joinBtn.textContent = 'Join';
  renderOrderBook(null);
  renderOrders([]);
  updateTradeStatus('');
  goLobby();
});

socket.on('paused', (isPaused)=>{
  setTradingEnabled(!isPaused && myJoined && lastPhase==='running');
});

socket.on('news', ({ text, delta })=>{
  if (!newsText || !newsBar) return;
  newsText.textContent = text || '';
  newsBar.style.background = (delta>0) ? '#12361f' : (delta<0) ? '#3a1920' : '#121a2b';
  newsBar.style.transition = 'opacity .3s ease';
  newsBar.style.opacity = '1';
  setTimeout(()=>{ newsBar.style.opacity='0.85'; }, 16000);
});

socket.on('priceUpdate', ({ price, priceMode })=>{
  if (!myJoined) return;
  tick++;
  prices.push(price);
  if(prices.length>MAX_POINTS) prices.shift();
  priceLbl.textContent = Number(price).toFixed(2);
  if (priceMode) updateModeBadges(priceMode);
  scheduleDraw();
});

socket.on('you', ({ position, pnl, avgCost })=>{
  myPos = Number(position || 0);
  myAvgCost = Number(avgCost || 0);
  posLbl.textContent = formatExposure(myPos);
  pnlLbl.textContent = Number(pnl || 0).toFixed(2);
  if (avgLbl) {
    avgLbl.textContent = myAvgCost ? Number(myAvgCost).toFixed(2) : '—';
  }
  scheduleDraw();
});

socket.on('tradeMarker', ({ side, px, qty })=>{
  if (!myJoined) return;
  const s = (side==='BUY') ? +1 : -1;
  markers.push({ tick, px, side: s, qty: qty || 1 });
  scheduleDraw();
});

socket.on('openOrders', (orders)=>{
  renderOrders(orders || []);
  renderOrderBook(lastBookSnapshot);
});

socket.on('chatHistory', (history)=>{
  chatMessages.length = 0;
  (history || []).forEach((msg) => chatMessages.push(msg));
  renderChat();
});

socket.on('chatMessage', (message)=>{
  addChatMessage(message);
});

/* form interactions */
orderTypeRadios.forEach((radio) => {
  radio.addEventListener('change', () => {
    if (radio.checked) {
      orderType = radio.value === 'limit' ? 'limit' : 'market';
      if (orderType === 'limit') {
        limitPriceRow?.classList.remove('hidden');
      } else {
        limitPriceRow?.classList.add('hidden');
        if (tradeStatus) tradeStatus.dataset.tone = 'info';
      }
    }
  });
});

if (buyBtn) buyBtn.addEventListener('click', () => submitOrder('BUY'));
if (sellBtn) sellBtn.addEventListener('click', () => submitOrder('SELL'));
if (cancelAllBtn) cancelAllBtn.addEventListener('click', () => cancelOrders());

if (openOrdersList) {
  openOrdersList.addEventListener('click', (ev) => {
    const target = ev.target.closest('[data-cancel]');
    if (!target) return;
    const id = target.getAttribute('data-cancel');
    if (id) cancelOrders([id]);
  });
}

if (chatForm) {
  chatForm.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const text = (chatInput?.value || '').trim();
    if (!text) return;
    socket.emit('chatMessage', { text }, (ack) => {
      if (ack?.ok) {
        chatInput.value = '';
      }
    });
  });
}

/* init */
goLobby();
resizeCanvas();
updateModeBadges('news');
renderOrderBook(null);
renderOrders([]);
renderChat();
updateTradeStatus('');
