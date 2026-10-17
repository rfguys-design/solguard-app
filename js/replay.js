/* Replay -- a virtual drive.
   Same physics as the live drive. The ONLY difference is where the inputs
   come from: instead of GPS and the system clock, position comes from a road
   and time comes from a virtual clock. Every decision still goes through
   glareGeom() and classify(), so there is no second copy of the sun maths.

   A replay route is { name, pts:[[lat,lng]...], cumS:[seconds from start...] }.
   cumS comes from the router's real travel times for a planned trip, or from
   an assumed highway speed for a road picked off the map. */

const REPLAY={
  active:false, playing:false, route:null, clock:null, t0:null,
  elapsed:0, redSec:0, raf:0, line:null, marker:null, onEnd:null,
  defaultSpeed:26.8,             // m/s (60 mph) for roads with no travel times
  trail:[], clearSky:false,
  pxPerSec:80,                   // the car moves about this fast on screen...
  maxPlaySec:10,                 // ...but a whole drive never takes longer than this

  /* Tapped highways on the Glare map, the most blinding stretches and
     the planner's Watch this drive, all play through here. */
  init(){
    // the same Pause / Stop pair sits in the Glare map and Plan panels, always
    // in place (greyed out when nothing is playing) so the panel never jumps
    document.querySelectorAll(".rp-pause").forEach(b=>b.onclick=()=>{ if(this.active) this.togglePause(); });
    document.querySelectorAll(".rp-stop").forEach(b=>b.onclick=()=>this.stop());
    // scrub: the slider in the HUD, or drag the car along the route on the map
    const hud=$("hud"); L.DomEvent.disableClickPropagation(hud); L.DomEvent.disableScrollPropagation(hud);
    $("hudScrub").oninput=e=>{ if(!this.active) return;
      this.seek(+e.target.value/1000*this.route.cumS[this.route.cumS.length-1]); };
    const box=APP.map.getContainer();
    box.addEventListener("pointermove",e=>{ if(!this.dragging) return;
      e.preventDefault(); this.seek(this.timeNear(APP.map.mouseEventToLatLng(e))); });
    const end=()=>{ if(!this.dragging) return; this.dragging=false; APP.map.dragging.enable(); box.style.cursor=""; };
    box.addEventListener("pointerup",end); box.addEventListener("pointercancel",end);
  },

  /* Jump to t seconds into the drive (paused). The warning needs the sun to
     STAY in the zone for a few seconds, so the 15 s before t are run through
     the classifier first: the state shown is what a real drive would show
     there, not a cold start. */
  seek(t){
    if(!this.active) return;
    const r=this.route, total=r.cumS[r.cumS.length-1];
    t=clamp(t,0,total);
    if(this.playing){ this.playing=false; cancelAnimationFrame(this.raf); }
    this.finished=false;
    resetHold(); H.risk="none";
    for(let tt=Math.max(0,t-15);tt<t;tt+=1){
      const p=positionAt(r,tt), clock=new Date(this.t0.getTime()+tt*1000), sp=sunPosition(clock,p.pt[0],p.pt[1]);
      H.lat=p.pt[0]; H.lng=p.pt[1]; H.headingUsed=p.hdg; H.sunAz=sp.az; H.sunEl=sp.el;
      H.cloud=this.clearSky?null:cloudAt(p.pt[0],p.pt[1],clock.getTime());
      const ridge=r.ridge?r.ridge[p.i-1]:null; H.inSunKnown=ridge!=null; H.inSun=!(ridge!=null && sp.el<ridge);
      bldCheck(); classify(clock.getTime());
    }
    // "glare so far" = the pre-coloured glare spans up to t
    this.redSec=(this.spans||[]).reduce((a,s)=>a+Math.max(0,Math.min(s.t1,t)-s.t0),0);
    this.elapsed=t;
    if(NAV.active && NAV.mode==="replay") NAV.resync();
    this.step(0);
    this.setControls();
  },
  /* the moment in the drive when the car is nearest this map point */
  timeNear(ll){
    const r=this.route, P=r.pts, kx=111320*Math.cos(ll.lat*Math.PI/180), ky=110540;
    let best=0, bd=1e18;
    for(let i=0;i<P.length-1;i++){
      const ax=(P[i][1]-ll.lng)*kx, ay=(P[i][0]-ll.lat)*ky, ex=(P[i+1][1]-P[i][1])*kx, ey=(P[i+1][0]-P[i][0])*ky;
      const L2=ex*ex+ey*ey, f=L2?clamp(-(ax*ex+ay*ey)/L2,0,1):0, dx=ax+f*ex, dy=ay+f*ey, d=dx*dx+dy*dy;
      if(d<bd){ bd=d; best=r.cumS[i]+f*(r.cumS[i+1]-r.cumS[i]); }
    }
    return best;
  },

  /* Show a road on the Glare map (does not start). */
  select(route){
    this.route=route;
    if(this.line){ APP.map.removeLayer(this.line); this.line=null; }
    if(!route) return;
    if(APP.tab==="map"){
      this.line=L.polyline(route.pts,{color:"#f5a623",weight:5,opacity:.9}).addTo(APP.map);
      APP.map.fitBounds(this.line.getBounds(),APP.fitOpts());
    }
    $("rInfo").textContent=route.name+" · "+fmtMin(route.cumS[route.cumS.length-1])+" drive.";
  },

  start(route,depart,opts){
    opts=opts||{};
    this.stop(true);
    this.demoKey=opts.demo||null;              // which demo button started it, if any
    this.route=route; this.onEnd=opts.onEnd||null;
    this.t0=new Date(depart.getTime()); this.elapsed=0; this.redSec=0;
    this.active=true; resetHold(); H.risk="none"; this.clearSky=!!opts.clearSky;
    document.body.classList.add("replaying");                      // phones re-order the page while a drive plays
    // the Glare map's canvas sits above every map layer; clear it now, or its
    // lines stay painted over the car whenever the map doesn't need to move
    if(HEATMAP.ctx) HEATMAP.draw();
    if(this.line){ APP.map.removeLayer(this.line); this.line=null; }   // drop the preview line
    // The whole drive is coloured before the car moves (preRender): it is all
    // known in advance. The car dot rides on its own pane above it.
    this.preRender();
    // frame the whole drive once; after that the zoom is the user's
    APP.map.fitBounds(L.latLngBounds(route.pts),Object.assign(APP.fitOpts(),{maxZoom:15,animate:false}));
    $("hud").classList.add("on"); drawSun(); syncShade();
    this.setControls();
    // load the sky along the whole drive before the first frame
    const total=route.cumS[route.cumS.length-1];
    wxEnsure(route.pts.filter((_,i)=>i%10===0).concat([route.pts[route.pts.length-1]]),
             this.t0.getTime(), this.t0.getTime()+total*1000).then(()=>{ if(this.active){ this.preRender(); this.step(); } });
    // and the buildings along it (js/buildings.js), then recolour again
    BLD.ensure(route.pts.filter((_,i)=>i%4===0||i===route.pts.length-1||route.pts.length<200)).then(()=>{ if(this.active&&this.route===route){ this.preRender(); this.step(); } });
    TERRAIN.ensure(route.pts.filter((_,i)=>i%4===0||i===route.pts.length-1)).then(()=>{ if(this.active&&this.route===route){ this.preRender(); this.step(); } });
    this.step();
    this.togglePause();            // start playing
  },

  togglePause(){
    if(!this.active) return;
    if(this.playing){ this.playing=false; cancelAnimationFrame(this.raf); this.setControls(); return; }
    this.playing=true;
    const r=this.route, total=r.cumS[r.cumS.length-1];
    const metres=r.pts.reduce((m,p,i)=>i?m+haversine(r.pts[i-1],p):0,0), mps=metres/Math.max(1,total);
    let last=performance.now();
    const loop=t=>{
      if(!this.playing) return;
      // Speed follows the map scale: the car crosses about pxPerSec of screen a
      // second, so zooming out speeds it up -- but never slower than the whole
      // drive in maxPlaySec.
      const mpp=156543.03*Math.cos(H.lat*Math.PI/180)/Math.pow(2,APP.map.getZoom());   // metres per pixel
      const speedup=Math.max(total/this.maxPlaySec, this.pxPerSec*mpp/Math.max(1,mps));
      const dt=Math.min(0.25,(t-last)/1000)*speedup; last=t;
      this.elapsed=Math.min(total,this.elapsed+dt);
      this.step(dt);
      if(this.elapsed>=total){ this.playing=false; this.finished=true; this.setControls(); return; }
      this.raf=requestAnimationFrame(loop);
    };
    if(this.finished){ this.finished=false; this.elapsed=0; this.redSec=0; resetHold(); }
    this.setControls();
    this.raf=requestAnimationFrame(loop);
  },

  /* One frame: feed the SAME state the GPS handler feeds, then the SAME classifier. */
  step(dt){
    const r=this.route, pos=positionAt(r,this.elapsed);
    H.lat=pos.pt[0]; H.lng=pos.pt[1]; H.headingUsed=pos.hdg; H.headingSrc="route"; H.speed=pos.speed;
    this.clock=new Date(this.t0.getTime()+this.elapsed*1000);
    const sp=sunPosition(this.clock,H.lat,H.lng); H.sunAz=sp.az; H.sunEl=sp.el;
    H.cloud=this.clearSky?null:cloudAt(H.lat,H.lng,this.clock.getTime());
    const map=APP.map;
    // follow the car without touching the zoom: pan only when it nears the edge
    const sz=map.getSize(), cp=map.latLngToContainerPoint([H.lat,H.lng]), m=60;
    if(!this.dragging && (cp.x<m||cp.y<m||cp.x>sz.x-m||cp.y>sz.y-m)) map.panTo([H.lat,H.lng],{animate:false});
    if(this.marker) this.marker.setLatLng([H.lat,H.lng]);
    else{
      this.marker=L.circleMarker([H.lat,H.lng],{radius:9,color:"#fff",weight:3,fillColor:"#3b82f6",fillOpacity:1,
                                                pane:carPane(),bubblingMouseEvents:false}).addTo(map)
        .bindTooltip("Drag me along the route",{direction:"right",offset:[10,0]});
      // grab the car (mouse or finger): the map stops panning and the car
      // follows the pointer along the route
      const el=this.marker.getElement();
      if(el){ el.style.cursor="grab"; el.style.touchAction="none";
        el.addEventListener("pointerdown",e=>{ e.preventDefault(); e.stopPropagation();
          this.dragging=true; map.dragging.disable();
          try{ map.getContainer().setPointerCapture(e.pointerId); }catch(_){}
          map.getContainer().style.cursor="grabbing"; }); }
    }
    if(bldCheck()){ /* a building or sound wall shades the car: no need to ask the terrain layer */ }
    else if(APP.shadeOn){
      try{
        APP.shade.setDate(this.clock);
        const p=map.latLngToContainerPoint([H.lat,H.lng]);
        Promise.resolve(APP.shade.isPositionInSun(p.x,p.y))
          .then(v=>{ H.inSun=v; H.inSunKnown=true; }).catch(()=>{ H.inSunKnown=false; });
      }catch(_){ H.inSunKnown=false; }
    } else H.inSunKnown=false;
    classify(this.clock.getTime());
    if(NAV.active && NAV.mode==="replay") NAV.tick(H.lat,H.lng,H.speed,this.clock.getTime());
    if(dt && H.risk==="high") this.redSec+=dt;
    renderHud();
    const total=r.cumS[r.cumS.length-1];
    $("hudClock").textContent=this.clock.toLocaleTimeString([], {hour:"numeric",minute:"2-digit",second:"2-digit"});
    $("hudProg").textContent=fmtMin(Math.max(0,this.elapsed))+" of "+fmtMin(total);   // the lead-in before the start counts as 0
    if(document.activeElement!==$("hudScrub")) $("hudScrub").value=Math.round(1000*this.elapsed/Math.max(1,total));
    $("hudRed").textContent=Math.round(this.redSec)+" s";
  },

  stop(quiet){
    const was=this.active;
    this.playing=false; cancelAnimationFrame(this.raf); this.active=false; this.finished=false;
    document.body.classList.remove("replaying");
    if(this.marker){ APP.map.removeLayer(this.marker); this.marker=null; }
    if(this.line && was){ APP.map.removeLayer(this.line); this.line=null; }
    this.clearTrail(); this.clearSky=false;
    $("hud").classList.remove("on"); this.setControls();
    H.inSunKnown=false;
    if(!quiet){ syncShade(); drawSun(); if(APP.tab==="map") HEATMAP.draw(); VIEW.render(); }
    if(NAV.active && NAV.mode==="replay") NAV.stop();
    if(was && this.onEnd){ const f=this.onEnd; this.onEnd=null; f(); }
  }
};

/* Pause/Stop buttons in every panel reflect the replay's state. */
REPLAY.setControls=function(){
  const label=!this.active?"Pause":(this.finished?"Play again":(this.playing?"Pause":"Resume"));
  document.querySelectorAll(".rp-pause").forEach(b=>{ b.textContent=label; b.disabled=!this.active; });
  document.querySelectorAll(".rp-stop").forEach(b=>{ b.disabled=!this.active; });
  // the demo button that started this drive stays marked until Stop
  if(!this.active) this.demoKey=null;
  document.querySelectorAll("[data-demo]").forEach(b=>b.classList.toggle("demo-on",b.dataset.demo===this.demoKey));
};
/* Colour the whole drive before it plays: run the SAME classifier (with its
   hold-and-release timing) over the drive, one second at a time, on a scratch
   copy of the car state, and draw one polyline per colour run: green clear,
   amber marginal, red glare. Hills: a route from the Glare map carries the
   map's ridge height per point (route.ridge), the same terrain test the map
   uses. Buildings: the ray cast in js/buildings.js, both here and live.
   The live replay additionally asks ShadeMap, which can't be asked ahead of
   time, so on a planner trip a hill can turn a red stretch "Blocked". */
REPLAY.preRender=function(){
  this.clearTrail();
  const r=this.route, total=r.cumS[r.cumS.length-1], saved=JSON.stringify(H);
  resetHold(); H.risk="none";
  const colour=()=>H.risk==="high"?"#e63c3c":H.risk==="marginal"?"#e0a030":"#2fbf71";
  let run=null, spans=[], open=null;
  for(let t=0;t<=total+0.5;t+=1){
    const tt=Math.min(t,total), p=positionAt(r,tt), clock=new Date(this.t0.getTime()+tt*1000);
    const sp=sunPosition(clock,p.pt[0],p.pt[1]);
    H.lat=p.pt[0]; H.lng=p.pt[1]; H.headingUsed=p.hdg; H.sunAz=sp.az; H.sunEl=sp.el;
    H.cloud=this.clearSky?null:cloudAt(p.pt[0],p.pt[1],clock.getTime());
    const ridge=r.ridge?r.ridge[p.i-1]:null;
    H.inSunKnown=ridge!=null; H.inSun=!(ridge!=null && sp.el<ridge);
    bldCheck();                                     // buildings and sound walls (OpenStreetMap)
    classify(clock.getTime());
    const c=colour();
    // same width rule as the Glare map: busier = thicker, when Show traffic is on
    const a=r.aadt?r.aadt[p.i-1]:null;
    const wgt=(HEATMAP.traffic&&a!=null)?5*clamp(Math.round(Math.sqrt(a/40000)*4)/4,0.25,3):7;
    if(H.risk==="high"){ if(!open) open={t0:tt,pts:[]}; open.t1=tt; open.pts.push(p.pt); }
    else if(open){ spans.push(open); open=null; }
    if(!run||run.c!==c||run.w!==wgt){ if(run) this.trail.push(run.line); run={c,w:wgt,line:L.polyline(run?[run.last,p.pt]:[p.pt],{color:c,weight:wgt,opacity:.95}).addTo(APP.map)}; }
    else run.line.addLatLng(p.pt);
    run.last=p.pt;
  }
  if(run) this.trail.push(run.line);
  if(open) spans.push(open);
  this.spans=spans;                                 // seek() adds these up for "glare so far"
  Object.assign(H,JSON.parse(saved)); resetHold();
  // Route, direction and times: in the replay panel, and a label on the map
  // at the longest stretch of glare
  const clk=s=>new Date(this.t0.getTime()+s*1000).toLocaleTimeString([], {hour:"numeric",minute:"2-digit"});
  const clks=s=>new Date(this.t0.getTime()+s*1000).toLocaleTimeString([], {hour:"numeric",minute:"2-digit",second:"2-digit"});
  $("hudRoute").textContent=r.name;
  const g=spans.length?spans.reduce((a,b)=>(b.t1-b.t0>a.t1-a.t0?b:a)):null;
  $("hudTimes").textContent=`Drive ${clk(0)}\u2013${clk(total)}`+
    (g?` \u00b7 glare ${clks(g.t0)}\u2013${clks(g.t1)}`:" \u00b7 no glare");
  if(g){
    const mid=g.pts[g.pts.length>>1];
    this.trail.push(L.tooltip({permanent:true,direction:"top",offset:[0,-8],className:"glarelabel",pane:carPane()})
      .setLatLng(mid).setContent(`Glare ${clks(g.t0)}\u2013${clks(g.t1)} (${Math.round(g.t1-g.t0)} s)`).addTo(APP.map));
  }
};
/* The car dot gets its own map layer above every line, so it is never hidden. */
function carPane(){
  if(!APP.map.getPane("car")){ const p=APP.map.createPane("car"); p.style.zIndex=650; }
  return "car";
}
REPLAY.clearTrail=function(){
  this.trail.forEach(l=>APP.map.removeLayer(l)); this.trail=[];
};

/* ---------- route builders ---------- */
function routeFromPts(name,pts,speedMps,extra){
  const cumS=[0];
  for(let i=1;i<pts.length;i++) cumS.push(cumS[i-1]+haversine(pts[i-1],pts[i])/speedMps);
  return Object.assign({name,pts,cumS},extra||{});
}
/* An OSRM route from the planner: real per-segment travel times. */
function routeFromOsrm(name,rt){
  const cumS=[0];
  for(let i=1;i<rt.coords.length;i++) cumS.push(cumS[i-1]+(rt.durs[i-1]||0));
  return {name,pts:rt.coords,cumS};
}
/* Where the car is `t` seconds into the drive, and which way it points. */
function positionAt(r,t){
  const pts=r.pts, cs=r.cumS, n=pts.length;
  let i=1; while(i<n-1 && cs[i]<t) i++;
  const a=pts[i-1], b=pts[i], seg=Math.max(1e-6,cs[i]-cs[i-1]);
  const f=clamp((t-cs[i-1])/seg,0,1);
  // skip zero-length steps so the heading never comes from two identical points
  let j=i; while(j<n-1 && haversine(pts[j-1],pts[j])<1) j++;
  return { pt:[a[0]+(b[0]-a[0])*f, a[1]+(b[1]-a[1])*f],
           hdg:bearing(pts[j-1],pts[j]),
           speed:haversine(a,b)/seg, i };
}

function fmtMin(s){ s=Math.round(s); return Math.floor(s/60)+":"+pad2(s%60); }
