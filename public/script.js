const socket=io({transports:['websocket','polling'],upgrade:true});
const joinView=document.getElementById('joinView');
const waitView=document.getElementById('waitView');
const gameView=document.getElementById('gameView');
const nameInput=document.getElementById('nameInput');
const joinBtn=document.getElementById('joinBtn');
const joinMsg=document.getElementById('joinMsg');
const newsBar=document.getElementById('newsBar');
const priceLbl=document.getElementById('priceLbl');
const fairLbl=document.getElementById('fairLbl');
const posLbl=document.getElementById('posLbl');
const pnlLbl=document.getElementById('pnlLbl');
const buyBtn=document.getElementById('buyBtn');
const sellBtn=document.getElementById('sellBtn');
const cvs=document.getElementById('chart'); const ctx=cvs.getContext('2d');

let myId=null, prices=[],tick=0,markers=[];
const MAX_POINTS=600;
function show(e){e.classList.remove('hidden');} function hide(e){e.classList.add('hidden');}
function goLobby(){show(joinView);hide(waitView);hide(gameView);}
function goWait(){hide(joinView);show(waitView);hide(gameView);}
function goGame(){hide(joinView);hide(waitView);show(gameView);resizeCanvas();}
function resizeCanvas(){const bb=document.querySelector('.chart-wrap').getBoundingClientRect();
  const dpr=window.devicePixelRatio||1;const w=bb.width;const h=w*0.45;
  cvs.width=w*dpr;cvs.height=h*dpr;cvs.style.width=w+'px';cvs.style.height=h+'px';
  ctx.setTransform(dpr,0,0,dpr,0,0);}
window.addEventListener('resize',resizeCanvas);
function draw(){
  const w=cvs.width/(window.devicePixelRatio||1),h=cvs.height/(window.devicePixelRatio||1);
  ctx.clearRect(0,0,w,h);
  if(prices.length<2)return;
  const view=prices.slice(-MAX_POINTS);
  const lo=Math.min(...view),hi=Math.max(...view),range=hi-lo||1;
  const X=i=>i/(view.length-1)*w,Y=p=>h-((p-lo)/range)*h;
  ctx.strokeStyle="#6da8ff";ctx.lineWidth=2;ctx.beginPath();
  ctx.moveTo(0,Y(view[0]));for(let i=1;i<view.length;i++)ctx.lineTo(X(i),Y(view[i]));ctx.stroke();
  const startTick=tick-view.length+1;
  for(const m of markers){const i=m.tick-startTick;if(i<0||i>=view.length)continue;
    const x=X(i),y=Y(m.px);ctx.fillStyle=m.side>0?"#2ecc71":"#ff5c5c";
    ctx.beginPath();if(m.side>0){ctx.moveTo(x,y-10);ctx.lineTo(x-6,y);ctx.lineTo(x+6,y);}
    else{ctx.moveTo(x,y+10);ctx.lineTo(x-6,y);ctx.lineTo(x+6,y);}ctx.closePath();ctx.fill();}
}
function scheduleDraw(){if(scheduleDraw._p)return;scheduleDraw._p=true;requestAnimationFrame(()=>{scheduleDraw._p=false;draw();});}
socket.on('connect',()=>myId=socket.id);
socket.on('phase',phase=>{
  if(phase==='running')goGame();else if(phase==='lobby')goWait();else goLobby();
});
joinBtn.onclick=()=>{
  const nm=(nameInput.value||'').trim()||'Player';
  joinBtn.disabled=true;
  socket.emit('join',nm,res=>{
    if(res&&res.ok){goWait();joinMsg.textContent='Joined, waiting for host...';}
    else{joinBtn.disabled=false;joinMsg.textContent='Join failed';}
  });
};
socket.on('gameState',snap=>{
  if(snap.phase==='running'&&!gameView.classList.contains('shown')){goGame();prices=[];markers=[];}
  priceLbl.textContent=snap.price.toFixed(2);
  fairLbl.textContent=snap.fair.toFixed(2);
  if(snap.players&&snap.players[myId]){
    const me=snap.players[myId];
    posLbl.textContent=me.position;
    pnlLbl.textContent=(+me.pnl).toFixed(2);
  }
  if(snap.news&&snap.news.text){
    newsBar.textContent=snap.news.text;
    const s=snap.news.sign||0;
    newsBar.style.background=s>0?"#12361f":s<0?"#3a1920":"#121a2b";
  }
  tick=snap.tick;prices.push(snap.price);if(prices.length>MAX_POINTS)prices.shift();
  scheduleDraw();
  const canTrade=snap.phase==='running'&&!snap.paused;
  buyBtn.disabled=!canTrade;sellBtn.disabled=!canTrade;
});
buyBtn.onclick=()=>{socket.emit('trade',+1);markers.push({tick,px:prices.at(-1),side:+1});};
sellBtn.onclick=()=>{socket.emit('trade',-1);markers.push({tick,px:prices.at(-1),side:-1});};
resizeCanvas();
