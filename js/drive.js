/* Driving mode of the Drive tab -- the live in-car display. Entered with
   "Drive this route" (with directions) or "Just drive" (warnings only); left
   with End drive, which stops the sensors and goes back to the planner.
   GPS position + course and the compass heading go into H, the sun comes from
   the real clock, ShadeMap says whether the car's point is in sun or blocked
   by a building or hill, and classify() turns it into GREEN / AMBER / RED.
   Every sample can be logged and exported as CSV for road-test validation.
   Sensors only work over HTTPS (or localhost), and only after a tap. */

const DRIVE={
  started:false, watchId:null, logging:false, rows:[], marker:null, db:null,
  gpsHeadingMinSpeed:1.5,        // m/s; above this, trust GPS course over the compass
  mapZoom:17,                    // first zoom (buildings resolve for the shadow layer); after that the driver's own
  headingUp:false, rot:0,        // map turned so the road ahead points up (like Google Maps), or north up

  init(){
    APP.tabs.drive={
      onShow:()=>{
        REPLAY.stop();
        if(this.started && H.lat!==null) this.follow();
        shadeSetDate(new Date());
        status(this.started ? this.footer() : (window.isSecureContext ? ""
          : "Live sensors need HTTPS. Open the deployed https:// address on the phone."));
        resetHold(); H.risk="none"; renderHud();
      },
      onHide:()=>this.applyOrient(false),
      onWeather:()=>{ classify(Date.now()); renderHud(); }
    };
    $("startBtn").onclick=()=>this.start();
    $("endDriveBtn").onclick=()=>this.end();
    $("logBtn").onclick=()=>{ this.logging=!this.logging; $("logBtn").classList.toggle("on",this.logging); this.updateLogBtn(); };
    $("dlBtn").onclick=()=>this.downloadCSV();
    $("clrBtn").onclick=()=>this.clearLog();
    this.loadPersisted();
    this.initOrient();
  },

  start(){
    if(this.started) return; this.started=true; this.centered=false;
    $("startBtn").style.display="none"; $("logBtn").disabled=false;
    this.timers=[];
    if("geolocation" in navigator){
      this.watchId=navigator.geolocation.watchPosition(p=>this.onGeo(p),
        e=>status("Location error: "+e.message+". Check HTTPS and permissions."),
        {enableHighAccuracy:true,maximumAge:1000,timeout:15000});
    } else status("This browser has no location access.");
    if(!this.orientOn) try{
      this.orientOn=true;                                          // listeners stay for the visit: added once
      if(typeof DeviceOrientationEvent!=="undefined" && typeof DeviceOrientationEvent.requestPermission==="function"){
        DeviceOrientationEvent.requestPermission()                 // iPhone asks first
          .then(r=>{ if(r==="granted") window.addEventListener("deviceorientation",e=>this.onOrient(e),true); }).catch(()=>{});
      } else {
        window.addEventListener("deviceorientationabsolute",e=>this.onOrient(e),true);
        window.addEventListener("deviceorientation",e=>this.onOrient(e),true);
      }
    }catch(_){}
    try{ if("wakeLock" in navigator) navigator.wakeLock.request("screen").then(l=>{ this.wake=l; }).catch(()=>{}); }catch(_){}
    if(APP.shade && !this.shadeHooked){ this.shadeHooked=true; APP.shade.on("idle",()=>this.recomputeInSun()); }
    this.timers.push(setInterval(()=>{ if(APP.tab==="drive") shadeSetDate(new Date()); },30000));   // shadows follow the real clock
    this.timers.push(setInterval(()=>{                                            // keep the decision fresh while stopped
      if(APP.tab!=="drive"||REPLAY.active||H.lat===null) return;
      // a phone standing still sends few fixes, so the 8 s off-route rule is checked here too
      if(NAV.active && NAV.mode==="live" && NAV.offSince && !NAV.rerouting && Date.now()-NAV.offSince>NAV.offRouteSec*1000) NAV.reroute(H.lat,H.lng);
      const sp=sunPosition(new Date(),H.lat,H.lng); H.sunAz=sp.az; H.sunEl=sp.el;
      if(!APP.shadeOn){ H.inSunKnown=false; bldCheck(); classify(Date.now()); renderHud(); }
    },1000));
    this.timers.push(setInterval(()=>this.refreshCloud(),300000));
    status("Waiting for GPS...");
  },

  /* End drive: sensors off, the car off the map, directions off, back to the
     planner (or to `to`, e.g. Highway glare). The log is kept. */
  end(to){
    if(this.watchId!==null && "geolocation" in navigator) navigator.geolocation.clearWatch(this.watchId);
    this.watchId=null; (this.timers||[]).forEach(clearInterval); this.timers=[];
    try{ if(this.wake) this.wake.release(); }catch(_){} this.wake=null;
    if(this.marker){ APP.map.removeLayer(this.marker); this.marker=null; }
    if(NAV.active && NAV.mode==="live") NAV.stop();
    this.started=false; this.logging=false; $("logBtn").classList.remove("on"); $("logBtn").disabled=true; this.updateLogBtn();
    $("startBtn").style.display="";
    resetHold(); H.risk="none"; renderHud();
    this.applyOrient(false);
    APP.show(to||"plan"); drawSun();
  },

  onGeo(pos){
    if(REPLAY.active) return;                       // a replay owns H while it runs
    const c=pos.coords;
    H.lat=c.latitude; H.lng=c.longitude; H.alt=c.altitude;
    H.speed=(c.speed===null||isNaN(c.speed))?null:c.speed;
    H.gpsHeading=(c.heading===null||isNaN(c.heading))?null:c.heading;
    this.chooseHeading();
    const sp=sunPosition(new Date(),H.lat,H.lng); H.sunAz=sp.az; H.sunEl=sp.el;
    if(H.cloud===null) this.refreshCloud();
    BLD.ensure([[H.lat,H.lng]]);                    // buildings around the car, loaded once per area
    TERRAIN.ensure([[H.lat,H.lng]]);                // and the hills
    if(APP.tab!=="drive") return;                   // only the Drive tab follows the car
    this.applyOrient();
    this.follow();
    if(this.marker) this.marker.setLatLng([H.lat,H.lng]);
    else this.marker=L.marker([H.lat,H.lng],{interactive:false,keyboard:false,zIndexOffset:1000,icon:L.divIcon({className:"carmk",
      iconSize:[34,34],iconAnchor:[17,17],
      html:'<svg viewBox="0 0 34 34" width="34" height="34"><path d="M17 4 L27 28 L17 22.5 L7 28 Z" fill="#3b82f6" stroke="#fff" stroke-width="2.5" stroke-linejoin="round"/></svg>'})}).addTo(APP.map);
    this.turn();
    if(!APP.shadeOn){ H.inSunKnown=false; bldCheck(); classify(Date.now()); renderHud(); this.logSample(); }   // no terrain layer -> decide now
    if(NAV.active && NAV.mode==="live") NAV.tick(H.lat,H.lng,H.speed,Date.now());   // directions + glare alerts
    drawSun();
    status(this.footer());
  },
  chooseHeading(){
    if(H.gpsHeading!==null && H.speed!==null && H.speed>=this.gpsHeadingMinSpeed){ H.headingUsed=H.gpsHeading; H.headingSrc="gps"; }
    else if(H.compassHeading!==null){ H.headingUsed=H.compassHeading; H.headingSrc="compass"; }
    else if(H.gpsHeading!==null){ H.headingUsed=H.gpsHeading; H.headingSrc="gps"; }
  },
  onOrient(e){
    if(typeof e.webkitCompassHeading==="number") H.compassHeading=e.webkitCompassHeading;
    else if(e.absolute && typeof e.alpha==="number") H.compassHeading=(360-e.alpha)%360;
    this.chooseHeading();
    if(this.started && Date.now()-(this.turnAt||0)>250) this.turn();   // the compass fires many times a second
  },

  /* ---------- the map follows the car ----------
     The first fix zooms in to mapZoom; after that the driver's own zoom (+/-, pinch) is kept. Heading up puts the
     car low on the screen, so more of the road ahead shows. */
  follow(){
    if(H.lat===null) return;
    const m=APP.map, z=this.centered?m.getZoom():this.mapZoom; this.centered=true;
    let c=L.latLng(H.lat,H.lng);
    if(this.rotOn && H.headingUsed!==null){
      const ahead=0.22*document.querySelector(".mapwrap").clientHeight, th=H.headingUsed*Math.PI/180;
      c=m.unproject(m.project(c,z).add([Math.sin(th)*ahead,-Math.cos(th)*ahead]),z);
    }
    m.setView(c,z,{animate:false});
  },

  /* ---------- north up / heading up ----------
     Leaflet can't turn its map, so heading up turns the whole map element with CSS. It is made square and as wide as
     the frame's diagonal, so no corner is ever empty, and the zoom buttons and credits move out to the frame so they
     stay upright. Leaflet's own coordinates are untouched (ShadeMap's sun test still works). Dragging would go
     sideways on a turned map, so it is off; the map follows the car anyway, and zooming stays on the car. */
  initOrient(){
    try{ this.headingUp=localStorage.getItem("solguard.headingUp")==="1"; }catch(_){}
    $("orientBtn").onclick=()=>{
      this.headingUp=!this.headingUp;
      try{ localStorage.setItem("solguard.headingUp",this.headingUp?"1":"0"); }catch(_){}
      this.applyOrient(); this.follow();
    };
    window.addEventListener("resize",()=>{ if(this.rotOn) this.layoutRot(); });
    this.renderOrient();
  },
  renderOrient(){
    const b=$("orientBtn");
    b.innerHTML=this.headingUp?'<span class="oi">&#9650;</span> Heading up':'<span class="oi">N</span> North up';
    b.title=this.headingUp?"The road ahead points up. Tap for north up.":"North points up. Tap to turn the map with the car.";
    b.classList.toggle("on",this.headingUp);
  },
  applyOrient(force){
    const on=force===false?false:(APP.tab==="drive" && this.started && this.headingUp && H.lat!==null);
    this.renderOrient();
    if(on===!!this.rotOn){ if(on) this.turn(); return; }
    this.rotOn=on;
    const m=APP.map, wrap=document.querySelector(".mapwrap"), el=$("map");
    const zoom=m.zoomControl&&m.zoomControl.getContainer(), att=m.attributionControl&&m.attributionControl.getContainer();
    wrap.classList.toggle("rot",on);
    $("ctlTL").parentNode.classList.toggle("leaflet-touch",el.classList.contains("leaflet-touch"));   // same button size
    if(on){
      this.ctlHome=[zoom&&zoom.parentNode,att&&att.parentNode];
      if(zoom) $("ctlTL").appendChild(zoom);
      if(att) $("ctlBR").appendChild(att);
      m.dragging.disable();
      m.options.touchZoom=m.options.scrollWheelZoom=m.options.doubleClickZoom="center";
      this.layoutRot();
    } else {
      const [zh,ah]=this.ctlHome||[];
      if(zoom&&zh) zh.appendChild(zoom);
      if(att&&ah) ah.appendChild(att);
      m.dragging.enable();
      m.options.touchZoom=m.options.scrollWheelZoom=m.options.doubleClickZoom=true;
      el.style.cssText=""; this.rot=0;
      m.invalidateSize({pan:false});
      if(this.started) this.follow();
    }
  },
  layoutRot(){
    const wrap=document.querySelector(".mapwrap"), el=$("map"), W=wrap.clientWidth, Ht=wrap.clientHeight;
    const D=Math.ceil(Math.hypot(W,Ht))+2;
    Object.assign(el.style,{inset:"auto",left:((W-D)/2)+"px",top:((Ht-D)/2)+"px",width:D+"px",height:D+"px"});
    APP.map.invalidateSize({pan:false}); this.follow(); this.turn();
  },
  /* the arrow always points along the heading on the map; heading up also turns the map the other way */
  turn(){
    this.turnAt=Date.now();
    drawSun();
    const h=H.headingUsed;
    if(this.marker && this.marker.getElement()){
      const svg=this.marker.getElement().firstChild;
      if(svg){ svg.style.transform="rotate("+(h===null?0:h)+"deg)"; svg.style.opacity=h===null?.55:1; }
    }
    if(this.rotOn && h!==null){
      this.rot+=((-h-this.rot)%360+540)%360-180;                   // the short way round: 350 to 10 turns 20, not 340
      $("map").style.transform="rotate("+this.rot+"deg)";
    }
  },
  async recomputeInSun(){
    if(APP.tab!=="drive"||REPLAY.active||!APP.shadeOn||H.lat===null) return;
    try{
      const pt=APP.map.latLngToContainerPoint([H.lat,H.lng]);
      H.inSun=await APP.shade.isPositionInSun(pt.x,pt.y); H.inSunKnown=true;
    }catch(_){ H.inSunKnown=false; }
    bldCheck();                                     // a building blocks even if the terrain layer says open sky
    classify(Date.now()); renderHud(); this.logSample();
  },
  /* Live cloud comes from the same hourly cache as everything else. */
  async refreshCloud(){
    if(H.lat===null) return;
    const now=Date.now();
    await wxEnsure([[H.lat,H.lng]],now,now+3600000);
    H.cloud=cloudAt(H.lat,H.lng,Date.now());
  },
  footer(){
    return "Live drive · heading from "+H.headingSrc+" · "+
      (!APP.useWeather?"weather off":(H.cloud===null?"cloud unknown":"cloud "+H.cloud+"%"))+
      (APP.shadeOn?" · shadows on":" · open sky assumed");
  },

  /* ---------- log: rows persist to IndexedDB so a reload can't lose a drive ---------- */
  COLS:["timestamp","lat","lng","alt_m","speed_mps","gps_heading","compass_heading","heading_used","heading_src",
        "sun_az","sun_el","delta_angle","in_sun","in_sun_known","risk","score","cloud_pct","sky_factor"],
  openDB(){
    return new Promise((res,rej)=>{
      if(!("indexedDB" in window)){ rej(new Error("no indexedDB")); return; }
      let settled=false; const done=(fn,v)=>{ if(!settled){ settled=true; fn(v); } };
      const req=indexedDB.open("solguard",1);
      req.onupgradeneeded=e=>{ const db=e.target.result;
        if(!db.objectStoreNames.contains("samples")) db.createObjectStore("samples",{autoIncrement:true}); };
      req.onsuccess=e=>{ this.db=e.target.result; done(res,this.db); };
      req.onerror=()=>done(rej,req.error);
      req.onblocked=()=>done(rej,new Error("idb blocked"));
      setTimeout(()=>done(rej,new Error("idb timeout")),3000);    // never hang the app
    });
  },
  async loadPersisted(){
    try{
      await this.openDB();
      this.rows=await new Promise(res=>{ const out=[];
        const cur=this.db.transaction("samples","readonly").objectStore("samples").openCursor();
        cur.onsuccess=e=>{ const c=e.target.result; if(c){ out.push(c.value); c.continue(); } else res(out); };
        cur.onerror=()=>res(out); });
    }catch(_){ this.rows=[]; }
    if(this.rows.length){ $("dlBtn").disabled=false; $("clrBtn").disabled=false; }
    this.updateLogBtn();
  },
  updateLogBtn(){
    $("logBtn").textContent=this.logging?("Stop log ("+this.rows.length+")")
      :(this.rows.length?("Start log ("+this.rows.length+" saved)"):"Start log");
  },
  logSample(){
    if(!this.logging||H.lat===null) return;
    const row=[new Date().toISOString(),H.lat,H.lng,H.alt,H.speed,H.gpsHeading,H.compassHeading,H.headingUsed,
      H.headingSrc,H.sunAz,H.sunEl,H.dAng,H.inSun,H.inSunKnown,H.risk,H.score,H.cloud,+H.sky.toFixed(2)];
    this.rows.push(row);
    if(this.db){ try{ this.db.transaction("samples","readwrite").objectStore("samples").add(row); }catch(_){} }
    $("dlBtn").disabled=false; $("clrBtn").disabled=false; this.updateLogBtn();
  },
  downloadCSV(){
    const esc=v=>v===null||v===undefined?"":(typeof v==="number"?v:String(v));
    const csv=[this.COLS.join(",")].concat(this.rows.map(r=>r.map(esc).join(","))).join("\n");
    const url=URL.createObjectURL(new Blob([csv],{type:"text/csv"}));
    const a=document.createElement("a");
    a.href=url; a.download="solguard_log_"+new Date().toISOString().replace(/[:.]/g,"-")+".csv";
    a.click(); URL.revokeObjectURL(url);
  },
  async clearLog(){
    if(!confirm("Delete all "+this.rows.length+" saved samples? Download first if you need them.")) return;
    if(this.db) await new Promise(res=>{ const r=this.db.transaction("samples","readwrite").objectStore("samples").clear();
      r.onsuccess=()=>res(); r.onerror=()=>res(); });
    this.rows=[]; $("dlBtn").disabled=true; $("clrBtn").disabled=true; this.updateLogBtn();
  }
};
