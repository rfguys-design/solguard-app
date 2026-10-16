/* Terrain -- does a hill or ridge stand between the car and the sun?

   The same test the Python pipeline uses for the statewide map
   (solguard.py, HorizonCache.angle): from the road point, walk toward the
   sun's compass direction over the elevation model; the horizon there is
       max over distance d of atan((elev(d) - elev(here) - d^2 / 2R') / d)
   with R' = 7/6 of the Earth's radius (the usual allowance for light bending
   over the curve). The sun is blocked when its elevation is below that.

   Elevation: the Terrarium tiles on AWS (the ones ShadeMap draws its hill
   shadows from), decoded in the browser. Three levels, so the planner sees
   what the map's shadow layer shows without loading a whole county:
     zoom 12 (~38 m per point)  100 m - 3 km, every 50 m
     zoom 11 (~75 m)            3-15 km, every 75 m
     zoom 10 (~150 m, as in the Python scan) 15-30 km, every 150 m
   The first 100 m are skipped (the Python scan starts at 150 m): elevation
   models are bare earth, so on a bridge or a raised freeway the "road" sits
   at the valley floor and the ground beside it looks like a wall. A zoom-14
   (10 m) band tried for road cuts produced exactly that: skylines 17-20 deg
   up from terrain 15 m away. What decides a sun under ~4 deg right beside
   the road (cuts, embankments, sound walls, trees) is not in this data. */

const TERRAIN={
  NEAR_Z:12, MID_Z:11, FAR_Z:10, skipM:100, nearM:3000, midM:15000, farM:30000,
  stepNear:50, stepMid:75, stepFar:150,
  R:6371008.8*7/6,
  tiles:new Map(),                 // "z/x/y" -> {w,h,data:Float32Array} | Promise | null (failed)
  memo:new Map(),
  url:(z,x,y)=>`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`,

  tileXY(lat,lng,z){
    const n=2**z, x=(lng+180)/360*n, r=lat*Math.PI/180;
    const y=(1-Math.log(Math.tan(r)+1/Math.cos(r))/Math.PI)/2*n;
    return [x,y];
  },
  loadTile(z,x,y){
    const k=z+"/"+x+"/"+y;
    if(this.tiles.has(k)) return this.tiles.get(k);
    const job=(async()=>{
      try{
        const r=await fetch(this.url(z,x,y)); if(!r.ok) throw 0;
        const bmp=await createImageBitmap(await r.blob());
        const c=document.createElement("canvas"); c.width=bmp.width; c.height=bmp.height;
        const g=c.getContext("2d",{willReadFrequently:true}); g.drawImage(bmp,0,0);
        const px=g.getImageData(0,0,c.width,c.height).data, data=new Float32Array(c.width*c.height);
        for(let i=0;i<data.length;i++) data[i]=px[4*i]*256+px[4*i+1]+px[4*i+2]/256-32768;
        this.tiles.set(k,{w:c.width,h:c.height,data});
      }catch(_){ this.tiles.set(k,null); }
    })();
    this.tiles.set(k,job);
    return job;
  },
  /* elevation (m) at a point from zoom z, or null if that tile isn't loaded */
  elev(lat,lng,z){
    const [fx,fy]=this.tileXY(lat,lng,z), x=Math.floor(fx), y=Math.floor(fy);
    const t=this.tiles.get(z+"/"+x+"/"+y);
    if(t instanceof Promise){ this._partial=true; return null; }   // still downloading: answer is provisional
    if(!t) return null;
    const c=Math.min(t.w-1,Math.floor((fx-x)*t.w)), r=Math.min(t.h-1,Math.floor((fy-y)*t.h));
    return t.data[r*t.w+c];
  },
  /* the finest loaded elevation allowed at this distance (0 near, 1 mid, 2 far) */
  at(lat,lng,band){
    if(band<=0){ const e=this.elev(lat,lng,this.NEAR_Z); if(e!==null) return e; }
    if(band<=1){ const e=this.elev(lat,lng,this.MID_Z); if(e!==null) return e; }
    return this.elev(lat,lng,this.FAR_Z);
  },

  /* Load what a route needs: fine tiles along it, coarse tiles 30 km round it. */
  ensure(points){
    if(!points.length) return Promise.resolve();
    const jobs=[], seen=new Set(), add=(z,x,y)=>{ const k=z+"/"+x+"/"+y; if(seen.has(k)) return; seen.add(k); jobs.push(this.loadTile(z,x,y)); };
    let la0=90,la1=-90,ln0=180,ln1=-180;
    for(const p of points){ la0=Math.min(la0,p[0]); la1=Math.max(la1,p[0]); ln0=Math.min(ln0,p[1]); ln1=Math.max(ln1,p[1]);
      for(const [z,pad] of [[this.NEAR_Z,0.03]])                     // ~3 km round each point
        for(const dl of [-pad,0,pad]) for(const dn of [-pad,0,pad]){
          const [x,y]=this.tileXY(p[0]+dl,p[1]+dn,z); add(z,Math.floor(x),Math.floor(y)); } }
    const box=(m,z)=>{
      const padLat=m/110540, padLng=m/(111320*Math.cos((la0+la1)/2*Math.PI/180));
      const [x0,y0]=this.tileXY(la1+padLat,ln0-padLng,z), [x1,y1]=this.tileXY(la0-padLat,ln1+padLng,z);
      for(let x=Math.floor(x0);x<=Math.floor(x1);x++) for(let y=Math.floor(y0);y<=Math.floor(y1);y++) add(z,x,y);
    };
    box(this.midM,this.MID_Z); box(this.farM,this.FAR_Z);
    return Promise.all(jobs);
  },
  ready(lat,lng){ return this.elev(lat,lng,this.FAR_Z)!==null; },

  /* The horizon angle (deg) looking toward bearing az from this point, and
     where it is: {ang, d}. null if the elevation isn't loaded here. */
  horizon(lat,lng,az){
    const key=lat.toFixed(3)+","+lng.toFixed(3)+","+Math.round(az);
    if(this.memo.has(key)) return this.memo.get(key);
    this._partial=false;
    const here=this.at(lat,lng,0); if(here===null) return null;
    const b=az*Math.PI/180, ky=110540, kx=111320*Math.max(0.2,Math.cos(lat*Math.PI/180));
    let best={ang:0,d:0};
    for(let d=this.skipM; d<=this.farM; d+=(d<this.nearM?this.stepNear:d<this.midM?this.stepMid:this.stepFar)){
      const e=this.at(lat+d*Math.cos(b)/ky, lng+d*Math.sin(b)/kx, d<this.nearM?0:d<this.midM?1:2);
      if(e===null) continue;
      const a=Math.atan2(e-here-d*d/(2*this.R),d)*180/Math.PI;
      if(a>best.ang) best={ang:a,d};
    }
    if(this.memo.size>50000) this.memo.clear();
    // never remember an answer made while finer tiles were still downloading:
    // it fell back to coarse data and drew false spikes in the Driver's view
    if(!this._partial) this.memo.set(key,best);
    return best;
  },
  /* Is the sun at (az, el) behind the terrain from here? {kind:"hill", ang, d} or null/undefined */
  blocks(lat,lng,az,el){
    if(el<=0) return null;
    if(!this.ready(lat,lng)) return undefined;
    const h=this.horizon(lat,lng,az);
    return h && el<h.ang ? {kind:"hill", ang:h.ang, d:h.d} : null;
  }
};
