/* SolGuard app shell -- the pieces every tab shares.
   - one Leaflet map
   - the tabs: Drive (plan a route; "drive" is its driving mode, no tab of its own) / Highway glare
   - one date + time ("when") that Plan and the Glare map both read
   - the sun marker, the ShadeMap shadow layer, the weather toggle
   - the vehicle state H and classify(): used by BOTH the live drive and replay,
     so a replay is a faithful rehearsal of what the phone would say in the car. */

const $=id=>document.getElementById(id);

/* SunCalc can report when the sun crosses any elevation. Register the two
   edges of the visor-unblockable band so we can print today's glare windows. */
SunCalc.addTime(CONFIG.sunElevMax,"bandTopRise","bandTopSet");
SunCalc.addTime(CONFIG.sunElevMin,"bandLowRise","bandLowSet");

const APP={
  tab:null, when:null, map:null, shade:null, shadeOn:false, useWeather:true,
  tabs:{},                       // name -> {onShow,onHide,onWhen,onWeather}
  SOCAL:[[32.55,-118.95],[34.35,-116.25]], // first view in both tabs: Los Angeles to San Diego

  init(){
    this.map=L.map("map",{zoomControl:true}).setView([32.80,-117.10],11);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png",{
      maxZoom:19, referrerPolicy:"strict-origin-when-cross-origin",
      attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(this.map);
    this.map.on("moveend zoomend",()=>{ drawSun(); updateSunLine(); });

    // date + time bar
    const now=new Date(); now.setMinutes(Math.round(now.getMinutes()/5)*5,0,0);
    /* Typing a date: the browser reports one after EVERY digit (the year passes
       through 0002, 0026, 0202 ...). Apply only a whole, plausible date, and
       never write the box back while the person is typing in it -- that wiped
       the month and day, and an empty value showed the time as NaN:NaN. */
    const dateOk=v=>{ const y=+String(v).slice(0,4); return /^\d{4}-\d{2}-\d{2}$/.test(v) && y>=1950 && y<=2100; };
    const fromBar=()=>{ const v=$("wDate").value; if(dateOk(v)) this.setWhen(fromYmd(v,+$("wTime").value)); };
    $("wDate").addEventListener("input",fromBar);
    $("wDate").addEventListener("change",fromBar);
    $("wDate").addEventListener("blur",()=>{ if(!dateOk($("wDate").value)) $("wDate").value=ymd(this.when); });   // left half-typed: put the real date back
    $("wTime").oninput=()=>this.setWhen(fromYmd(ymd(this.when),+$("wTime").value));
    $("wNow").onclick=()=>{ const n=new Date(); n.setMinutes(Math.round(n.getMinutes()/5)*5,0,0); this.setWhen(n); };
    this.setWhen(now,true);

    // one Real weather setting, with a switch on each tab that uses it (Plan,
    // Glare map); flipping either flips both
    const wx=[...document.querySelectorAll(".wx-switch")];
    wx.forEach(x=>x.onchange=()=>{
      this.useWeather=x.checked; wx.forEach(y=>y.checked=x.checked);
      const t=this.tabs[this.tab]; if(t&&t.onWeather) t.onWeather();
      VIEW.render();
    });

    // welcome sheet: over the whole app on the first visit; closing it in any way counts as seen; "?" brings it back
    const seen=()=>{ try{ return localStorage.getItem("solguard.welcomed")==="1"; }catch(_){ return false; } };
    const sheet=$("welcome");
    const closeSheet=()=>{ sheet.hidden=true; try{ localStorage.setItem("solguard.welcomed","1"); }catch(_){} };
    const openSheet=()=>{ sheet.hidden=false; $("demoBtn").focus(); };
    if(!seen() && !new URLSearchParams(location.search).get("demo")) openSheet();   // a demo link goes straight in
    $("welcomeX").onclick=closeSheet;
    sheet.addEventListener("click",e=>{ if(e.target===sheet) closeSheet(); });          // tap outside the card
    document.addEventListener("keydown",e=>{ if(e.key==="Escape" && !sheet.hidden) closeSheet(); });
    sheet.querySelectorAll("[data-go]").forEach(b=>b.onclick=()=>{ closeSheet(); this.show(b.dataset.go); });
    // Apple-style "Learn more" links: open the short story beneath them
    const more=(btn,box)=>{ $(btn).onclick=()=>{ const b=$(box); b.hidden=!b.hidden;
      $(btn).textContent=b.hidden?(btn==="hWhy"?"Why it matters":"Learn more"):"Show less"; $(btn).setAttribute("aria-expanded",String(!b.hidden)); }; };
    more("welcomeMore","welcomeInfo"); more("hWhy","hWhyBox");
    $("hToData").onclick=()=>$("hExportCard").scrollIntoView({behavior:"smooth",block:"start"});
    $("helpBtn").onclick=openSheet;
    // the one-click demo: the I-8 evening example, then play it
    $("demoBtn").onclick=async()=>{
      closeSheet(); this.show("plan");
      const t=PLAN.trips.find(x=>x.id==="elcajon-ob")||PLAN.trips[PLAN.trips.length-1]; if(!t) return;
      await PLAN.loadExample(t); PLAN.watch();
      if(isPhone()) $("viewCard").scrollIntoView({block:"start",behavior:"smooth"});
    };

    initSplitter();
    initPhone();
    initDock();
    this.map.invalidateSize(); this.map.fitBounds(this.SOCAL,{padding:[20,20],animate:false});
    initShade();
    // while driving, the Drive tab button stays put (End drive leaves); Highway glare ends the drive
    $("tab-plan").onclick=()=>{ if(this.tab!=="drive") this.show("plan"); };
    $("tab-map").onclick=()=>{ if(this.tab==="drive") DRIVE.end("map"); else this.show("map"); };
    window.addEventListener("hashchange",()=>this.show(location.hash.slice(1)));
    PLAN.init(); HEATMAP.init(); REPLAY.init(); DRIVE.init(); VIEW.init(); NAV.init(); EXPORT.init();
    this.show(location.hash.slice(1)||"plan");
  },

  show(name){
    if(!this.tabs[name]) name="plan";
    if(name===this.tab) return;
    const prev=this.tabs[this.tab]; if(prev&&prev.onHide) prev.onHide();
    this.tab=name;
    document.body.dataset.tab=name;                                // the phone layout orders the page per tab
    for(const k of ["plan","map","drive"]) $("pane-"+k).classList.toggle("on",k===name);
    $("tab-plan").classList.toggle("sel",name!=="map");              // driving mode is part of the Drive tab
    $("tab-map").classList.toggle("sel",name==="map");
    $("whenBar").style.display = name==="drive" ? "none" : "";   // Drive always uses the real clock
    $("wLabel").textContent = name==="plan" ? "Leave" : "Time";     // the departure on Plan, the moment shown on the map
    // Highway glare is for agencies: the driver's tools (windshield, sensitivity) step aside there
    for(const id of ["viewCard","sensCard"]) $(id).style.display = name==="map" ? "none" : "";
    closePops();
    if(location.hash.slice(1)!==name) history.replaceState(null,"","#"+name);
    status("");
    this.tabs[name].onShow();
    syncShade(); drawSun(); updateSunLine(); VIEW.render();
    setTimeout(()=>this.map.invalidateSize(),0);
  },

  /* Fitting a route: leave room for the Driver's view floating on the map (desktop) */
  fitOpts(){
    if(document.body.classList.contains("docked") && VIEW.open && $("viewCard").style.display!=="none")
      return {paddingTopLeft:[$("dockView").offsetWidth+30,30],paddingBottomRight:[30,30]};
    return {padding:[30,30]};
  },

  /* Change the shared moment. silent = just update the controls. */
  setWhen(d,silent){
    if(!(d instanceof Date) || isNaN(d)) return;                  // never let a bad date in
    this.when=d;
    if(document.activeElement!==$("wDate")) $("wDate").value=ymd(d);   // not while it is being typed in
    $("wTime").value=minsOfDay(d);
    $("wTimeV").textContent=hhmm(minsOfDay(d));
    updateSunLine();
    if(silent) return;
    VIEW.render();
    shadeSetDate(d);
    drawSun();
    const t=this.tabs[this.tab]; if(t&&t.onWhen) t.onWhen();
  }
};

function status(html){ $("status").innerHTML=html||""; }

/* Phones: one finger scrolls the page, two move the map (a half-screen map
   would otherwise swallow every swipe down the page); the Drive tab's
   numbers fold behind "Details". */
const isPhone=()=>matchMedia("(max-width:899px)").matches;
function initPhone(){
  $("driveMoreBtn").onclick=()=>{ const m=$("driveMore"), open=!m.classList.contains("open");
    m.classList.toggle("open",open); $("driveMoreBtn").innerHTML=open?"Details &#9662;":"Details &#9656;"; };
  if(!matchMedia("(pointer:coarse)").matches) return;
  const map=APP.map, box=map.getContainer(), hint=$("mapHint"); let t=null;
  const apply=()=>{ if(isPhone()) map.dragging.disable(); else map.dragging.enable(); };
  apply(); matchMedia("(max-width:899px)").addEventListener("change",apply);
  // pinch (touch zoom) still moves and zooms the map with two fingers
  box.addEventListener("touchmove",e=>{ if(!isPhone()||e.touches.length>1||REPLAY.dragging) return;
    hint.classList.add("show"); clearTimeout(t); t=setTimeout(()=>hint.classList.remove("show"),1200); },{passive:true});
}

/* Desktop: the panel holds the controls, the map holds what you look at.
   Parts marked data-dock (the Driver's view, Glare sensitivity, the weather and
   traffic switches, the legends) move onto the map; on a phone they go back to
   their place in the page, where the one-column order applies. */
function initDock(){
  const items=[...document.querySelectorAll("[data-dock]")].map(el=>{
    const mark=document.createComment("dock: "+(el.id||el.dataset.dock)); el.parentNode.insertBefore(mark,el);
    return {el,mark,slot:$(el.dataset.dock)};
  });
  const apply=()=>{
    const desk=!isPhone();
    items.forEach(({el,mark,slot})=>{ if(desk) slot.appendChild(el); else mark.parentNode.insertBefore(el,mark.nextSibling); });
    document.body.classList.toggle("docked",desk);
    $("sensBox").open=desk || $("sensBox").open;      // in its popover there is nothing to unfold
    if(!desk) closePops();
    if(APP.map) setTimeout(()=>APP.map.invalidateSize(),0);
  };
  apply(); matchMedia("(max-width:899px)").addEventListener("change",apply);
  // the two map buttons open their popovers; a click anywhere else closes them
  for(const [b,p] of [["layersBtn","layersPop"],["setBtn","setPop"]])
    $(b).onclick=e=>{ e.stopPropagation(); const open=$(p).hidden; closePops(); $(p).hidden=!open; $(b).classList.toggle("on",open); $(b).setAttribute("aria-expanded",String(open)); };
  for(const p of ["layersPop","setPop"]) $(p).addEventListener("click",e=>e.stopPropagation());
  document.addEventListener("click",closePops);
  // the windshield on the map: normal or bigger (remembered)
  const big=on=>{ $("dockView").classList.toggle("big",on); $("vSize").textContent=on?"Smaller":"Bigger";
    try{ localStorage.setItem("solguard.viewBig",on?"1":"0"); }catch(_){} };
  let b0=false; try{ b0=localStorage.getItem("solguard.viewBig")==="1"; }catch(_){}
  big(b0); $("vSize").onclick=()=>big(!$("dockView").classList.contains("big"));
}
function closePops(){
  for(const [b,p] of [["layersBtn","layersPop"],["setBtn","setPop"]]){ $(p).hidden=true; $(b).classList.remove("on"); $(b).setAttribute("aria-expanded","false"); }
}

/* Desktop: drag the divider between the panel and the map to resize the
   panel (320 px to 65% of the window). The width is remembered. The
   Driver's view scales with it, so a wider panel is a bigger windshield. */
function initSplitter(){
  const sp=$("splitter"), side=document.querySelector(".side");
  const fit=w=>Math.round(clamp(w,320,Math.max(320,window.innerWidth*0.65)));
  try{ const w=+localStorage.getItem("solguard.panelW"); if(w) side.style.width=fit(w)+"px"; }catch(_){}
  let dragging=false;
  sp.addEventListener("pointerdown",e=>{ dragging=true; sp.setPointerCapture(e.pointerId); sp.classList.add("drag");
    document.body.style.userSelect="none"; e.preventDefault(); });
  sp.addEventListener("pointermove",e=>{ if(!dragging) return;
    side.style.width=fit(e.clientX-side.getBoundingClientRect().left)+"px"; APP.map.invalidateSize({pan:false}); });
  const end=()=>{ if(!dragging) return; dragging=false; sp.classList.remove("drag"); document.body.style.userSelect="";
    try{ localStorage.setItem("solguard.panelW",parseInt(side.style.width)); }catch(_){}
    APP.map.invalidateSize(); };
  sp.addEventListener("pointerup",end); sp.addEventListener("pointercancel",end);
  sp.addEventListener("dblclick",()=>{ side.style.width=""; try{ localStorage.removeItem("solguard.panelW"); }catch(_){} APP.map.invalidateSize(); });
}

/* "Sun 9 deg up, WSW. Low-sun glare window today: 5:12-6:04 PM" for the map centre. */
const COMPASS=["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
function compass(az){ return COMPASS[Math.round(az/22.5)%16]; }
function updateSunLine(){
  if(!APP.map||!APP.when) return;
  const c=APP.map.getCenter(), sp=sunPosition(APP.when,c.lat,c.lng);
  const top="band"+CONFIG.sunElevMax, low="band"+CONFIG.sunElevMin;   // the edges move with Glare sensitivity
  for(const [e,n] of [[CONFIG.sunElevMax,top],[CONFIG.sunElevMin,low]])
    if(!SunCalc.times.some(x=>x[1]===n+"Rise")) SunCalc.addTime(e,n+"Rise",n+"Set");
  const t=SunCalc.getTimes(new Date(APP.when.getFullYear(),APP.when.getMonth(),APP.when.getDate(),12),c.lat,c.lng);
  const ok=d=>d&&!isNaN(d);
  const win=(a,b)=>ok(a)&&ok(b)?clockText(a)+"&ndash;"+clockText(b):"--";
  const where = sp.el>0 ? `Sun ${sp.el.toFixed(0)}&deg; up in the ${compass(sp.az)}` : "Sun is down";
  $("wSun").innerHTML=`${where}. Low-sun windows that day: ${win(t[low+"Rise"],t[top+"Rise"])} and ${win(t[top+"Set"],t[low+"Set"])}`;
}

/* ===================  SUN MARKER  =================== */
/* A sun icon parked at the map edge in the sun's real compass direction, with
   its elevation, plus a faint ray from the centre so you can see how a road
   lines up with it. Hidden when the sun is below the horizon. */
let _sunMk=null,_sunRay=null;
function drawSun(){
  const map=APP.map; if(!map) return;
  if(_sunMk){ map.removeLayer(_sunMk); _sunMk=null; }
  if(_sunRay){ map.removeLayer(_sunRay); _sunRay=null; }
  if(APP.tab==="drive"||REPLAY.active) return;
  const c=map.getCenter(), sp=sunPosition(APP.when,c.lat,c.lng);
  if(sp.el<=0) return;
  const sz=map.getSize(), ctr=map.latLngToContainerPoint(c);
  const th=sp.az*Math.PI/180, dx=Math.sin(th), dy=-Math.cos(th);   // north = up
  const m=36;
  const tx=dx>0?(sz.x-m-ctr.x)/dx:(dx<0?(m-ctr.x)/dx:1e9);
  const ty=dy>0?(sz.y-m-ctr.y)/dy:(dy<0?(m-ctr.y)/dy:1e9);
  const t=Math.max(20,Math.min(tx,ty));
  const edge=map.containerPointToLatLng(L.point(ctr.x+dx*t,ctr.y+dy*t));
  const rayEnd=map.containerPointToLatLng(L.point(ctr.x+dx*(t-20),ctr.y+dy*(t-20)));
  _sunRay=L.polyline([c,rayEnd],{color:"#f5a623",weight:2,opacity:.45,dashArray:"3 6",interactive:false}).addTo(map);
  const html='<div style="display:flex;flex-direction:column;align-items:center">'
    +'<div style="width:24px;height:24px;border-radius:50%;background:radial-gradient(circle,#ffe08a,#f5a623);'
    +'box-shadow:0 0 9px 3px rgba(245,166,35,.6);border:2px solid #fff"></div>'
    +'<div style="font:600 11px system-ui;color:#f5a623;background:rgba(0,0,0,.55);padding:0 4px;border-radius:4px;margin-top:2px">'
    +sp.el.toFixed(0)+'&deg;</div></div>';
  _sunMk=L.marker(edge,{icon:L.divIcon({className:"",html,iconSize:[24,40],iconAnchor:[12,12]}),
    interactive:false,keyboard:false}).addTo(map);
}

/* ===================  SHADOW LAYER (ShadeMap)  =================== */
/* Terrain and building shadows for the chosen moment. Buildings come from
   js/buildings.js (OpenStreetMap) through getFeatures(), only when zoomed in
   to street level (15+): below that they'd be invisible and slow to load. Shown on Plan, Drive and
   during a replay; hidden on the statewide map, where it would just darken
   the whole state at night and slow the animation down. */
function initShade(){
  if(!CONFIG.shadeMapApiKey){ $("shadeState").textContent="shadows: no key"; return; }
  const opts={ date:APP.when, color:"#01112f", opacity:0.5, apiKey:CONFIG.shadeMapApiKey,
    getFeatures:async()=>{
      if(!APP.map||APP.map.getZoom()<15) return [];
      const b=APP.map.getBounds(); await BLD.ensureBounds(b); return BLD.features(b); },
    terrainSource:{ tileSize:256, maxZoom:15,
      getSourceUrl:({x,y,z})=>`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`,
      getElevation:({r,g,b})=>(r*256+g+b/256)-32768 } };
  try{
    if(window.L&&typeof L.shadeMap==="function") APP.shade=L.shadeMap(opts);
    else if(window.ShadeMap) APP.shade=new window.ShadeMap(opts);
  }catch(_){ APP.shade=null; }
  if(!APP.shade) $("shadeState").textContent="shadows unavailable";
}
function syncShade(){
  if(!APP.shade) return;
  const want = APP.tab!=="map" || REPLAY.active;
  try{
    if(want && !APP.shadeOn){ APP.shade.addTo(APP.map); APP.shadeOn=true; shadeSetDate(REPLAY.active?REPLAY.clock:(APP.tab==="drive"?new Date():APP.when)); }
    if(!want && APP.shadeOn){ APP.map.removeLayer(APP.shade); APP.shadeOn=false; }
  }catch(_){}
  $("shadeState").textContent = APP.shadeOn ? "shadows shown: hills, and buildings when zoomed in to street level. Both are counted in the glare." : "";
}
let _shadeT=null;
function shadeSetDate(d){
  if(!APP.shade||!APP.shadeOn||!d) return;
  clearTimeout(_shadeT);                      // re-rendering shadows is heavy; settle first
  _shadeT=setTimeout(()=>{ try{ APP.shade.setDate(d); }catch(_){} },120);
}

/* ===================  VEHICLE STATE + CLASSIFIER  =================== */
/* H is "the car": live GPS fills it in Drive, the virtual drive fills it in
   replay. classify() turns it into a risk with sustained-exposure gating (a
   brief flash of sun doesn't trip a warning) and a short release delay (so
   it doesn't flicker). */
const H={
  lat:null,lng:null,alt:null,speed:null,gpsHeading:null,compassHeading:null,
  headingUsed:null,headingSrc:"--",sunAz:null,sunEl:null,dAng:null,bldg:null,
  inSun:true,inSunKnown:false,risk:"none",score:0,cloud:null,sky:1,
  _t:{highSince:0,margSince:0,dropSince:0}
};
function resetHold(){ H._t.highSince=0; H._t.margSince=0; H._t.dropSince=0; }

function classify(now){
  if(H.sunEl===null || H.headingUsed===null){ resetHold(); H.risk="none"; H.score=0; return; }
  if(H.sunEl<=0){ resetHold(); H.risk="none"; H.score=0; return; }                  // sun down
  const g=glareGeom(H.sunEl,H.sunAz,H.headingUsed);
  H.dAng=g.d;
  // shaded by a hill or building -- "Blocked" only when it would otherwise be
  // glare or watch; a shaded sun far off to the side is simply Clear
  if(H.inSunKnown && !H.inSun){ resetHold(); H.risk=g.tier==="safe"?"safe":"blocked"; H.score=0; return; }
  H.sky=APP.useWeather?skyFactor(H.cloud):1;
  H.score=Math.round(g.score*H.sky*100);
  const lvl=RANK[applySky(g.tier,H.sky)];
  if(lvl>=2){ if(!H._t.highSince) H._t.highSince=now; } else H._t.highSince=0;
  if(lvl>=1){ if(!H._t.margSince) H._t.margSince=now; } else H._t.margSince=0;
  let tier="safe";
  if(lvl>=2 && now-H._t.highSince>=CONFIG.highMinSec*1000) tier="high";
  else if(lvl>=1 && now-H._t.margSince>=CONFIG.marginalMinSec*1000) tier="marginal";
  if(RANK[tier]<RANK[H.risk] && H.risk!=="none" && H.risk!=="blocked"){   // release hysteresis
    if(!H._t.dropSince) H._t.dropSince=now;
    if(now-H._t.dropSince<CONFIG.releaseSec*1000) tier=H.risk; else H._t.dropSince=0;
  } else H._t.dropSince=0;
  H.risk=tier;
}

const BANNER={
  none:    ["neutral","Sun down","No glare right now."],
  safe:    ["green","Clear","Sun's high, or off to the side."],
  blocked: ["green","Blocked","A hill or building has the sun."],
  marginal:["amber","Watch","Glare is building."],
  high:    ["red","Glare","Sun in your eyes."]
};
/* Paint H into the Drive tab's banner + tiles, and the replay HUD on the map. */
function renderHud(){
  let [cls,word,sub]=BANNER[H.risk];
  // no position yet: say so, rather than "Sun down"
  if(H.risk==="none" && H.lat===null && !REPLAY.active)
    [word,sub]=DRIVE.started?["Finding you","Waiting for GPS."]:["Ready","Mount your phone. Then go."];
  // a very low sun: no visor reaches it -- say so, plainly
  if(H.risk==="high" && H.sunEl!==null && H.sunEl<LOW_SUN+1) sub="Too low for the visor. Slow down.";
  $("banner").className="banner "+cls; $("dState").textContent=word; $("dSub").textContent=sub;
  $("tEl").textContent  = H.sunEl===null?"--":H.sunEl.toFixed(1);
  $("tAz").textContent  = H.sunAz===null?"--":Math.round(H.sunAz);
  $("tHdg").textContent = H.headingUsed===null?"--":Math.round(H.headingUsed);
  $("tD").textContent   = H.dAng===null?"--":Math.round(H.dAng);
  $("tSun").textContent = !H.inSunKnown?"unknown":(H.inSun?"open sky":"blocked");
  $("tSpd").textContent = H.speed===null?"--":Math.round(H.speed*2.23694);
  const hs=$("hudState");
  hs.textContent=word; hs.style.background="var(--"+cls+")";
  $("hudEl").textContent = H.sunEl===null?"--":H.sunEl.toFixed(1)+"°";
  $("hudD").textContent  = H.dAng===null?"--":Math.round(H.dAng)+"° off";
  $("hudCloud").textContent = (REPLAY.active&&REPLAY.clearSky)?"clear sky (demo)":!APP.useWeather?"weather off":(H.cloud===null?"unknown (clear assumed)":H.cloud+"%");
  VIEW.render();
}
