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
const bookScrollToggle = document.getElementById('bookScrollToggle');
const chartTypeToggle= document.getElementById('chartTypeToggle');
const joinFullscreenBtn = document.getElementById('joinFullscreenBtn');
const waitFullscreenBtn = document.getElementById('waitFullscreenBtn');
const gameFullscreenBtn = document.getElementById('gameFullscreenBtn');
const fullscreenButtons = [joinFullscreenBtn, waitFullscreenBtn, gameFullscreenBtn].filter(Boolean);

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
const MAX_VISIBLE_POINTS = 240;
const CANDLE_DURATION_MS = 10000;
const MAX_VISIBLE_CANDLES = 120;
const MAX_CANDLES = 360;
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
let chartType = 'line';
const MAX_BOOK_DEPTH = 30;
let autoScrollBook = true;
let lastBookLevels = new Map();
let lastTradedPrice = null;
const candleSeries = [];
let lastCandle = null;
let lastTickTimestamp = null;
let avgTickInterval = 250;
let ticksPerCandle = Math.max(1, Math.round(CANDLE_DURATION_MS / Math.max(1, avgTickInterval)));

/* ui helpers */
function show(node){ if(node) node.classList.remove('hidden'); }
function hide(node){ if(node) node.classList.add('hidden'); }

function isFullscreenActive(){
  return Boolean(document.fullscreenElement);
}

function syncFullscreenButtons(){
  const active = isFullscreenActive();
  fullscreenButtons.forEach((btn) => {
    btn.dataset.active = active ? 'true' : 'false';
    btn.textContent = active ? 'Exit Fullscreen' : 'Enter Fullscreen';
  });
}

async function toggleFullscreen(){
  const target = document.documentElement;
  if (!target || typeof target.requestFullscreen !== 'function') return;
  try {
    if (isFullscreenActive()) {
      if (typeof document.exitFullscreen === 'function') {
        await document.exitFullscreen();
      }
    } else {
      await target.requestFullscreen();
    }
  } catch (err) {
    console.error('Fullscreen request failed', err);
  } finally {
    syncFullscreenButtons();
  }
}

function syncChartToggle(){
  if (!chartTypeToggle) return;
  if (chartType === 'line') {
    chartTypeToggle.textContent = 'Show Candles';
  } else {
    chartTypeToggle.textContent = 'Show Line';
  }
  chartTypeToggle.dataset.mode = chartType;
}

function resetCandles(){
  candleSeries.length = 0;
  lastCandle = null;
  lastTickTimestamp = null;
  avgTickInterval = 250;
  ticksPerCandle = Math.max(1, Math.round(CANDLE_DURATION_MS / Math.max(1, avgTickInterval)));
}

function trimCandles(){
  if (candleSeries.length > MAX_CANDLES) {
    candleSeries.splice(0, candleSeries.length - MAX_CANDLES);
  }
  lastCandle = candleSeries.at(-1) ?? null;
}

function seedInitialCandle(price){
  resetCandles();
  if (!Number.isFinite(price)) return;
  const now = Date.now();
  lastTickTimestamp = now;
  const bucket = Math.floor(now / CANDLE_DURATION_MS);
  const startMs = bucket * CANDLE_DURATION_MS;
  const candle = {
    bucket,
    startMs,
    endMs: now,
    startTick: 0,
    endTick: 0,
    open: price,
    high: price,
    low: price,
    close: price,
    count: 1,
    complete: false,
  };
  candleSeries.push(candle);
  trimCandles();
}

function updateCandleSeries(price, tickIndex, timestamp){
  if (!Number.isFinite(price)) return;
  const now = Number.isFinite(Number(timestamp)) ? Number(timestamp) : Date.now();
  if (lastTickTimestamp !== null) {
    const delta = Math.max(1, now - lastTickTimestamp);
    avgTickInterval = avgTickInterval * 0.85 + delta * 0.15;
    ticksPerCandle = Math.max(1, Math.round(CANDLE_DURATION_MS / Math.max(1, avgTickInterval)));
  }
  lastTickTimestamp = now;

  const bucket = Math.floor(now / CANDLE_DURATION_MS);
  lastCandle = candleSeries.at(-1) ?? null;

  if (!lastCandle || bucket > lastCandle.bucket) {
    if (lastCandle) {
      if (!Number.isFinite(lastCandle.endTick)) lastCandle.endTick = tickIndex - 1;
      if (!Number.isFinite(lastCandle.endMs)) lastCandle.endMs = lastCandle.startMs + CANDLE_DURATION_MS;
      lastCandle.complete = true;
    }

    let prevClose = lastCandle ? lastCandle.close : price;
    let prevEndTick = lastCandle && Number.isFinite(lastCandle.endTick)
      ? lastCandle.endTick
      : (lastCandle ? lastCandle.startTick ?? tickIndex - 1 : tickIndex - 1);

    const startBucket = lastCandle ? lastCandle.bucket + 1 : bucket;
    for (let b = startBucket; b < bucket; b += 1) {
      const fillerStartTick = prevEndTick + 1;
      const fillerEndTick = fillerStartTick + Math.max(1, ticksPerCandle) - 1;
      prevEndTick = fillerEndTick;
      const filler = {
        bucket: b,
        startMs: b * CANDLE_DURATION_MS,
        endMs: (b + 1) * CANDLE_DURATION_MS,
        startTick: fillerStartTick,
        endTick: fillerEndTick,
        open: prevClose,
        high: prevClose,
        low: prevClose,
        close: prevClose,
        count: 0,
        complete: true,
      };
      candleSeries.push(filler);
      prevClose = filler.close;
    }

    const candle = {
      bucket,
      startMs: bucket * CANDLE_DURATION_MS,
      endMs: now,
      startTick: tickIndex,
      endTick: tickIndex,
      open: price,
      high: price,
      low: price,
      close: price,
      count: 1,
      complete: false,
    };
    candleSeries.push(candle);
    trimCandles();
    return;
  }

  if (bucket < lastCandle.bucket) {
    return;
  }

  lastCandle.endTick = tickIndex;
  lastCandle.endMs = now;
  lastCandle.close = price;
  lastCandle.count = (lastCandle.count || 0) + 1;
  if (price > lastCandle.high) lastCandle.high = price;
  if (price < lastCandle.low) lastCandle.low = price;
}

function getVisibleCandles(startTick){
  if (!candleSeries.length) return [];
  const subset = candleSeries.filter((candle) => {
    const endTick = Number.isFinite(candle?.endTick) ? candle.endTick : candle.startTick;
    return Number.isFinite(endTick) ? endTick >= startTick : false;
  });
  return subset.slice(-MAX_VISIBLE_CANDLES);
}

function clearSeries(){
  prices = [];
  tick = 0;
  yLo = null;
  yHi = null;
  markers.length = 0;
  lastTradedPrice = null;
  resetCandles();
}

function prepareNewRound(initialPrice){
  const px = Number.isFinite(+initialPrice) ? +initialPrice : Number(prices.at(-1) ?? 100);
  clearSeries();
  prices.push(px);
  seedInitialCandle(px);
  lastTradedPrice = px;
  yLo = px - 3;
  yHi = px + 3;
  myAvgCost = 0;
  myPos = 0;
  if (priceLbl) priceLbl.textContent = Number(px).toFixed(2);
  if (posLbl) posLbl.textContent = '0';
  if (pnlLbl) pnlLbl.textContent = '0.00';
  if (avgLbl) avgLbl.textContent = '—';
}

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

function formatBookVolume(value){
  const num = Number(value || 0);
  if (!Number.isFinite(num)) return '0';
  const rounded = Math.round(num);
  if (rounded === 0 && num > 0) return '1';
  return Math.max(0, rounded).toString();
}

function syncBookScrollToggle(){
  if (!bookScrollToggle) return;
  bookScrollToggle.textContent = autoScrollBook ? 'Auto Scroll: On' : 'Auto Scroll: Off';
  bookScrollToggle.dataset.state = autoScrollBook ? 'on' : 'off';
}

function renderOrderBook(book){
  if (!bookBody) return;
  lastBookSnapshot = book;
  if (!autoScrollBook) {
    bookBody.style.setProperty('--book-pad-top', '12px');
    bookBody.style.setProperty('--book-pad-bottom', '12px');
  }
  if (!book || ((!Array.isArray(book.bids) || !book.bids.length) && (!Array.isArray(book.asks) || !book.asks.length))) {
    bookBody.innerHTML = '<div class="book-empty muted">No resting liquidity</div>';
    lastBookLevels = new Map();
    if (bookSpreadLbl) bookSpreadLbl.textContent = 'Spread: —';
    if (autoScrollBook) {
      const pad = Math.max(32, Math.floor(bookBody.clientHeight / 2));
      bookBody.style.setProperty('--book-pad-top', `${pad}px`);
      bookBody.style.setProperty('--book-pad-bottom', `${pad}px`);
    }
    return;
  }

  const ownLevels = new Set((myOrders || []).map((order) => `${order.side}:${Number(order.price).toFixed(2)}`));
  const asks = Array.isArray(book.asks) ? book.asks.slice(0, MAX_BOOK_DEPTH) : [];
  const bids = Array.isArray(book.bids) ? book.bids.slice(0, MAX_BOOK_DEPTH) : [];
  const bestAskStr = Number.isFinite(Number(book.bestAsk)) ? Number(book.bestAsk).toFixed(2) : null;
  const bestBidStr = Number.isFinite(Number(book.bestBid)) ? Number(book.bestBid).toFixed(2) : null;
  const volumes = [...asks, ...bids].map((lvl) => Math.max(0, Number(lvl?.size || 0)));
  const maxVol = Math.max(1, ...volumes);
  const prevLevels = lastBookLevels;
  const nextLevels = new Map();
  const seenPrices = new Set();
  const fragment = document.createDocumentFragment();
  const highlightKey = Number.isFinite(lastTradedPrice) ? Number(lastTradedPrice).toFixed(2) : null;
  let focusRow = null;

  const appendRow = (side, level, isBest) => {
    if (!level) return;
    const priceNum = Number(level.price);
    if (!Number.isFinite(priceNum)) return;
    const priceStr = priceNum.toFixed(2);
    const volume = Math.max(0, Number(level.size || 0));
    const manual = Math.max(0, Number(level.manual || 0));
    const row = document.createElement('div');
    row.className = `orderbook-row ${side}`;
    row.dataset.price = priceStr;
    if (isBest) row.classList.add('best');

    const ownKey = `${side === 'ask' ? 'SELL' : 'BUY'}:${priceStr}`;
    if (ownLevels.has(ownKey)) row.classList.add('own');

    const width = Math.min(100, (volume / maxVol) * 100);
    if (side === 'ask') row.style.setProperty('--ask-bar', width.toFixed(1));
    else row.style.setProperty('--bid-bar', width.toFixed(1));

    const sellSpan = document.createElement('span');
    sellSpan.className = 'sell';
    const priceSpan = document.createElement('span');
    priceSpan.className = 'price';
    const buySpan = document.createElement('span');
    buySpan.className = 'buy';

    if (side === 'ask') {
      sellSpan.textContent = formatBookVolume(volume);
      if (manual > 0.01) {
        const chip = document.createElement('span');
        chip.className = 'manual-chip';
        chip.textContent = formatVolume(manual);
        sellSpan.appendChild(chip);
      }
      buySpan.textContent = '';
    } else {
      sellSpan.textContent = '';
      buySpan.textContent = formatBookVolume(volume);
      if (manual > 0.01) {
        const chip = document.createElement('span');
        chip.className = 'manual-chip';
        chip.textContent = formatVolume(manual);
        buySpan.appendChild(chip);
      }
    }

    const strong = document.createElement('strong');
    strong.textContent = priceStr;
    priceSpan.appendChild(strong);

    row.append(sellSpan, priceSpan, buySpan);

    if (highlightKey && priceStr === highlightKey) {
      row.classList.add('current');
      focusRow = row;
    }

    seenPrices.add(priceStr);

    const levelKey = `${side}:${priceStr}`;
    const rounded = Math.round(volume);
    if ((prevLevels.has(levelKey) && prevLevels.get(levelKey) !== rounded) || (!prevLevels.has(levelKey) && rounded > 0)) {
      row.classList.add('flash');
    }
    nextLevels.set(levelKey, rounded);

    fragment.appendChild(row);
  };

  for (let i = asks.length - 1; i >= 0; i -= 1) {
    const level = asks[i];
    const best = Number(level?.price) === Number(book.bestAsk);
    appendRow('ask', level, best);
  }

  if (highlightKey && !seenPrices.has(highlightKey)) {
    const midRow = document.createElement('div');
    midRow.className = 'orderbook-row midpoint current';
    midRow.dataset.price = highlightKey;
    const sellSpan = document.createElement('span');
    sellSpan.className = 'sell';
    sellSpan.textContent = '—';
    const priceSpan = document.createElement('span');
    priceSpan.className = 'price';
    const strong = document.createElement('strong');
    strong.textContent = highlightKey;
    priceSpan.appendChild(strong);
    const buySpan = document.createElement('span');
    buySpan.className = 'buy';
    buySpan.textContent = '—';
    midRow.append(sellSpan, priceSpan, buySpan);
    fragment.appendChild(midRow);
    focusRow = midRow;
  }

  for (let i = 0; i < bids.length; i += 1) {
    const level = bids[i];
    const best = Number(level?.price) === Number(book.bestBid);
    appendRow('bid', level, best);
  }

  const previousScroll = autoScrollBook ? null : bookBody.scrollTop;
  bookBody.innerHTML = '';
  bookBody.appendChild(fragment);
  if (!autoScrollBook && previousScroll !== null) {
    bookBody.scrollTop = previousScroll;
  }
  lastBookLevels = nextLevels;

  if (bookSpreadLbl) {
    const spread = Number(book.spread);
    bookSpreadLbl.textContent = Number.isFinite(spread) && spread > 0
      ? `Spread: ${spread.toFixed(2)}`
      : 'Spread: —';
  }

  if (autoScrollBook) {
    requestAnimationFrame(() => {
      const clientHeight = bookBody.clientHeight;
      const maxScroll = Math.max(0, bookBody.scrollHeight - clientHeight);
      const current = focusRow || bookBody.querySelector('.orderbook-row.current') || bookBody.querySelector('.orderbook-row.best');
      const bestAskEl = bestAskStr ? bookBody.querySelector(`.orderbook-row.ask[data-price="${bestAskStr}"]`) : null;
      const bestBidEl = bestBidStr ? bookBody.querySelector(`.orderbook-row.bid[data-price="${bestBidStr}"]`) : null;
      let scrollPos = null;
      let padBase = 18;
      const clampPad = (pad) => Math.max(18, Math.min(240, Number.isFinite(pad) ? pad : 60));

      if (current) {
        const rowHeight = current.offsetHeight || 32;
        const midpoint = current.offsetTop + rowHeight / 2;
        padBase = clampPad(Math.floor(clientHeight / 2 - rowHeight / 2));
        scrollPos = midpoint - clientHeight / 2;
      } else if (bestAskEl && bestBidEl) {
        const askMid = bestAskEl.offsetTop + (bestAskEl.offsetHeight || 0) / 2;
        const bidMid = bestBidEl.offsetTop + (bestBidEl.offsetHeight || 0) / 2;
        const midline = (askMid + bidMid) / 2;
        const approxHeight = ((bestAskEl.offsetHeight || 0) + (bestBidEl.offsetHeight || 0)) / 2 || 32;
        padBase = clampPad(Math.floor(clientHeight / 2 - approxHeight / 2));
        scrollPos = midline - clientHeight / 2;
      } else if (bestAskEl || bestBidEl) {
        const ref = bestAskEl || bestBidEl;
        const rowHeight = ref.offsetHeight || 32;
        const midpoint = ref.offsetTop + rowHeight / 2;
        padBase = clampPad(Math.floor(clientHeight / 2 - rowHeight / 2));
        scrollPos = midpoint - clientHeight / 2;
      } else {
        const approxHeight = 28;
        padBase = clampPad(Math.floor(clientHeight / 2 - approxHeight / 2));
        scrollPos = Math.max(0, (bookBody.scrollHeight - clientHeight) / 2);
      }

      bookBody.style.setProperty('--book-pad-top', `${padBase}px`);
      bookBody.style.setProperty('--book-pad-bottom', `${padBase}px`);

      if (scrollPos !== null) {
        const clamped = Math.max(0, Math.min(maxScroll, scrollPos));
        bookBody.scrollTop = clamped;
      }
    });
  } else {
    bookBody.style.setProperty('--book-pad-top', '12px');
    bookBody.style.setProperty('--book-pad-bottom', '12px');
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

  const view = prices.slice(-MAX_VISIBLE_POINTS);
  const viewLen = view.length;
  if(!viewLen) return;

  const startTick = Math.max(0, tick - viewLen + 1);

  const rawLo = Math.min(...view), rawHi = Math.max(...view);
  const pad = Math.max(0.5, (rawHi-rawLo)*0.12);
  const tgtLo = rawLo-pad, tgtHi=rawHi+pad;

  if(yLo===null||yHi===null){ yLo=tgtLo; yHi=tgtHi; }
  if(tgtLo<yLo) yLo=tgtLo; else yLo=yLo+(tgtLo-yLo)*0.05;
  if(tgtHi>yHi) yHi=tgtHi; else yHi=yHi+(tgtHi-yHi)*0.05;

  const step = MAX_VISIBLE_POINTS>1 ? w/(MAX_VISIBLE_POINTS-1) : w;
  const usedWidth = viewLen>1 ? (viewLen-1)*step : 0;
  const rightPad = Math.max(40, Math.min(90, w*0.1));
  const offsetX = Math.max(0, w - usedWidth - rightPad);
  const X = (i)=> offsetX + i*step;
  const clampIndex = (idx) => Math.max(0, Math.min(viewLen-1, idx));
  const XFromTick = (tIdx) => X(clampIndex(tIdx - startTick));
  const Y = p=> h - ((p - yLo)/Math.max(1e-6,(yHi-yLo)))*h;

  const candleSeries = chartType === 'candles'
    ? getVisibleCandles(startTick)
    : [];

  if(chartType === 'candles' && candleSeries.length){
    const len = candleSeries.length;
    ctx.lineWidth = 1;
    for(let i=0;i<len;i+=1){
      const candle = candleSeries[i];
      const open = Number.isFinite(candle.open) ? candle.open : candle.close;
      const close = Number.isFinite(candle.close) ? candle.close : open;
      const high = Number.isFinite(candle.high) ? candle.high : Math.max(open, close);
      const low = Number.isFinite(candle.low) ? candle.low : Math.min(open, close);
      const bullish = close >= open;
      const color = bullish ? '#2ecc71' : '#ff5c5c';
      const centerTick = Number.isFinite(candle?.startTick) && Number.isFinite(candle?.endTick)
        ? (candle.startTick + candle.endTick) / 2
        : startTick + i * Math.max(1, ticksPerCandle);
      const x = XFromTick(centerTick);
      const top = Math.min(Y(open), Y(close));
      const bottom = Math.max(Y(open), Y(close));
      const isLast = i === len - 1;
      const isComplete = Boolean(candle.complete);
      ctx.save();
      ctx.globalAlpha = !isComplete && isLast ? 0.7 : 1;
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.moveTo(x, Y(high));
      ctx.lineTo(x, Y(low));
      ctx.stroke();
      ctx.fillStyle = color;
      const spanTicks = Number.isFinite(candle?.endTick) && Number.isFinite(candle?.startTick)
        ? Math.max(1, candle.endTick - candle.startTick + 1)
        : Math.max(1, ticksPerCandle);
      const widthFactor = Math.max(1, Math.min(Math.max(1, ticksPerCandle), candle?.count || spanTicks));
      const bodyWidth = Math.max(3, Math.min(12, step * widthFactor * 0.6));
      const height = Math.max(1, bottom - top);
      ctx.fillRect(x - bodyWidth / 2, top, bodyWidth, height);
      ctx.restore();
    }
  } else if (viewLen >= 2) {
    ctx.strokeStyle='#6da8ff'; ctx.lineWidth=2; ctx.beginPath();
    ctx.moveTo(X(0), Y(view[0]));
    for(let i=1;i<viewLen;i++) ctx.lineTo(X(i), Y(view[i]));
    ctx.stroke();
  }

  if (myPos!==0 && myAvgCost) {
    ctx.save(); ctx.setLineDash([6,4]); ctx.lineWidth=1.5;
    ctx.strokeStyle = myPos>0 ? '#2ecc71' : '#ff5c5c';
    const y=Y(myAvgCost); ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(w,y); ctx.stroke(); ctx.restore();
  }

  for(const m of markers){
    const i = m.tick - startTick; if(i<0||i>=viewLen) continue;
    const x = X(i), y = Y(m.px);
    ctx.fillStyle = m.side>0 ? '#2ecc71' : '#ff5c5c';
    ctx.beginPath();
    if(m.side>0){ ctx.moveTo(x,y-10); ctx.lineTo(x-6,y); ctx.lineTo(x+6,y); }
    else       { ctx.moveTo(x,y+10); ctx.lineTo(x-6,y); ctx.lineTo(x+6,y); }
    ctx.closePath(); ctx.fill();
  }

  const lastPrice = view.at(-1);
  if (lastPrice !== undefined) {
    let lastX = X(viewLen - 1);
    if (chartType === 'candles' && candleSeries.length) {
      const lastCandle = candleSeries.at(-1);
      const referenceTick = Number.isFinite(lastCandle?.endTick)
        ? lastCandle.endTick
        : Number.isFinite(lastCandle?.startTick)
          ? lastCandle.startTick
          : startTick + candleSeries.length * Math.max(1, ticksPerCandle);
      lastX = XFromTick(referenceTick);
    }
    ctx.fillStyle='#fff'; ctx.beginPath();
    ctx.arc(lastX, Y(lastPrice), 2.5, 0, Math.PI*2);
    ctx.fill();
  }
}
function scheduleDraw(){
  if (scheduleDraw._p) return;
  scheduleDraw._p = true;
  requestAnimationFrame(() => {
    scheduleDraw._p = false;
    draw();
  });
}

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
        prepareNewRound(ack.price ?? ack.fairValue ?? 100);
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
  prepareNewRound(price ?? fairValue ?? 100);
  if (paused) setTradingEnabled(false); else setTradingEnabled(true);
  goGame();
  scheduleDraw();
  renderOrderBook(null);
  renderOrders([]);
});

socket.on('gameReset', ()=>{
  myJoined = false;
  clearSeries();
  myAvgCost=0; myPos=0;
  nameInput.value = '';
  joinBtn.disabled = false; joinBtn.textContent = 'Join';
  if (priceLbl) priceLbl.textContent = '—';
  if (posLbl) posLbl.textContent = '0';
  if (pnlLbl) pnlLbl.textContent = '0.00';
  if (avgLbl) avgLbl.textContent = '—';
  renderOrderBook(null);
  renderOrders([]);
  updateTradeStatus('');
  goLobby();
  scheduleDraw();
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

socket.on('priceUpdate', ({ price, priceMode, t: stamp })=>{
  if (!myJoined) return;
  tick++;
  const numeric = Number(price);
  const timestamp = Number.isFinite(Number(stamp)) ? Number(stamp) : undefined;
  if (Number.isFinite(numeric)) {
    prices.push(numeric);
    if(prices.length>MAX_POINTS) prices.shift();
    lastTradedPrice = numeric;
    if (priceLbl) priceLbl.textContent = numeric.toFixed(2);
    updateCandleSeries(numeric, tick, timestamp);
  } else if (prices.length) {
    lastTradedPrice = Number(prices.at(-1));
    if (priceLbl && Number.isFinite(lastTradedPrice)) priceLbl.textContent = lastTradedPrice.toFixed(2);
    if (Number.isFinite(lastTradedPrice)) {
      updateCandleSeries(lastTradedPrice, tick, timestamp);
    }
  }
  if (priceMode) updateModeBadges(priceMode);
  if (lastBookSnapshot) renderOrderBook(lastBookSnapshot);
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

if (bookScrollToggle) {
  bookScrollToggle.addEventListener('click', () => {
    autoScrollBook = !autoScrollBook;
    syncBookScrollToggle();
    if (autoScrollBook) {
      renderOrderBook(lastBookSnapshot);
    }
  });
}

fullscreenButtons.forEach((btn) => {
  btn.addEventListener('click', (ev) => {
    ev.preventDefault();
    toggleFullscreen();
  });
});

if (chartTypeToggle) {
  chartTypeToggle.addEventListener('click', () => {
    chartType = chartType === 'line' ? 'candles' : 'line';
    syncChartToggle();
    scheduleDraw();
  });
}

document.addEventListener('fullscreenchange', () => {
  syncFullscreenButtons();
});

document.addEventListener('fullscreenerror', () => {
  syncFullscreenButtons();
});

/* init */
goLobby();
resizeCanvas();
updateModeBadges('news');
renderOrderBook(null);
renderOrders([]);
renderChat();
updateTradeStatus('');
syncChartToggle();
syncFullscreenButtons();
syncBookScrollToggle();
