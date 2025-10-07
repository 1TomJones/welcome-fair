/* global io */
const socket = io();

// DOM refs
const lobby = document.getElementById("lobby");
const nameInput = document.getElementById("nameInput");
const joinBtn = document.getElementById("joinBtn");

const game = document.getElementById("game");
const priceLbl = document.getElementById("priceLbl");
const fairLbl  = document.getElementById("fairLbl");
const posLbl   = document.getElementById("posLbl");
const pnlLbl   = document.getElementById("pnlLbl");
const newsBar  = document.getElementById("newsBar");
const newsText = document.getElementById("newsText");
const buyBtn   = document.getElementById("buyBtn");
const sellBtn  = document.getElementById("sellBtn");

// --- join flow
joinBtn.onclick = () => {
  const nm = (nameInput.value || "").trim() || "Player";
  joinBtn.disabled = true;
  joinBtn.textContent = "Joining...";
  socket.emit("join", nm);
  setTimeout(() => (joinBtn.disabled = false, joinBtn.textContent = "Join Game"), 1200);
};

// --- phase & state handling
let chartReady = false;
socket.on("phase", phase => {
  if (phase === "running") {
    lobby.classList.add("hidden");
    game.classList.remove("hidden");
    // the section just became visible; size the canvas now
    setTimeout(() => { resizeCanvas(); chartReady = true; }, 0);
  } else {
    chartReady = false;
    game.classList.add("hidden");
    lobby.classList.remove("hidden");
  }
});

// simple history + markers
const MAX_POINTS = 240;
const prices = [];
const markers = []; // {idx, px, side}

let myId = null;
socket.on("connect", () => { myId = socket.id; });

socket.on("gameState", (snap) => {
  // if admin started while we were on lobby, ensure chart gets a size
  if (snap.phase === "running" && !chartReady) {
    setTimeout(() => { resizeCanvas(); chartReady = true; }, 0);
  }

  // UI
  priceLbl.textContent = snap.price.toFixed(2);
  fairLbl.textContent  = snap.fair.toFixed(2);
  const me = snap.players[myId];
  if (me) {
    posLbl.textContent  = me.position;
    pnlLbl.textContent  = (me.pnl || 0).toFixed(2);
  }

  // news
  if (snap.news && newsText.textContent !== snap.news) {
    newsText.textContent = snap.news;
  }
  newsBar.classList.remove("hidden");

  // history + redraw
  pushPrice(snap.price);
  renderChart();
});

// trading
buyBtn.onclick = () => { socket.emit("trade", +1); addMarker(+1); };
sellBtn.onclick = () => { socket.emit("trade", -1); addMarker(-1); };

// ------------- tiny chart engine -------------
const cvs = document.getElementById("chart");
const ctx = cvs.getContext("2d");
const PAD = { l: 36, r: 10, t: 8, b: 20 };

function pushPrice(p) {
  prices.push(p);
  if (prices.length > MAX_POINTS) prices.shift();
  // rebase markers when we shift
  for (const m of markers) m.idx -= 1;
  while (markers.length && markers[0].idx < 0) markers.shift();
}
function addMarker(side){
  if (!prices.length) return;
  markers.push({ idx: prices.length - 1, px: prices[prices.length-1], side });
}

function renderChart(){
  const w = cvs.width, h = cvs.height;
  if (w === 0 || h === 0) return; // not sized yet
  ctx.clearRect(0,0,w,h);

  // baseline if not enough points
  if (prices.length < 2){
    ctx.fillStyle = "#1b2740";
    ctx.fillRect(PAD.l, h - PAD.b, w - PAD.l - PAD.r, 1);
    return;
  }

  const view = prices.slice(-MAX_POINTS);
  const lo = Math.min(...view), hi = Math.max(...view);
  const range = Math.max(1e-6, hi - lo);
  const X = (i) => PAD.l + (i/(view.length-1)) * (w - PAD.l - PAD.r);
  const Y = (p) => PAD.t + (1 - (p - lo)/range) * (h - PAD.t - PAD.b);

  // grid
  ctx.strokeStyle = "rgba(255,255,255,.06)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let g=0; g<=3; g++){
    const yy = PAD.t + g*(h-PAD.t-PAD.b)/3;
    ctx.moveTo(PAD.l, yy); ctx.lineTo(w-PAD.r, yy);
  }
  ctx.stroke();

  // price line
  ctx.strokeStyle = "#89a7ff";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(X(0), Y(view[0]));
  for (let i=1;i<view.length;i++) ctx.lineTo(X(i), Y(view[i]));
  ctx.stroke();

  // last price dot
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(X(view.length-1), Y(view[view.length-1]), 3, 0, Math.PI*2);
  ctx.fill();

  // markers
  for (const m of markers){
    const shift = view.length - prices.length;
    const x = X(m.idx - shift);
    const y = Y(m.px);
    drawArrow(x, y, m.side);
  }

  // y labels
  ctx.fillStyle = "#98a4be";
  ctx.font = "11px system-ui, sans-serif";
  ctx.textAlign = "right";
  ctx.fillText(hi.toFixed(2), PAD.l - 6, Y(hi)+4);
  ctx.fillText(lo.toFixed(2), PAD.l - 6, Y(lo)+4);
}

function drawArrow(x,y,side){
  const up = side > 0;
  ctx.fillStyle = up ? "#2ecc71" : "#ff5c5c";
  const w = 8, h = 12;
  ctx.beginPath();
  if (up){
    ctx.moveTo(x, y- h);
    ctx.lineTo(x - w/2, y);
    ctx.lineTo(x + w/2, y);
  }else{
    ctx.moveTo(x, y+ h);
    ctx.lineTo(x - w/2, y);
    ctx.lineTo(x + w/2, y);
  }
  ctx.closePath();
  ctx.fill();
}

// responsive sizing
function resizeCanvas(){
  const wrap = document.querySelector(".chart-wrap");
  let vw = 0;
  if (wrap){
    // use bounding box (clientWidth returns 0 when element was hidden)
    vw = wrap.getBoundingClientRect().width;
  }
  if (!vw || vw < 40) vw = Math.min(window.innerWidth - 24, 1024);
  const vh = Math.max(180, Math.round(vw * 0.45));

  const scale = Math.max(1, Math.floor(window.devicePixelRatio || 1));
  cvs.width  = vw * scale;
  cvs.height = vh * scale;
  cvs.style.width  = vw + "px";
  cvs.style.height = vh + "px";

  ctx.setTransform(scale,0,0,scale,0,0);
  renderChart();
}
window.addEventListener("resize", resizeCanvas);
window.addEventListener("orientationchange", () => setTimeout(resizeCanvas, 100));
resizeCanvas();
