/* Driver's view -- the windshield, seen from the driver's seat.
   Draws the glare zones EXACTLY as glareGeom() tests them: across, degrees
   between the heading and the sun's compass direction; up, the sun's
   elevation. Both axes are to the same scale (degrees), so the red box is the
   real "coneLeftDeg left to coneRightDeg right, horizon to sunElevMax" region
   and the sun dot lands where the classifier sees it. Nothing here decides
   anything; it only shows what classify() and glareGeom() already decided.

   Source of the view, in order:
     replay running      -> the virtual car (H)
     live drive running  -> the real car (H)
     otherwise           -> a preview: the map centre at the chosen time,
                            facing the way the "Facing" slider says.

   Also here: the glare SENSITIVITY setting. It rewrites the CONFIG thresholds
   every tab reads, then rescores the current tab. "Standard" is the setting
   validated against crash records and used by the Python statewide scan.
   To fit their own car, a driver can DRAG the red box's left and right edges
   and the visor line on the picture (or use the sliders). */

/* ===========================  SENSITIVITY  =========================== */
const SENS={
  presets:{
    less:    {left:8,  right:8,  visor:15, hold:8},
    standard:{left:12, right:12, visor:18, hold:5},
    more:    {left:18, right:18, visor:24, hold:2}
  },
  names:{less:"Less sensitive", standard:"Standard", more:"More sensitive"},
  lim:{edge:[4,30], visor:[5,30], hold:[0,10]},          // visor down to 5 deg: a deep visor or a tall driver
  cur:{left:12, right:12, visor:18, hold:5},

  /* Watch zone and its confirm time follow the main ones in the same
     proportion as the validated defaults (22 = 12+10, 22 = 18+4, 3 s of 5 s). */
  apply(s){
    const [e0,e1]=this.lim.edge, [v0,v1]=this.lim.visor, [h0,h1]=this.lim.hold;
    s={left:clamp(Math.round(s.left),e0,e1), right:clamp(Math.round(s.right),e0,e1),
       visor:clamp(Math.round(s.visor),v0,v1), hold:clamp(Math.round(s.hold),h0,h1)};
    this.cur=s;
    CONFIG.coneLeftDeg=s.left;        CONFIG.coneRightDeg=s.right;
    CONFIG.coneDeg=Math.max(s.left,s.right);   CONFIG.coneMarginalDeg=CONFIG.coneDeg+CONFIG.watchExtraDeg;
    CONFIG.sunElevMax=s.visor;        CONFIG.sunMarginalElevMax=s.visor+4;
    CONFIG.highMinSec=s.hold;         CONFIG.marginalMinSec=Math.round(s.hold*0.6);
  },
  preset(){ const c=this.cur;
    for(const k in this.presets){ const p=this.presets[k];
      if(p.left===c.left&&p.right===c.right&&p.visor===c.visor&&p.hold===c.hold) return k; }
    return null; },
  load(){
    try{
      localStorage.removeItem("solguard.car");          // left over from the dropped photo feature
      const s=JSON.parse(localStorage.getItem("solguard.sens")||"null");
      if(s && s.cone!==undefined && s.left===undefined){ s.left=s.right=s.cone; }   // older saves: one symmetric cone
      if(s && [s.left,s.right,s.visor,s.hold].every(v=>typeof v==="number")) this.apply(s);
    }catch(_){}
  },
  save(){ try{ localStorage.setItem("solguard.sens",JSON.stringify(this.cur)); }catch(_){} },
  /* run fn with setting s applied, then restore the driver's own */
  with(s,fn){
    const keepC=Object.assign({},CONFIG), keepS=Object.assign({},this.cur);
    this.apply(s);
    try{ return fn(); } finally{ Object.assign(CONFIG,keepC); this.cur=keepS; }
  }
};
SENS.load();                          // before APP.init, so the first scores already use it

/* =============================  VIEW  ============================== */
const VIEW={
  K:5.7, CX:200, HY:140,             // px per degree (a ~70 deg view, like the driver's own); straight ahead; horizon line
  facing:null, open:true, built:false, e:{}, drag:null,

  init(){
    // open by default on a desktop; folded to its title bar on a phone, unless the person chose before
    try{ const v=localStorage.getItem("solguard.viewOpen"); this.open=v===null?!isPhone():v!=="0"; }catch(_){ this.open=!isPhone(); }
    $("viewToggle").onclick=()=>{ this.open=!this.open; try{ localStorage.setItem("solguard.viewOpen",this.open?"1":"0"); }catch(_){} this.layout(); this.render(); };
    $("vFacing").oninput=e=>{ this.facing=+e.target.value; this.render(); };
    $("vFaceSun").onclick=()=>{ const s=this.preview(); if(s){ this.facing=Math.round(s.az); this.render(); } };
    document.querySelectorAll("[data-sens]").forEach(b=>b.onclick=()=>this.setSens(Object.assign({},SENS.presets[b.dataset.sens])));
    for(const [id,key] of [["sLeft","left"],["sRight","right"],["sVisor","visor"],["sHold","hold"]])
      $(id).oninput=e=>this.setSens(Object.assign({},SENS.cur,{[key]:+e.target.value}));
    this.initDrag();
    APP.map.on("moveend",()=>this.render());
    this.build(); this.syncSens(); this.layout();
  },
  layout(){
    $("viewBody").style.display=this.open?"":"none";
    $("viewToggle").textContent=this.open?"Hide":"Show";
  },

  /* ---------- sensitivity ---------- */
  setSens(s){
    SENS.apply(s); SENS.save(); this.syncSens(); this.build();
    // rescore whatever is on screen with the new thresholds
    if(APP.tab==="plan" && PLAN.routes.length){ PLAN.hideTip(); PLAN.recompute(); PLAN.updateTip(); }
    else { const t=APP.tabs[APP.tab]; if(t&&t.onWeather) t.onWeather(); }
    if(REPLAY.active) REPLAY.preRender();            // recolour the drive (drawn above the plan's lines)
    updateSunLine(); this.render();
  },
  syncSens(){
    const c=SENS.cur, k=SENS.preset(), wx=CONFIG.watchExtraDeg;
    $("sLeft").value=c.left;   $("sLeftV").textContent=c.left+"°";
    $("sRight").value=c.right; $("sRightV").textContent=c.right+"°";
    $("sVisor").value=c.visor; $("sVisorV").textContent=c.visor+"°";
    $("sHold").value=c.hold;   $("sHoldV").textContent=c.hold+" s";
    document.querySelectorAll("[data-sens]").forEach(b=>b.classList.toggle("on",b.dataset.sens===k));
    $("sensName").textContent=k?SENS.names[k]:"Custom";
    const across=c.left===c.right?`within &plusmn;${c.left}&deg; of straight ahead`:`from ${c.left}&deg; left to ${c.right}&deg; right of straight ahead`;
    const wAcross=c.left===c.right?`out to &plusmn;${c.left+wx}&deg;`:`out to ${c.left+wx}&deg; left and ${c.right+wx}&deg; right`;
    $("sensNote").innerHTML=
      `<b>Glare</b> (red) when the sun is ${across} and under ${c.visor}&deg; up, for ${c.hold} s. `+
      `<b>Watch</b> (amber) ${wAcross} and up to ${c.visor+4}&deg;, for ${CONFIG.marginalMinSec} s. `+
      (k==="standard"?"Standard is the setting checked against crash records."
                     :"Standard (&plusmn;12&deg;, 18&deg;, 5 s) is the setting checked against crash records; the statewide data files always use it.");
  },

  /* ---------- dragging the zone on the picture ----------
     Three handles: the red box's left edge, its right edge, and the visor
     line. While dragging only the picture updates (cheap); the tabs are
     rescored once, on release. */
  initDrag(){
    const svg=$("viewSvg");
    const toSvg=e=>{ const p=svg.createSVGPoint(); p.x=e.clientX; p.y=e.clientY;
      const m=svg.getScreenCTM(); return m?p.matrixTransform(m.inverse()):null; };
    svg.addEventListener("pointerdown",e=>{
      const h=e.target.closest("[data-drag]"); if(!h) return;
      e.preventDefault(); svg.setPointerCapture(e.pointerId);
      this.drag=h.dataset.drag; svg.classList.add("dragging");
    });
    svg.addEventListener("pointermove",e=>{
      if(!this.drag) return;
      const p=toSvg(e); if(!p) return;
      const c=Object.assign({},SENS.cur);
      if(this.drag==="left")  c.left =(this.CX-p.x)/this.K;
      if(this.drag==="right") c.right=(p.x-this.CX)/this.K;
      if(this.drag==="visor") c.visor=(this.HY-p.y)/this.K;
      SENS.apply(c);
      const k=JSON.stringify(SENS.cur); if(k===this._lastDrag) return; this._lastDrag=k;
      this.syncSens(); this.build(); this.render();
    });
    const end=()=>{ if(!this.drag) return; this.drag=null; this._lastDrag=null;
      svg.classList.remove("dragging"); this.setSens(SENS.cur); };
    svg.addEventListener("pointerup",end); svg.addEventListener("pointercancel",end);
  },

  /* ---------- drawing ---------- */
  px(off){ return this.CX+off*this.K; },
  py(el){ return this.HY-el*this.K; },

  /* The fixed parts: frame, dashboard, zones, drag handles. Rebuilt when
     sensitivity changes. */
  build(){
    const c=CONFIG, x=o=>this.px(o).toFixed(1), y=e=>this.py(e).toFixed(1), HY=this.HY, f1=v=>v.toFixed(1);
    /* Layout (viewBox 400 x 300), drawn from a photo taken in the driver's
       seat: a ~70 deg view (a phone's 1x camera), the driver's visor across the
       top, the A-pillar on the left only, the steering wheel centred under the
       eyes, the dash and the SolGuard screen at the bottom right. The sky
       above the horizon is to scale (K px per degree); the cabin is context.
       Cabin colours come from the theme (--cab-*): light greys by day, dark
       ones in dark mode, so the picture sits in the page instead of on it. */
    const edgeX=yy=>-2+(yy-22)*(106/168);                       // the pillar's inner edge (glass begins right of it)
    const glass="M -2 0 L 400 0 L 400 190 L 104 190 L -2 22 Z";
    const vy=this.py(c.sunElevMax), V=f1(vy);
    const gl=c.coneLeftDeg, gr=c.coneRightDeg, wl=gl+c.watchExtraDeg, wr=gr+c.watchExtraDeg;
    const span=(a,b)=>a===b?`&plusmn;${a}&deg;`:`${a}&deg; L &middot; ${b}&deg; R`;
    // drag handles: a wide invisible hit strip plus a visible grip
    const gx=(o,yy,id)=>`<g data-drag="${id}" class="vgrip-ew"><rect x="${f1(this.px(o)-9)}" y="${V}" width="18" height="${f1(HY-vy)}" fill="transparent"/>`+
      `<rect x="${f1(this.px(o)-4)}" y="${f1(yy-11)}" width="8" height="22" rx="4" fill="#fff" stroke="#d70015" stroke-width="1.5"/>`+
      `<path d="M${f1(this.px(o)-1.5)} ${f1(yy-5)} v10 M${f1(this.px(o)+1.5)} ${f1(yy-5)} v10" stroke="#d70015" stroke-width="1"/></g>`;
    const midY=(vy+HY)/2, vgX=150;
    const handles=gx(-gl,midY,"left")+gx(gr,midY,"right")+
      `<g data-drag="visor" class="vgrip-ns"><rect x="40" y="${f1(vy-8)}" width="360" height="16" fill="transparent"/>`+
      `<rect x="${vgX-13}" y="${f1(vy-4)}" width="26" height="8" rx="4" fill="#fff" stroke="#6e6e73" stroke-width="1.5"/>`+
      `<path d="M${vgX-6} ${f1(vy-1.5)} h12 M${vgX-6} ${f1(vy+1.5)} h12" stroke="#6e6e73" stroke-width="1"/></g>`;
    const ticks=[-30,-20,-10,10,20,30].map(o=>`<line x1="${x(o)}" y1="${HY-2}" x2="${x(o)}" y2="${HY+2}" stroke="#ffffff99"/>`+
      `<text x="${x(o)}" y="${HY-5}" fill="#ffffffdd" font-size="8" text-anchor="middle" paint-order="stroke" stroke="#0007" stroke-width="2">${Math.abs(o)}&deg; ${o<0?"L":"R"}</text>`).join("");
    const elTicks=[10,20].map(e=>{ const yy=this.py(e), ex=Math.max(4,edgeX(yy))+4;
      return `<line x1="${f1(ex)}" y1="${f1(yy)}" x2="${f1(ex+6)}" y2="${f1(yy)}" stroke="#ffffff88"/>`+
        `<text x="${f1(ex+9)}" y="${f1(yy+3)}" fill="#ffffffcc" font-size="8" paint-order="stroke" stroke="#0006" stroke-width="2">${e}&deg;</text>`; }).join("");
    // roadside marker posts on the right shoulder, in perspective toward the vanishing point
    const posts=[0.08,0.16,0.28,0.46,0.75].map(t=>{
      const px=200+t*(470-200), pb=HY+t*(192-HY), h=1.5+t*24, w=0.6+t*3.4;
      return `<rect x="${f1(px-w/2)}" y="${f1(pb-h)}" width="${f1(w)}" height="${f1(h)}" fill="#e4e7ec"/>`+
             `<rect x="${f1(px-w/2)}" y="${f1(pb-h)}" width="${f1(w)}" height="${f1(h*0.18)}" fill="#ff9a2e"/>`;
    }).join("");
    // centre-line dashes, shrinking with distance
    const dashes=[[0.04,0.07],[0.11,0.16],[0.22,0.31],[0.40,0.56],[0.70,1.0]].map(([a,b])=>{
      const P=t=>[f1(200+t*(130-200)),f1(HY+t*(192-HY))], w=(a+b)/2*5+0.4;
      return `<line x1="${P(a)[0]}" y1="${P(a)[1]}" x2="${P(b)[0]}" y2="${P(b)[1]}" stroke="#f1f3f6" stroke-width="${f1(w)}"/>`;
    }).join("");
    // the driver's visor, flipped down: from the pillar across the whole view, bottom edge at the visor line
    const vx0=Math.max(8,edgeX(vy)-6);
    const visor=`<path d="M${f1(vx0)} -2 L402 -2 L402 ${V} L${f1(vx0+12)} ${V} Q${f1(vx0)} ${V} ${f1(vx0)} ${f1(vy-12)} Z" style="fill:var(--cab-visor)" opacity=".94"/>`+
      (vy>34?`<rect x="${f1(vx0+26)}" y="6" width="190" height="${f1(Math.max(8,vy-26))}" rx="10" fill="none" style="stroke:var(--cab-line)" stroke-width="1.2"/>`:"");
    $("viewSvg").setAttribute("viewBox","0 0 400 300");
    $("viewSvg").innerHTML=`
<defs>
  <clipPath id="vGlass"><path d="${glass}"/></clipPath>
  <linearGradient id="vSky" x1="0" y1="0" x2="0" y2="1">
    <stop id="vSkyTop" offset="0" stop-color="#2a4a7a"/><stop id="vSkyLow" offset="1" stop-color="#f0a060"/>
  </linearGradient>
  <linearGradient id="vGnd" x1="0" y1="0" x2="0" y2="1">
    <stop id="vGndFar" offset="0" stop-color="#6d6a58"/><stop id="vGndNear" offset="1" stop-color="#2f3326"/>
  </linearGradient>
  <linearGradient id="vRoad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7a7f86"/><stop offset="1" stop-color="#4a4e55"/></linearGradient>
  <linearGradient id="vTint" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffffff" stop-opacity=".08"/>
    <stop offset=".45" stop-color="#ffffff" stop-opacity="0"/></linearGradient>
  <radialGradient id="vGlow"><stop offset="0" stop-color="#fffbe6"/><stop offset=".25" stop-color="#ffe9a0" stop-opacity=".9"/>
    <stop offset="1" stop-color="#ffcc55" stop-opacity="0"/></radialGradient>
  <radialGradient id="vWash" gradientUnits="userSpaceOnUse" cx="200" cy="100" r="260">
    <stop offset="0" stop-color="#fff8dc" stop-opacity="1"/><stop offset=".35" stop-color="#fff0c0" stop-opacity=".55"/>
    <stop offset="1" stop-color="#ffe7a0" stop-opacity=".12"/></radialGradient>
</defs>
<rect width="400" height="300" style="fill:var(--cab-bg)"/>
<g clip-path="url(#vGlass)">
  <rect x="0" y="0" width="400" height="${HY}" fill="url(#vSky)"/>
  <rect x="0" y="${HY}" width="400" height="${192-HY}" fill="url(#vGnd)"/>
  <!-- the road ahead: two-lane, the car in the right lane -->
  <polygon points="198.5,${HY} 201.5,${HY} 520,192 -60,192" fill="url(#vRoad)"/>
  <line x1="201.3" y1="${HY}" x2="470" y2="192" stroke="#eef0f3" stroke-width="2.2"/>
  <line x1="198.7" y1="${HY}" x2="-20" y2="192" stroke="#f2c94c" stroke-width="2.2"/>
  ${dashes}${posts}
  <!-- watch zone, then glare zone: the classifier's two boxes -->
  <rect x="${x(-wl)}" y="${y(c.sunMarginalElevMax)}" width="${f1((wl+wr)*this.K)}"
        height="${f1(c.sunMarginalElevMax*this.K)}" fill="#ff9f0a22" stroke="#ff9f0a" stroke-width="1.2" stroke-dasharray="4 3"/>
  <rect x="${x(-gl)}" y="${V}" width="${f1((gl+gr)*this.K)}"
        height="${f1(c.sunElevMax*this.K)}" fill="#ff3b3030" stroke="#ff3b30" stroke-width="1.6"/>
  <line x1="0" y1="${HY}" x2="400" y2="${HY}" stroke="#ffffff40"/>
  ${ticks}${elTicks}
  <g id="vSun"><circle r="30" fill="url(#vGlow)"/><circle id="vSunCore" r="7" fill="#fffdf2"/></g>
  <!-- hills, then buildings, as skylines drawn over the sun: a blocked sun disappears behind them -->
  <path id="vHill" d="" fill="#3b4a2f" fill-opacity=".95" stroke="#5d6e4a" stroke-width="1"/>
  <path id="vBld" d="" fill="#2a2f37" fill-opacity=".92" stroke="#4a5260" stroke-width="1"/>
  <rect x="0" y="0" width="400" height="192" fill="url(#vTint)"/>
  <rect id="vWashR" x="0" y="0" width="400" height="192" fill="url(#vWash)" opacity="0"/>
</g>
<!-- the driver's visor (the model: it blocks the sun above sunElevMax) -->
${visor}
<line x1="${f1(vx0)}" y1="${V}" x2="400" y2="${V}" style="stroke:var(--cab-text)" stroke-width="1" stroke-dasharray="2 3" opacity=".7"/>
<text x="392" y="${f1(vy-6)}" style="fill:var(--cab-text)" font-size="9" text-anchor="end">visor blocks sun above ${c.sunElevMax}&deg;</text>
<text x="${f1(this.px((gr-gl)/2))}" y="${f1(vy+11)}" fill="#fff" font-size="9" font-weight="700" text-anchor="middle" paint-order="stroke" stroke="#a1120acc" stroke-width="2.5">GLARE ${span(gl,gr)}</text>
<text x="200" y="${f1(Math.max(10,this.py(c.sunMarginalElevMax)-3))}" style="fill:var(--cab-text)" font-size="8" font-weight="700" text-anchor="middle">WATCH ${span(wl,wr)}</text>
${handles}
<line x1="200" y1="${HY}" x2="200" y2="${HY-7}" stroke="#ffffffcc" stroke-width="1.5"/>
<text x="200" y="${HY-10}" fill="#ffffffdd" font-size="8" text-anchor="middle" paint-order="stroke" stroke="#0007" stroke-width="2">ahead</text>
<!-- door and dashboard -->
<path d="M0 118 L74 190 L0 190 Z" style="fill:var(--cab-door)"/>
<path d="M0 300 L0 194 Q200 180 400 194 L400 300 Z" style="fill:var(--cab-dash)"/>
<path d="M0 195 Q200 181 400 195" fill="none" style="stroke:var(--cab-dashtop)" stroke-width="5"/>
<!-- SolGuard on its screen, bottom right: the same colour as the Drive banner -->
<circle cx="300" cy="213" r="5" style="fill:var(--cab-wheel-hi)"/>
<rect x="302" y="210" width="104" height="70" rx="7" fill="#0b0b0c" style="stroke:var(--cab-line)"/>
<rect id="vPhone" x="308" y="216" width="92" height="30" rx="4" fill="#6e6e73"/>
<text id="vPhoneT" x="354" y="235" fill="#fff" font-size="11" font-weight="800" text-anchor="middle">--</text>
<!-- steering wheel, centred under the driver's eyes -->
<circle cx="188" cy="334" r="151" fill="none" style="stroke:var(--cab-wheel)" stroke-width="22"/>
<circle cx="188" cy="331" r="151" fill="none" style="stroke:var(--cab-wheel-hi)" stroke-width="1.5" opacity=".8"/>
<path d="M50 300 Q110 282 150 298 M326 300 Q266 282 226 298" style="stroke:var(--cab-wheel)" stroke-width="18" fill="none" stroke-linecap="round"/>
<circle cx="188" cy="318" r="38" style="fill:var(--cab-wheel);stroke:var(--cab-wheel-hi)" stroke-width="1.5"/>
<g id="vEdge" style="display:none"><path id="vEdgeArrow" fill="#ffd36b" stroke="#0008" stroke-width="1"/><text id="vEdgeText" fill="#ffd36b" font-size="10" font-weight="700" paint-order="stroke" stroke="#000a" stroke-width="2.5"></text></g>
<text id="vMode" x="392" y="13" style="fill:var(--cab-text)" font-size="8" text-anchor="end"></text>`;
    this.e={ sun:$("vSun"), core:$("vSunCore"), bld:$("vBld"), hill:$("vHill"), wash:$("vWashR"), washG:$("vWash"), edge:$("vEdge"),
             arrow:$("vEdgeArrow"), edgeT:$("vEdgeText"), mode:$("vMode"), top:$("vSkyTop"), low:$("vSkyLow"),
             gFar:$("vGndFar"), gNear:$("vGndNear"), phone:$("vPhone"), phoneT:$("vPhoneT") };
    this.B={x0:62,x1:388,y0:Math.max(40,vy+14),y1:132,top:Math.max(26,vy+14),tx0:70,tx1:340,u:1};   // where edge arrows may sit
    this.built=true;
  },

  /* Where the sun lands in the picture: {x, y, shown} or, off-picture,
     the side it is on (l / r / t) for the edge arrow. The view is +-FOV deg
     across and from just under the horizon to TOP deg up. */
  FOV:35, TOP:24,
  sunSpot(off,el){
    const F=this.FOV, T=this.TOP, inX=Math.abs(off)<=F, inY=el>=-1 && el<=T;
    const x=this.px(clamp(off,-F,F)), y=this.py(clamp(el,-1,T));
    return {x,y,shown:inX&&inY, side:!inX?(off>0?"r":"l"):(el>T?"t":null)};
  },

  /* The buildings around the car as a skyline across the windshield: the
     highest angle any building reaches, every 1.5 deg, from BLD.skyline().
     Buildings below the eye line (or none loaded) draw nothing. */
  drawSkyline(lat,lng,hdg){
    if(!this.skyOffs){ this.skyOffs=[]; for(let o=-36;o<=36;o+=1.2) this.skyOffs.push(o); }
    // hills first (behind): the terrain horizon every 1.5 deg, smooth like a ridge line
    // (preview mode looks at the map centre: fetch its elevation once, then redraw)
    if(lat!=null && !TERRAIN.ready(lat,lng)){ const k=lat.toFixed(2)+","+lng.toFixed(2);
      if(this._tReq!==k){ this._tReq=k; TERRAIN.ensure([[lat,lng]]).then(()=>this.render()); } }
    const hv=(lat==null||hdg==null||!TERRAIN.ready(lat,lng))?null:this.skyOffs.map(o=>{ const h=TERRAIN.horizon(lat,lng,(hdg+o+360)%360); return h?h.ang:0; });
    if(!hv||hv.every(e=>e<=0.05)) this.e.hill.setAttribute("d","");
    else{
      const base=this.HY+2;
      let d=`M${this.px(this.skyOffs[0]).toFixed(1)} ${base}`;
      this.skyOffs.forEach((o,i)=>{ d+=` L${this.px(o).toFixed(1)} ${(hv[i]>0?this.py(Math.min(hv[i],40)):base).toFixed(1)}`; });
      this.e.hill.setAttribute("d",d+` L${this.px(this.skyOffs[this.skyOffs.length-1]).toFixed(1)} ${base} Z`);
    }
    const v=(lat==null||hdg==null)?null:BLD.skyline(lat,lng,hdg,this.skyOffs);
    if(!v||v.every(e=>e<=0)){ this.e.bld.setAttribute("d",""); return; }
    const base=this.HY+2;
    let d=`M${this.px(this.skyOffs[0]).toFixed(1)} ${base}`;
    this.skyOffs.forEach((o,i)=>{
      const x0=this.px(o-0.75).toFixed(1), x1=this.px(o+0.75).toFixed(1), y=v[i]>0?this.py(Math.min(v[i],40)).toFixed(1):base;
      d+=` L${x0} ${y} L${x1} ${y}`;            // flat tops: a building edge, not a mountain
    });
    d+=` L${this.px(this.skyOffs[this.skyOffs.length-1]).toFixed(1)} ${base} Z`;
    this.e.bld.setAttribute("d",d);
  },

  /* Preview mode: sun at the map centre at the chosen time (or now, on Drive). */
  preview(){
    if(!APP.map||!APP.when) return null;
    const c=APP.map.getCenter(), when=APP.tab==="drive"?new Date():APP.when, sp=sunPosition(when,c.lat,c.lng);
    return {az:sp.az, el:sp.el, lat:c.lat, lng:c.lng, when};
  },

  render(){
    if(!this.built||!this.open) return;
    const live=APP.tab==="drive" && DRIVE.started && !REPLAY.active && H.headingUsed!==null && H.sunEl!==null;
    const fromCar=(REPLAY.active && H.sunEl!==null) || live;
    let az, el, hdg, sky, risk=null, now=null, modeTxt, pb=null, lat, lng;
    $("vPreviewRow").style.display=fromCar?"none":"";
    if(fromCar){
      az=H.sunAz; el=H.sunEl; hdg=H.headingUsed; lat=H.lat; lng=H.lng; sky=APP.useWeather&&!(REPLAY.active&&REPLAY.clearSky)?skyFactor(H.cloud):1;
      risk=H.risk; now=REPLAY.active?REPLAY.clock.getTime():Date.now();
      modeTxt=(REPLAY.active?"replay · ":"live · ")+clockText(new Date(now))+" · heading "+Math.round(hdg)+"° "+compass(hdg);
    } else {
      const p=this.preview(); if(!p) return;
      if(this.facing===null) this.facing=p.el>0?Math.round(p.az):270;
      az=p.az; el=p.el; hdg=this.facing;
      sky=APP.useWeather?skyFactor(cloudAt(p.lat,p.lng,p.when.getTime())):1;
      pb=BLD.blocks(p.lat,p.lng,az,el)||null;          // a building at the map centre, if loaded
      lat=p.lat; lng=p.lng;
      $("vFacing").value=hdg; $("vFacingV").textContent=Math.round(hdg)+"° "+compass(hdg);
      modeTxt="preview · map centre · "+clockText(p.when);
    }
    const off=signedOff(hdg,az), g=glareGeom(el,az,hdg), tier=applySky(g.tier,sky);
    this.e.mode.textContent=modeTxt;

    // sky colour from the sun's height
    const [top,low]= el<-6?["#070c18","#141c30"] : el<0?["#16223d","#6a4458"] : el<8?["#27426e","#f39a5a"]
                   : el<20?["#3566a0","#e9be86"] : ["#3f7fc4","#a9cdea"];
    this.e.top.setAttribute("stop-color",top); this.e.low.setAttribute("stop-color",low);
    const [gf,gn]= el<-6?["#151a1f","#0b0e11"] : el<0?["#3a3638","#1a1b1c"] : el<8?["#7a6a52","#2f2e24"] : ["#6f7458","#2f3628"];
    this.e.gFar.setAttribute("stop-color",gf); this.e.gNear.setAttribute("stop-color",gn);

    this.drawSkyline(lat,lng,hdg);

    // the sun: in the windshield, or an arrow at the edge pointing to it
    const S=this.sunSpot(off,el), sx=S.x, sy=S.y, shown=el>-1 && S.shown, B=this.B;
    this.e.sun.style.display=shown?"":"none";
    this.e.sun.setAttribute("transform",`translate(${sx.toFixed(1)},${sy.toFixed(1)})`);
    const blocked=fromCar?risk==="blocked":(!!pb && g.tier!=="safe"), bldg=fromCar?H.bldg:pb;   // same rule as classify()
    this.e.sun.setAttribute("opacity", blocked?0.35:(sky<0.6?0.55:1));
    if(el>-1 && !shown){
      let ax, ay, ang, txt, anchor="middle";
      const inX=S.side==="t";
      if(!inX){ const r=S.side==="r"; ax=r?B.x1:B.x0; ay=clamp(sy,B.y0,B.y1); ang=r?0:180;
                txt="sun "+Math.round(Math.abs(off))+"° "+(r?"right":"left"); anchor=r?"end":"start"; }
      else    { ax=clamp(sx,B.tx0,B.tx1); ay=B.top; ang=-90; txt="sun "+Math.round(el)+"° up"; }
      const t=ang*Math.PI/180, ca=Math.cos(t), sa=Math.sin(t), u=B.u;
      const P=(a,b)=>(ax+u*(a*ca-b*sa)).toFixed(1)+","+(ay+u*(a*sa+b*ca)).toFixed(1);
      this.e.arrow.setAttribute("d",`M${P(8,0)} L${P(-6,-7)} L${P(-6,7)} Z`);
      this.e.edgeT.setAttribute("x",inX?ax:(S.side==="r"?ax-12*u:ax+12*u)); this.e.edgeT.setAttribute("y",inX?ay+18*u:ay+4*u);
      this.e.edgeT.setAttribute("text-anchor",inX?"middle":anchor); this.e.edgeT.textContent=txt;
      this.e.edge.style.display="";
    } else this.e.edge.style.display="none";

    // glare wash: how blinding it would look
    const shownTier=fromCar?(risk==="high"||risk==="marginal"?risk:(risk==="blocked"?"safe":tier)):tier;
    const wash=blocked?0:(shownTier==="high"?0.35+0.45*g.score*sky:shownTier==="marginal"?0.12+0.15*g.score*sky:0);
    this.e.wash.setAttribute("opacity",wash.toFixed(2));
    this.e.washG.setAttribute("cx",sx.toFixed(1)); this.e.washG.setAttribute("cy",sy.toFixed(1));

    this.explain({off,el,g,tier,sky,risk,now,fromCar,blocked,bldg});
  },

  /* The words under the picture: what was flagged, and why. */
  explain(s){
    const c=CONFIG;
    // whole degrees, unless rounding would put the number on the wrong side of a zone edge
    const deg=(v,edges)=>{ const r=Math.round(v); return edges.some(e=>(v<e)!==(r<e)||(v<=e)!==(r<=e))?v.toFixed(1):String(r); };
    const a=Math.abs(s.off), edge=s.off<0?c.coneLeftDeg:c.coneRightDeg, wx=c.watchExtraDeg;
    const side=a<1?"straight ahead":deg(a,[edge,edge+wx])+"° "+(s.off<0?"left":"right")+" of straight ahead";
    const where=`Sun ${deg(s.el,[c.sunElevMax,c.sunMarginalElevMax])}° up, ${side}`;
    let state, why;
    if(s.el<c.sunElevMin){ state="none"; why="The sun is below the horizon."; }
    else if(s.blocked){ state="blocked"; why=where+", but "+(s.bldg?bldWords(s.bldg):"a hill (terrain shadow layer)")+" blocks it."; }
    else {
      // which side's edge applies, in words: "the 12° glare edge on the left"
      const sideW=s.off<0?"left":"right";
      const inG=a<edge || a<1, inW=a<edge+wx;
      if(inG && s.el<=c.sunElevMax) why=where+`: inside the glare zone (${edge}° to the ${sideW}) and below the ${c.sunElevMax}° visor line. The visor can't block it.`+
        (s.el<LOW_SUN+1?" A sun this low is the most blinding of all.":"");
      else if(inG && s.el<=c.sunMarginalElevMax) why=where+`: in line with the road but just above the ${c.sunElevMax}° visor line, so the visor can mostly block it.`;
      else if(inW && s.el<=c.sunMarginalElevMax) why=where+`: past the glare zone's ${edge}° ${sideW} edge, inside the watch zone (${edge+wx}°).`;
      else if(inW) why=where+`: high enough (over ${c.sunMarginalElevMax}°) for the visor.`;
      else why=where+`: outside the watch zone (${edge+wx}° to the ${sideW}).`;
      if(s.tier!==s.g.tier) why+=s.tier==="safe"?" Heavy cloud removes the glare.":" Cloud softens it from Glare to Watch.";
      state=s.tier;
      if(s.fromCar){
        // the car's warning waits for the sun to STAY in the zone (classify's hold)
        const need=s.tier==="high"?c.highMinSec:s.tier==="marginal"?c.marginalMinSec:0;
        const since=s.tier==="high"?H._t.highSince:H._t.margSince;
        if(need && RANK[s.risk]<RANK[s.tier] && since){
          why+=` Confirming: ${Math.min(need,(s.now-since)/1000).toFixed(0)} of ${need} s before it warns.`;
        } else if(RANK[s.risk]>RANK[s.tier]) why+=" Holding the warning a moment so it doesn't flicker.";
        state=s.risk==="none"?s.tier:s.risk;
      } else if(s.tier!=="safe") why+=` A car would warn once it stays there ${s.tier==="high"?c.highMinSec:c.marginalMinSec} s.`;
    }
    const [cls,word]=BANNER[state]||BANNER.safe;
    const pill=$("vState"); pill.textContent=word; pill.style.background="var(--"+cls+")";
    this.e.phone.style.fill="var(--"+cls+")"; this.e.phoneT.textContent=word.toUpperCase();
    $("vWhy").textContent=why;
  }
};
