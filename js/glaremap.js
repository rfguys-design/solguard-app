/* Glare map -- every kilometre of California state highway, coloured by
   whether the sun is in a driver's eyes there at the chosen moment.

   This needs no simulation. At one instant the sun sits in essentially the
   same place across a county, so the only question per piece of road is the
   one the live app asks: is the sun within the cone of my heading, low but
   above my local ridge, and is the sky clear? One comparison per segment,
   tens of thousands of segments, a few milliseconds. Press "Play the day"
   and watch the glare band sweep across the state.

   Traffic goes both ways. Every segment is scored for each direction a
   driver can travel it: both ways on an undivided road, one way on each
   carriageway of a divided highway (solguard.py works out which is which).
   An earlier version scored only the direction each road happened to be
   drawn in, so westbound I-8 at sunset barely showed.

   Two views:
     By length  -- km of highway in glare (where is the problem?)
     By drivers -- how many drivers are in that glare right now, from the
                   Caltrans traffic count on each road (who does it reach?)

   The layer file comes from solguard.py: shape, ridge both ways, carriageway
   direction, traffic. */

const HEATMAP={
  roads:null, cells:null, canvas:null, ctx:null, playing:false, timer:0, framed:false,
  prolongedSec:180,            // glare held this long = the kind a driver can't wait out
  mapSpeedMph:60,              // assumed speed when turning map distance into minutes
  traffic:true,                // line width + counter follow traffic; off = every road the same

  init(){
    APP.tabs.map={
      onShow:()=>{
        this.ensureCanvas(); this.canvas.style.display="block";
        const go=()=>{
          if(!this.framed){ APP.map.setView([37.2,-119.5],6); this.framed=true; }
          this.loadSky(); this.draw();
        };
        if(this.roads) go(); else this.load().then(ok=>{ if(ok) go(); });
      },
      onHide:()=>{
        this.pause(); REPLAY.stop();
        if(REPLAY.line){ APP.map.removeLayer(REPLAY.line); REPLAY.line=null; }
        if(this.canvas) this.canvas.style.display="none";
      },
      onWhen:()=>{ this.loadSky(); this.draw(); },
      onWeather:()=>this.draw()
    };
    $("hPlay").onclick=()=>this.playing?this.pause():this.play();
    this.presetsReady=fetch("data/demo_drives.json").then(r=>r.ok?r.json():null).then(j=>{ this.presets=j&&j.drives; }).catch(()=>{});
    $("rToPlan").onclick=()=>APP.show("plan");
    $("hTraffic").onchange=()=>this.setTraffic($("hTraffic").checked);
    APP.map.on("click",e=>{ if(APP.tab==="map" && !REPLAY.active) this.pickRoad(e); });
  },

  load(){
    $("hInfo").textContent="Loading highways…";
    return fetch("ca_segments.json").then(r=>{
      if(!r.ok) throw new Error("ca_segments.json not found next to this page");
      return r.json();
    }).then(j=>{
      // Roads arrive as delta-encoded shapes. Unpack once and work out every
      // piece's bearing and weather cell once, so a time change only compares angles.
      this.roads=[]; const cells=new Set();
      for(const rd of j.roads){
        const n=rd.p.length/2, lat=new Float64Array(n), lon=new Float64Array(n), cell=new Array(n);
        let la=0, lo=0;
        for(let i=0;i<n;i++){ la+=rd.p[2*i]; lo+=rd.p[2*i+1]; lat[i]=la/1e5; lon[i]=lo/1e5;
          cell[i]=wxCell(lat[i],lon[i]); cells.add(cell[i]); }
        const m=Math.max(0,n-1), brg=new Float32Array(m), dir=new Uint8Array(m), aadt=new Float32Array(m);
        for(let i=0;i<n-1;i++){
          brg[i]=bearing([lat[i],lon[i]],[lat[i+1],lon[i+1]]);
          dir[i]=rd.d?+rd.d[i]:0;              // 0 two-way, 1 drawn way only, 2 reverse only
          aadt[i]=rd.t?rd.t[i]*100:rd.k*1000;  // vehicles a day, both directions, on this segment
        }
        // older layer files have no reverse ridge: use the forward one (no terrain check that way)
        this.roads.push({b:rd.b, lat, lon, brg, dir, aadt, cell, ridge:rd.r, ridgeBack:rd.q||rd.r, k:rd.k, n, route:rd.n||null});
      }
      this.cells=[...cells];
      return true;
    }).catch(e=>{ $("hInfo").textContent=e.message; return false; });
  },

  /* One request fetches the whole state's sky for the shared date. */
  loadSky(){
    if(!this.cells||!APP.useWeather) return;
    const d=APP.when, a=new Date(d.getFullYear(),d.getMonth(),d.getDate(),0), b=new Date(a.getTime()+86399000);
    const pts=this.cells.map(wxCellCentre);
    if(this.cells.every(c=>WX.days.has(c+"|"+utcDay(a.getTime())) && WX.days.has(c+"|"+utcDay(b.getTime())))) return;
    this.skyStatus("Loading cloud cover...");
    wxEnsure(pts,a.getTime(),b.getTime()).then(()=>{ if(APP.tab==="map") this.draw(); });
  },
  skyStatus(t){ status(t); },

  ensureCanvas(){
    if(this.canvas) return;
    const c=document.createElement("canvas");
    c.style.cssText="position:absolute;inset:0;pointer-events:none;z-index:400";
    APP.map.getContainer().appendChild(c);
    this.canvas=c; this.ctx=c.getContext("2d");
    APP.map.on("move zoom resize viewreset",()=>{ if(APP.tab==="map") this.draw(); });
  },

  /* Sun position cached per half-degree cell -- across a county it varies by a
     fraction of a degree, and computing it 20,000 times a frame would be slow. */
  sunCache(when){
    const cache=new Map();
    return (lat,lon)=>{
      const k=((lat*2)|0)*1000+((lon*2)|0);
      let v=cache.get(k);
      if(!v){ v=sunPosition(when,((lat*2)|0)/2+0.25,((lon*2)|0)/2+0.25); cache.set(k,v); }
      return v;
    };
  },

  /* Score one road at one moment, into state/way/segKm (one entry per
     piece): how bad the sun is (0 safe, 1 marginal, 2 high -- the same tests
     as the car), which way it is worst (0 drawn way, 1 reverse), and how long
     the piece is. Opposite headings can't both face a sun 12 deg off one of
     them, so one direction per piece is enough. cloud: Map cell -> %, or null
     for a clear sky. */
  scoreRoad(rd,sunAt,cloud,state,way,segKm){
    const rate=(sp,hdg,ridge,cell)=>{
      if(sp.el<CONFIG.sunElevMin || sp.el<ridge) return 0;
      let tier=glareGeom(sp.el,sp.az,hdg).tier;                       // the same test as the car
      if(tier!=="safe" && cloud) tier=applySky(tier,skyFactor(cloud.get(cell)));   // same cloud rule as the car
      return RANK[tier];
    };
    state.length=0; way.length=0; segKm.length=0;
    for(let i=0;i<rd.n-1;i++){
      const sp=sunAt(rd.lat[i],rd.lon[i]), d=rd.dir[i];
      const fwd=d===2?0:rate(sp,rd.brg[i],rd.ridge[i],rd.cell[i]);
      const rev=d===1?0:rate(sp,(rd.brg[i]+180)%360,rd.ridgeBack[i+1],rd.cell[i]);
      state.push(Math.max(fwd,rev)); way.push(rev>fwd?1:0);
      const dLa=(rd.lat[i+1]-rd.lat[i])*111.32, dLo=(rd.lon[i+1]-rd.lon[i])*111.32*Math.cos(rd.lat[i]*Math.PI/180);
      segKm.push(Math.sqrt(dLa*dLa+dLo*dLo));
    }
  },

  draw(){
    if(!this.roads||!this.ctx) return;
    const map=APP.map, size=map.getSize(), c=this.canvas, ctx=this.ctx, dpr=window.devicePixelRatio||1;
    if(c.width!==size.x*dpr||c.height!==size.y*dpr){
      c.width=size.x*dpr; c.height=size.y*dpr; c.style.width=size.x+"px"; c.style.height=size.y+"px";
    }
    ctx.setTransform(dpr,0,0,dpr,0,0);
    ctx.clearRect(0,0,size.x,size.y);
    if(REPLAY.active) return;                        // the replay owns the map while it runs

    const when=APP.when, ms=when.getTime();
    // this moment's cloud % per weather cell (null = unknown -> clear)
    const cloud=new Map(); let known=0;
    for(const cell of this.cells){
      const [la,lo]=wxCellCentre(cell), v=APP.useWeather?cloudAt(la,lo,ms):null;
      cloud.set(cell,v); if(v!==null) known++;
    }
    if(APP.useWeather && known) this.drawClouds(ctx,map,cloud);

    const sunAt=this.sunCache(when), b=map.getBounds(), z=map.getZoom();
    const S_=b.getSouth(), N_=b.getNorth(), W_=b.getWest(), E_=b.getEast();
    const baseW=z<7?2:(z<9?3:(z<12?4.5:6.5)), byDrivers=this.traffic;
    ctx.lineCap="round"; ctx.lineJoin="round"; ctx.lineWidth=baseW;
    let hotM=0, warmM=0, longM=0, hotCars=0, longCars=0, warmCars=0;
    const mps=this.mapSpeedMph*0.44704, kmh=mps*3.6, share=trafficShare(when);
    const state=[], way=[], segKm=[];
    // direction arrows only once roads are far enough apart to read them
    const showArrows=z>=9, arrowGapPx=z>=12?110:90, arrows=[];

    for(const rd of this.roads){
      if(rd.b[2]<S_||rd.b[0]>N_||rd.b[3]<W_||rd.b[1]>E_) continue;
      const alpha=byDrivers?0.95:Math.min(1,0.45+rd.k/120);
      // Cars present per km in ONE direction right now: the daily count covers
      // both directions, and a car at kmh km/h occupies 1/kmh hours per km.
      const carsPerKm=i=>rd.aadt[i]/2*share/kmh;
      // Pass 1: how bad is each piece, which way is it worst, and how long is it.
      this.scoreRoad(rd,sunAt,cloud,state,way,segKm);
      // Pass 2: an unbroken chain of lit pieces, all driven the same way, is
      // one continuous dose of glare. Longer than prolongedSec to drive = the
      // kind you can't wait out: purple.
      const long=new Array(state.length).fill(false);
      for(let i=0;i<state.length;){
        if(state[i]!==2){ i++; continue; }
        let j=i, km=0, cars=0;
        while(j<state.length && state[j]===2 && way[j]===way[i]){ km+=segKm[j]; cars+=segKm[j]*carsPerKm(j); j++; }
        if(km*1000/mps>=this.prolongedSec){ for(let k=i;k<j;k++) long[k]=true; longM+=km; longCars+=cars; }
        else{ hotM+=km; hotCars+=cars; }
        i=j;
      }
      // Pass 3: draw, breaking the path whenever the colour (or, with traffic
      // on, the width) changes. With traffic on, busier roads draw thicker.
      // Along the way, drop an arrow every arrowGapPx of lit road pointing the
      // way the glare-facing driver travels.
      let open=false, colour=null, width=0, prev=null, run=arrowGapPx/2;
      for(let i=0;i<state.length;i++){
        if(state[i]===0){ if(open){ ctx.stroke(); open=false; } prev=null; run=arrowGapPx/2; continue; }
        if(state[i]===1){ warmM+=segKm[i]; warmCars+=segKm[i]*carsPerKm(i); }
        const want = state[i]===1 ? "rgba(210,145,30,"+(alpha*0.7)+")"
                   : long[i] ? "rgba(168,60,230,"+alpha+")" : "rgba(230,60,60,"+alpha+")";
        const w = byDrivers ? baseW*clamp(Math.round(Math.sqrt(rd.aadt[i]/40000)*4)/4,0.25,3) : baseW;
        const p0=prev||map.latLngToContainerPoint([rd.lat[i],rd.lon[i]]);
        if(!open||want!==colour||w!==width){
          if(open) ctx.stroke();
          ctx.beginPath(); ctx.moveTo(p0.x,p0.y); ctx.strokeStyle=want; ctx.lineWidth=w; colour=want; width=w; open=true;
        }
        const p1=map.latLngToContainerPoint([rd.lat[i+1],rd.lon[i+1]]); ctx.lineTo(p1.x,p1.y);
        if(showArrows){
          const dx=p1.x-p0.x, dy=p1.y-p0.y, len=Math.hypot(dx,dy);
          let at=arrowGapPx-run;                    // distance into this piece of the next arrow
          while(at<=len){
            const f=at/len, ang=Math.atan2(dy,dx)+(way[i]?Math.PI:0);
            arrows.push({x:p0.x+f*dx, y:p0.y+f*dy, ang, size:Math.max(5,w*1.1)});
            at+=arrowGapPx;
          }
          run=len-(at-arrowGapPx);
        }
        prev=p1;
      }
      if(open) ctx.stroke();
    }
    // arrows on top of every line, white with a dark edge so they read on red and purple
    ctx.lineJoin="miter"; ctx.lineCap="butt";
    for(const a of arrows){
      ctx.save(); ctx.translate(a.x,a.y); ctx.rotate(a.ang);
      const s=a.size;
      ctx.beginPath(); ctx.moveTo(s,0); ctx.lineTo(-s*0.7,-s*0.75); ctx.lineTo(-s*0.25,0); ctx.lineTo(-s*0.7,s*0.75); ctx.closePath();
      ctx.lineWidth=2; ctx.strokeStyle="rgba(10,14,22,0.85)"; ctx.stroke();
      ctx.fillStyle="#fff"; ctx.fill();
      ctx.restore();
    }
    const num=x=>Math.round(x).toLocaleString();
    const any=longM||hotM||warmM;
    this.glareNow={long:longM, hot:hotM, warm:warmM};      // Play the day reads this to set its pace
    if(byDrivers){
      $("hCount").textContent=num(longCars+hotCars)+" drivers";
      $("hInfo").innerHTML=any
        ? `In view right now: about <b>${num(longCars)}</b> drivers in glare over 3 min (${num(longM)} km), `+
          `<b>${num(hotCars)}</b> in brief glare (${num(hotM)} km), ${num(warmCars)} marginal. `+
          `Estimated from Caltrans daily counts and a typical hourly pattern. Tap a highway for details.`
        : "No glare anywhere in view at this moment. Tap a highway for details.";
    }else{
      $("hCount").textContent=num(longM+hotM)+" km";
      $("hInfo").innerHTML=any
        ? `In view: <b>${num(longM)} km</b> over 3 min, <b>${num(hotM)} km</b> brief, ${num(warmM)} km marginal. Tap a highway for details.`
        : "No glare anywhere in view at this moment. Tap a highway for details.";
    }
    this.skyStatus(!APP.useWeather ? "Weather off: clear sky assumed everywhere."
      : known ? "Real cloud cover for this date and hour (Open-Meteo), shown as light tiles."
      : (this.cells.some(cl=>WX.days.has(cl+"|"+utcDay(ms))) ? "No weather data for this date: clear sky assumed."
                                                             : "Loading cloud cover..."));
  },

  /* Each weather cell as a light tile, more opaque the cloudier it is, under
     the glare lines -- so you can see WHY a road is or isn't lit. Zoomed in,
     each tile prints its cloud %. */
  drawClouds(ctx,map,cloud){
    const z=map.getZoom(), b=map.getBounds().pad(0.1), s=CONFIG.wxCellDeg/2;
    ctx.font="600 12px system-ui,sans-serif"; ctx.textAlign="center"; ctx.textBaseline="middle";
    for(const [cell,v] of cloud){
      if(v===null) continue;
      const [la,lo]=wxCellCentre(cell);
      if(!b.intersects([[la-s,lo-s],[la+s,lo+s]])) continue;
      const p0=map.latLngToContainerPoint([la+s,lo-s]), p1=map.latLngToContainerPoint([la-s,lo+s]);
      ctx.fillStyle="rgba(215,222,235,"+(0.05+0.5*v/100).toFixed(3)+")";
      ctx.fillRect(p0.x,p0.y,p1.x-p0.x,p1.y-p0.y);
      ctx.strokeStyle="rgba(215,222,235,0.25)"; ctx.lineWidth=1; ctx.strokeRect(p0.x,p0.y,p1.x-p0.x,p1.y-p0.y);
      if(z>=8){
        const cx=(p0.x+p1.x)/2, cy=(p0.y+p1.y)/2;
        ctx.fillStyle="rgba(10,14,22,0.75)"; ctx.fillText(Math.round(v)+"%",cx+1,cy+1);
        ctx.fillStyle="#fff"; ctx.fillText(Math.round(v)+"%",cx,cy);
      }
    }
  },

  /* Play the day at a pace set by what's on screen: slow while there is
     glare in view (1 min a frame), a little faster with only marginal glare
     (3 min), fast with none (15 min), fastest with the sun down everywhere in
     view (30 min). The hours that matter get the screen time. */
  play(){
    this.playing=true;
    const step=()=>{
      if(!this.playing) return;
      const g=this.glareNow||{long:0,hot:0,warm:0}, d=APP.when, c=APP.map.getCenter();
      const sunUp=sunPosition(d,c.lat,c.lng).el>-1;
      const dm=g.long+g.hot>0?1 : g.warm>0?3 : sunUp?15 : 30;
      $("hPlay").textContent=dm===1?"Pause · glare: slowed down":dm===3?"Pause · marginal":"Pause · fast-forward";
      const m=(minsOfDay(d)+dm)%1440;                // wrap to midnight of the same date
      APP.setWhen(new Date(d.getFullYear(),d.getMonth(),d.getDate(),Math.floor(m/60),m%60));
      this.timer=setTimeout(()=>requestAnimationFrame(step),dm===1?80:60);
    };
    step();
  },
  pause(){ this.playing=false; clearTimeout(this.timer); $("hPlay").textContent="Play the day"; },

  setTraffic(on){
    this.traffic=on;
    if(REPLAY.active) REPLAY.preRender();                // one switch for the map and the replay
    $("hTraffic").checked=on;
    $("hTrafficNote").textContent=on
      ? "Thicker line = busier road, from Caltrans traffic counts."
      : "Every road the same width, glare counted in km.";
    $("hCount").title=on?"drivers in glare in view, right now":"km of state highway in glare in view";
    $("hLegendWidth").style.visibility=on?"":"hidden";   // keep its space so the panel never jumps
    this.draw();
  },

  /* ======================  DEMO DRIVES  ======================
     "Most blinding stretch: San Diego County / California" (shown in Plan a
     trip): the app picks the date, the time and the road. Searches the next
     12 months, clear sky (forecasts don't reach that far).

     Ranked by what ONE DRIVER goes through, not by traffic (it used to be
     drivers an hour x severity; Ray: in Plan a trip it is a personal drive).
     DEAD-CENTRE glare first. A sun at the edge of the
     12 deg cone for minutes is less blinding than one straight ahead for half
     a minute, so length is only a threshold:
       1. the sun within coreDeg of straight ahead and coreElev degrees up
          (top capped just under the current visor line: elBand) --
          the middle of the visor-proof band, where glareGeom's severity peaks
          (lower, the haze dims it; higher, a visor starts to reach it),
       2. unbroken for at least coreMinSec of driving,
       3. of those, the most seconds x severity, where severity is
          glareGeom's score (1 = dead centre at the band's middle): the
          longest, most blinding unbroken glare a driver would sit through. */
  regions:{
    sd:{name:"San Diego County", box:[32.53,-117.60,33.51,-116.08]},   // the whole county, coast to desert
    ca:{name:"California", box:[32.4,-124.6,42.1,-114.0]}
  },
  coreDeg:3,                   // "dead centre": sun this close to straight ahead
  coreMinSec:30,               // ...for at least this long
  coreElev:[1,14],             // ...with the sun this high: under the visor (from 1 deg: since 2026-10-17 the lowest sun counts most, see sunSeverity)
  /* ...capped just under the TIGHT limit's visor line (CONFIG.demoLimit,
     10 deg -> 5-9 deg up), so the drive is glare under any setting at least
     that loose. Dead centre (3 deg) is inside its 6/7 deg box. Fixed: the
     pick does not follow the driver's own Glare sensitivity. */
  elBand(){ return [this.coreElev[0], Math.min(this.coreElev[1], CONFIG.demoLimit.visor-1)]; },
  presets:null,                // data/demo_drives.json: the searches, done ahead of time
  rankVersion:"personal-5",    // bump when the ranking changes, so old saved answers are not used

  /* Every road piece, filed by the compass heading a driver on it can have
     (both ways on two-way road, one way on a carriageway). Dead-centre glare
     needs the sun within coreDeg of that heading, so each moment only the
     few degrees around the sun's azimuth need checking -- about 3% of the
     state instead of all of it. Built once. */
  headingIndex(){
    if(this._hidx) return this._hidx;
    const idx=Array.from({length:360},()=>[]);
    this.roads.forEach((rd,r)=>{
      for(let i=0;i<rd.n-1;i++){
        if(rd.dir[i]!==2) idx[Math.floor(rd.brg[i])%360].push(r,i,0);
        if(rd.dir[i]!==1) idx[Math.floor((rd.brg[i]+180)%360)].push(r,i,1);
      }
    });
    return this._hidx=idx;
  },

  /* The worst dead-centre glare inside box ([S,W,N,E]) at one moment, or null.
     Same tests as scoreRoad (visor-proof band, ridge, cloud ignored), plus the
     sun within coreDeg of straight ahead. */
  bestRunAt(when,box){
    const sunAt=this.sunCache(when), kmh=this.mapSpeedMph*1.609344, share=trafficShare(when);
    const [S_,W_,N_,E_]=box, idx=this.headingIndex();
    const band=this.elBand();
    // the sun's direction differs across a big box (several degrees across
    // California), so check every heading between its corners' values
    const azs=[[S_,W_],[S_,E_],[N_,W_],[N_,E_]].map(([a,b])=>sunPosition(when,a,b).az);
    const az0=azs[0], rel=azs.map(a=>((a-az0+540)%360)-180);
    const lo=Math.floor(Math.min(...rel))-this.coreDeg-1, hi=Math.ceil(Math.max(...rel))+this.coreDeg+1;
    const hits=new Map();                                  // road -> [{i,way}]
    for(let d=lo; d<=hi; d++){
      const list=idx[((Math.floor(az0)+d)%360+360)%360];
      for(let q=0;q<list.length;q+=3){
        const r=list[q], i=list[q+1], way=list[q+2], rd=this.roads[r];
        if(rd.lat[i]<S_-0.2||rd.lat[i]>N_+0.2||rd.lon[i]<W_-0.2||rd.lon[i]>E_+0.2) continue;
        const sp=sunAt(rd.lat[i],rd.lon[i]);
        if(sp.el<band[0]||sp.el>band[1]) continue;
        if(sp.el<(way?rd.ridgeBack[i+1]:rd.ridge[i])) continue;
        const off=angleDiff(way?(rd.brg[i]+180)%360:rd.brg[i],sp.az);
        if(off>this.coreDeg) continue;
        if(!hits.has(r)) hits.set(r,[]);
        const sev=glareGeom(sp.el,sp.az,way?(rd.brg[i]+180)%360:rd.brg[i]).score;
        hits.get(r).push(i,way,off,sp.el,sev);
      }
    }
    let best=null;
    for(const [r,h] of hits){
      const rd=this.roads[r], segs=[];
      for(let q=0;q<h.length;q+=5) segs.push([h[q],h[q+1],h[q+2],h[q+3],h[q+4]]);
      segs.sort((a,b)=>a[1]-b[1]||a[0]-b[0]);
      // unbroken runs: consecutive pieces, same direction
      for(let a=0;a<segs.length;){
        let b=a; while(b+1<segs.length && segs[b+1][1]===segs[a][1] && segs[b+1][0]===segs[b][0]+1) b++;
        /* DRIVE it, don't just look at it: a car enters the run at `when` and
           the clock runs as it goes (map speed); the sun is recomputed for each
           piece at the moment the car reaches it, and the glare ends where the
           sun leaves dead centre, sets or drops behind the ridge. Judging the
           whole run at one instant credited SR-62 with 27 min of glare when the
           2 deg sun set 12 min into the drive. */
        const way=segs[a][1], order=[]; for(let k=a;k<=b;k++) order.push(segs[k][0]);
        if(way) order.reverse();                                        // reverse carriageway: travel runs down the indices
        let km=0, vkm=0, offKm=0, elKm=0, sevKm=0, t=when.getTime(), cut=null; const done=[];
        // a straight desert road can be ONE segment 40+ km long: walk it in
        // steps of at most 1 km, so the sun is checked where the car really is
        drive: for(const i of order){
          const hdg=way?(rd.brg[i]+180)%360:rd.brg[i], ridge=way?rd.ridgeBack[i+1]:rd.ridge[i];
          const A=way?[rd.lat[i+1],rd.lon[i+1]]:[rd.lat[i],rd.lon[i]], B=way?[rd.lat[i],rd.lon[i]]:[rd.lat[i+1],rd.lon[i+1]];
          const L=haversine(A,B)/1000, n=Math.max(1,Math.ceil(L)), dl=L/n;
          for(let q=0;q<n;q++){
            const fr=q/n, la=A[0]+(B[0]-A[0])*fr, lo=A[1]+(B[1]-A[1])*fr, sp=sunPosition(new Date(t),la,lo);
            const off=angleDiff(hdg,sp.az);
            if(sp.el<band[0]||sp.el>band[1]||sp.el<ridge||off>this.coreDeg){ if(q>0){ cut={i,frac:fr}; done.push(i); } break drive; }
            const sev=glareGeom(sp.el,sp.az,hdg).score;
            km+=dl; vkm+=dl*rd.aadt[i]; offKm+=dl*off; elKm+=dl*sp.el; sevKm+=dl*sev;
            t+=dl/kmh*3600000;
          }
          done.push(i);
        }
        if(!done.length){ a=b+1; continue; }
        const i0=Math.min(...done), j0=Math.max(...done)+1, mid=(i0+j0)>>1, sec=km/kmh*3600;
        if(km>0 && sec>=this.coreMinSec && rd.lat[mid]>=S_ && rd.lat[mid]<=N_ && rd.lon[mid]>=W_ && rd.lon[mid]<=E_){
          const perHour=vkm/km/2*share;          // drivers an hour, one direction, at this hour
          const score=sec*sevKm/km;               // one driver: seconds x how blinding (traffic is kept for information only)
          if(!best||score>best.score) best={rd,i:i0,j:j0,way,cut,km,sec,offAvg:offKm/km,elAvg:elKm/km,perHour,score,when};
        }
        a=b+1;
      }
    }
    return best;
  },

  /* Search a year: EVERY day at 5-minute steps (a 3 deg window lasts only
     about ten minutes), then 1-minute steps on the best day. Weekly sampling
     was tried first and missed roads: for a given heading the sun is dead
     ahead only on certain days, and its direction at a given height moves up
     to ~1.5 deg a day, so a week's jump can step right over a road's window.
     Yields to the page between days so the button can show progress. */
  async searchYear(box,progress){
    const today=new Date(); today.setHours(0,0,0,0);
    const corners=[[box[0],box[1]],[box[0],box[3]],[box[2],box[1]],[box[2],box[3]]];
    const band=this.elBand();
    const lowSun=t=>corners.some(([a,b])=>{ const el=sunPosition(t,a,b).el; return el>=band[0]-0.5 && el<=band[1]+0.5; });
    const day=(d,step)=>{ let b=null;
      for(let m=0;m<1440;m+=step){
        const t=new Date(d.getFullYear(),d.getMonth(),d.getDate(),Math.floor(m/60),m%60);
        if(!lowSun(t)) continue;
        const r=this.bestRunAt(t,box); if(r&&(!b||r.score>b.score)) b=r;
      }
      return b; };
    const pause=()=>new Promise(r=>setTimeout(r,0));
    let best=null;
    for(let k=0;k<365;k++){
      const r=day(new Date(today.getFullYear(),today.getMonth(),today.getDate()+k),5);
      if(r&&(!best||r.score>best.score)) best=r;
      if(k%5===0){ progress(Math.round(k/365*95)); await pause(); }
    }
    if(!best) return null;
    const b=best.when, r=day(new Date(b.getFullYear(),b.getMonth(),b.getDate()),1);
    if(r&&r.score>best.score) best=r;
    progress(100);
    return best;
  },

  /* a search result as data for data/demo_drives.json: the drive itself
     (lead-in, glare, run-out) is stored, so Plan a trip needs no highway file */
  presetOf(best){
    const r=this.routeForRun(best);
    return {label:r.label, coords:r.route.pts.map(p=>[+p[0].toFixed(5),+p[1].toFixed(5)]), leadM:Math.round(r.leadM),
            sec:best.sec, km:best.km, offAvg:best.offAvg, elAvg:best.elAvg, perHour:best.perHour, score:best.score,
            when:best.when.toISOString(), band:this.elBand(), rank:this.rankVersion};
  },

  /* The most blinding stretch in a region, as a trip the planner can load:
     {name, when, coords, durs, distance, duration, stats}. From
     data/demo_drives.json when it is still valid, otherwise searched now
     (which needs the highway file: loaded here if the map hasn't been opened). */
  async worstTrip(key,progress){
    const reg=this.regions[key];
    await this.presetsReady;
    let p=this.presets&&this.presets[key];
    if(!p || new Date(p.when)<new Date() || !p.band || p.band.join()!==this.elBand().join() || p.rank!==this.rankVersion){
      if(!this.roads && !(await this.load())) return null;
      const best=await this.searchYear(reg.box,progress||(()=>{}));
      if(!best) return null;
      p=this.presetOf(best);
      (this.presets=this.presets||{})[key]=p;
    }
    return {name:p.label, when:new Date(p.when), region:reg.name, stats:p, route:this.tripRoute(p.coords,p.label)};
  },
  /* highway points -> a route the planner can use: a point every ~100 m
     (highway data on a straight desert road has vertices kilometres apart,
     and the planner scores point by point), highway speed for the times */
  tripRoute(pts,label){
    const coords=[pts[0]];
    for(let k=1;k<pts.length;k++){ const a=pts[k-1], b=pts[k], n=Math.max(1,Math.ceil(haversine(a,b)/100));
      for(let q=1;q<=n;q++) coords.push([a[0]+(b[0]-a[0])*q/n, a[1]+(b[1]-a[1])*q/n]); }
    const cum=[0]; for(let k=1;k<coords.length;k++) cum.push(cum[k-1]+haversine(coords[k-1],coords[k]));
    const speed=REPLAY.defaultSpeed, durs=cum.slice(1).map((c,k)=>(c-cum[k])/speed);
    return {coords, durs, distance:cum[cum.length-1], duration:cum[cum.length-1]/speed, label:"fastest", roads:label};
  },

  /* A glare run as a drivable route: a couple of km of lead-in so the warning
     visibly comes on, the glare itself (up to 15 km), then a short run-out,
     all in the direction that faces the sun. */
  routeForRun(w){
    const {rd,i,j}=w, at=k=>[rd.lat[k],rd.lon[k]];
    // vertex indices in travel order: segment k runs vertex k -> k+1 (or back, if reversed)
    let order=[]; for(let k=i;k<=j;k++) order.push(k);
    order=[...new Set(w.way ? order.map(k=>k+1).reverse().concat([i]) : order.concat([j]))];
    const lenOf=ids=>{ let m=0; for(let q=1;q<ids.length;q++) m+=haversine(at(ids[q-1]),at(ids[q])); return m; };
    while(order.length>2 && lenOf(order)>60000) order.pop();      // the whole glare run (a long straight desert road can be 40+ km)
    const step=w.way?1:-1;                                         // walking BACK from the first vertex
    // run-up of exactly 2.5 km and run-out of 1 km: desert roads have vertices
    // kilometres apart, so stop part-way along the last piece instead of at a vertex
    const walk=(k0,dir,limit)=>{ const out=[]; let m=0, prev=at(k0);
      for(let k=k0+dir; k>=0 && k<rd.n; k+=dir){
        const p=at(k), d=haversine(prev,p);
        if(m+d>=limit){ const f=(limit-m)/d; out.push([prev[0]+(p[0]-prev[0])*f, prev[1]+(p[1]-prev[1])*f]); return out; }
        out.push(p); m+=d; prev=p;
      }
      return out; };
    const leadPts=walk(order[0],step,2500).reverse(), glPts=order.map(at);
    let tailPts;
    if(w.cut && glPts.length>=2){
      // the glare ended part-way along the last (long) segment: stop the drive there, + a 1 km run-out
      const A=glPts[glPts.length-2], B=glPts[glPts.length-1], L=Math.max(1,haversine(A,B));
      const ip=f=>[A[0]+(B[0]-A[0])*f, A[1]+(B[1]-A[1])*f];
      glPts[glPts.length-1]=ip(w.cut.frac); tailPts=[ip(Math.min(1,w.cut.frac+1000/L))];
    } else tailPts=walk(order[order.length-1],-step,1000);
    const pts=leadPts.concat(glPts,tailPts);
    // per point: the nearest vertex's ridge and traffic (run-up/run-out points use the end vertices)
    const vOf=q=>q<leadPts.length?order[0]:q>=leadPts.length+order.length?order[order.length-1]:order[q-leadPts.length];
    const ridge=pts.map((_,q)=>{ const k=vOf(q); return w.way?rd.ridgeBack[k]:rd.ridge[k]; });   // looking the way the car drives
    const aadt=pts.map((_,q)=>rd.aadt[clamp(w.way?vOf(q)-1:vOf(q),0,rd.n-2)]);
    const hdg=bearing(pts[0],pts[pts.length-1]);
    const label=(rd.route?routeName(rd.route)+" ":"")+bound(hdg,rd.route);
    const lenPts=a=>{ let m=0; for(let q=1;q<a.length;q++) m+=haversine(a[q-1],a[q]); return m; };
    return {label, leadM:leadPts.length?lenPts(leadPts.concat([at(order[0])])):0,
            route:routeFromPts(`${label} (${(lenPts(pts)/1000).toFixed(1)} km)`,pts,REPLAY.defaultSpeed,{ridge,aadt})};
  },

  /* Tap a highway: replay ~12 km of it from the tapped point, in the
     direction the map scores it. */
  pickRoad(e){
    if(!this.roads) return;
    const map=APP.map, p=e.containerPoint, b=map.getBounds();
    // Divided highways are stored as two one-way roads lying side by side. Of
    // the roads under the finger, replay the direction that faces the sun --
    // that's the one the user is looking at when they tap a red stretch.
    const near=new Map();                                     // road -> its closest vertex
    for(const rd of this.roads){
      if(rd.b[2]<b.getSouth()||rd.b[0]>b.getNorth()||rd.b[3]<b.getWest()||rd.b[1]>b.getEast()) continue;
      // distance to each drawn segment, not just its end points: zoomed in, the
      // points of a long straight stretch can be far apart on screen
      let q0=map.latLngToContainerPoint([rd.lat[0],rd.lon[0]]);
      for(let i=0;i<rd.n-1;i++){
        const q1=map.latLngToContainerPoint([rd.lat[i+1],rd.lon[i+1]]);
        const vx=q1.x-q0.x, vy=q1.y-q0.y, L2=vx*vx+vy*vy;
        const f=L2?clamp(((p.x-q0.x)*vx+(p.y-q0.y)*vy)/L2,0,1):0;
        const d=Math.hypot(q0.x+f*vx-p.x,q0.y+f*vy-p.y);
        if(d<14 && (!near.has(rd)||d<near.get(rd).d)) near.set(rd,{rd,i,d});
        q0=q1;
      }
    }
    if(!near.size){ $("rInfo").textContent="No highway there. Zoom in and tap right on a road."; return; }
    $("rInfo").textContent="Tap any highway to see its glare right now.";
    // Each road is drawn in ONE direction (often both carriageways the same
    // way). Consider every direction traffic may actually take there.
    const sun=sunPosition(APP.when,e.latlng.lat,e.latlng.lng), opts=[];
    for(const c of near.values()){
      const s=Math.min(c.i,c.rd.n-2), b0=c.rd.brg[s], d=c.rd.dir[s];
      if(d!==2) opts.push({...c,rev:false,facing:angleDiff(b0,sun.az)});
      if(d!==1) opts.push({...c,rev:true,facing:angleDiff((b0+180)%360,sun.az)});
    }
    const {rd,i,rev}=opts.sort((a,b)=>a.facing-b.facing)[0];
    const at=k=>[rd.lat[k],rd.lon[k]];
    // ~12 km from the tap in the chosen direction; if the road ends sooner, extend behind the tap
    const step=rev?-1:1; let k=rev?i+1:i, m=0; const pts=[];
    const ridge=[], rg=k=>rev?rd.ridgeBack[k]:rd.ridge[k];      // ridge looking the way the car drives
    const aadt=[], tr=k=>rd.aadt[clamp(rev?k-1:k,0,rd.n-2)];        // traffic on the piece ahead
    while(k>=0 && k<rd.n && m<12000){ pts.push(at(k)); ridge.push(rg(k)); aadt.push(tr(k)); if(k+step>=0&&k+step<rd.n) m+=haversine(at(k),at(k+step)); k+=step; }
    for(let j=(rev?i+2:i-1); m<4000 && j>=0 && j<rd.n; j-=step){ pts.unshift(at(j)); ridge.unshift(rg(j)); aadt.unshift(tr(j)); m+=haversine(at(j),pts[1]); }
    if(pts.length<2) return;
    const hdg=bearing(pts[0],pts[pts.length-1]);
    const name=`${rd.route?routeName(rd.route)+" ":"Highway "}${bound(hdg,rd.route)}`;
    // this piece, this direction, right now: the same tests as the map's colours
    const s=Math.min(i,rd.n-2), segHdg=rev?(rd.brg[s]+180)%360:rd.brg[s], ridgeHere=rev?rd.ridgeBack[s+1]:rd.ridge[s];
    const g=glareGeom(sun.el,sun.az,segHdg), off=signedOff(segHdg,sun.az);
    const cl=APP.useWeather?cloudAt(e.latlng.lat,e.latlng.lng,APP.when.getTime()):null;
    let tier=applySky(g.tier,APP.useWeather?skyFactor(cl):1), why;
    if(sun.el<=0){ tier="none"; why="The sun is down."; }
    else if(sun.el<ridgeHere && g.tier!=="safe"){ tier="blocked"; why=`Hills block the sun here (ridge ${ridgeHere.toFixed(1)}&deg; up).`; }
    else why=`Sun ${sun.el.toFixed(0)}&deg; up, ${Math.abs(off)<1?"straight ahead":Math.round(Math.abs(off))+"&deg; "+(off<0?"left":"right")+" of straight ahead"}`+
             (cl!=null&&cl>=30?`, ${cl}% cloud`:"")+".";
    const [cls,word]=BANNER[tier]||BANNER.safe;
    const perHour=Math.round(rd.aadt[s]*trafficShare(APP.when)/2/10)*10;
    const box=document.createElement("div");
    box.style.cssText="font:13px system-ui,sans-serif;line-height:1.45;min-width:210px";
    box.innerHTML=`<b>${name}</b><br><span style="display:inline-block;margin:4px 0;padding:1px 8px;border-radius:6px;color:#fff;font-weight:800;background:var(--${cls})">${word}</span>`+
      ` at ${clockText(APP.when)}<br>${why}<br><span style="color:#666">About ${perHour.toLocaleString()} drivers an hour this way, at this time.</span><br>`;
    const btn=document.createElement("button");
    btn.textContent="Watch this drive"; btn.className="primary"; btn.style.cssText="margin-top:7px;width:100%";
    btn.onclick=()=>{ APP.map.closePopup();
      const route=this.tripRoute(pts,name);
      PLAN.loadTrip({name, when:APP.when, route,
        prefix:`<b>${name}</b>, tapped on the Highway glare map: ${(route.distance/1609.34).toFixed(1)} mi at ${clockText(APP.when)}. `}); };
    box.appendChild(btn);
    L.popup({maxWidth:280}).setLatLng(e.latlng).setContent(box).openOn(APP.map);
  }
};

/* "8" -> "I-8", "101" -> "US-101", "52" -> "SR-52". */
const INTERSTATES=new Set(["5","8","10","15","40","80","105","110","205","210","238","280","380","405","505","580","605","680","710","780","805","880","980"]);
const US_ROUTES=new Set(["6","50","95","97","101","199","395"]);
function routeName(n){ return (INTERSTATES.has(n)?"I-":US_ROUTES.has(n)?"US-":"SR-")+n; }
/* Direction as the signs say it. Highways are signed by number: odd routes
   north/south, even routes east/west -- so southbound I-5 is "southbound" even
   where it runs southeast. Without a route, the nearest compass point. */
function bound(hdg,route){
  const r=Math.PI/180, n=parseInt(route,10);
  if(!isNaN(n)) return n%2 ? (Math.cos(hdg*r)>=0?"northbound":"southbound") : (Math.sin(hdg*r)>=0?"eastbound":"westbound");
  return ["northbound","eastbound","southbound","westbound"][Math.round(hdg/90)%4];
}
