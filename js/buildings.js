/* Buildings -- does a building (or a freeway sound wall) stand between the
   car and the sun?

   Data: OpenStreetMap, from the public Overpass API, loaded in 0.01-degree
   tiles (~1.1 x 0.9 km) along a route or around the live car, and cached for
   the session. Footprints are good in San Diego (many from SanGIS), but
   HEIGHTS ARE MOSTLY MISSING: checked 2026-10-15, only 0-4% of buildings near
   the example routes and downtown have a height tag, 4-25% a storey count.
   So a missing height gets a LOW default (one storey). That keeps the test
   conservative: it only says "blocked" when even a low building would block,
   so it can miss shade from an untagged tower but never hides real glare
   behind an imagined one.

   Test (2.5-D ray cast, the same idea as the ridge test for hills): walk from
   the car toward the sun's compass direction; for every footprint edge the
   ray crosses at distance d, the building blocks the sun if
       atan((height - eye height) / d) > sun elevation.
   With a low sun this reaches far: a 10 m building blocks a 5 deg sun out to
   ~100 m. */

const BLD={
  TILE:0.005, CELL:0.0005,         // load tiles (deg, ~550 x 460 m); index cells (~50 m)
  eye:1.2,                         // driver's eye above the road, m
  maxReachM:800,                   // never look further than this
  stepM:10,                        // ray sampling step through the index
  tiles:new Map(),                 // "a:b" -> "ok" | Promise | {failedAt}
  queue:Promise.resolve(),         // requests go one at a time: the public server allows ~2 slots
  batch:6,                         // tiles per request; a failed batch is split in half and retried
  retryAfterMs:20000,
  cells:new Map(),                 // "i:j" -> [edge,...]
  seen:new Set(),                  // OSM way ids already indexed
  maxH:4.5, count:0, estimated:0,
  // public Overpass servers, tried in turn (all free, all sometimes busy)
  endpoints:["https://overpass-api.de/api/interpreter","https://maps.mail.ru/osm/tools/overpass/api/interpreter",
             "https://overpass.private.coffee/api/interpreter"],

  tileKey(lat,lng){ return Math.floor(lat/this.TILE)+":"+Math.floor(lng/this.TILE); },
  /* the tile under a point is loaded, so a ray from it can be trusted (mostly: see ensure) */
  covered(lat,lng){ return this.tiles.get(this.tileKey(lat,lng))==="ok"; },
  ready(){ return this.count>0; },

  /* Load every tile within ~250 m of these points. Resolves when done;
     failures are remembered so a dead server isn't asked again and again.
     Points far apart (a road from the Glare map has one per ~1 km) are
     filled in every 200 m first, so no stretch between them is missed. */
  ensure(points){
    const dense=[];
    for(let i=0;i<points.length;i++){
      const a=points[i]; dense.push(a);
      const b=points[i+1]; if(!b) break;
      const n=Math.floor(haversine(a,b)/200);
      for(let k=1;k<=n;k++) dense.push([a[0]+(b[0]-a[0])*k/(n+1), a[1]+(b[1]-a[1])*k/(n+1)]);
    }
    points=dense;
    const need=new Set(), wait=new Set(), pad=0.0025, now=Date.now();
    for(const p of points) for(const dl of [-pad,0,pad]) for(const dn of [-pad,0,pad]){
      const k=this.tileKey(p[0]+dl,p[1]+dn), v=this.tiles.get(k);
      if(v instanceof Promise) wait.add(v);
      else if(v===undefined || (v.failedAt && now-v.failedAt>this.retryAfterMs)) need.add(k); }
    // nearby tiles in one request: sort so each batch is a compact patch
    const keys=[...need].sort();
    for(let i=0;i<keys.length;i+=this.batch) wait.add(this.fetchTiles(keys.slice(i,i+this.batch)));
    return Promise.all([...wait]);
  },
  ensureBounds(b){
    const pts=[]; for(let la=b.getSouth();la<=b.getNorth()+this.TILE;la+=this.TILE)
      for(let ln=b.getWest();ln<=b.getEast()+this.TILE;ln+=this.TILE) pts.push([Math.min(la,b.getNorth()),Math.min(ln,b.getEast())]);
    return pts.length>48?Promise.resolve():this.ensure(pts);   // never load a whole city at once
  },

  fetchTiles(keys){
    const job=this.queue=this.queue.then(()=>this.load(keys),()=>this.load(keys));
    keys.forEach(k=>this.tiles.set(k,job));
    return job;
  },
  /* One request for a batch of tiles. If it keeps failing (dense cities such
     as Los Angeles, where every building is mapped, can time out), split it
     in half and try each half, down to a single tile, before giving up. */
  async load(keys){
    const T=this.TILE, bb=k=>{ const [a,b]=k.split(":").map(Number); return `(${(a*T).toFixed(4)},${(b*T).toFixed(4)},${((a+1)*T).toFixed(4)},${((b+1)*T).toFixed(4)})`; };
    const q="[out:json][timeout:50];("+keys.map(k=>`way["building"]${bb(k)};way["barrier"="noise_barrier"]${bb(k)};`).join("")+");out tags geom;";
    const sleep=ms=>new Promise(r=>setTimeout(r,ms));
    const tries=keys.length>1?2:4;                    // big batches give up sooner and split
    for(let attempt=0;attempt<tries;attempt++){
      const url=this.endpoints[attempt%this.endpoints.length];
      try{
        const ctl=new AbortController(), timer=setTimeout(()=>ctl.abort(),60000);
        const r=await fetch(url,{method:"POST",body:"data="+encodeURIComponent(q),signal:ctl.signal,
                                 headers:{"Content-Type":"application/x-www-form-urlencoded"}});
        clearTimeout(timer);
        if(!r.ok){ await sleep(r.status===429||r.status===504?4000*(attempt+1):1000); continue; }
        const js=await r.json();
        if(js.remark && /timed out|out of memory/i.test(js.remark)) continue;   // a partial answer: don't trust it
        for(const e of js.elements||[]) this.add(e);
        keys.forEach(k=>this.tiles.set(k,"ok"));
        return;
      }catch(_){ await sleep(1500); }
    }
    if(keys.length>1){ const h=keys.length>>1; await this.load(keys.slice(0,h)); await this.load(keys.slice(h)); return; }
    keys.forEach(k=>this.tiles.set(k,{failedAt:Date.now()}));   // try again after retryAfterMs
  },

  /* metres from OSM tags; est = true when guessed */
  height(t){
    const num=v=>{ if(!v) return null; const m=String(v).match(/^\s*([\d.]+)\s*(m|ft|')?/i); if(!m) return null;
      const x=parseFloat(m[1]); return (m[2]&&/ft|'/i.test(m[2]))?x*0.3048:x; };
    let h=num(t.height)||num(t["building:height"]);
    if(h) return {h,est:false};
    const lv=parseFloat(t["building:levels"]);
    if(lv>0) return {h:lv*3+1,est:false};
    if(t.barrier==="noise_barrier") return {h:4,est:true};
    if(/^(garage|garages|shed|carport|kiosk)$/.test(t.building)) return {h:3,est:true};
    return {h:4.5,est:true};                       // one storey: the conservative default
  },

  add(e){
    if(e.type!=="way"||!e.geometry||e.geometry.length<2||this.seen.has(e.id)) return;
    const t=e.tags||{};
    if(t.building==="roof"||t.building==="construction") return;   // open-sided or not built yet
    this.seen.add(e.id);
    const {h,est}=this.height(t), kind=t.barrier==="noise_barrier"?"wall":"building";
    const g=e.geometry, C=this.CELL;
    const b={id:e.id,h,est,kind,pts:g.map(p=>[p.lat,p.lon])};
    this.count++; if(est) this.estimated++; this.maxH=Math.max(this.maxH,h);
    for(let i=1;i<g.length;i++){
      const a=g[i-1], c=g[i], edge={a:[a.lat,a.lon], c:[c.lat,c.lon], b};
      const i0=Math.floor(Math.min(a.lat,c.lat)/C), i1=Math.floor(Math.max(a.lat,c.lat)/C);
      const j0=Math.floor(Math.min(a.lon,c.lon)/C), j1=Math.floor(Math.max(a.lon,c.lon)/C);
      for(let ii=i0;ii<=i1;ii++) for(let jj=j0;jj<=j1;jj++){
        const k=ii+":"+jj; let arr=this.cells.get(k); if(!arr) this.cells.set(k,arr=[]); arr.push(edge); }
    }
  },

  /* Is the point inside this footprint? (GPS error, or a road mapped under a
     building or parking structure.) Such a building is ignored: otherwise
     every ray "hits" its walls a few metres away and the whole sky is blocked. */
  contains(b,lat,lng){
    const P=b.pts; let inside=false;
    for(let i=0,j=P.length-1;i<P.length;j=i++){
      const [yi,xi]=P[i],[yj,xj]=P[j];
      if((yi>lat)!==(yj>lat) && lng<(xj-xi)*(lat-yi)/(yj-yi)+xi) inside=!inside;
    }
    return inside;
  },
  /* Does anything block the sun at (az, el) from this point? Returns the
     nearest blocker {h, d, est, kind}, null if clear, or undefined if the
     buildings here aren't loaded (unknown). */
  blocks(lat,lng,az,el){
    if(el<=0) return null;
    if(!this.covered(lat,lng)) return undefined;
    const tanE=Math.tan(el*Math.PI/180);
    const reach=Math.min(this.maxReachM,(this.maxH-this.eye)/tanE);
    const kx=111320*Math.cos(lat*Math.PI/180), ky=110540;
    const dx=Math.sin(az*Math.PI/180), dy=Math.cos(az*Math.PI/180);   // east, north (m)
    const C=this.CELL, tried=new Set(), done=new Set(), inside=new Map();
    let best=null;
    for(let s=0;s<=reach+this.stepM;s+=this.stepM){
      const la=lat+dy*s/ky, ln=lng+dx*s/kx;
      const ci=Math.floor(la/C), cj=Math.floor(ln/C);
      for(const k of [ci+":"+cj, (ci+1)+":"+cj, (ci-1)+":"+cj, ci+":"+(cj+1), ci+":"+(cj-1)]){
        if(tried.has(k)) continue; tried.add(k);
        const arr=this.cells.get(k); if(!arr) continue;
        for(const e of arr){
          if(done.has(e)) continue; done.add(e);
          if(e.b.kind==="building"){ let c=inside.get(e.b); if(c===undefined) inside.set(e.b,c=this.contains(e.b,lat,lng)); if(c) continue; }
          // ray P + t*d against segment A + u*(B - A), in metres around the car
          const ax=(e.a[1]-lng)*kx, ay=(e.a[0]-lat)*ky, bx=(e.c[1]-lng)*kx, by=(e.c[0]-lat)*ky;
          const ex=bx-ax, ey=by-ay, den=dx*ey-dy*ex;
          if(Math.abs(den)<1e-9) continue;
          const t=(ax*ey-ay*ex)/den, u=(ax*dy-ay*dx)/den;
          if(u<0||u>1||t<2||t>reach) continue;
          if((e.b.h-this.eye)/t>tanE && (!best||t<best.d)) best={h:e.b.h,d:t,est:e.b.est,kind:e.b.kind};
        }
      }
      if(best && best.d<s-this.stepM) break;          // nothing closer can come later
    }
    return best;
  },

  /* The skyline seen from this point: for each direction hdg+offs[i], the
     highest angle (deg above the eye) that any building reaches within
     reachM. null if the buildings here aren't loaded. Drawn by the Driver's
     view; uses the same footprints and heights as blocks(). Cached, because
     a replay asks every frame from almost the same spot. */
  skyline(lat,lng,hdg,offs,reachM){
    if(!this.covered(lat,lng)) return null;
    // recompute only after ~10 m of travel or a 2 deg turn: a replay asks 60 times a second
    const key=lat.toFixed(4)+","+lng.toFixed(4)+","+Math.round(hdg/2)+","+this.count;
    if(this._sky && this._sky.key===key) return this._sky.v;
    const kx=111320*Math.cos(lat*Math.PI/180), ky=110540, C=this.CELL, R=reachM||500, inside=new Map();
    const v=offs.map(off=>{
      const az=(hdg+off)*Math.PI/180, dx=Math.sin(az), dy=Math.cos(az), tried=new Set(), done=new Set();
      let top=-1;
      for(let s=0;s<=R;s+=this.stepM){
        const ci=Math.floor((lat+dy*s/ky)/C), cj=Math.floor((lng+dx*s/kx)/C);
        for(const k of [ci+":"+cj,(ci+1)+":"+cj,(ci-1)+":"+cj,ci+":"+(cj+1),ci+":"+(cj-1)]){
          if(tried.has(k)) continue; tried.add(k);
          const arr=this.cells.get(k); if(!arr) continue;
          for(const e of arr){
            if(done.has(e)) continue; done.add(e);
            if(e.b.kind==="building"){ let c=inside.get(e.b); if(c===undefined) inside.set(e.b,c=this.contains(e.b,lat,lng)); if(c) continue; }
            const ax=(e.a[1]-lng)*kx, ay=(e.a[0]-lat)*ky, ex=(e.c[1]-lng)*kx-ax, ey=(e.c[0]-lat)*ky-ay, den=dx*ey-dy*ex;
            if(Math.abs(den)<1e-9) continue;
            const t=(ax*ey-ay*ex)/den, u=(ax*dy-ay*dx)/den;
            if(u<0||u>1||t<2||t>R) continue;
            top=Math.max(top,Math.atan((e.b.h-this.eye)/t)*180/Math.PI);
          }
        }
      }
      return top;
    });
    this._sky={key,v};
    return v;
  },

  /* GeoJSON for ShadeMap's building shadows, inside the given bounds */
  features(b){
    const out=[], seen=new Set(), C=this.CELL;
    for(let i=Math.floor(b.getSouth()/C);i<=Math.floor(b.getNorth()/C);i++)
      for(let j=Math.floor(b.getWest()/C);j<=Math.floor(b.getEast()/C);j++){
        const arr=this.cells.get(i+":"+j); if(!arr) continue;
        for(const e of arr){ const B=e.b; if(seen.has(B)||B.kind!=="building") continue; seen.add(B);
          const ring=B.pts.map(p=>[p[1],p[0]]);
          if(ring.length>=4) out.push({type:"Feature",geometry:{type:"Polygon",coordinates:[ring]},properties:{height:B.h,render_height:B.h}}); }
      }
    return out;
  }
};

/* Fill the car's obstruction state from the buildings. Called by the live
   drive and the replay just before classify(); a building block overrides an
   open sky from the terrain layer, never the other way round. */
function bldCheck(){
  H.bldg=null;
  if(H.lat===null||H.sunEl===null||H.sunEl<=0) return false;
  // buildings first (nearer, more specific), then hills (js/terrain.js)
  const b=BLD.blocks(H.lat,H.lng,H.sunAz,H.sunEl)||TERRAIN.blocks(H.lat,H.lng,H.sunAz,H.sunEl);
  if(b){ H.bldg=b; H.inSun=false; H.inSunKnown=true; return true; }
  return false;
}
function bldWords(b){
  if(!b) return "";
  if(b.kind==="hill") return `a hill or ridge ${b.d>=1000?(b.d/1609.34).toFixed(1)+" mi":Math.round(b.d)+" m"} away (the skyline there is ${b.ang.toFixed(1)}° up)`;
  const what=b.kind==="wall"?"a sound wall":"a building";
  return `${what} about ${Math.round(b.h)} m tall${b.est?" (height estimated)":""}, ${Math.round(b.d)} m away`;
}
