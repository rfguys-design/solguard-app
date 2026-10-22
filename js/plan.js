/* Drive tab: plan a route (driving mode is js/drive.js).
   Enter a destination and a departure (the shared date + time bar), and the
   route is coloured by predicted glare at the moment you'd reach each stretch.
   Drag the time and the whole route recolours. "Find a shadier route" scores
   detours and leave-earlier / leave-later options; "Watch this drive" replays
   the trip second by second through the same classifier the car uses.

   Scope note: per-segment scoring uses sun elevation + heading-vs-sun angle +
   cloud + BUILDINGS (js/buildings.js: OpenStreetMap footprints along the
   route, a ray cast toward the sun) + HILLS (js/terrain.js: the horizon from
   the elevation model, the same test as the statewide map). */

const PLAN_CFG={
  aheadDeg:10,                       // |off-axis| within this reads as "straight ahead"
  sampleSec:2,                       // time spacing between scored points
  maxRoutePoints:400,                // hard cap on scored points
  detourOffsetsM:[400,900,1600],    // how far to the side a parallel road may be
  overBudgetShowFrac:0.5,           // show an over-time-limit route anyway if it at least halves glare
  angledOffDeg:35, angledRangeDeg:25, // "angled away from the sun": streets 10-60 deg off its direction
  maxZonesToAvoid:2,                 // bypass the two worst glare zones
  maxDetourProbes:12,                // cap on near-zone bypass calls
  gridAlong:[0.2,0.35,0.5,0.65,0.8], // area search: waypoint positions along the trip (fraction of its length)
  gridAcross:[-0.35,-0.2,-0.1,0.1,0.2,0.35], // ...and to either side (fraction of its length)
  endClearM:1500,                    // no detour waypoints this close to the start or the end
  loopRevisitM:40, loopGapM:600,     // a route coming back within 40 m of where it was 600+ m earlier = a loop
  detourPenaltyPerMin:300,           // blended cost: 1 extra min == this many glare-metres
  minGlareReductionM:150,            // only call it "shadier" if it cuts at least this much
  departureSweepMin:60, departureStepMin:10, maxShiftMin:30,
  reasonableGlareFrac:0.5,           // "leave later" aims to HALVE glare, not eliminate it
  routeSimilarThresh:0.97, routeSimilarDistM:80,   // only near-identical routes count as "the same"
  maxOptions:6, optionMinGlareDiffM:240, optionMinTimeDiffS:120
};

const PLAN={
  from:null, to:null, fromMk:null, toMk:null, routes:[], selected:0,
  group:null, maxDetourMin:10, trips:[],

  init(){
    this.group=L.layerGroup();
    APP.tabs.plan={
      onShow:()=>{ this.group.addTo(APP.map); if(this.routes.length) this.recompute(); },
      onHide:()=>{ REPLAY.stop(); APP.map.removeLayer(this.group); },
      onWhen:()=>this.refresh(),
      onWeather:()=>this.recompute()
    };
    APP.map.on("click",e=>{
      if(APP.tab!=="plan"||REPLAY.active) return;
      this.to=[e.latlng.lat,e.latlng.lng]; this.setMarker("to",this.to);
      $("toIn").value="dropped pin"; this.checkReady();
    });
    $("gpsBtn").onclick=()=>{
      if(!("geolocation" in navigator)){ this.note("This browser has no location access."); return; }
      $("gpsBtn").textContent="Locating...";
      navigator.geolocation.getCurrentPosition(p=>{
        this.from=[p.coords.latitude,p.coords.longitude]; this.setMarker("from",this.from);
        $("fromIn").value="my location"; $("gpsBtn").textContent="My location"; APP.map.setView(this.from,13);
      },()=>{ $("gpsBtn").textContent="My location"; this.note("Location unavailable. Type a start address instead."); },
      {enableHighAccuracy:true,timeout:8000});
    };
    // suggestions as you type (Photon): picking one sets the exact place
    suggestBox("fromIn",()=>{ this.from=null; },ll=>{ this.from=ll; this.setMarker("from",ll); });
    suggestBox("toIn",()=>{ this.to=null; this.checkReady(); },ll=>{ this.to=ll; this.setMarker("to",ll); this.checkReady(); },
               ()=>{ if(!$("planBtn").disabled) this.doPlan(); });
    for(const id of ["fromIn","toIn"]) $(id).addEventListener("keydown",e=>{ if(e.key==="Enter" && !e.defaultPrevented && !$("planBtn").disabled) this.doPlan(); });
    $("planBtn").onclick=()=>this.doPlan();
    $("shadierBtn").onclick=()=>this.findShadier();
    $("exToggle").onclick=()=>$("planExamples").classList.toggle("open");
    // no destination: live warnings wherever you drive (sensors must start inside the tap)
    // a route up or a destination typed: drive there; neither: live warnings wherever you drive
    $("justDriveBtn").onclick=()=>{
      if(this.routes.length && this.to){ this.driveRoute(); return; }
      if(!window.isSecureContext) status("Live GPS needs HTTPS: open the deployed https:// address on the phone.");
      APP.show("drive"); DRIVE.start();
      if($("toIn").value.trim()) this.driveTo();
    };
    $("watchBtn").onclick=()=>this.watch();
    $("navBtn").onclick=()=>this.driveRoute();
    $("timingUse").onclick=()=>{ if(this.tipWhen) APP.setWhen(this.tipWhen); };   // refresh() then hides the tip
    $("detourMin").onchange=e=>{ const v=parseInt(e.target.value); if(!isNaN(v)&&v>=0) this.maxDetourMin=v; };

    fetch("data/demo_routes.json").then(r=>r.ok?r.json():{trips:[]}).then(j=>{
      this.trips=j.trips||[];
      this.exampleCards();
    }).catch(()=>{});
  },

  /* Three example cards: the two most blinding stretches (desert highways, the worst glare one driver
     meets) and one everyday commute, which is also the welcome demo and shows what the desert can't:
     other routes, a shadier route, buildings and hills, a better time to leave. */
  async exampleCards(){
    const box=$("examples"); box.innerHTML="";
    const card=(eyebrow,title,meta,cls,go)=>{
      const b=document.createElement("button"); b.className="excard"+(cls?" "+cls:"");
      b.innerHTML=`<span class="ex-eye">${eyebrow}</span><b>${title}</b><span class="ex-meta">${meta}</span>`;
      b.onclick=()=>{ $("planExamples").classList.remove("open"); go(); }; box.appendChild(b);
    };
    await HEATMAP.presetsReady;
    const P=HEATMAP.presets||{};
    for(const [k,region] of [["sd","San Diego County"],["ca","California"]]){
      const p=P[k], dir=s=>s.replace(/bound$/,"");
      if(!p){ card("Most blinding stretch · "+region,"Find it","Searches the next 12 months","worst",()=>this.loadWorst(k)); continue; }
      const when=new Date(p.when).toLocaleString([],{month:"short",day:"numeric",hour:"numeric",minute:"2-digit"});
      card("Most blinding stretch · "+region, dir(p.label)+(p.from?` · ${p.from}${p.toward?", toward ":" &rarr; "}${p.to}`:""),
           `${when} · ${Math.max(1,Math.round(p.sec/60))} min of glare`,"worst",()=>this.loadWorst(k));
    }
    const t=this.trips.find(x=>x.id==="elcajon-ob");
    if(t) card("Everyday commute","I-8 west · El Cajon &rarr; Ocean Beach",
               (t.when==="evening"?"Evening":"Morning")+" · watch the route turn red","",()=>this.loadExample(t));
  },

  note(html){ $("note").innerHTML=html; },
  checkReady(){ $("planBtn").disabled=!(this.to||$("toIn").value.trim()); },
  setMarker(which,ll){
    const key=which==="from"?"fromMk":"toMk";
    if(this[key]) this[key].setLatLng(ll);
    else this[key]=L.marker(ll,{title:which}).addTo(this.group);
  },

  /* Example trips use routes saved in data/demo_routes.json, so they work even
     if the free routing server is down. The time is set to when the sun is
     actually low for that direction on the chosen date. */
  async loadExample(t){
    REPLAY.stop();
    this.from=t.from; this.to=t.to;
    $("fromIn").value=t.name.split(" → ")[0]; $("toIn").value=t.name.split(" → ")[1].replace(/ \(.*\)/,"");
    this.checkReady();
    this.setMarker("from",this.from); this.setMarker("to",this.to);
    this.routes=t.routes.map(r=>Object.assign({},r)); this.selected=0; this.notePrefix="";
    this.note("Finding the departure with the most glare for your settings...");
    await TERRAIN.ensure(this.routes[0].coords.filter((_,i)=>i%6===0));   // hills decide the lowest sun
    const pick=SENS.with(CONFIG.demoLimit,()=>this.worstDeparture(t));   // the tight limit, not the driver's setting
    APP.setWhen(pick.dep,true); shadeSetDate(pick.dep);
    await this.afterRoutes();
    const day=d=>d.toLocaleDateString([], {weekday:"short",month:"short",day:"numeric"});
    this.notePrefix=((pick.today?"Departure set to <b>"+clockText(pick.dep)+"</b>, the worst glare that day. "
      :pick.found?"Not much glare on "+day(pick.asked)+", so the example moved to <b>"+day(pick.dep)+", "+clockText(pick.dep)+"</b>. "
      :"No strong glare on this trip in the next 6 months. "));
    this.recompute();
  },

  /* An example should SHOW glare. Run under CONFIG.demoLimit (a tight
     setting), so the pick is glare under any looser one and does not change
     when the driver moves the sliders. Try every
     departure 5 min apart through that day's low-sun window (evening or
     morning), and keep the one with the most glare (the same projectRoute
     scoring the planner uses, hills included; buildings load later). If the
     chosen day has none, step forward 3 days at a time, up to ~6 months. */
  worstDeparture(t){
    const r=this.routes[0], mid=r.coords[Math.floor(r.coords.length/2)], base=APP.when;
    const enough=800;                                   // at least ~0.5 mi of glare
    let best=null;
    for(let day=0; day<=180; day+=(day===0?1:3)){
      const d=new Date(base.getFullYear(),base.getMonth(),base.getDate()+day,12);
      const tm=SunCalc.getTimes(d,mid[0],mid[1]);
      // the window: from the sun 30 deg up to sunset (evening), or sunrise to 30 deg up (morning)
      let a,b;
      if(t.when==="evening"){ a=new Date(tm.sunset.getTime()-150*60000); b=tm.sunset; }
      else { a=new Date(tm.sunrise.getTime()-20*60000); b=new Date(tm.sunrise.getTime()+150*60000); }
      let dayBest=null;
      for(let ms=a.getTime(); ms<=b.getTime(); ms+=5*60000){
        const dep=new Date(ms); dep.setSeconds(0,0); dep.setMinutes(Math.round(dep.getMinutes()/5)*5);
        const e=projectRoute(r,dep).exposed;
        if(!dayBest||e>dayBest.e) dayBest={dep,e};
      }
      if(day===0) best={dep:dayBest.dep,e:dayBest.e,today:true,found:true,asked:base};
      if(dayBest.e>=enough){ return day===0?best:{dep:dayBest.dep,e:dayBest.e,today:false,found:true,asked:base}; }
    }
    best.today=best.e>=enough; best.found=false;
    return best;
  },

  /* A highway stretch as a trip (fixed moment): from the Glare map's tap
     popup, or a "most blinding stretch". Every planner tool works on it. */
  async loadTrip(w){
    APP.show("plan"); REPLAY.stop();
    const c=w.route.coords;
    this.from=c[0]; this.to=c[c.length-1];
    $("fromIn").value=w.name+" (start)"; $("toIn").value=w.name+" (end)"; this.checkReady();
    this.setMarker("from",this.from); this.setMarker("to",this.to);
    this.routes=[Object.assign({},w.route)]; this.selected=0;
    APP.setWhen(w.when,true); shadeSetDate(w.when);
    this.notePrefix=w.prefix||"";
    await this.afterRoutes();
  },
  /* A "most blinding stretch": one highway stretch, one direction, one
     moment (fixed: the moment is the point). */
  async loadWorst(key){
    REPLAY.stop(); this.notePrefix="";
    this.note("Loading the most blinding stretch...");
    const w=await HEATMAP.worstTrip(key,p=>this.note("Searching the next 12 months... "+p+"%"));
    if(!w){ this.note("No dead-centre glare found."); return; }
    const L=CONFIG.demoLimit, st=w.stats;
    w.prefix=`<b>Most blinding stretch in ${w.region}</b>: ${w.name}, `+
      w.when.toLocaleString([], {weekday:"short",month:"short",day:"numeric",year:"numeric",hour:"numeric",minute:"2-digit"})+
      `. The sun is ${st.elAvg.toFixed(0)}&deg; up and ${st.offAvg.toFixed(1)}&deg; from straight ahead for ${fmtSec(st.sec)} without a break: `+
      `the longest, most blinding glare one driver meets on a state highway in the next 12 months. The drive starts ${(st.leadM/1000).toFixed(1)} km early so you see it come on. `+
      `Picked with a tight glare limit (${L.left}&deg; left, ${L.right}&deg; right, visor ${L.visor}&deg;), so it is glare at any looser setting. `;
    await this.loadTrip(w);
  },

  async doPlan(){
    REPLAY.stop(); this.notePrefix="";
    try{
      this.note("Finding route...");
      const fromTxt=$("fromIn").value.trim(), toTxt=$("toIn").value.trim();
      // typing clears the place (oninput), so a set place is a picked suggestion, GPS fix or pin: keep it
      if(fromTxt && !this.from) this.from=await geocode(fromTxt);
      if(toTxt   && !this.to)   this.to  =await geocode(toTxt);
      if(!this.from||!this.to){ this.note("Need both a start and a destination."); return; }
      this.setMarker("from",this.from); this.setMarker("to",this.to);
      this.routes=await fetchRoutes(this.from,this.to); this.selected=0;
      await this.afterRoutes();
    }catch(err){ this.note("Could not plan the route: "+err.message+". Try an example trip above."); }
  },

  async afterRoutes(){
    this.hideTip();
    APP.map.invalidateSize();                           // phones: the map may have just been laid out
    APP.map.fitBounds(L.latLngBounds(this.routes[0].coords),APP.fitOpts());
    $("planActions").style.display=""; $("planReplay").style.display=""; $("detourRow").style.display="";
    $("planResults").style.display="flex"; document.body.classList.add("has-route");
    this.recompute();                                   // draw now, sky fills in when it arrives
    await this.loadSky();
    this.recompute(); this.updateTip();
    // buildings can take ~30 s on the free servers: load them in the background, redraw when they arrive
    const routes=this.routes;
    this.loadBuildings().then(()=>{ if(this.routes===routes){ this.recompute(); this.updateTip(); } });
  },

  /* OpenStreetMap buildings along every listed route (js/buildings.js). */
  async loadBuildings(){
    if(!this.routes.length) return;
    const routes=this.routes, pts=[]; routes.forEach(r=>r.coords.forEach((c,i)=>{ if(i%4===0) pts.push(c); }));
    this.bldState="loading";
    // hills load fast (a few dozen elevation tiles): redraw as soon as they're in
    const hills=TERRAIN.ensure(pts).then(()=>{ if(this.routes===routes) this.recompute(); });
    await Promise.all([BLD.ensure(pts),hills]);
    const r=this.routes[this.selected];
    this.bldState=r.coords.filter((_,i)=>i%10===0).every(c=>BLD.covered(c[0],c[1]))?"ok":"part";
    if(!BLD.ready()) this.bldState="fail";
    // the free servers are often busy: try the missing areas again in the
    // background (twice), and redraw when they arrive
    if(this.bldState!=="ok" && (this._bldRetry=(this._bldRetry||0)+1)<=2)
      setTimeout(async()=>{ if(this.routes!==routes) return;
        await this.loadBuildings(); if(this.routes===routes) this.recompute(); }, BLD.retryAfterMs+1000);
    else if(this.bldState==="ok") this._bldRetry=0;
  },
  bldNote(proj){
    if(this.bldState==="loading") return " Checking buildings along the way...";
    if(this.bldState==="fail") return " Building data didn't load (OpenStreetMap server busy): buildings not counted.";
    const mi=x=>(x/1609.34).toFixed(1);
    const part=this.bldState==="part"?" (building data for part of the route only)":"";
    const hill=proj.pts.filter(p=>p.bldg&&p.bldg.kind==="hill").length, bld=proj.pts.filter(p=>p.bldg&&p.bldg.kind!=="hill").length;
    const what=hill&&bld?"Hills and buildings":hill?"Hills":"Buildings";
    return proj.shaded>=80?" "+what+" shade <b>"+mi(proj.shaded)+" mi</b> where the sun would otherwise be in your eyes"+part+"."
                          :(this.bldState?" No hill or building shades the glare stretches"+part+".":"");
  },

  /* Cloud cover along every candidate route, for the trip window plus the
     hour either side (the leave-earlier / leave-later options need it). */
  async loadSky(){
    if(!this.routes.length) return;
    const pts=[]; this.routes.forEach(r=>r.coords.forEach((c,i)=>{ if(i%15===0) pts.push(c); }));
    const t0=APP.when.getTime(), dur=Math.max(...this.routes.map(r=>r.duration))*1000;
    await wxEnsure(pts,t0-PLAN_CFG.departureSweepMin*60000,t0+dur+PLAN_CFG.departureSweepMin*60000);
  },
  refresh(){                                            // the shared date/time changed
    this.notePrefix="";                                 // "departure set to..." no longer true
    if(!this.routes.length) return;
    this.routes=this.routes.filter(r=>!r._delayMin);    // leave-later options were relative to the old time
    this.hideTip();                                     // the tip was relative to the old time too
    this.selected=Math.min(this.selected,this.routes.length-1);
    this.recompute(); this.loadSky().then(()=>{ this.recompute(); this.updateTip(); });
  },

  candDate(rt){ return new Date(APP.when.getTime()+(rt._delayMin||0)*60000); },

  recompute(){
    if(!this.routes.length) return;
    const r=this.routes[this.selected], dep=this.candDate(r);
    const proj=projectRoute(r,dep);
    this.draw(proj); this.stats(proj); this.renderAlts();
    const p0=r.coords[0], cl=cloudAt(p0[0],p0[1],dep.getTime());
    const sky = !APP.useWeather ? "Weather is off: clear sky assumed."
      : (cl===null ? (cloudLoaded(p0[0],p0[1],dep.getTime())
                       ? "No weather data for this date: clear sky assumed."
                       : "Loading cloud cover...")
                   : "Sky at the start: ~"+cl+"% cloud"+(skyFactor(cl)<0.6?" (glare reduced)":"")+".");
    const when=clockText(dep);
    this.note((this.notePrefix||"")+(proj.hotspots
      ? "<b>"+proj.hotspots+" glare zone(s)</b> leaving at "+when+" &middot; "+glarePhrase(proj)+". Tap a ! marker for the numbers."
      : "<b>No glare zones</b> leaving at "+when+".")+this.bldNote(proj)+" "+sky);
    status("Route by OSRM, places by Photon (OpenStreetMap data), cloud by Open-Meteo.");
  },

  draw(proj){
    this.group.eachLayer(l=>{ if(l!==this.fromMk && l!==this.toMk) this.group.removeLayer(l); });
    let run=[proj.pts[0].ll], runCol=gradeColor(proj.pts[0]);
    for(let k=1;k<proj.pts.length;k++){
      const col=gradeColor(proj.pts[k]);
      run.push(proj.pts[k].ll);
      if(col!==runCol || k===proj.pts.length-1){
        L.polyline(run,{color:runCol,weight:6,opacity:.95}).addTo(this.group);
        run=[proj.pts[k].ll]; runCol=col;
      }
    }
    proj.pts.forEach(p=>{ if(!p.hotspot) return;
      const t=clockText(p.when);
      const popup="<div style='font:12px system-ui;line-height:1.5'><b>Glare at "+t+"</b><br>"+
        "sun elevation: <b>"+p.sunEl.toFixed(1)+"&deg;</b><br>"+
        "sun azimuth: <b>"+Math.round(p.sunAz)+"&deg;</b><br>"+
        "your heading: <b>"+Math.round(p.hdg)+"&deg;</b><br>"+
        "sun off your heading: <b>"+Math.round(p.dAng)+"&deg;</b><br>"+
        "cloud: <b>"+(p.cloud===null?"unknown":p.cloud+"%")+"</b><br>"+
        "lasts: <b>"+Math.round(p.runSec)+" s</b></div>";
      L.marker(p.ll,{icon:L.divIcon({className:"",html:'<div class="hot">!</div>',iconSize:[22,22]})})
        .addTo(this.group).bindTooltip("Glare ~"+t+" · "+Math.round(p.runSec)+" s",{direction:"top"})
        .bindPopup(popup);
    });
  },

  stats(){ /* the numbers sit on the selected route's card now (renderAlts) */ },

  /* One card per route, Google Maps style: the selected card opens up with
     the numbers and the buttons (Drive, Watch, Find a shadier route). */
  renderAlts(){
    const box=$("alts"), act=$("planActions");
    $("pane-plan").appendChild(act);                    // park the buttons while the cards are rebuilt
    box.innerHTML="";
    // time: the fastest route in minutes, every other one as "+N min" next to it
    const fast=Math.min(...this.routes.map(r=>r.duration));
    this.routes.forEach((rt,i)=>{
      const dep=this.candDate(rt), proj=projectRoute(rt,dep), sel=i===this.selected;
      const div=document.createElement("div");
      div.className="alt"+(sel?" sel":"");
      const base=rt._label||(rt.label?rt.label.charAt(0).toUpperCase()+rt.label.slice(1):"Route "+(i+1));
      const nm=(rt._tag?"<b>"+rt._tag+"</b>"+(rt._tag!==base?" · "+base:""):base)+(rt.roads?' <span class="meta">via '+rt.roads+'</span>':"");
      const bad=proj.exposed>=80;
      const glare=(bad?(proj.exposed/1609.34).toFixed(1)+" mi in glare":glarePhrase(proj))+
        (sel&&proj.hotspots?" · "+proj.hotspots+" glare zone"+(proj.hotspots>1?"s":""):"");
      div.innerHTML='<div class="alt-top"><span class="alt-name">'+nm+'</span><span class="alt-min">'+(rt.duration-fast<30?Math.round(rt.duration/60)+' min':'+'+Math.max(1,Math.round((rt.duration-fast)/60))+' min')+'</span></div>'+
        '<div class="alt-sub">'+(rt.distance/1609.34).toFixed(1)+' mi'+(rt._delayMin?" · leave "+clockText(dep):"")+
        ' · <span class="alt-glare '+(bad?"bad":"ok")+'">'+glare+'</span></div>';
      if(sel){ div.appendChild(act); act.style.display=""; }
      else div.onclick=()=>{ this.selected=i; this.recompute(); };
      box.appendChild(div);
    });
  },

  hideTip(){ $("timingTip").style.display="none"; this.tipWhen=null; },
  /* Would leaving a little earlier or later cut the glare on the fastest
     route? Tries 10-30 min either way; aims to halve the glare, settles for
     any real cut. Runs whenever the route or the departure changes. */
  updateTip(){
    this.hideTip();
    const spatial=this.routes.filter(r=>!r._delayMin);
    if(!spatial.length) return;
    const C=PLAN_CFG, dep=APP.when, primary=spatial.reduce((a,b)=>b.duration<a.duration?b:a);
    const primExp=projectRoute(primary,dep).exposed;
    if(primExp<C.minGlareReductionM) return;
    const option=(sign,label)=>{
      const s=[], cap=Math.min(C.departureSweepMin,C.maxShiftMin);
      for(let dm=C.departureStepMin; dm<=cap; dm+=C.departureStepMin)
        s.push({dm,exp:projectRoute(primary,new Date(dep.getTime()+sign*dm*60000)).exposed});
      const chosen=s.find(r=>r.exp<=primExp*C.reasonableGlareFrac)||s.find(r=>primExp-r.exp>=C.minGlareReductionM);
      return chosen?{_delayMin:sign*chosen.dm,_label:label(chosen.dm),_exp:chosen.exp}:null;
    };
    const t=[option(+1,dm=>"Leave "+dm+" min later"),option(-1,dm=>"Leave "+dm+" min earlier")]
      .filter(Boolean).sort((a,b)=>a._exp-b._exp)[0];
    if(t) this.showTip(t,primExp,dep);
  },
  /* Leaving at another time is advice, not a route -- and usually the bigger
     fix -- so it gets its own box above the route list, with a button. */
  showTip(t,primExp,dep){
    const mi=x=>(x/1609.34).toFixed(1), when=new Date(dep.getTime()+t._delayMin*60000);
    const cut=Math.round(100*(1-t._exp/primExp));
    $("timingText").innerHTML="<b>"+t._label+"</b> ("+clockText(when)+"). "+cut+"% less glare, "+mi(t._exp)+" mi instead of "+mi(primExp)+". No detour.";
    this.tipWhen=when; $("timingTip").style.display="";
  },

  /* Replay the selected trip through the live classifier. */
  watch(){
    if(!this.routes.length) return;
    const r=this.routes[this.selected];
    REPLAY.start(routeFromOsrm("planned trip",r),this.candDate(r),{line:false,onEnd:()=>{
      if(APP.tab==="plan") APP.map.fitBounds(L.latLngBounds(r.coords),APP.fitOpts()); }});
    NAV.start(r,"replay",{depart:this.candDate(r),dest:this.to});   // the directions card rides along, silently
    if(isPhone()){
      if(!VIEW.open){ VIEW.open=true; VIEW.layout(); VIEW.render(); }     // the windshield for the replay (not saved)
      setTimeout(()=>{ APP.map.invalidateSize(); $("navCard").scrollIntoView({block:"start",behavior:"smooth"}); },50);
    }
  },

  /* Drive this route for real: driving mode, GPS on, directions + glare alerts.
     DRIVE.start() must run inside the tap (phones only grant sensors then). */
  driveRoute(){
    if(!this.routes.length) return;
    const r=this.routes[this.selected];
    if(!window.isSecureContext) status("Live GPS needs HTTPS: open the deployed https:// address on the phone. Directions are shown, but the car won't move until GPS works.");
    APP.show("drive"); DRIVE.start();
    if(window.speechSynthesis){ try{ speechSynthesis.speak(new SpeechSynthesisUtterance("")); }catch(_){} }   // unlock speech inside the tap
    NAV.start(r,"live",{dest:this.to});
  },

  /* A destination but no planned route: the route starts from the car's first GPS fix (sensors are already on). */
  async driveTo(){
    if(window.speechSynthesis){ try{ speechSynthesis.speak(new SpeechSynthesisUtterance("")); }catch(_){} }
    try{
      const to=this.to||await geocode($("toIn").value.trim());
      const t0=Date.now();
      while(H.lat===null){
        if(!DRIVE.started) return;
        if(Date.now()-t0>30000) throw new Error("no GPS fix yet");
        await new Promise(r=>setTimeout(r,500));
      }
      const routes=await fetchRoutes([H.lat,H.lng],to);
      if(DRIVE.started && !NAV.active) NAV.start(routes[0],"live",{dest:to});
    }catch(err){ status("Could not get directions: "+err.message+". Glare warnings still work."); }
  },

  /* Avoid-the-glare routing: route through detour waypoints set perpendicular
     to the road at the worst glare zone and along the trip, score every
     candidate, add leave-earlier / leave-later options, keep the best few. */
  async findShadier(){
    const btn=$("shadierBtn"); btn.disabled=true; btn.textContent="Searching...";
    try{
      const dep=APP.when, C=PLAN_CFG;
      const spatialAll=this.routes.filter(r=>!r._delayMin);
      const primary=spatialAll.reduce((a,b)=>b.duration<a.duration?b:a, spatialAll[0]);
      // Candidates are scored WITHOUT buildings: their corridors aren't loaded,
      // and judging some routes with buildings and some without would be unfair.
      // Buildings are added to the final list once it is chosen.
      const noB={buildings:false};
      const primProj=projectRoute(primary,dep,noB);
      const zones=glareZones(primProj);
      if(!zones.length){ this.note("No glare zones to avoid on this route at this time."); return; }
      /* Bypass each bad glare zone on a PARALLEL road: two waypoints, at the
         zone's start and end, offset to the same side, U-turns forbidden at
         both. To pass through both the router has to travel alongside the
         zone. (A single waypoint beside the route, as before, mostly produced
         spurs: off the freeway, touch the point, turn round, back on.) */
      const P=primProj.pts, totalM=primary.distance;
      const along=[0]; for(let k=1;k<P.length;k++) along.push(along[k-1]+haversine(P[k-1].ll,P[k].ll));
      const clear=ll=>{ const k=P.findIndex(p=>p.ll===ll); return k<0 || (along[k]>C.endClearM && totalM-along[k]>C.endClearM); };
      /* Two kinds of bypass per zone and side: a road parallel to the zone
         (travel within 60 deg of the trip's direction at the waypoints), and
         streets ANGLED AWAY from the sun (travel at the sun's direction
         +-angledOffDeg there). A parallel road into a sunset faces the same
         sun; a street 25-40 deg off it has no high glare at all. */
      const pairs=[];
      outer: for(const d of C.detourOffsetsM) for(const z of zones.slice(0,C.maxZonesToAvoid)) for(const side of [90,270]){
        if(!clear(z.start)&&!clear(z.end)) continue;
        const a=clear(z.start)?z.start:z.anchor, b=clear(z.end)?z.end:z.anchor;
        const vias=[offsetPoint(a[0],a[1],(z.brg+side)%360,d), offsetPoint(b[0],b[1],(z.brg+side)%360,d)];
        const tilt=(side===90?1:-1)*C.angledOffDeg;          // lean toward the side we're bypassing on
        for(const want of [{hdg:z.brg,range:60},{hdg:(z.sunAz+tilt+360)%360,range:C.angledRangeDeg}]){
          if(pairs.length>=C.maxDetourProbes) break outer;
          pairs.push({vias,...want});
        }
      }
      /* AREA SEARCH: one waypoint at each point of a grid over the whole area
         between start and end (aligned with the trip, up to 35% of its length
         to either side), no direction required. Tested on El Cajon -> Ocean
         Beach with every limit off: the shady routes were 5-8 km south of
         I-8 (through downtown, or around SR-94), far outside the near-zone
         bypasses -- which is why the search kept returning I-8. Grid points
         go first so they always get a probe. */
      const tripM=haversine(this.from,this.to), tripBrg=bearing(this.from,this.to);
      const grid=[];
      for(const u of C.gridAlong) for(const v of C.gridAcross){
        const p=offsetPoint(this.from[0],this.from[1],tripBrg,u*tripM);
        grid.push({vias:[offsetPoint(p[0],p[1],(tripBrg+90)%360,v*tripM)],hdg:null});
      }
      pairs.unshift(...grid);
      const found=spatialAll.slice(); let done=0, loops=0;
      for(const pr of pairs){
        btn.textContent="Searching... "+(++done)+"/"+pairs.length;
        const r=await fetchRouteVia(this.from,pr.vias,this.to,pr.hdg,pr.range);
        if(r && hasLoop(r)) loops++;
        else if(r) found.push(r);
        await new Promise(r=>setTimeout(r,110));            // be gentle on the free demo server
      }
      // new roads may have new weather cells
      const pts=[]; found.forEach(r=>r.coords.forEach((c,i)=>{ if(i%15===0) pts.push(c); }));
      await wxEnsure(pts,dep.getTime()-C.departureSweepMin*60000,dep.getTime()+3*3600000);

      const primDur=primary.duration, primExp=primProj.exposed, scored=[], kept=[primary];
      // Over the time limit: not ranked, but the shadiest one is shown anyway
      // (clearly marked) if it at least halves the glare -- silently dropping
      // these is what hid every genuinely local route before.
      let overBudget=null;
      found.filter(c=>c!==primary && (c.duration-primDur)/60>this.maxDetourMin).forEach(c=>{
        const pj=projectRoute(c,dep,noB);
        if(pj.exposed<=primExp*(1-C.overBudgetShowFrac) && (!overBudget||pj.exposed<overBudget._exp)){
          c._delayMin=0; c._exp=pj.exposed; c._extraMin=(c.duration-primDur)/60; c._cost=Infinity;
          c._label="Local roads, over your "+this.maxDetourMin+"-min limit"; overBudget=c;
        }
      });
      found.filter(c=>c!==primary).forEach(c=>{
        if((c.duration-primDur)/60>this.maxDetourMin) return;                     // over the time budget
        if(kept.some(k=>Math.abs(k.distance-c.distance)<30 && Math.abs(k.duration-c.duration)<20)) return;  // exact repeat
        if(kept.some(k=>routeSimilarity(c,k)>C.routeSimilarThresh)) return;       // the same route again
        kept.push(c);
      });
      kept.forEach(c=>{
        const pj=projectRoute(c,dep,noB), extra=(c.duration-primDur)/60;
        c._delayMin=0; c._exp=pj.exposed; c._extraMin=extra;
        c._cost=pj.weighted+C.detourPenaltyPerMin*Math.max(0,extra);
        // a detour has to earn its place by cutting glare; OSRM's own
        // alternatives are kept for comparison either way
        if(c.label==="detour" && primExp-pj.exposed<C.minGlareReductionM) return;
        if(c.label==="detour") c._label="Bypass";
        scored.push(c);
      });
      this.updateTip();
      scored.sort((a,b)=>a._cost-b._cost);
      if(!scored.length){ this.note("No route within +"+this.maxDetourMin+" min. Raise the detour limit or try another time."); return; }
      const effTime=c=>c.duration+(c._delayMin||0)*60;
      const distinct=(c,list)=>!list.some(k=>Math.abs(k._exp-c._exp)<C.optionMinGlareDiffM &&
                                              Math.abs(effTime(k)-effTime(c))<C.optionMinTimeDiffS);
      const final=[scored[0]];
      if(primary!==scored[0] && distinct(primary,final)) final.push(primary);
      for(const c of scored){ if(final.length>=C.maxOptions) break; if(!final.includes(c) && distinct(c,final)) final.push(c); }
      if(overBudget) final.push(overBudget);
      // Show the result: tag the fastest and the shadiest, and SELECT the
      // shadiest so the map and the numbers switch to it. (Leaving the
      // fastest selected made a successful search look like nothing changed.)
      final.forEach(c=>{ c._tag=null; });
      primary._tag="Fastest";
      const shady=final.filter(c=>c!==primary && c!==overBudget).sort((a,b)=>a._exp-b._exp)[0];
      const pick=shady && (primExp-shady._exp)>=C.minGlareReductionM ? shady : primary;
      if(pick!==primary) pick._tag="Shadiest";
      this.routes=final; this.selected=final.indexOf(pick); this.recompute();
      const best=final[0], mi=x=>(x/1609.34).toFixed(1);
      const shadiest=final.filter(c=>c!==primary && c!==overBudget).sort((a,b)=>a._exp-b._exp)[0];
      if(shadiest && (primExp-shadiest._exp)>=C.minGlareReductionM){
        const dMin=Math.round(shadiest._extraMin);
        this.note("<b>Shadiest route</b>: glare "+mi(shadiest._exp)+" mi (was "+mi(primExp)+") "+
          (dMin>0?"for +"+dMin+" min":"at no time cost")+". "+final.length+" routes listed, best overall first.");
      } else this.note("No road within +"+this.maxDetourMin+" min avoids much of this glare."+
          (loops?" ("+loops+" detours rejected for looping back.)":""));
      if(overBudget) this.note($("note").innerHTML+" <b>Over your time limit:</b> local roads cut glare to "+
          mi(overBudget._exp)+" mi for +"+Math.round(overBudget._extraMin)+" min (listed last; raise the max detour to rank it).");
      // now the buildings along the routes on the list: redraw, keep the search's note
      const said=$("note").innerHTML;
      this.loadBuildings().then(()=>{ if(this.routes!==final) return;
        const pj=projectRoute(this.routes[this.selected],this.candDate(this.routes[this.selected]));
        this.draw(pj); this.stats(pj); this.renderAlts(); this.note(said+" (Search ranked by sun angle and cloud; the list now includes buildings.)"+this.bldNote(pj)); });
    }catch(err){
      this.note("Shadier-route search failed: "+((err&&err.message)||err)+". The free routing server may be busy; try again.");
    }finally{ btn.disabled=false; btn.textContent="Find a shadier route"; }
  }
};

/* ====================  PROJECT + SCORE A ROUTE  =============== */
/* Sample the route every ~2 s of driving, score each point at the moment the
   car is there, then GATE runs by sustained duration: a glare zone must last
   >= marginalMinSec (marginal) / highMinSec (high), same as the live drive. */
function projectRoute(route,departDate,opts){
  const C=PLAN_CFG, n=route.coords.length, useB=!(opts&&opts.buildings===false);
  const cum=[0]; for(let i=0;i<n-1;i++) cum.push(cum[i]+(route.durs[i]||0));
  const total=cum[n-1]||0;
  const targetDt=Math.max(C.sampleSec,total/C.maxRoutePoints);
  const idx=[0]; let lastT=0;
  for(let i=1;i<n;i++){ if(cum[i]-lastT>=targetDt){ idx.push(i); lastT=cum[i]; } }
  if(idx[idx.length-1]!==n-1) idx.push(n-1);

  const pts=[];
  for(let k=0;k<idx.length;k++){
    const i=idx[k], here=route.coords[i], nxt=route.coords[idx[Math.min(k+1,idx.length-1)]];
    const hdg=(here===nxt)?(pts.length?pts[pts.length-1].hdg:0):bearing(here,nxt);
    const when=new Date(departDate.getTime()+cum[i]*1000);
    const sp=sunPosition(when,here[0],here[1]);
    const g=glareGeom(sp.el,sp.az,hdg);
    const cloud=cloudAt(here[0],here[1],when.getTime()), sky=APP.useWeather?skyFactor(cloud):1;
    let tier=applySky(g.tier,sky), bldg=null;
    // a building or sound wall between the car and the sun: no glare here
    if(tier!=="safe"){
      bldg=(useB&&BLD.blocks(here[0],here[1],sp.az,sp.el))||TERRAIN.blocks(here[0],here[1],sp.az,sp.el)||null;   // hills always: cheap, loaded for the whole area
      if(bldg) tier="safe";
    }
    pts.push({ll:here,when,sunEl:sp.el,sunAz:sp.az,hdg,dAng:g.d,tier,bldg,
              score:bldg?0:g.score*sky,cloud,sky,gtier:"safe"});
  }
  /* Duration gate, the same way the car's classify() does it: HIGH needs the
     sun in the high cone continuously for highMinSec; MARGINAL needs any glare
     for marginalMinSec. An earlier version gated whole runs of "any glare" and
     called the entire run high if it contained a moment of high -- so a
     westbound street with the sun 20 deg off (marginal) became "high" for its
     whole length after one curve into the cone, every westbound route scored
     about the same, and no detour could ever look better. */
  const runs=(isIn,minS,fn)=>{
    for(let i=0;i<pts.length;){
      if(!isIn(pts[i])){ i++; continue; }
      let j=i; while(j+1<pts.length && isIn(pts[j+1])) j++;
      const durS=(pts[j].when-pts[i].when)/1000;
      if(durS>=minS) for(let k=i;k<=j;k++) fn(pts[k],durS);
      i=j+1;
    }
  };
  runs(p=>p.tier!=="safe", CONFIG.marginalMinSec, (p,d)=>{ p.gtier="marginal"; p.runSec=d; });
  runs(p=>p.tier==="high", CONFIG.highMinSec,     (p,d)=>{ p.gtier="high";     p.runSec=d; });
  let exposed=0, weighted=0, hotspots=0, prevHigh=false, peak=null, shaded=0;
  const dir={ahead:0,left:0,right:0};
  for(let k=1;k<pts.length;k++){
    const segLen=haversine(pts[k-1].ll,pts[k].ll), p=pts[k];
    if(p.bldg) shaded+=segLen;
    if(p.gtier!=="safe"){
      weighted+=segLen*p.score;
      if(!peak||p.score>peak.score) peak={score:p.score,sunEl:p.sunEl,dAng:p.dAng};
    }
    if(p.gtier==="high"){
      exposed+=segLen;
      const s=signedOff(p.hdg,p.sunAz);
      if(Math.abs(s)<=C.aheadDeg) dir.ahead+=segLen; else if(s>0) dir.right+=segLen; else dir.left+=segLen;
      if(!prevHigh){ hotspots++; p.hotspot=true; }
    }
    prevHigh=(p.gtier==="high");
  }
  return {pts,exposed,weighted,peak,hotspots,dir,shaded,distance:route.distance,duration:route.duration};
}

/* graded colour: green when safe, else an amber -> red ramp by severity */
function gradeColor(p){
  if(p.bldg) return "#5b7db1";                       // the sun would be in your eyes, but a building shades it
  if(p.gtier==="safe") return "#1f7a4d";
  let s=clamp((p.score||0)/0.6,0,1);
  s=Math.round(s/0.15)*0.15;                    // quantise so neighbouring segments merge
  const lerp=(a,b)=>Math.round(a+(b-a)*s);
  return "#"+[lerp(0xb3,0xc4),lerp(0x79,0x2c),lerp(0x1a,0x2c)].map(x=>x.toString(16).padStart(2,"0")).join("");
}
/* driver-language summary: "glare ahead 1.2 mi (harsh)" */
function glarePhrase(proj){
  if(proj.exposed<80) return "clear";
  const mi=x=>(x/1609.34).toFixed(1);
  const parts=[["ahead",proj.dir.ahead],["from the right",proj.dir.right],["from the left",proj.dir.left]]
    .filter(p=>p[1]>0).sort((a,b)=>b[1]-a[1]);
  if(!parts.length) return "clear";
  const harsh=(proj.peak&&proj.peak.score>=0.35)?"harsh":"mild";
  let s="glare "+parts[0][0]+" "+mi(parts[0][1])+" mi";
  if(parts[1]&&parts[1][1]>=0.3*parts[0][1]&&parts[1][1]>=322) s+=", "+parts[1][0]+" "+mi(parts[1][1])+" mi";
  return s+" ("+harsh+")";
}
/* the high-glare runs of a projection, worst first, each with an anchor + bearing */
function glareZones(proj){
  const zones=[]; let i=0;
  while(i<proj.pts.length){
    if(proj.pts[i].gtier!=="high"){ i++; continue; }
    let j=i; while(j+1<proj.pts.length && proj.pts[j+1].gtier==="high") j++;
    let len=0; for(let k=i+1;k<=j;k++) len+=haversine(proj.pts[k-1].ll,proj.pts[k].ll);
    const mid=proj.pts[Math.floor((i+j)/2)];
    zones.push({anchor:mid.ll, start:proj.pts[i].ll, end:proj.pts[j].ll, sunAz:mid.sunAz,
                brg:(j>i)?bearing(proj.pts[i].ll,proj.pts[j].ll):mid.hdg, exposed:len});
    i=j+1;
  }
  return zones.sort((a,b)=>b.exposed-a.exposed);
}

/* ==========================  SERVICES  ========================== */
/* Routing and address search are free volunteer servers with no guarantee.
   Give up after a while instead of spinning forever, and say why in words. */
async function fetchJSON(url,opts={},ms=12000){
  const ctl=new AbortController(), t=setTimeout(()=>ctl.abort(),ms);
  try{
    const r=await fetch(url,{...opts,signal:ctl.signal});
    if(r.status===429) throw new Error("the free map server is busy right now");
    if(r.status===403) throw new Error("the free map server refused the request");
    if(!r.ok) throw new Error("the map server answered "+r.status);
    return await r.json();
  }catch(err){
    if(err.name==="AbortError") throw new Error("the free map server did not answer in time");
    if(err instanceof TypeError) throw new Error("could not reach the map server");
    throw err;
  }finally{ clearTimeout(t); }
}
const GEOCODED=new Map();            // each address is looked up once per visit

/* Place search: Photon (OpenStreetMap data, knows business names, ranks
   places near a point first), so "Starbucks" means the one nearby, not one
   in Virginia. Near = your GPS fix if you used My location, else the map. */
function searchNear(){
  if(PLAN.from && $("fromIn").value==="my location") return PLAN.from;
  const c=APP.map.getCenter(); return [c.lat,c.lng];
}
async function photonSearch(q,limit,signal){
  const [lat,lon]=searchNear();
  const url=CONFIG.photon+"?lang=en&limit="+(limit+5)+"&lat="+lat.toFixed(4)+"&lon="+lon.toFixed(4)+"&q="+encodeURIComponent(q);
  const r=await fetch(url,{signal}); if(!r.ok) throw new Error("place search answered "+r.status);
  const j=await r.json();
  return (j.features||[]).filter(f=>f.properties.countrycode==="US").slice(0,limit).map(f=>{
    const p=f.properties, street=[p.housenumber,p.street].filter(Boolean).join(" ");
    const name=p.name||street||p.city||"";
    const where=[p.name?street:"",p.city||p.county,p.state==="California"?"":p.state].filter(x=>x&&x!==name).join(", ");
    return {name, where, ll:[f.geometry.coordinates[1],f.geometry.coordinates[0]]};
  });
}
async function geocode(q){
  const key=q.trim().toLowerCase();
  if(GEOCODED.has(key)) return GEOCODED.get(key);
  let ll=null;
  try{ const r=await photonSearch(q,1); if(r.length) ll=r[0].ll; }catch(_){}
  if(!ll){                                           // Photon down or empty: Nominatim, once, on submit
    const j=await fetchJSON(CONFIG.nominatim+"?format=json&limit=1&countrycodes=us&q="+encodeURIComponent(q),{headers:{"Accept-Language":"en"}});
    if(!j.length) throw new Error('could not find "'+q+'"');
    ll=[parseFloat(j[0].lat),parseFloat(j[0].lon)];
  }
  GEOCODED.set(key,ll);
  return ll;
}

/* A suggestion list under an input: up to 5 places as you type (after a short
   pause), arrow keys + Enter or a tap to pick. onType: the text changed;
   onPick(ll): a place was picked; onEnter: Enter with nothing highlighted. */
function suggestBox(id,onType,onPick,onEnter){
  const inp=$(id), list=document.createElement("div");
  list.className="suggest"; list.setAttribute("role","listbox"); list.hidden=true;
  inp.parentNode.style.position="relative"; inp.parentNode.appendChild(list);
  inp.setAttribute("autocomplete","off");
  let timer=null, ctl=null, items=[], hi=-1;
  const close=()=>{ list.hidden=true; hi=-1; };
  const mark=()=>[...list.children].forEach((el,i)=>el.classList.toggle("hi",i===hi));
  const pick=i=>{ const it=items[i]; if(!it) return;
    inp.value=it.name+(it.where?", "+it.where:""); GEOCODED.set(inp.value.trim().toLowerCase(),it.ll);
    close(); onPick(it.ll); };
  inp.addEventListener("input",()=>{
    onType(); clearTimeout(timer); if(ctl) ctl.abort();
    const q=inp.value.trim(); if(q.length<3){ close(); return; }
    timer=setTimeout(async()=>{
      ctl=new AbortController();
      try{ items=await photonSearch(q,5,ctl.signal); }catch(_){ return; }
      if(inp.value.trim()!==q) return;
      list.innerHTML=""; hi=-1;
      items.forEach((it,i)=>{ const el=document.createElement("div"); el.className="sg"; el.setAttribute("role","option");
        el.innerHTML="<b></b><span></span>"; el.firstChild.textContent=it.name; el.lastChild.textContent=it.where;
        el.onpointerdown=e=>{ e.preventDefault(); pick(i); };      // before the input loses focus
        list.appendChild(el); });
      list.style.left=inp.offsetLeft+"px"; list.style.width=inp.offsetWidth+"px";
      list.hidden=!items.length;
    },250);
  });
  inp.addEventListener("keydown",e=>{
    if(list.hidden) return;
    if(e.key==="ArrowDown"||e.key==="ArrowUp"){ e.preventDefault(); const n=items.length; hi=e.key==="ArrowDown"?(hi+1)%n:(hi<=0?n-1:hi-1); mark(); }
    else if(e.key==="Enter"){ e.preventDefault(); if(hi>=0) pick(hi); else { pick(0); if(onEnter) onEnter(); } }
    else if(e.key==="Escape"){ close(); }
  });
  inp.addEventListener("blur",()=>setTimeout(close,100));
}
function osrmRoute(rt,label){
  const coords=rt.geometry.coordinates.map(c=>[c[1],c[0]]);          // -> [lat,lng]
  let durs=[]; (rt.legs||[]).forEach(l=>{ if(l.annotation&&l.annotation.duration) durs=durs.concat(l.annotation.duration); });
  // name the route by its three longest roads, route numbers where they exist
  // ("I 8, SR 94, I 5"), in the order you drive them
  const dist=new Map(), first=new Map();
  (rt.legs||[]).forEach(l=>(l.steps||[]).forEach(st=>{
    const key=(st.ref||"").split(";")[0].trim().replace(/^I (\d+)/,"I-$1").replace(/^CA (\d+)/,"SR-$1")
      .replace(/^US (\d+)/,"US-$1")||(st.name||"").trim();
    if(!key) return;
    dist.set(key,(dist.get(key)||0)+st.distance);
    if(!first.has(key)) first.set(key,first.size);
  }));
  const roads=[...dist.entries()].sort((a,b)=>b[1]-a[1]).slice(0,3).map(e=>e[0])
    .sort((a,b)=>first.get(a)-first.get(b)).join(", ");
  return {coords,durs,distance:rt.distance,duration:rt.duration,label,roads,steps:osrmSteps(rt)};   // steps: js/nav.js
}
async function fetchRoutes(from,to){
  const u=CONFIG.osrmBase+"/route/v1/driving/"+from[1]+","+from[0]+";"+to[1]+","+to[0]+
    "?overview=full&geometries=geojson&alternatives=3&annotations=duration&steps=true";
  const j=await fetchJSON(u);
  if(j.code!=="Ok"||!j.routes||!j.routes.length) throw new Error("no route found");
  return j.routes.map((rt,i)=>osrmRoute(rt,i===0?"fastest":"alt"));
}
/* Route through waypoints. hdg: the trip's direction there -- the car must
   pass each waypoint heading within 60 deg of it, so the router can't snap a
   waypoint onto a street going the wrong way and circle back to it. */
async function fetchRouteVia(from,vias,to,hdg,range=60){
  const pts=[from].concat(vias,[to]).map(p=>p[1]+","+p[0]).join(";");
  const brg=hdg==null?"":"&bearings="+[""].concat(vias.map(()=>Math.round(hdg)%360+","+range),[""]).join(";");
  const u=CONFIG.osrmBase+"/route/v1/driving/"+pts+
    "?overview=full&geometries=geojson&annotations=duration&steps=true&continue_straight=true"+brg;   // no U-turns at waypoints
  try{
    const j=await fetchJSON(u);
    if(j.code!=="Ok"||!j.routes||!j.routes.length) return null;
    return osrmRoute(j.routes[0],"detour");
  }catch(_){ return null; }
}
/* Does a route come back to where it already was -- out and back on a spur,
   or round a block? Sample every ~50 m; a point within loopRevisitM of one
   more than loopGapM earlier along the route, travelled the SAME way (round a
   block) or the OPPOSITE way (out and back), is a loop. Coming back at a wide
   angle is a crossing -- a bypass passing over or under the road it left --
   and is fine. */
function hasLoop(route){
  const C=PLAN_CFG, s=[]; let m=0, last=null;
  for(const c of route.coords){
    if(last) m+=haversine(last,c);
    if(!s.length || m-s[s.length-1].m>=50) s.push({ll:c,m});
    last=c;
  }
  const hdg=k=>bearing(s[Math.max(0,k-1)].ll,s[Math.min(s.length-1,k+1)].ll);
  for(let i=0;i<s.length;i++)
    for(let j=i+1;j<s.length;j++)
      if(s[j].m-s[i].m>C.loopGapM && haversine(s[i].ll,s[j].ll)<C.loopRevisitM){
        const turn=angleDiff(hdg(i),hdg(j));
        if(turn<45 || turn>135) return true;
      }
  return false;
}
/* fraction of route A that runs along route B. 1 = identical path. */
function routeSimilarity(a,b){
  const samp=(coords,n)=>{ const s=Math.max(1,Math.floor(coords.length/n)); const o=[]; for(let i=0;i<coords.length;i+=s) o.push(coords[i]); return o; };
  const A=samp(a.coords,40), B=samp(b.coords,60);
  let near=0;
  for(const p of A){ let md=1e9;
    for(const q of B){ const d=haversine(p,q); if(d<md){ md=d; if(md<PLAN_CFG.routeSimilarDistM) break; } }
    if(md<PLAN_CFG.routeSimilarDistM) near++;
  }
  return near/A.length;
}
