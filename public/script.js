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
const joinFullscreenBtn = document.getElementById('joinFullscreenBtn');
const waitFullscreenBtn = document.getElementById('waitFullscreenBtn');
const gameFullscreenBtn = document.getElementById('gameFullscreenBtn');
const fullscreenButtons = [joinFullscreenBtn, waitFullscreenBtn, gameFullscreenBtn].filter(Boolean);

const chartContainer = document.getElementById('chart');
let chartApi = null;
let candleSeriesApi = null;
let avgPriceLineCandle = null;
let chartResizeObserver = null;

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
const chatTargetList = document.getElementById('chatTargetList');
const chatChannelSummary = document.getElementById('chatChannelSummary');

/* state */
let myId = null;
let myJoined = false;
let lastPhase = 'lobby';
let prices = [];
let tick = 0;
const markers = [];
let candlePlotData = [];
const MAX_POINTS = 600;
const CANDLE_DURATION_MS = 10000;
const MAX_VISIBLE_CANDLES = 120;
const MAX_CANDLES = 360;
let myAvgCost = 0;
let myPos = 0;
let currentMode = 'news';
let lastBookSnapshot = null;
let myOrders = [];
let orderType = 'market';
const chatMessages = [];
let statusTimer = null;
const MAX_BOOK_DEPTH = 30;
let autoScrollBook = true;
let lastBookLevels = new Map();
let lastTradedPrice = null;
const candleSeries = [];
let lastCandle = null;
let lastTickTimestamp = null;
let avgTickInterval = 250;
let ticksPerCandle = Math.max(1, Math.round(CANDLE_DURATION_MS / Math.max(1, avgTickInterval)));
let lastPointTime = null;

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

function ensureChart(){
  if (chartApi || !chartContainer || typeof LightweightCharts === 'undefined') {
    return;
  }
  chartContainer.innerHTML = '';
  chartApi = LightweightCharts.createChart(chartContainer, {
    layout: {
      background: { color: '#0d1423' },
      textColor: '#d5e7ff',
      fontSize: 12,
      fontFamily: 'Inter, "Segoe UI", system-ui, sans-serif',
    },
    grid: {
      vertLines: { color: 'rgba(109,168,255,0.12)' },
      horzLines: { color: 'rgba(109,168,255,0.12)' },
    },
    rightPriceScale: {
      borderVisible: false,
      scaleMargins: { top: 0.1, bottom: 0.18 },
    },
    timeScale: {
      borderVisible: false,
      rightOffset: 4,
      barSpacing: 10,
    },
    crosshair: {
      mode: LightweightCharts.CrosshairMode.Normal,
    },
    localization: {
      priceFormatter: (price) => Number(price).toFixed(2),
    },
    autoSize: false,
  });
  candleSeriesApi = chartApi.addCandlestickSeries({
    upColor: '#2ecc71',
    downColor: '#ff5c5c',
    borderVisible: false,
    wickUpColor: '#2ecc71',
    wickDownColor: '#ff5c5c',
    priceLineVisible: false,
  });

  candleSeriesApi.setData(candlePlotData);
  updateAveragePriceLine();
  syncMarkers();

  if (!chartResizeObserver && typeof ResizeObserver === 'function') {
    chartResizeObserver = new ResizeObserver(() => {
      resizeChart();
    });
    const target = chartContainer.parentElement || chartContainer;
    chartResizeObserver.observe(target);
  }

  resizeChart();
}

function resizeChart(){
  if (!chartApi || !chartContainer) return;
  const wrap = chartContainer.parentElement || chartContainer;
  const width = Math.max(320, Math.floor(wrap.clientWidth || chartContainer.clientWidth || 320));
  const height = Math.max(260, Math.floor(width * 0.48));
  chartContainer.style.height = `${height}px`;
  chartApi.applyOptions({ width, height });
  chartApi.timeScale().scrollToRealTime();
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
  if (!Number.isFinite(price)) return { changed: false, newBucket: false };
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

    const openPrice = Number.isFinite(prevClose) ? prevClose : price;
    const high = Math.max(openPrice, price);
    const low = Math.min(openPrice, price);
    const candle = {
      bucket,
      startMs: bucket * CANDLE_DURATION_MS,
      endMs: now,
      startTick: tickIndex,
      endTick: tickIndex,
      open: openPrice,
      high,
      low,
      close: price,
      count: 1,
      complete: false,
    };
    candleSeries.push(candle);
    trimCandles();
    lastCandle = candleSeries.at(-1) ?? null;
    return { changed: true, newBucket: true };
  }

  if (bucket < lastCandle.bucket) {
    return { changed: false, newBucket: false };
  }

  lastCandle.endTick = tickIndex;
  lastCandle.endMs = now;
  lastCandle.close = price;
  lastCandle.count = (lastCandle.count || 0) + 1;
  if (price > lastCandle.high) lastCandle.high = price;
  if (price < lastCandle.low) lastCandle.low = price;
  return { changed: true, newBucket: false };
}

function roundPrice(value){
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.round(num * 100) / 100;
}

function nextPointTime(timestamp){
  const base = Number.isFinite(Number(timestamp)) ? Number(timestamp) : Date.now();
  let seconds = Math.floor(base / 1000);
  if (lastPointTime !== null && seconds <= lastPointTime) {
    seconds = lastPointTime + 1;
  }
  lastPointTime = seconds;
  return seconds;
}

function syncCandleSeriesData(options = {}){
  if (!candleSeriesApi) return;
  const { shouldScroll = false } = options;
  const mapped = candleSeries
    .slice(-MAX_VISIBLE_CANDLES)
    .map((candle) => {
      const endMs = Number.isFinite(candle?.endMs)
        ? candle.endMs
        : (Number.isFinite(candle?.startMs) ? candle.startMs + CANDLE_DURATION_MS : Date.now());
      const time = Math.floor(endMs / 1000);
      return {
        time,
        open: roundPrice(candle.open),
        high: roundPrice(candle.high),
        low: roundPrice(candle.low),
        close: roundPrice(candle.close),
      };
  });
  candlePlotData = mapped;
  candleSeriesApi.setData(mapped);
  if (chartApi && shouldScroll) {
    chartApi.timeScale().scrollToRealTime();
  }
}

function syncMarkers(){
  if (!candleSeriesApi) return;
  let source = markers;
  const minTime = candlePlotData[0]?.time;
  if (Number.isFinite(minTime)) {
    source = markers.filter((m) => !Number.isFinite(m.time) || m.time >= minTime);
    if (source.length !== markers.length) {
      markers.length = 0;
      source.forEach((item) => markers.push(item));
    }
  }
  const mapped = source.map((m) => ({
    time: m.time,
    position: m.side > 0 ? 'belowBar' : 'aboveBar',
    color: m.side > 0 ? '#2ecc71' : '#ff5c5c',
    shape: m.side > 0 ? 'arrowUp' : 'arrowDown',
    text: `${m.side > 0 ? 'B' : 'S'} ${formatBookVolume(m.qty || 1)}`,
  }));
  candleSeriesApi.setMarkers(mapped);
}

function updateAveragePriceLine(){
  if (typeof LightweightCharts === 'undefined' || !candleSeriesApi) return;
  if (avgPriceLineCandle) {
    candleSeriesApi.removePriceLine(avgPriceLineCandle);
    avgPriceLineCandle = null;
  }
  const px = Number(myAvgCost || 0);
  if (!myPos || !Number.isFinite(px) || px <= 0) {
    return;
  }
  const color = myPos > 0 ? '#2ecc71' : '#ff5c5c';
  const options = {
    price: roundPrice(px),
    color,
    lineStyle: LightweightCharts.LineStyle.Dashed,
    lineWidth: 1,
    axisLabelVisible: true,
    title: 'Avg',
  };
  avgPriceLineCandle = candleSeriesApi.createPriceLine(options);
}

function clearSeries(){
  prices = [];
  tick = 0;
  markers.length = 0;
  lastTradedPrice = null;
  resetCandles();
  candlePlotData = [];
  lastPointTime = null;
  if (candleSeriesApi) candleSeriesApi.setData(candlePlotData);
  syncMarkers();
}

function prepareNewRound(initialPrice){
  const px = Number.isFinite(+initialPrice) ? +initialPrice : Number(prices.at(-1) ?? 100);
  clearSeries();
  prices.push(px);
  seedInitialCandle(px);
  lastTradedPrice = px;
  lastPointTime = Math.floor(Date.now() / 1000);
  ensureChart();
  syncCandleSeriesData({ shouldScroll: true });
  myAvgCost = 0;
  myPos = 0;
  if (priceLbl) priceLbl.textContent = Number(px).toFixed(2);
  if (posLbl) posLbl.textContent = '0';
  if (pnlLbl) pnlLbl.textContent = '0.00';
  if (avgLbl) avgLbl.textContent = '—';
  updateAveragePriceLine();
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
  ensureChart();
  resizeChart();
}

window.addEventListener('resize', () => {
  resizeChart();
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
  const volumes = [...asks, ...bids].map((lvl) => Math.max(0, Number(lvl?.size || 0)));
  const maxVol = Math.max(1, ...volumes);
  const prevLevels = lastBookLevels;
  const nextLevels = new Map();
  const seenPrices = new Set();
  const fragment = document.createDocumentFragment();
  const highlightKey = Number.isFinite(lastTradedPrice) ? Number(lastTradedPrice).toFixed(2) : null;
  let focusRow = null;

  const buildCell = (sideClass, { label, fill, manual, placeholder }) => {
    const span = document.createElement('span');
    span.className = `cell ${sideClass}`;
    const value = document.createElement('span');
    value.className = 'value';
    const text = (label ?? '').toString();
    if (!text || placeholder) {
      span.classList.add('placeholder');
      value.textContent = text || '—';
    } else {
      value.textContent = text;
    }
    span.appendChild(value);
    const fillValue = Number.isFinite(fill) ? Math.max(0, Math.min(100, Number(fill))) : 0;
    span.style.setProperty('--fill', fillValue.toFixed(1));
    if (!placeholder && Number.isFinite(manual) && manual > 0.01) {
      const chip = document.createElement('span');
      chip.className = 'manual-chip';
      chip.textContent = formatVolume(manual);
      span.appendChild(chip);
    }
    return span;
  };

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

    const sellSpan = side === 'ask'
      ? buildCell('sell', { label: formatBookVolume(volume), fill: width, manual })
      : buildCell('sell', { label: '—', fill: 0, manual: 0, placeholder: true });
    const buySpan = side === 'bid'
      ? buildCell('buy', { label: formatBookVolume(volume), fill: width, manual })
      : buildCell('buy', { label: '—', fill: 0, manual: 0, placeholder: true });

    const priceSpan = document.createElement('span');
    priceSpan.className = 'price';

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
    const sellSpan = buildCell('sell', { label: '—', fill: 0, placeholder: true });
    const priceSpan = document.createElement('span');
    priceSpan.className = 'price';
    const strong = document.createElement('strong');
    strong.textContent = highlightKey;
    priceSpan.appendChild(strong);
    const buySpan = buildCell('buy', { label: '—', fill: 0, placeholder: true });
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
      const clientHeight = bookBody.clientHeight || 0;
      const padBase = Math.max(36, Math.min(160, Math.floor(clientHeight * 0.28)));
      bookBody.style.setProperty('--book-pad-top', `${padBase}px`);
      bookBody.style.setProperty('--book-pad-bottom', `${padBase}px`);
      const current = focusRow || bookBody.querySelector('.orderbook-row.current') || bookBody.querySelector('.orderbook-row.best');
      if (current && typeof current.scrollIntoView === 'function') {
        current.scrollIntoView({ block: 'center' });
      } else {
        const midpoint = Math.max(0, (bookBody.scrollHeight - clientHeight) / 2);
        bookBody.scrollTop = midpoint;
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
      }
    } else {
      joinBtn.disabled=false; joinBtn.textContent='Join';
      joinMsg.textContent='Join failed. Try again.';
    }
  });
};

socket.on('playerList', (rows = [])=>{
  const roster = Array.isArray(rows)
    ? rows.map((entry) => ({
        name: entry?.name || 'Player',
        isBot: Boolean(entry?.isBot),
      }))
    : [];
  if (rosterUl) {
    rosterUl.innerHTML = '';
    roster.forEach((r)=>{
      const li = document.createElement('li');
      li.textContent = r.isBot ? `${r.name} 🤖` : r.name;
      rosterUl.appendChild(li);
    });
  }
});

socket.on('priceMode', (mode)=>{ updateModeBadges(mode); });

socket.on('orderBook', (book)=>{ renderOrderBook(book); });

socket.on('gameStarted', ({ fairValue, productName, paused, price })=>{
  if (!myJoined) return;
  productLbl.textContent = productName || 'Demo Asset';
  prepareNewRound(price ?? fairValue ?? 100);
  if (paused) setTradingEnabled(false); else setTradingEnabled(true);
  goGame();
  ensureChart();
  resizeChart();
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
  ensureChart();
  syncCandleSeriesData({ shouldScroll: true });
  updateAveragePriceLine();
  resizeChart();
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
  ensureChart();
  nextPointTime(timestamp);
  let candleUpdate = { changed: false, newBucket: false };
  if (Number.isFinite(numeric)) {
    prices.push(numeric);
    if(prices.length>MAX_POINTS) prices.shift();
    lastTradedPrice = numeric;
    if (priceLbl) priceLbl.textContent = numeric.toFixed(2);
    candleUpdate = updateCandleSeries(numeric, tick, timestamp) || candleUpdate;
  } else if (prices.length) {
    lastTradedPrice = Number(prices.at(-1));
    if (priceLbl && Number.isFinite(lastTradedPrice)) priceLbl.textContent = lastTradedPrice.toFixed(2);
    if (Number.isFinite(lastTradedPrice)) {
      const fallback = updateCandleSeries(lastTradedPrice, tick, timestamp);
      if (fallback) candleUpdate = fallback;
    }
  }
  if (candleUpdate && candleUpdate.changed) {
    syncCandleSeriesData({ shouldScroll: Boolean(candleUpdate.newBucket) });
  }
  if (priceMode) updateModeBadges(priceMode);
  if (lastBookSnapshot) renderOrderBook(lastBookSnapshot);
  syncMarkers();
});

socket.on('you', ({ position, pnl, avgCost })=>{
  myPos = Number(position || 0);
  myAvgCost = Number(avgCost || 0);
  posLbl.textContent = formatExposure(myPos);
  pnlLbl.textContent = Number(pnl || 0).toFixed(2);
  if (avgLbl) {
    avgLbl.textContent = myAvgCost ? Number(myAvgCost).toFixed(2) : '—';
  }
  updateAveragePriceLine();
});

socket.on('tradeMarker', ({ side, px, qty })=>{
  if (!myJoined) return;
  const s = (side==='BUY') ? +1 : -1;
  const time = lastPointTime ?? Math.floor(Date.now()/1000);
  markers.push({ time, price: roundPrice(px), side: s, qty: qty || 1 });
  if (markers.length > 160) markers.shift();
  syncMarkers();
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
    const payload = { text };
    socket.emit('chatMessage', payload, (ack) => {
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

document.addEventListener('fullscreenchange', () => {
  syncFullscreenButtons();
});

document.addEventListener('fullscreenerror', () => {
  syncFullscreenButtons();
});

/* init */
goLobby();
ensureChart();
resizeChart();
updateModeBadges('news');
renderOrderBook(null);
renderOrders([]);
renderChat();
renderChatTargets();
updateTradeStatus('');
syncFullscreenButtons();
syncBookScrollToggle();
