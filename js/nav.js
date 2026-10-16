/* Navigation -- "Drive this route": turn-by-turn directions plus what only
   SolGuard knows, the glare ahead on THIS route at THIS time.

   One card at the top of the panel:
     next turn     "In 0.4 mi -- Turn right onto SR-94"   (OSRM's steps)
     glare ahead   "Glare in 2.1 mi -- 40 s -- sun from the left"
                   (projectRoute(): the same scoring as the planner, with
                   cloud and buildings, for the moment the car gets there)
   and spoken alerts (the browser's speech synthesis), so the driver doesn't
   have to look. The live Clear / Watch / Glare state stays where it was
   (Drive banner, Driver's view).

   Two modes, same code:
     live    GPS from js/drive.js; off the route for 8 s -> new route from here
     replay  "Watch this drive" feeds the virtual car; silent (a replay runs a
             whole drive in seconds, far too fast to speak)

   Phone browsers stop speaking when the screen is off or another app is in
   front, so SolGuard has to stay on screen. "Open in Google Maps" hands the
   same route to Google's app for anyone who prefers it. */

const NAV={
  active:false, mode:null, route:null, dest:null, cum:[], steps:[], glare:[],
  idx:0, s:0, total:0, muted:false, said:new Set(), offSince:0, rerouting:false,
  glareAt:0, layer:null, depart:null,
  offRouteM:50, offRouteSec:8, glareEveryMs:60000,

  init(){
    $("navEnd").onclick=()=>{ const m=this.mode; this.stop(); if(m==="replay") REPLAY.stop(); if(m==="live") DRIVE.end(); };
    $("navMute").onclick=()=>{ this.muted=!this.muted; if(this.muted) this.hush(); this.renderMute(); };
  },

  /* ---------- start / stop ---------- */
  async start(route,mode,opts){
    opts=opts||{};
    this.stop(true);
    this.active=true; this.mode=mode; this.depart=opts.depart||new Date();
    this.dest=opts.dest||route.coords[route.coords.length-1];
    this.muted=mode==="replay";
    $("navCard").style.display=""; this.renderMute();
    $("navNote").textContent=mode==="replay"?"Replay: directions and glare alerts as they'd appear on the drive. Voice plays on a real drive."
      :"Keep SolGuard on screen: phones stop speaking when it's in the background.";
    this.setRoute(route);
    if(mode==="live") this.say("start","Starting route."+(this.glare.length?" "+this.glareSummary():""));
    this.render();
    if(!route.steps){                                        // example trips are saved without directions
      $("navText").textContent="Getting directions...";
      await ensureSteps(route);
      if(this.route===route){ this.mapSteps(); this.render(); }
    }
  },
  stop(quiet){
    this.active=false; this.hush();
    if(this.layer){ APP.map.removeLayer(this.layer); this.layer=null; }
    $("navCard").style.display="none";
    this.route=null; this.mode=null;
  },
  setRoute(route){
    this.route=route; this.idx=0; this.s=0; this.said=new Set(); this.offSince=0;
    this.cum=[0];
    for(let i=1;i<route.coords.length;i++) this.cum.push(this.cum[i-1]+haversine(route.coords[i-1],route.coords[i]));
    this.total=this.cum[this.cum.length-1];
    $("navGmaps").href=gmapsUrl(route,this.dest);
    this.mapSteps();
    this.computeGlare(0,this.depart.getTime());
    this.drawLayer();
  },

  /* each step's position along the route (metres), matched in driving order */
  mapSteps(){
    const r=this.route, out=[]; let from=0;
    (r.steps||[]).forEach(st=>{
      let best=from, bd=1e9;
      for(let i=from;i<r.coords.length && i<from+4000;i++){
        const d=haversine(st.loc,r.coords[i]); if(d<bd){ bd=d; best=i; }
        if(bd<5 && d>200) break;
      }
      if(bd<120){ out.push(Object.assign({at:this.cum[best]},st)); from=best; }
    });
    this.steps=out;
  },

  /* Glare stretches ahead, scored for the moment the car will reach them:
     the planner's projectRoute() on the rest of the route, leaving from
     index i at time ms. Recomputed every minute on a live drive. */
  computeGlare(i,ms){
    const r=this.route;
    if(!r.durs||r.durs.length<2){ this.glare=[]; return; }
    const sub={coords:r.coords.slice(i), durs:r.durs.slice(i), distance:r.distance, duration:r.duration};
    const proj=projectRoute(sub,new Date(ms)), P=proj.pts, out=[];
    let along=this.cum[i], k=0;
    const pos=[along]; for(let j=1;j<P.length;j++){ along+=haversine(P[j-1].ll,P[j].ll); pos.push(along); }
    while(k<P.length){
      if(P[k].gtier!=="high"){ k++; continue; }
      let j=k; while(j+1<P.length && P[j+1].gtier==="high") j++;
      const mid=P[(k+j)>>1], off=signedOff(mid.hdg,mid.sunAz);
      out.push({s0:pos[k], s1:pos[j], sec:Math.max(1,(P[j].when-P[k].when)/1000),
                side:Math.abs(off)<=PLAN_CFG.aheadDeg?"ahead":(off<0?"from the left":"from the right"),
                harsh:Math.max(...P.slice(k,j+1).map(p=>p.score))>=0.35, ll:P.slice(k,j+1).map(p=>p.ll),
                low:Math.min(...P.slice(k,j+1).map(p=>p.sunEl))<LOW_SUN+1});      // a sun no visor reaches
      k=j+1;
    }
    this.glare=out; this.glareAt=Date.now();
    this.drawLayer();
  },

  /* the route on the map (live drive only; a replay draws its own) */
  drawLayer(){
    if(this.layer){ APP.map.removeLayer(this.layer); this.layer=null; }
    if(!this.active||this.mode!=="live"||!this.route) return;
    this.layer=L.layerGroup().addTo(APP.map);
    L.polyline(this.route.coords,{color:"#3b82f6",weight:7,opacity:.75}).addTo(this.layer);
    this.glare.forEach(g=>L.polyline(g.ll,{color:"#e63c3c",weight:8,opacity:.95}).addTo(this.layer));
  },

  /* ---------- every position update ---------- */
  tick(lat,lng,speed,nowMs){
    if(!this.active||!this.route||this.rerouting) return;
    const m=this.snap(lat,lng);
    if(this.mode==="live" && m.off>this.offRouteM){
      if(!this.offSince) this.offSince=nowMs;
      if(nowMs-this.offSince>this.offRouteSec*1000){ this.reroute(lat,lng); return; }
    } else this.offSince=0;
    this.idx=m.i; this.s=Math.max(this.s,m.s);              // never slide backwards on GPS jitter
    if(this.mode==="live" && Date.now()-this.glareAt>this.glareEveryMs) this.computeGlare(this.idx,nowMs);
    this.speak(speed);
    this.render();
    if(this.s>=this.total-25){
      this.say("arrive","You have arrived.");
      $("navDist").textContent=""; $("navText").textContent="You have arrived"; $("navArrow").textContent="⚑";
      if(this.mode==="live") setTimeout(()=>{ if(this.s>=this.total-25) this.stop(); },8000);
    }
  },

  /* a replay jumped (dragged car / slider): search the whole route once, and
     let the position go backwards; re-announce nothing (replays are silent) */
  resync(){ this._full=true; this.s=0; this.idx=0; },
  /* nearest point on the route, searching a window ahead of the last match */
  snap(lat,lng){
    const C=this.route.coords, kx=111320*Math.cos(lat*Math.PI/180), ky=110540;
    let best={i:this.idx,s:this.s,off:1e9};
    const a0=this._full?0:Math.max(0,this.idx-30), a1=this._full?C.length-1:Math.min(C.length-1,this.idx+400);
    this._full=false;
    for(let i=a0;i<a1;i++){
      const ax=(C[i][1]-lng)*kx, ay=(C[i][0]-lat)*ky, bx=(C[i+1][1]-lng)*kx, by=(C[i+1][0]-lat)*ky;
      const ex=bx-ax, ey=by-ay, L2=ex*ex+ey*ey;
      const t=L2?clamp(-(ax*ex+ay*ey)/L2,0,1):0, px=ax+t*ex, py=ay+t*ey, d=Math.hypot(px,py);
      if(d<best.off) best={i, s:this.cum[i]+t*Math.sqrt(L2), off:d};
    }
    return best;
  },

  async reroute(lat,lng){
    this.rerouting=true; this.say("reroute"+Date.now(),"Rerouting.");
    $("navText").textContent="Rerouting..."; $("navDist").textContent="";
    try{
      const routes=await fetchRoutes([lat,lng],this.dest);
      if(this.active){ this.depart=new Date(); this.setRoute(routes[0]); this.rerouting=false; this.render(); }
    }catch(_){ $("navNote").textContent="Couldn't get a new route (routing server busy). Trying again shortly."; }
    this.rerouting=false; this.offSince=0;
  },

  /* ---------- what to show ---------- */
  nextStep(){ return this.steps.find(st=>st.at>this.s+8 && st.t!=="depart"); },
  nextGlare(){ return this.glare.find(g=>g.s1>this.s); },

  render(){
    if(!this.active) return;
    const st=this.nextStep();
    if(st){
      $("navArrow").textContent=stepArrow(st);
      $("navDist").textContent=st.t==="arrive"?fmtDist(st.at-this.s)+" to go":"In "+fmtDist(st.at-this.s);
      $("navText").textContent=stepText(st);
    } else if(!this.route.steps){
      $("navArrow").textContent="↑"; $("navDist").textContent=fmtDist(this.total-this.s)+" to go";
      $("navText").textContent=this.route.steps===null?"Directions unavailable (routing server busy); glare alerts still work":"Getting directions...";
    }
    const g=this.nextGlare(), box=$("navGlare");
    if(!g){ box.className="navglare clear"; box.textContent="No glare ahead on this route"; return; }
    if(g.s0<=this.s){
      box.className="navglare now";
      box.textContent=`In glare now: sun ${g.side}, ${fmtDist(g.s1-this.s)} to go`;
    } else {
      const d=g.s0-this.s;
      box.className="navglare "+(d<1609?"soon":"later");
      box.textContent=`Glare in ${fmtDist(d)} · ${fmtSec(g.sec)} · sun ${g.side}${g.low?" · very low sun, visor won't help":g.harsh?" (harsh)":""}`;
    }
  },
  renderMute(){
    const b=$("navMute");
    b.textContent=this.muted?"Voice off":"Voice on"; b.disabled=this.mode==="replay";
  },

  /* ---------- voice ---------- */
  speak(speed){
    const fast=(speed||0)>18;                               // ~40 mph: announce earlier
    const st=this.nextStep();
    if(st && st.t!=="arrive"){
      const d=st.at-this.s, key="s"+st.at;
      if(fast && d<=1700 && d>900) this.say(key+"far","In "+sayDist(d)+", "+stepText(st)+".");
      else if(d<=(fast?450:250) && d>(fast?200:80)) this.say(key+"near","In "+sayDist(d)+", "+stepText(st)+".");
      else if(d<=(fast?60:35)) this.say(key+"now",stepText(st)+".");
    }
    const g=this.nextGlare();
    if(g){
      const d=g.s0-this.s, key="g"+Math.round(g.s0);
      if(d<=1700 && d>800) this.say(key+"far",`Glare ahead in ${sayDist(d)}, sun ${g.side}, for about ${saySec(g.sec)}.${g.low?" The sun is very low. Your visor won't block it.":""}`);
      else if(d<=400 && d>0) this.say(key+"near",`Glare in ${sayDist(d)}. Sun ${g.side}. The visor won't block it.`);
      else if(d<=0 && this.s<g.s1) this.say(key+"in","Glare now. Slow down and keep your distance.");
    }
  },
  say(key,text){
    if(this.said.has(key)) return; this.said.add(key);
    if(this.muted||!("speechSynthesis" in window)) return;
    try{ const u=new SpeechSynthesisUtterance(text); u.rate=1.02; speechSynthesis.speak(u); }catch(_){}
  },
  hush(){ try{ if("speechSynthesis" in window) speechSynthesis.cancel(); }catch(_){} },
  glareSummary(){
    const n=this.glare.length, mi=this.glare.reduce((a,g)=>a+g.s1-g.s0,0);
    return n?`${n} glare ${n>1?"zones":"zone"} on this route, ${sayDist(mi)} in all.`:"";
  }
};

/* ---------- words ---------- */
function roadName(st){
  const ref=(st.ref||"").split(";")[0].trim().replace(/^I (\d+)/,"I-$1").replace(/^CA (\d+)/,"SR-$1").replace(/^US (\d+)/,"US-$1");
  return ref||st.name||"";
}
function stepText(st){
  const road=roadName(st), onto=road?" onto "+road:"", m=st.m||"";
  const toward=st.dest?" toward "+st.dest.split(",")[0].split(":").pop().trim():"";
  switch(st.t){
    case "arrive":   return "Arrive at your destination";
    case "depart":   return "Head out"+(road?" on "+road:"");
    case "merge":    return "Merge"+onto;
    case "on ramp":  return "Take the ramp"+(road?onto:toward);
    case "off ramp": return "Take the exit"+(toward||onto);
    case "fork":     return "Keep "+(m.replace("slight ","")||"straight")+" at the fork"+(road?onto:toward);
    case "end of road": return "At the end of the road, turn "+m+onto;
    case "roundabout": case "rotary": return "At the roundabout, take exit "+(st.ex||1)+onto;
    case "new name": case "continue": return (m.includes("left")||m.includes("right")?"Keep "+m.replace("slight ",""):"Continue")+onto;
    default:
      if(m==="uturn") return "Make a U-turn"+onto;
      if(m==="straight") return "Continue straight"+onto;
      return "Turn "+m+onto;
  }
}
function stepArrow(st){
  if(st.t==="arrive") return "⚑";
  if(st.t==="roundabout"||st.t==="rotary") return "⟳";
  return ({"left":"←","right":"→","slight left":"↖","slight right":"↗","sharp left":"↙",
           "sharp right":"↘","uturn":"↶","straight":"↑"})[st.m]||"↑";
}
function fmtDist(m){
  if(m>=322) return (m/1609.34).toFixed(m<16093?1:0)+" mi";
  return Math.max(50,Math.round(m*3.28084/50)*50)+" ft";
}
function sayDist(m){
  const mi=m/1609.34;
  if(mi>=1.3) return mi.toFixed(1).replace(/\.0$/,"")+" miles";
  if(mi>=0.8) return "1 mile";
  if(mi>=0.4) return "half a mile";
  if(mi>=0.18) return "a quarter mile";
  return Math.max(100,Math.round(m*3.28084/100)*100)+" feet";
}
function fmtSec(s){ return s<90?Math.round(s)+" s":Math.round(s/60)+" min"; }
function saySec(s){ return s<90?Math.round(s/5)*5+" seconds":Math.round(s/60)+" minutes"; }

/* Google Maps directions for the same route: origin, destination, and up to
   8 points along it so Google follows our (possibly shadier) path. */
function gmapsUrl(route,dest){
  const c=route.coords, n=c.length, f=p=>p[0].toFixed(5)+","+p[1].toFixed(5);
  const via=[]; for(let k=1;k<=8;k++) via.push(f(c[Math.floor(n*k/9)]));
  return "https://www.google.com/maps/dir/?api=1&travelmode=driving&origin="+f(c[0])+"&destination="+f(dest||c[n-1])+
         "&waypoints="+encodeURIComponent(via.join("|"));
}

/* Saved example trips have no directions. Ask the router for the same path
   (start, end and 10 points along it) with steps; drop the "arrive/depart"
   steps it adds at each of those points. steps = null if it can't be had. */
async function ensureSteps(route){
  if(route.steps!==undefined) return;
  const c=route.coords, n=c.length, pts=[c[0]];
  for(let k=1;k<=10;k++) pts.push(c[Math.floor(n*k/11)]);
  pts.push(c[n-1]);
  try{
    const u=CONFIG.osrmBase+"/route/v1/driving/"+pts.map(p=>p[1]+","+p[0]).join(";")+"?overview=false&steps=true&continue_straight=true";
    const j=await fetchJSON(u);
    if(j.code!=="Ok") throw new Error(j.code);
    route.steps=osrmSteps(j.routes[0]);
  }catch(_){ route.steps=null; }
}
/* OSRM steps -> what navigation needs; for a route through waypoints, the
   arrive/depart pairs at each waypoint are not real manoeuvres */
function osrmSteps(rt){
  const legs=rt.legs||[], out=[];
  legs.forEach((l,li)=>(l.steps||[]).forEach((st,si)=>{
    const t=st.maneuver.type;
    if(t==="depart" && li>0) return;
    if(t==="arrive" && li<legs.length-1) return;
    if(t==="notification") return;
    const step={t, m:st.maneuver.modifier||"", ex:st.maneuver.exit||null, name:st.name||"", ref:st.ref||"",
              dest:st.destinations||"", loc:[st.maneuver.location[1],st.maneuver.location[0]]};
    // "continue" on the road you are already on is not an instruction (the
    // router marks every change of name or number, and waypoint joins)
    const prev=out[out.length-1];
    if((t==="new name"||t==="continue") && !/left|right|uturn/.test(step.m) && prev && roadName(prev)&&roadName(prev)===roadName(step)) return;
    out.push(step);
  }));
  return out;
}
