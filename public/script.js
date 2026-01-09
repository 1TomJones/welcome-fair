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
const lastNewsHeadline = document.getElementById('lastNewsHeadline');
const priceLbl       = document.getElementById('priceLbl');
const posLbl         = document.getElementById('posLbl');
const pnlLbl         = document.getElementById('pnlLbl');
const avgLbl         = document.getElementById('avgLbl');
const chartModeBadge = document.getElementById('chartModeBadge');
const connectionBadge= document.getElementById('connectionBadge');
const phaseBadge     = document.getElementById('phaseBadge');
const pauseBadge     = document.getElementById('pauseBadge');
const bookBody       = document.getElementById('bookBody');
const darkBookBody   = document.getElementById('darkBookBody');
const icebergBookBody = document.getElementById('icebergBookBody');
const bookSpreadLbl  = document.getElementById('bookSpread');
const bookModeBadge  = document.getElementById('bookModeBadge');
const bookScrollToggle = document.getElementById('bookScrollToggle');
const bookTabs       = Array.from(document.querySelectorAll('.book-tab'));
const joinFullscreenBtn = document.getElementById('joinFullscreenBtn');
const waitFullscreenBtn = document.getElementById('waitFullscreenBtn');
const gameFullscreenBtn = document.getElementById('gameFullscreenBtn');
const fullscreenButtons = [joinFullscreenBtn, waitFullscreenBtn, gameFullscreenBtn].filter(Boolean);
const introModal     = document.getElementById('introModal');
const introOpenBtn   = document.getElementById('introOpenBtn');
const introCloseBtn  = document.getElementById('introCloseBtn');
const introDismissBtn= document.getElementById('introDismissBtn');

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
const aggressivenessRow = document.getElementById('aggressivenessRow');
const aggressivenessInput = document.getElementById('aggressivenessInput');
const cancelAllBtn   = document.getElementById('cancelAllBtn');
const closeAllBtn    = document.getElementById('closeAllBtn');
const closeAllModal  = document.getElementById('closeAllModal');
const closeAllConfirmBtn = document.getElementById('closeAllConfirmBtn');
const closeAllDismissBtn = document.getElementById('closeAllDismissBtn');
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
let lastDarkSnapshot = null;
let lastIcebergSnapshot = null;
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
let bookTickSize = 0.25;
let currentBookView = 'dom';

/* ui helpers */
function show(node){ if(node) node.classList.remove('hidden'); }
function hide(node){ if(node) node.classList.add('hidden'); }
function clamp(value, min, max){ return Math.max(min, Math.min(max, value)); }
function lerp(start, end, t){ return start + (end - start) * t; }

function algoSettingsFromAggressiveness(qty, aggressiveness){
  const safeAgg = clamp(Number.isFinite(aggressiveness) ? aggressiveness : 50, 0, 100);
  const normalized = safeAgg / 100;
  const passiveSlicePct = lerp(0.1, 0.03, normalized);
  const passiveSliceQty = Math.max(1, Math.round(qty * passiveSlicePct));
  const burstEveryTicks = Math.max(1, Math.round(lerp(8, 1, normalized)));
  const capPerBurst = Math.max(1, Math.round(qty * lerp(0.05, 0.4, normalized)));
  const participationRate = Number(lerp(0, 0.9, normalized).toFixed(2));

  return {
    aggressiveness: safeAgg,
    passiveSliceQty,
    burstEveryTicks,
    capPerBurst,
    participationRate,
  };
}

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
      priceFormatter: (price) => formatPrice(price),
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

function tickDecimals(value){
  if (!Number.isFinite(value)) return 0;
  const text = value.toString();
  if (text.includes('e-')) {
    const [, exp] = text.split('e-');
    return Math.max(0, Number(exp) || 0);
  }
  const parts = text.split('.');
  return parts[1] ? parts[1].length : 0;
}

function getTickSize(){
  return Number.isFinite(bookTickSize) && bookTickSize > 0 ? bookTickSize : 0.25;
}

function snapPriceValue(value){
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  const tickSize = getTickSize();
  const snapped = Math.round(num / tickSize) * tickSize;
  return Number(snapped.toFixed(tickDecimals(tickSize)));
}

function formatPrice(value){
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  const tickSize = getTickSize();
  return snapPriceValue(num).toFixed(tickDecimals(tickSize));
}

function roundPrice(value){
  return snapPriceValue(value);
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
  if (priceLbl) priceLbl.textContent = formatPrice(px);
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

function showIntroModal(){
  if (introModal) introModal.classList.remove('hidden');
}
function hideIntroModal(){
  if (introModal) introModal.classList.add('hidden');
}

function goLobby(){
  show(joinView); hide(waitView); hide(gameView);
  setTradingEnabled(false);
  setPhaseBadge('lobby');
  setPauseBadge(false);
}
function goWaiting(){
  hide(joinView); show(waitView); hide(gameView);
  setTradingEnabled(false);
  setPhaseBadge('lobby');
  setPauseBadge(false);
}
function goGame(){
  hide(joinView); hide(waitView); show(gameView);
  setTradingEnabled(true);
  ensureChart();
  resizeChart();
}

window.addEventListener('resize', () => {
  resizeChart();
  renderActiveBook();
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

function setPhaseBadge(phase){
  if (!phaseBadge) return;
  const label = phase === 'running' ? 'Running' : phase === 'lobby' ? 'Lobby' : 'Paused';
  phaseBadge.textContent = `Phase: ${label}`;
  phaseBadge.dataset.phase = phase;
}

function setPauseBadge(paused){
  if (!pauseBadge) return;
  pauseBadge.dataset.paused = paused ? 'true' : 'false';
  pauseBadge.textContent = paused ? 'Paused' : 'Live';
}

function setConnectionBadge(state){
  if (!connectionBadge) return;
  connectionBadge.dataset.state = state;
  switch (state) {
    case 'connected':
      connectionBadge.textContent = 'Connected';
      break;
    case 'error':
      connectionBadge.textContent = 'Connection Error';
      break;
    default:
      connectionBadge.textContent = 'Connecting…';
  }
}

function formatVolume(value){
  const num = Number(value || 0);
  if (!Number.isFinite(num)) return '0.00';
  if (Math.abs(num) >= 100) return num.toFixed(0);
  if (Math.abs(num) >= 10) return num.toFixed(1);
  return num.toFixed(2);
}

function formatElapsed(ms){
  const totalSeconds = Math.max(0, Math.floor((ms || 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
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

function renderDepthBook(book, { container, lastLevels, setLastLevels, isActive, emptyMessage, ownOrders, highlightPrice } = {}){
  if (!container) return;
  if (Number.isFinite(book?.tickSize)) {
    bookTickSize = book.tickSize;
    if (priceInput) priceInput.step = bookTickSize.toString();
    if (priceInput?.value && document.activeElement !== priceInput) {
      const snapped = snapPriceValue(priceInput.value);
      priceInput.value = formatPrice(snapped);
    }
  }
  if (!autoScrollBook || !isActive) {
    container.style.setProperty('--book-pad-top', '12px');
    container.style.setProperty('--book-pad-bottom', '12px');
  }
  if (!book || ((!Array.isArray(book.bids) || !book.bids.length) && (!Array.isArray(book.asks) || !book.asks.length))) {
    container.innerHTML = `<div class="book-empty muted">${emptyMessage || 'No resting liquidity'}</div>`;
    setLastLevels?.(new Map());
    if (isActive && bookSpreadLbl) bookSpreadLbl.textContent = 'Spread: —';
    if (autoScrollBook && isActive) {
      const pad = Math.max(32, Math.floor(container.clientHeight / 2));
      container.style.setProperty('--book-pad-top', `${pad}px`);
      container.style.setProperty('--book-pad-bottom', `${pad}px`);
    }
    return;
  }

  const ownLevels = new Set((ownOrders || []).map((order) => `${order.side}:${formatPrice(order.price)}`));
  const asks = Array.isArray(book.asks) ? book.asks.slice(0, MAX_BOOK_DEPTH) : [];
  const bids = Array.isArray(book.bids) ? book.bids.slice(0, MAX_BOOK_DEPTH) : [];
  const volumes = [...asks, ...bids].map((lvl) => Math.max(0, Number(lvl?.size || 0)));
  const maxVol = Math.max(1, ...volumes);
  const prevLevels = lastLevels ?? new Map();
  const nextLevels = new Map();
  const seenPrices = new Set();
  const fragment = document.createDocumentFragment();
  const highlightKey = highlightPrice && Number.isFinite(lastTradedPrice) ? formatPrice(lastTradedPrice) : null;
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
    const priceStr = formatPrice(priceNum);
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
    const best = snapPriceValue(level?.price) === snapPriceValue(book.bestAsk);
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
    const best = snapPriceValue(level?.price) === snapPriceValue(book.bestBid);
    appendRow('bid', level, best);
  }

  const previousScroll = autoScrollBook || !isActive ? null : container.scrollTop;
  container.innerHTML = '';
  container.appendChild(fragment);
  if (!autoScrollBook && isActive && previousScroll !== null) {
    container.scrollTop = previousScroll;
  }
  setLastLevels?.(nextLevels);

  if (isActive && bookSpreadLbl) {
    const spread = Number(book.spread);
    bookSpreadLbl.textContent = Number.isFinite(spread) && spread > 0
      ? `Spread: ${formatPrice(spread)}`
      : 'Spread: —';
  }

  if (autoScrollBook && isActive) {
    requestAnimationFrame(() => {
      const clientHeight = container.clientHeight || 0;
      const padBase = Math.max(36, Math.min(160, Math.floor(clientHeight * 0.28)));
      container.style.setProperty('--book-pad-top', `${padBase}px`);
      container.style.setProperty('--book-pad-bottom', `${padBase}px`);
      const current = focusRow || container.querySelector('.orderbook-row.current') || container.querySelector('.orderbook-row.best');
      if (current && typeof current.scrollIntoView === 'function') {
        current.scrollIntoView({ block: 'center' });
      } else {
        const midpoint = Math.max(0, (container.scrollHeight - clientHeight) / 2);
        container.scrollTop = midpoint;
      }
    });
  } else {
    container.style.setProperty('--book-pad-top', '12px');
    container.style.setProperty('--book-pad-bottom', '12px');
  }
}

function renderOrderBook(book){
  lastBookSnapshot = book;
  renderDepthBook(book, {
    container: bookBody,
    lastLevels: lastBookLevels,
    setLastLevels: (levels) => { lastBookLevels = levels; },
    isActive: currentBookView === 'dom',
    emptyMessage: 'No resting liquidity',
    ownOrders: myOrders.filter((order) => order.type !== 'dark'),
    highlightPrice: true,
  });
}

function renderDarkBook(book){
  lastDarkSnapshot = book;
  if (!darkBookBody) return;
  const orders = Array.isArray(book?.orders) ? book.orders : [];
  darkBookBody.innerHTML = '';
  if (!orders.length) {
    const empty = document.createElement('div');
    empty.className = 'dark-ticket-empty';
    empty.textContent = 'No dark pool orders';
    darkBookBody.appendChild(empty);
    return;
  }
  const list = document.createElement('div');
  list.className = 'dark-ticket-list';
  orders.forEach((order) => {
    const sideLabel = order.side === 'BUY' ? 'Buy' : 'Sell';
    const sideClass = order.side === 'BUY' ? 'buy' : 'sell';
    const isOwn = order.ownerId && order.ownerId === myId;
    const priceLabel = Number.isFinite(order.price) ? formatPrice(order.price) : '—';
    const qtyLabel = formatVolume(order.remaining);

    const ticket = document.createElement('div');
    ticket.className = `dark-ticket ${sideClass}${isOwn ? ' own' : ''}`;
    ticket.dataset.orderId = order.id;
    ticket.dataset.side = order.side;
    ticket.dataset.price = order.price;
    ticket.dataset.remaining = order.remaining;

    const header = document.createElement('div');
    header.className = 'dark-ticket-header';
    const side = document.createElement('span');
    side.className = order.side === 'BUY' ? 'side-buy' : 'side-sell';
    side.textContent = isOwn ? `Your ${sideLabel}` : sideLabel;
    const price = document.createElement('span');
    price.textContent = `@ ${priceLabel}`;
    header.append(side, price);

    const body = document.createElement('div');
    body.className = 'dark-ticket-body';
    const volume = document.createElement('span');
    volume.textContent = `Volume ${qtyLabel}`;
    const idLabel = document.createElement('span');
    idLabel.textContent = `#${order.id}`;
    body.append(volume, idLabel);

    const actions = document.createElement('div');
    actions.className = 'dark-ticket-actions';
    if (isOwn) {
      actions.innerHTML = `
        <label>
          Price
          <input type="number" step="0.25" min="0" value="${Number.isFinite(order.price) ? order.price : ''}" data-dark-edit="price" />
        </label>
        <label>
          Volume
          <input type="number" step="1" min="1" value="${order.remaining}" data-dark-edit="volume" />
        </label>
        <button type="button" class="ticket-btn full-width" data-dark-update>Update Order</button>
        <button type="button" class="ticket-btn secondary full-width" data-dark-cancel>Close Order</button>
      `;
    } else {
      const maxQty = Math.max(1, Math.round(order.remaining));
      actions.innerHTML = `
        <label>
          Take Volume
          <input type="number" step="1" min="1" max="${maxQty}" value="${maxQty}" data-dark-take-qty />
        </label>
        <button type="button" class="ticket-btn" data-dark-take>Take</button>
      `;
    }

    ticket.append(header, body, actions);
    list.appendChild(ticket);
  });
  darkBookBody.appendChild(list);
}

function renderIcebergBook(book){
  lastIcebergSnapshot = book;
  if (!icebergBookBody) return;
  const orders = Array.isArray(book?.orders) ? book.orders : [];
  icebergBookBody.innerHTML = '';
  if (!orders.length) {
    const empty = document.createElement('div');
    empty.className = 'dark-ticket-empty';
    empty.textContent = 'No iceberg orders';
    icebergBookBody.appendChild(empty);
    return;
  }
  const list = document.createElement('div');
  list.className = 'iceberg-ticket-list';
  orders.forEach((order) => {
    const sideLabel = order.side === 'BUY' ? 'Buy' : 'Sell';
    const sideClass = order.side === 'BUY' ? 'buy' : 'sell';
    const isOwn = order.ownerId && order.ownerId === myId;
    const priceLabel = Number.isFinite(order.price) ? formatPrice(order.price) : '—';
    const qtyLabel = formatVolume(order.remaining);

    const ticket = document.createElement('div');
    ticket.className = `iceberg-ticket ${sideClass}${isOwn ? ' own' : ''}`;
    ticket.dataset.orderId = order.id;
    ticket.dataset.side = order.side;
    ticket.dataset.price = order.price;
    ticket.dataset.remaining = order.remaining;

    const header = document.createElement('div');
    header.className = 'dark-ticket-header';
    const side = document.createElement('span');
    side.className = order.side === 'BUY' ? 'side-buy' : 'side-sell';
    side.textContent = isOwn ? `Your ${sideLabel}` : sideLabel;
    const price = document.createElement('span');
    price.textContent = `@ ${priceLabel}`;
    header.append(side, price);

    const body = document.createElement('div');
    body.className = 'dark-ticket-body';
    const volume = document.createElement('span');
    volume.textContent = `Volume ${qtyLabel}`;
    const visible = document.createElement('span');
    const displayQty = Number(order.displayQty ?? 0);
    visible.textContent = displayQty > 0 ? `Visible ${formatVolume(displayQty)}` : '';
    body.append(volume, visible);

    const actions = document.createElement('div');
    actions.className = 'dark-ticket-actions';
    if (isOwn) {
      actions.innerHTML = `
        <label>
          Price
          <input type="number" step="0.25" min="0" value="${Number.isFinite(order.price) ? order.price : ''}" data-iceberg-edit="price" />
        </label>
        <label>
          Volume
          <input type="number" step="1" min="1" value="${order.remaining}" data-iceberg-edit="volume" />
        </label>
        <button type="button" class="ticket-btn full-width" data-iceberg-update>Update Order</button>
        <button type="button" class="ticket-btn secondary full-width" data-iceberg-cancel>Close Order</button>
      `;
    } else {
      const maxQty = Math.max(1, Math.round(order.remaining));
      actions.innerHTML = `
        <label>
          Take Volume
          <input type="number" step="1" min="1" max="${maxQty}" value="${maxQty}" data-iceberg-take-qty />
        </label>
        <button type="button" class="ticket-btn" data-iceberg-take>Take</button>
      `;
    }

    ticket.append(header, body, actions);
    list.appendChild(ticket);
  });
  icebergBookBody.appendChild(list);
  });
  darkBookBody.appendChild(list);
}

function renderActiveBook(){
  if (currentBookView === 'dark') {
    renderDarkBook(lastDarkSnapshot);
  } else if (currentBookView === 'iceberg') {
    renderIcebergBook(lastIcebergSnapshot);
  } else {
    renderOrderBook(lastBookSnapshot);
  }
}

function setBookView(view){
  const next = view === 'dark' ? 'dark' : view === 'iceberg' ? 'iceberg' : 'dom';
  currentBookView = next;
  bookTabs.forEach((tab) => {
    const active = tab.dataset.view === next;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
  if (bookBody) bookBody.classList.toggle('hidden', next !== 'dom');
  if (darkBookBody) darkBookBody.classList.toggle('hidden', next !== 'dark');
  if (icebergBookBody) icebergBookBody.classList.toggle('hidden', next !== 'iceberg');
  renderActiveBook();
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
    const isIceberg = order.type === 'iceberg';
    const isAlgo = order.type === 'algo';
    const price = Number.isFinite(order.price) ? formatPrice(order.price) : '—';
    const venue = isIceberg ? 'Iceberg' : isAlgo ? 'Algo' : order.type === 'dark' ? 'Dark' : 'Lit';
    const displayQty = isIceberg ? formatVolume(order.displayQty || 0) : null;
    const executed = isIceberg ? formatVolume(order.executed || 0) : null;
    const avgFill = isIceberg && Number.isFinite(order.avgFillPrice) ? formatPrice(order.avgFillPrice) : '—';
    const age = isIceberg && order.createdAt ? formatElapsed(Date.now() - order.createdAt) : null;
    const algoExecuted = isAlgo ? formatVolume(order.executed || 0) : null;
    const algoPassive = isAlgo ? formatVolume(order.executedPassive || 0) : null;
    const algoAggressive = isAlgo ? formatVolume(order.executedAggressive || 0) : null;
    const algoAvg = isAlgo && Number.isFinite(order.avgFillPrice) ? formatPrice(order.avgFillPrice) : '—';
    const algoAge = isAlgo && order.createdAt ? formatElapsed(Date.now() - order.createdAt) : null;
    const meta = isIceberg
      ? `Exec ${executed} · Rem ${qty} · Avg ${avgFill} · ${age}`
      : isAlgo
        ? `Exec ${algoExecuted} · Rem ${qty} · Pass ${algoPassive} · Agg ${algoAggressive} · Avg ${algoAvg} · ${algoAge}`
        : `Remaining ${qty}`;
    return `
      <li class="active-order">
        <div class="order-info">
          <span class="${sideClass}">${venue} ${sideLabel} ${isIceberg ? `${displayQty} shown` : qty}</span>
          <span class="order-meta">${meta}</span>
        </div>
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
  if (orderType === 'limit' || orderType === 'dark' || orderType === 'iceberg') {
    let px = Number(priceInput?.value || 0);
    if (!Number.isFinite(px) || px <= 0) {
      px = inferredLimitPrice(side);
      if (Number.isFinite(px)) {
        priceInput.value = formatPrice(px);
      }
    }
    if (!Number.isFinite(px) || px <= 0) {
      updateTradeStatus('Set a valid limit price.', 'error');
      return;
    }
    px = snapPriceValue(px);
    if (priceInput) priceInput.value = formatPrice(px);
    payload.price = px;
  }
  if (orderType === 'algo') {
    const aggressiveness = Number(aggressivenessInput?.value ?? 50);
    const settings = algoSettingsFromAggressiveness(qty, aggressiveness);
    payload.passiveSliceQty = settings.passiveSliceQty;
    payload.burstEveryTicks = settings.burstEveryTicks;
    payload.capPerBurst = settings.capPerBurst;
    payload.participationRate = settings.participationRate;
    if (aggressivenessInput) aggressivenessInput.value = String(settings.aggressiveness);
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
        const px = formatPrice(resp.price || 0);
        updateTradeStatus(`Filled ${formatVolume(resp.filled)} @ ${px}`, 'success');
      } else if (resp.queued) {
        updateTradeStatus('Order queued.', 'info');
      } else {
        updateTradeStatus('Order completed.', 'success');
      }
      quantityInput.value = '1';
    } else {
      if (resp.filled > 0) {
        const px = formatPrice(resp.price || 0);
        updateTradeStatus(`Filled ${formatVolume(resp.filled)} @ ${px}`, 'success');
      } else {
        const restingLabel = resp.type === 'dark'
          ? 'Dark order resting.'
          : resp.type === 'iceberg'
            ? 'Iceberg resting.'
            : resp.type === 'algo'
              ? 'Algo order live.'
              : 'Order resting.';
        updateTradeStatus(restingLabel, 'info');
      }
      if (resp.resting?.price) {
        priceInput.value = formatPrice(resp.resting.price);
      }
    }
  });
}

function submitDarkOrder(side, price, qty){
  if (!myJoined || lastPhase !== 'running') return;
  const numericQty = Number(qty || 0);
  if (!Number.isFinite(numericQty) || numericQty <= 0) {
    updateTradeStatus('Enter a positive quantity.', 'error');
    return;
  }
  const numericPrice = Number(price || 0);
  if (!Number.isFinite(numericPrice) || numericPrice <= 0) {
    updateTradeStatus('Set a valid dark pool price.', 'error');
    return;
  }
  const snapped = snapPriceValue(numericPrice);
  updateTradeStatus('Submitting…', 'info');
  throttleButtons();
  socket.emit('submitOrder', {
    side,
    quantity: numericQty,
    type: 'dark',
    price: snapped,
  }, (resp) => {
    if (!resp || !resp.ok) {
      updateTradeStatus(explainReason(resp?.reason), 'error');
      return;
    }
    if (resp.filled > 0) {
      updateTradeStatus(`Filled ${formatVolume(resp.filled)} @ ${formatPrice(resp.price || snapped)}`, 'success');
    } else {
      updateTradeStatus(resp.resting ? 'Dark order resting.' : 'Order completed.', 'info');
    }
  });
}

function submitIcebergOrder(side, price, qty){
  if (!myJoined || lastPhase !== 'running') return;
  const numericQty = Number(qty || 0);
  if (!Number.isFinite(numericQty) || numericQty <= 0) {
    updateTradeStatus('Enter a positive quantity.', 'error');
    return;
  }
  const numericPrice = Number(price || 0);
  if (!Number.isFinite(numericPrice) || numericPrice <= 0) {
    updateTradeStatus('Set a valid iceberg price.', 'error');
    return;
  }
  const snapped = snapPriceValue(numericPrice);
  updateTradeStatus('Submitting…', 'info');
  throttleButtons();
  socket.emit('submitOrder', {
    side,
    quantity: numericQty,
    type: 'iceberg',
    price: snapped,
  }, (resp) => {
    if (!resp || !resp.ok) {
      updateTradeStatus(explainReason(resp?.reason), 'error');
      return;
    }
    if (resp.filled > 0) {
      updateTradeStatus(`Filled ${formatVolume(resp.filled)} @ ${formatPrice(resp.price || snapped)}`, 'success');
    } else {
      updateTradeStatus(resp.resting ? 'Iceberg resting.' : 'Order completed.', 'info');
    }
  });
}

function takeIcebergOrder(side, price, qty){
  if (!myJoined || lastPhase !== 'running') return;
  const numericQty = Number(qty || 0);
  if (!Number.isFinite(numericQty) || numericQty <= 0) {
    updateTradeStatus('Enter a positive quantity.', 'error');
    return;
  }
  const numericPrice = Number(price || 0);
  if (!Number.isFinite(numericPrice) || numericPrice <= 0) {
    updateTradeStatus('Set a valid price.', 'error');
    return;
  }
  const snapped = snapPriceValue(numericPrice);
  updateTradeStatus('Submitting…', 'info');
  throttleButtons();
  socket.emit('submitOrder', {
    side,
    quantity: numericQty,
    type: 'limit',
    price: snapped,
  }, (resp) => {
    if (!resp || !resp.ok) {
      updateTradeStatus(explainReason(resp?.reason), 'error');
      return;
    }
    if (resp.filled > 0) {
      updateTradeStatus(`Filled ${formatVolume(resp.filled)} @ ${formatPrice(resp.price || snapped)}`, 'success');
    } else {
      updateTradeStatus('Order resting.', 'info');
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

function cancelAllOrders(){
  socket.emit('cancelAll', (resp) => {
    if (!resp?.ok) {
      updateTradeStatus('Unable to cancel orders.', 'error');
      return;
    }
    const canceledCount = resp?.canceled?.length || 0;
    if (canceledCount) {
      updateTradeStatus(`Cancelled ${canceledCount} order(s).`, 'info');
      return;
    }
    updateTradeStatus('No orders to cancel.', 'error');
  });
}

function closeAllOrders(){
  socket.emit('closeAll', (resp) => {
    if (!resp?.ok) {
      updateTradeStatus('Unable to close out.', 'error');
      return;
    }
    const canceledCount = resp?.canceled?.length || 0;
    const flattenedQty = Math.abs(Number(resp?.flatten?.qty ?? 0));
    if (flattenedQty > 0) {
      updateTradeStatus(`Closed out ${formatVolume(flattenedQty)}.`, 'success');
      return;
    }
    if (resp?.flatten?.queued) {
      updateTradeStatus('Close-out queued.', 'info');
      return;
    }
    if (canceledCount) {
      updateTradeStatus(`Cancelled ${canceledCount} order(s).`, 'info');
      return;
    }
    updateTradeStatus('Nothing to close out.', 'error');
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
socket.on('connect', ()=>{
  myId = socket.id;
  setConnectionBadge('connected');
});

socket.on('connect_error', ()=>{ setConnectionBadge('error'); });
socket.on('disconnect', ()=>{ setConnectionBadge('error'); });

socket.on('phase', (phase)=>{
  lastPhase = phase;
  setPhaseBadge(phase);
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
        setPhaseBadge('lobby');
        setPauseBadge(false);
      } else {
        productLbl.textContent = ack.productName || 'Demo Asset';
        prepareNewRound(ack.price ?? ack.fairValue ?? 100);
        setPhaseBadge('running');
        setPauseBadge(Boolean(ack.paused));
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
socket.on('icebergBook', (book)=>{ renderIcebergBook(book); });

socket.on('gameStarted', ({ fairValue, productName, paused, price })=>{
  if (!myJoined) return;
  productLbl.textContent = productName || 'Demo Asset';
  prepareNewRound(price ?? fairValue ?? 100);
  setPhaseBadge('running');
  setPauseBadge(Boolean(paused));
  if (paused) setTradingEnabled(false); else setTradingEnabled(true);
  goGame();
  ensureChart();
  resizeChart();
  renderOrderBook(null);
  renderIcebergBook(null);
  renderOrders([]);
});

socket.on('gameReset', ()=>{
  myJoined = false;
  clearSeries();
  myAvgCost=0; myPos=0;
  setPhaseBadge('lobby');
  setPauseBadge(false);
  if (lastNewsHeadline) lastNewsHeadline.textContent = 'Waiting for news…';
  nameInput.value = '';
  joinBtn.disabled = false; joinBtn.textContent = 'Join';
  if (priceLbl) priceLbl.textContent = '—';
  if (posLbl) posLbl.textContent = '0';
  if (pnlLbl) pnlLbl.textContent = '0.00';
  if (avgLbl) avgLbl.textContent = '—';
  renderOrderBook(null);
  renderIcebergBook(null);
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
  setPauseBadge(Boolean(isPaused));
});

socket.on('news', ({ text, delta })=>{
  if (!newsText || !newsBar) return;
  newsText.textContent = text || '';
  if (lastNewsHeadline) lastNewsHeadline.textContent = text || '—';
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
    if (priceLbl) priceLbl.textContent = formatPrice(numeric);
    candleUpdate = updateCandleSeries(numeric, tick, timestamp) || candleUpdate;
  } else if (prices.length) {
    lastTradedPrice = Number(prices.at(-1));
    if (priceLbl && Number.isFinite(lastTradedPrice)) priceLbl.textContent = formatPrice(lastTradedPrice);
    if (Number.isFinite(lastTradedPrice)) {
      const fallback = updateCandleSeries(lastTradedPrice, tick, timestamp);
      if (fallback) candleUpdate = fallback;
    }
  }
  if (candleUpdate && candleUpdate.changed) {
    syncCandleSeriesData({ shouldScroll: Boolean(candleUpdate.newBucket) });
  }
  if (priceMode) updateModeBadges(priceMode);
  if (lastBookSnapshot || lastDarkSnapshot || lastIcebergSnapshot) renderActiveBook();
  syncMarkers();
});

socket.on('you', ({ position, pnl, avgCost })=>{
  myPos = Number(position || 0);
  myAvgCost = Number(avgCost || 0);
  posLbl.textContent = formatExposure(myPos);
  pnlLbl.textContent = Number(pnl || 0).toFixed(2);
  if (avgLbl) {
    avgLbl.textContent = myAvgCost ? formatPrice(myAvgCost) : '—';
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
  renderActiveBook();
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
      orderType = radio.value;
      if (orderType === 'limit' || orderType === 'dark' || orderType === 'iceberg') {
        limitPriceRow?.classList.remove('hidden');
      } else {
        limitPriceRow?.classList.add('hidden');
        if (tradeStatus) tradeStatus.dataset.tone = 'info';
      }
      if (orderType === 'algo') {
        aggressivenessRow?.classList.remove('hidden');
      } else {
        aggressivenessRow?.classList.add('hidden');
      }
    }
  });
});

bookTabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    const view = tab.dataset.view;
    if (view) setBookView(view);
  });
});

if (buyBtn) buyBtn.addEventListener('click', () => submitOrder('BUY'));
if (sellBtn) sellBtn.addEventListener('click', () => submitOrder('SELL'));
if (cancelAllBtn) cancelAllBtn.addEventListener('click', () => cancelAllOrders());
if (closeAllBtn) closeAllBtn.addEventListener('click', () => show(closeAllModal));
if (closeAllDismissBtn) closeAllDismissBtn.addEventListener('click', () => hide(closeAllModal));
if (closeAllConfirmBtn) closeAllConfirmBtn.addEventListener('click', () => {
  hide(closeAllModal);
  closeAllOrders();
});

if (openOrdersList) {
  openOrdersList.addEventListener('click', (ev) => {
    const target = ev.target.closest('[data-cancel]');
    if (!target) return;
    const id = target.getAttribute('data-cancel');
    if (id) cancelOrders([id]);
  });
}

if (darkBookBody) {
  darkBookBody.addEventListener('click', (ev) => {
    const takeBtn = ev.target.closest('[data-dark-take]');
    const cancelBtn = ev.target.closest('[data-dark-cancel]');
    const updateBtn = ev.target.closest('[data-dark-update]');
    const ticket = ev.target.closest('.dark-ticket');
    if (!ticket) return;
    const orderId = ticket.dataset.orderId;
    const side = ticket.dataset.side;
    const price = Number(ticket.dataset.price || 0);
    if (takeBtn) {
      const qtyInput = ticket.querySelector('input[data-dark-take-qty]');
      const qty = Number(qtyInput?.value || 0);
      const takeSide = side === 'BUY' ? 'SELL' : 'BUY';
      submitDarkOrder(takeSide, price, qty);
      return;
    }
    if (cancelBtn && orderId) {
      cancelOrders([orderId]);
      return;
    }
    if (updateBtn && orderId) {
      const priceInputEl = ticket.querySelector('input[data-dark-edit="price"]');
      const volumeInputEl = ticket.querySelector('input[data-dark-edit="volume"]');
      const nextPrice = Number(priceInputEl?.value || 0);
      const nextVolume = Number(volumeInputEl?.value || 0);
      if (!Number.isFinite(nextPrice) || nextPrice <= 0 || !Number.isFinite(nextVolume) || nextVolume <= 0) {
        updateTradeStatus('Set a valid price and volume.', 'error');
        return;
      }
      socket.emit('cancelOrders', [orderId], (resp) => {
        if (!resp?.canceled?.length) {
          updateTradeStatus('Unable to update order.', 'error');
          return;
        }
        submitDarkOrder(side, nextPrice, nextVolume);
      });
    }
  });
}

if (icebergBookBody) {
  icebergBookBody.addEventListener('click', (ev) => {
    const takeBtn = ev.target.closest('[data-iceberg-take]');
    const cancelBtn = ev.target.closest('[data-iceberg-cancel]');
    const updateBtn = ev.target.closest('[data-iceberg-update]');
    const ticket = ev.target.closest('.iceberg-ticket');
    if (!ticket) return;
    const orderId = ticket.dataset.orderId;
    const side = ticket.dataset.side;
    const price = Number(ticket.dataset.price || 0);
    if (takeBtn) {
      const qtyInput = ticket.querySelector('input[data-iceberg-take-qty]');
      const qty = Number(qtyInput?.value || 0);
      const takeSide = side === 'BUY' ? 'SELL' : 'BUY';
      takeIcebergOrder(takeSide, price, qty);
      return;
    }
    if (cancelBtn && orderId) {
      cancelOrders([orderId]);
      return;
    }
    if (updateBtn && orderId) {
      const priceInputEl = ticket.querySelector('input[data-iceberg-edit="price"]');
      const volumeInputEl = ticket.querySelector('input[data-iceberg-edit="volume"]');
      const nextPrice = Number(priceInputEl?.value || 0);
      const nextVolume = Number(volumeInputEl?.value || 0);
      if (!Number.isFinite(nextPrice) || nextPrice <= 0 || !Number.isFinite(nextVolume) || nextVolume <= 0) {
        updateTradeStatus('Set a valid price and volume.', 'error');
        return;
      }
      socket.emit('cancelOrders', [orderId], (resp) => {
        if (!resp?.canceled?.length) {
          updateTradeStatus('Unable to update order.', 'error');
          return;
        }
        submitIcebergOrder(side, nextPrice, nextVolume);
      });
    }
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
      renderActiveBook();
    }
  });
}

if (introOpenBtn) introOpenBtn.addEventListener('click', showIntroModal);
if (introCloseBtn) introCloseBtn.addEventListener('click', hideIntroModal);
if (introDismissBtn) introDismissBtn.addEventListener('click', hideIntroModal);
if (introModal) {
  introModal.addEventListener('click', (ev) => {
    if (ev.target === introModal) hideIntroModal();
  });
}
if (closeAllModal) {
  closeAllModal.addEventListener('click', (ev) => {
    if (ev.target === closeAllModal) hide(closeAllModal);
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
renderDarkBook(null);
renderIcebergBook(null);
renderOrders([]);
renderChat();
renderChatTargets();
updateTradeStatus('');
syncFullscreenButtons();
syncBookScrollToggle();
setConnectionBadge('connecting');
setPhaseBadge('lobby');
setPauseBadge(false);
if (lastNewsHeadline && newsText) lastNewsHeadline.textContent = newsText.textContent || 'Waiting for news…';
setBookView('dom');
setTimeout(showIntroModal, 300);
socket.on('darkBook', (book)=>{ renderDarkBook(book); });
