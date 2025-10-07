import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());

const pubDir = path.join(__dirname, "public");
app.use(express.static(pubDir));
app.get("/", (_,res)=>res.sendFile(path.join(pubDir,"index.html")));
app.get("/health", (_,res)=>res.type("text/plain").send("OK"));

const server = http.createServer(app);
const io = new Server(server,{ cors:{ origin:"*" }});

/* ===== Game State ===== */
const TICK_MS=250, NEWS_MS=5000;
const DEFAULT_ROUND=180;

const state={
  phase:"lobby",
  price:100, fair:100,
  tick:0, endsAt:0, paused:false,
  news:{text:"",sign:0},
  newsIndex:-1, lastNewsAt:0,
  newsItems:[
    {text:"Strong earnings expected",sign:+1,dfair:+0.8},
    {text:"Growth slows modestly",sign:-1,dfair:-0.6},
    {text:"Market consolidating",sign:0,dfair:0.0},
    {text:"Upgrades from analysts",sign:+1,dfair:+0.7},
    {text:"Profit taking continues",sign:-1,dfair:-0.5}
  ],
  players:{}
};

function recomputePnl(p,px){
  p.pnl=(p.realized||0)+((px-(p.avgCost||0))*(p.position||0));
}
function emitRoster(){
  const roster=Object.values(state.players).map(p=>({name:p.name,position:p.position||0,pnl:+(p.pnl||0).toFixed(2)}));
  io.emit("playerList",roster);
}
function snapshot() {
  const playersMin = {};
  for (const [id, p] of Object.entries(state.players)) {
    playersMin[id] = {
      name: p.name,
      position: p.position | 0,
      pnl: +(p.pnl || 0).toFixed(2),
      avgCost: +(p.avgCost || 0)
    };
  }
  return {
    phase: state.phase,
    tick: state.tick,
    timeLeft: Math.ceil(Math.max(0, (state.endsAt || 0) - Date.now()) / 1000),
    price: +state.price.toFixed(2),
    fair: +state.fair.toFixed(2),
    news: state.news,
    players: playersMin
  };
}

function broadcast(){io.emit("gameState",snapshot());}
function resetPlayers(){
  for(const p of Object.values(state.players))
    Object.assign(p,{position:0,avgCost:0,realized:0,pnl:0});
}
function step(){
  if(state.paused||state.phase!=="running")return;
  state.tick++;
  const toward=(state.fair-state.price)*0.08;
  const noise=(Math.random()-0.5)*0.8;
  state.price=Math.max(1,state.price+toward+noise);
  for(const p of Object.values(state.players))recomputePnl(p,state.price);

  const now=Date.now();
  if(now-state.lastNewsAt>=NEWS_MS){
    state.newsIndex=(state.newsIndex+1)%state.newsItems.length;
    const n=state.newsItems[state.newsIndex];
    state.fair+=n.dfair; state.news={text:n.text,sign:n.sign};
    state.lastNewsAt=now;
  }

  if(now>=state.endsAt){
    state.phase="ended"; clearInterval(state._timer); state._timer=null;
    state.news={text:"Round finished",sign:0};
  }
  broadcast();
}

/* ===== Socket Events ===== */
io.on("connection",socket=>{
  socket.data.joined=false;
  socket.data.lastTradeAt=0;

  socket.on("join",(name,ack)=>{
    const nm=(name||"Player").trim();
    if(!socket.data.joined){
      socket.data.joined=true;
      state.players[socket.id]={name:nm,position:0,avgCost:0,realized:0,pnl:0};
      recomputePnl(state.players[socket.id],state.price);
      emitRoster();
    }
    if(ack)ack({ok:true,phase:state.phase});
    if(state.phase!=="lobby")socket.emit("gameState",snapshot());
  });

  socket.on("trade",side=>{
    if(state.phase!=="running"||state.paused)return;
    const now=Date.now();
    if(now-socket.data.lastTradeAt<120)return;
    socket.data.lastTradeAt=now;
    const p=state.players[socket.id]; if(!p)return;
    const want=p.position+(side>0?1:-1);
    if(Math.abs(want)>5)return;
    const px=state.price;
    if(p.position===0){p.position=side>0?1:-1;p.avgCost=px;}
    else if(Math.sign(p.position)===Math.sign(side)){
      const newPos=p.position+(side>0?1:-1);
      p.avgCost=(p.avgCost*Math.abs(p.position)+px)/Math.abs(newPos);
      p.position=newPos;
    }else{
      p.realized+=(px-p.avgCost)*(p.position>0?1:-1);
      const after=p.position+(side>0?1:-1);
      if(after===0){p.position=0;p.avgCost=0;}else{p.position=after;p.avgCost=px;}
    }
    recomputePnl(p,state.price);
    broadcast();
  });

  socket.on("startGame",({seconds}= {})=>{
    state.roundSeconds=Math.max(30,Math.min(900,seconds||DEFAULT_ROUND));
    state.phase="running"; state.tick=0; state.paused=false;
    state.price=100; state.fair=100; state.newsIndex=-1;
    state.news={text:"Session started",sign:0};
    state.lastNewsAt=Date.now();
    state.endsAt=Date.now()+state.roundSeconds*1000;
    resetPlayers(); clearInterval(state._timer);
    state._timer=setInterval(step,TICK_MS);
    io.emit("phase",state.phase);
    broadcast();
  });

  socket.on("pauseGame",()=>{ state.paused=true; broadcast(); });
  socket.on("resumeGame",()=>{ state.paused=false; broadcast(); });
  socket.on("pushNews",({text,sign=0,dfair=0}={})=>{
    state.fair+=+dfair; state.news={text:text||"",sign:Math.sign(sign)}; broadcast();
  });

  socket.on("disconnect",()=>{ delete state.players[socket.id]; emitRoster(); });
});

/* ===== Start ===== */
const PORT=process.env.PORT||4000;
server.listen(PORT,"0.0.0.0",()=>console.log(`🚀 Server running on ${PORT}`));

