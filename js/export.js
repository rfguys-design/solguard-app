/* Export -- a year of glare on state highways, as a CSV for agencies.

   One row per ~1-mile STRETCH of highway, PER DIRECTION of travel (breaking
   at county lines): the unit a planner acts on, and one row per thing in a
   spreadsheet or a GIS join. Every stretch is reported (full coverage, zeros
   included), RANKED statewide, with the top 5% flagged as hotspots.

   The ranking metric is glare VMT -- vehicle-miles travelled in glare a year
   (vehicles passing while the stretch is in glare x its length): the unit
   agencies already count in, fair to long and short stretches, and it adds up
   by county or route. Ranked by its SEVERITY-WEIGHTED form (each passing
   vehicle weighted by how blinding the sun was: glareGeom's score, dead ahead
   in the middle of the 0-18 deg band = 1). The parts stay in the file so an
   agency can re-rank by its own rules.

   Columns:
     stretch_id                     route_direction_n
     county, route, direction       direction as signed (odd routes N/S, even E/W)
     start_lat ... end_lon, length_mi
     aadt                           vehicles a day, both directions (Caltrans counts)
     glare_hours_year, glare_days_year
     low_sun_glare_hours            of those, hours with the sun under 5 deg up: the glare no
                                    visor can block, weighted most in the ranking
     am_glare_hours, pm_glare_hours, jan ... dec
     peak_month, peak_window_local  worst month, and its clock window (Pacific time)
     vehicles_in_glare_year         vehicles passing while it is in glare
     glare_vmt_year                 = vehicles_in_glare_year x length_mi
     severity_avg                   0-1, traffic-weighted mean of how blinding
     weighted_glare_vmt_year        = glare_vmt_year x severity_avg  (THE RANKING)
     priority_rank, priority_percentile, hotspot (top 5% statewide)
     fatal_glare_coded_2015_2024    FARS fatal crashes whose investigator coded glare
     fatal_in_modeled_glare_2015_2024
                                    FARS fatal crashes that happened while this model
                                    says the stretch was in glare (observed, not in the score:
                                    too rare to rank by, but the strongest line in the file)

   Model: fixed, not the sliders: Standard (sun within 12 deg of straight
   ahead, 0-18 deg up), hills from the map's ridge heights, CLEAR SKY (cloud
   only lowers these numbers), every 5 minutes through each day's low-sun
   windows, every day of the year. A location count: each sample in the zone
   counts (no 5-second confirm). Pre-computed for the whole state
   (data/statewide_glare_<year>.csv) so downloads are instant and ranks are
   statewide even in a county file; EXPORT.build(year) regenerates it. */

const EXPORT={
  counties:null, STEP:5, stretchM:1609, hotspotFrac:0.05, lowSunDeg:5,
  std:{cone:12, visor:18, wide:22},     // Standard, written out: the export must not follow the sliders
  fileYear:2027, file:null,             // the pre-computed statewide file
  MON:["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"],

  async init(){
    try{ const j=await (await fetch("data/ca_counties.json")).json(); this.counties=j.counties.map(c=>{
      let x0=180,x1=-180,y0=90,y1=-90;
      c.rings.forEach(r=>r.forEach(([x,y])=>{ x0=Math.min(x0,x); x1=Math.max(x1,x); y0=Math.min(y0,y); y1=Math.max(y1,y); }));
      return {name:c.name, rings:c.rings, box:[x0,y0,x1,y1]}; }); }catch(_){ this.counties=[]; }
    const sel=$("xArea");
    sel.innerHTML=`<option value="all">All of California</option><option value="view">The map as shown now</option>`+
      `<optgroup label="County">`+this.counties.map(c=>`<option value="c:${c.name}">${c.name} County</option>`).join("")+`</optgroup>`;
    sel.value="c:San Diego";
    $("xGo").onclick=()=>this.download();
  },

  countyAt(lat,lng){
    for(const c of this.counties){
      if(lng<c.box[0]||lng>c.box[2]||lat<c.box[1]||lat>c.box[3]) continue;
      for(const r of c.rings){
        let inside=false;
        for(let i=0,j=r.length-1;i<r.length;j=i++){ const [xi,yi]=r[i],[xj,yj]=r[j];
          if((yi>lat)!==(yj>lat) && lng<(xj-xi)*(lat-yi)/(yj-yi)+xi) inside=!inside; }
        if(inside) return c.name;
      }
    }
    return "";
  },
  say(html){ $("xInfo").innerHTML=html; },

  /* ======================  the download  ====================== */
  async download(){
    if(this.busy) return; this.busy=true; $("xGo").disabled=true;
    try{
      if(!this.file){
        this.say("Loading the statewide file...");
        try{ const r=await fetch(`data/statewide_glare_${this.fileYear}.csv`); if(r.ok) this.file=await r.text(); }catch(_){}
        if(!this.file){ this.say("No pre-computed file: working it out (this takes a while)..."); this.file=await this.build(this.fileYear); }
        if(!this.file){ this.say("Couldn't load the highway data."); return; }
      }
      const lines=this.file.trim().split("\n"), head=lines[0].split(","), col=n=>head.indexOf(n);
      const area=$("xArea").value, hot=$("xKind").value==="hot", vb=APP.map.getBounds();
      const ci=col("county"), hi=col("hotspot"), la=col("start_lat"), lo=col("start_lon"), la2=col("end_lat"), lo2=col("end_lon"), ri=col("priority_rank");
      let rows=lines.slice(1).map(l=>l.split(","));
      if(area.startsWith("c:")) rows=rows.filter(r=>r[ci]===area.slice(2));
      else if(area==="view") rows=rows.filter(r=>vb.contains([+r[la],+r[lo]])||vb.contains([+r[la2],+r[lo2]]));
      if(hot){ rows=rows.filter(r=>r[hi]==="yes"); rows.sort((a,b)=>+a[ri]-+b[ri]); }
      if(!rows.length){ this.say(hot?"No hotspot stretches in that area.":"No state highway in that area."); return; }
      const slug=area==="all"?"california":area==="view"?"map-view":area.slice(2).toLowerCase().replace(/\s+/g,"-")+"-county";
      const name=`solguard_glare_${slug}_${this.fileYear}${hot?"_hotspots":""}.csv`;
      const url=URL.createObjectURL(new Blob([head.join(",")+"\n"+rows.map(r=>r.join(",")).join("\n")+"\n"],{type:"text/csv"}));
      const a=document.createElement("a"); a.href=url; a.download=name; a.click();
      setTimeout(()=>URL.revokeObjectURL(url),5000);
      const nh=rows.filter(r=>r[hi]==="yes").length, top=rows.slice().sort((a,b)=>+a[ri]-+b[ri])[0];
      this.say(`Saved <b>${name}</b>: ${rows.length.toLocaleString()} stretches${hot?"":`, ${nh.toLocaleString()} of them hotspots`}. `+
        `Highest: <b>${top[col("route")]} ${top[col("direction")]}</b> (${top[ci]} County), #${(+top[ri]).toLocaleString()} in California.`);
    }finally{ this.busy=false; $("xGo").disabled=false; }
  },

  /* ======================  building the statewide file  ======================
     EXPORT.build(year) -> CSV text. Run once (a tool, not a button) and save as
     data/statewide_glare_<year>.csv. */
  async build(year){
    if(!HEATMAP.roads && !(await HEATMAP.load())) return null;
    const st=await this.compute(year);
    await this.addCrashes(st);
    this.rank(st);
    return this.toCSV(st);
  },

  /* every segment, every direction, every 5 minutes of the year's low-sun windows */
  async compute(year){
    const H=HEATMAP, roads=H.roads;
    const base=[]; let N=0; roads.forEach(rd=>{ base.push(N); N+=Math.max(0,rd.n-1); });
    const segCounty=new Array(N);
    roads.forEach((rd,r)=>{ for(let i=0;i<rd.n-1;i++) segCounty[base[r]+i]=this.countyAt((rd.lat[i]+rd.lat[i+1])/2,(rd.lon[i]+rd.lon[i+1])/2); });
    const N2=2*N, mins=new Float32Array(N2), am=new Float32Array(N2), veh=new Float32Array(N2), sev=new Float32Array(N2), low=new Float32Array(N2);
    const month=new Float32Array(N2*12), days=new Uint16Array(N2), lastDay=new Int16Array(N2).fill(-1);
    const wMin=new Int16Array(N2*24).fill(32767), wMax=new Int16Array(N2*24).fill(-1);   // per month x (am, pm)
    const idx=H.headingIndex(), {cone,visor,wide}=this.std, step=this.STEP;
    if(!SunCalc.times.some(t=>t[1]==="x19Rise")) SunCalc.addTime(visor+1,"x19Rise","x19Set");
    const box=[32.4,-124.6,42.1,-114.0], corners=[[box[0],box[1]],[box[0],box[3]],[box[2],box[1]],[box[2],box[3]]];
    const nDays=Math.round((new Date(year+1,0,1)-new Date(year,0,1))/864e5);
    for(let day=0; day<nDays; day++){
      const noon=new Date(year,0,1+day,12), ts=corners.map(([a,b])=>SunCalc.getTimes(noon,a,b)), ok=d=>d&&!isNaN(d);
      const wins=[[Math.min(...ts.map(t=>ok(t.sunrise)?+t.sunrise:Infinity)), Math.max(...ts.map(t=>ok(t.x19Rise)?+t.x19Rise:-Infinity))],
                  [Math.min(...ts.map(t=>ok(t.x19Set)?+t.x19Set:Infinity)),   Math.max(...ts.map(t=>ok(t.sunset)?+t.sunset:-Infinity))]];
      for(const [a,b] of wins){
        if(!isFinite(a)||!isFinite(b)) continue;
        for(let ms=Math.floor(a/(step*6e4))*step*6e4; ms<=b; ms+=step*6e4){
          const when=new Date(ms), sunAt=H.sunCache(when), mo=when.getMonth(), mod=when.getHours()*60+when.getMinutes();
          const hf=mod<720?0:1, share=trafficShare(when);
          const azs=corners.map(([la,lo])=>sunPosition(when,la,lo).az), az0=azs[0], rel=azs.map(x=>((x-az0+540)%360)-180);
          const lo=Math.floor(Math.min(...rel))-cone-1, hi=Math.ceil(Math.max(...rel))+cone+1;
          for(let dd=lo; dd<=hi; dd++){
            const list=idx[((Math.floor(az0)+dd)%360+360)%360];
            for(let q=0;q<list.length;q+=3){
              const r=list[q], i=list[q+1], way=list[q+2], rd=roads[r], sp=sunAt(rd.lat[i],rd.lon[i]);
              if(sp.el<CONFIG.sunElevMin||sp.el>visor) continue;
              const d=angleDiff(way?(rd.brg[i]+180)%360:rd.brg[i],sp.az);
              if(d>=cone) continue;
              if(sp.el<(way?rd.ridgeBack[i+1]:rd.ridge[i])) continue;          // behind the hills
              const id=2*(base[r]+i)+way, v=rd.aadt[i]/2*share*step/60;
              // how blinding: glareGeom's severity (lowest sun worst), with the Standard numbers
              const s=sunSeverity(sp.el,visor)*clamp((wide-d)/wide,0,1);
              if(sp.el<this.lowSunDeg) low[id]+=step;
              mins[id]+=step; if(hf===0) am[id]+=step; month[id*12+mo]+=step; veh[id]+=v; sev[id]+=v*s;
              if(lastDay[id]!==day){ lastDay[id]=day; days[id]++; }
              const w=id*24+mo*2+hf; if(mod<wMin[w]) wMin[w]=mod; if(mod+step>wMax[w]) wMax[w]=mod+step;
            }
          }
        }
      }
      if(day%7===0){ this.say(`Working out ${year}... ${Math.round(100*day/nDays)}%`); await new Promise(r=>setTimeout(r,0)); }
    }
    // segments -> ~1-mile stretches per road and direction, in travel order, breaking at county lines
    const out=[], counter=new Map();
    roads.forEach((rd,r)=>{
      for(const way of [0,1]){
        const segs=[]; for(let i=0;i<rd.n-1;i++){ if(way===0?rd.dir[i]===2:rd.dir[i]===1) continue; segs.push(i); }
        if(!segs.length) continue;
        if(way) segs.reverse();
        const cn=segs.map(i=>segCounty[base[r]+i]||"");                      // gaps at the coast: neighbours' county
        for(let k=1;k<cn.length;k++) if(!cn[k]) cn[k]=cn[k-1];
        for(let k=cn.length-2;k>=0;k--) if(!cn[k]) cn[k]=cn[k+1];
        let cur=null;
        const flush=()=>{
          if(!cur||cur.len<1) return;
          const L=cur.len, f=x=>x/L, rname=rd.route?routeName(rd.route):"unnumbered", dir=bound(bearing(cur.a,cur.b),rd.route);
          const key=rname+"_"+dir, n=(counter.get(key)||0)+1; counter.set(key,n);
          const mh=cur.mon.map(v=>f(v)/60), peak=mh.indexOf(Math.max(...mh));
          let win="";
          if(mh[peak]>0){ const span=h=>cur.wmax[peak*2+h]>=0?cur.wmax[peak*2+h]-cur.wmin[peak*2+h]:-1, h=span(0)>=span(1)?0:1;
            win=pad2(Math.floor(cur.wmin[peak*2+h]/60))+":"+pad2(cur.wmin[peak*2+h]%60)+"-"+pad2(Math.floor(cur.wmax[peak*2+h]/60))+":"+pad2(cur.wmax[peak*2+h]%60); }
          const vig=f(cur.veh), mi=L/1609.34, sv=cur.veh>0?cur.sev/cur.veh:0;
          out.push({id:`${rname}_${dir}_${n}`, county:cur.county, route:rname, dir, a:cur.a, b:cur.b, mi, aadt:f(cur.aadt),
            hours:f(cur.mins)/60, low:f(cur.low)/60, days:cur.days, am:f(cur.am)/60, mh, peak:mh[peak]>0?this.MON[peak]:"", win,
            vig, vmt:vig*mi, sev:sv, wvmt:vig*mi*sv, crashCoded:0, crashModel:0, hdg:bearing(cur.a,cur.b)});
        };
        // pieces of at most ~1 mile: the layer simplifies straight highway into
        // segments several miles long, and a stretch can't break inside one
        const pieces=[];
        segs.forEach((i,k)=>{
          const A=way?[rd.lat[i+1],rd.lon[i+1]]:[rd.lat[i],rd.lon[i]], B=way?[rd.lat[i],rd.lon[i]]:[rd.lat[i+1],rd.lon[i+1]];
          const n=Math.max(1,Math.ceil(haversine(A,B)/this.stretchM));
          for(let q=0;q<n;q++) pieces.push({i,k,a:[A[0]+(B[0]-A[0])*q/n,A[1]+(B[1]-A[1])*q/n],b:[A[0]+(B[0]-A[0])*(q+1)/n,A[1]+(B[1]-A[1])*(q+1)/n]});
        });
        pieces.forEach(({i,k,a,b})=>{
          const len=haversine(a,b), id=2*(base[r]+i)+way;
          if(!cur || cur.len>=this.stretchM || haversine(cur.b,a)>50 || cn[k]!==cur.county){ flush();
            cur={a,b,county:cn[k],len:0,mins:0,low:0,am:0,veh:0,sev:0,aadt:0,days:0,mon:new Array(12).fill(0),wmin:new Array(24).fill(32767),wmax:new Array(24).fill(-1)}; }
          cur.len+=len; cur.b=b;
          // length-weighted: the figures at a point of the stretch, averaged along it
          cur.mins+=mins[id]*len; cur.low+=low[id]*len; cur.am+=am[id]*len; cur.veh+=veh[id]*len; cur.sev+=sev[id]*len; cur.aadt+=rd.aadt[i]*len;
          cur.days=Math.max(cur.days,days[id]);
          for(let m=0;m<12;m++) cur.mon[m]+=month[id*12+m]*len;
          for(let kk=0;kk<24;kk++){ const w=id*24+kk; if(wMax[w]>=0){ cur.wmin[kk]=Math.min(cur.wmin[kk],wMin[w]); cur.wmax[kk]=Math.max(cur.wmax[kk],wMax[w]); } }
        });
        flush();
      }
    });
    return out;
  },

  /* FARS fatal crashes (fars_glare_matches.csv, from fars_glare.py): each to
     the nearest stretch (within 100 m), preferring the crash's direction of travel. */
  async addCrashes(st){
    let txt; try{ const r=await fetch("fars_glare_matches.csv"); if(!r.ok) return; txt=await r.text(); }catch(_){ return; }
    const lines=txt.trim().split(/\r?\n/), h=lines[0].split(",").map(x=>x.trim()), c=n=>h.indexOf(n);   // Windows line ends
    const cell=0.01, grid=new Map(), key=(a,b)=>Math.floor(a/cell)+":"+Math.floor(b/cell);
    st.forEach((s,k)=>{ new Set([key(s.a[0],s.a[1]),key(s.b[0],s.b[1]),key((s.a[0]+s.b[0])/2,(s.a[1]+s.b[1])/2)])
      .forEach(x=>{ if(!grid.has(x)) grid.set(x,[]); grid.get(x).push(k); }); });
    const distTo=(p,s)=>{ const kx=111320*Math.cos(p[0]*Math.PI/180), ky=110540, ax=(s.a[1]-p[1])*kx, ay=(s.a[0]-p[0])*ky, ex=(s.b[1]-s.a[1])*kx, ey=(s.b[0]-s.a[0])*ky;
      const L2=ex*ex+ey*ey, t=L2?clamp(-(ax*ex+ay*ey)/L2,0,1):0; return Math.hypot(ax+t*ex,ay+t*ey); };
    this.crashStats={coded:0,model:0,codedPlaced:0,modelPlaced:0};
    for(const l of lines.slice(1)){
      const v=l.split(",").map(x=>x.trim()), coded=v[c("glare_coded")]==="1", model=v[c("model_glare")]==="1";
      if(!coded&&!model) continue;
      if(coded) this.crashStats.coded++; if(model) this.crashStats.model++;
      const p=[+v[c("lat")],+v[c("lon")]], hdg=(+v[c("seg_bearing")]+(v[c("seg_dir")]==="2"?180:0))%360;
      let best=null, bd=100;
      for(let di=-1;di<=1;di++) for(let dj=-1;dj<=1;dj++){
        for(const k of grid.get((Math.floor(p[0]/cell)+di)+":"+(Math.floor(p[1]/cell)+dj))||[]){
          const s=st[k], d=distTo(p,s)+(angleDiff(s.hdg,hdg)>90?60:0);       // prefer the crash's direction
          if(d<bd){ bd=d; best=s; }
        }
      }
      if(best){ if(coded){ best.crashCoded++; this.crashStats.codedPlaced++; } if(model){ best.crashModel++; this.crashStats.modelPlaced++; } }
    }
  },

  rank(st){
    const order=st.map((s,k)=>k).sort((a,b)=>st[b].wvmt-st[a].wvmt);
    const hot=Math.max(1,Math.round(this.hotspotFrac*st.length));
    order.forEach((k,r)=>{ const s=st[k]; s.rank=r+1; s.pct=s.wvmt>0?100*(1-r/st.length):0; s.hot=s.wvmt>0 && r<hot; });
  },

  toCSV(st){
    const head=["stretch_id","county","route","direction","start_lat","start_lon","end_lat","end_lon","length_mi","aadt",
      "glare_hours_year","glare_days_year","low_sun_glare_hours","am_glare_hours","pm_glare_hours",...this.MON,"peak_month","peak_window_local",
      "vehicles_in_glare_year","glare_vmt_year","severity_avg","weighted_glare_vmt_year","priority_rank","priority_percentile","hotspot",
      "fatal_glare_coded_2015_2024","fatal_in_modeled_glare_2015_2024"];
    const rows=st.map(s=>[s.id,s.county,s.route,s.dir,s.a[0].toFixed(5),s.a[1].toFixed(5),s.b[0].toFixed(5),s.b[1].toFixed(5),s.mi.toFixed(2),
      Math.round(s.aadt),s.hours.toFixed(1),s.days,s.low.toFixed(1),s.am.toFixed(1),(s.hours-s.am).toFixed(1),...s.mh.map(v=>v.toFixed(1)),s.peak,s.win,
      Math.round(s.vig),Math.round(s.vmt),s.sev.toFixed(3),Math.round(s.wvmt),s.rank,s.pct.toFixed(1),s.hot?"yes":"no",
      s.crashCoded,s.crashModel].join(","));
    return head.join(",")+"\n"+rows.join("\n")+"\n";
  }
};
