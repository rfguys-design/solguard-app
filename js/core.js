/* SolGuard core -- the ONE copy of the glare science and the weather.
   ================================================================
   Every tab (Plan, Glare map, Drive, Replay) calls these functions. There is
   deliberately no second copy anywhere: when plan.html and index.html each had
   their own, the planner drifted to a +-22 deg cone while the HUD used +-12 deg,
   and the same road got two different answers. Same lesson as the Python side. */

/* ===========================  CONFIG  =========================== */
const CONFIG = {
  /* The scientific choices. They must match solguard.py (SUN_LOW, SUN_HIGH,
     CONE); if the two drift apart the map and the statewide scan disagree. */
  sunElevMin:          0,    // glare counts once the sun clears the horizon; hills are the
                             // ridge test's job. Was 3 until 2026-10-13: fatal-crash data
                             // (FARS) had drivers blinded with the sun 0.2-2.6 deg up.
  sunElevMax:         18,    // above this a sun visor reaches it
  sunMarginalElevMax: 22,    // marginal ("watch") tolerated a little higher
  coneDeg:            12,    // sun this close to straight ahead = unavoidable glare
  coneMarginalDeg:    22,    // wider cone for marginal
  coneLeftDeg:        12,    // the glare box's edges, left and right of the heading. Equal to
  coneRightDeg:       12,    //   coneDeg unless the driver drags them apart (js/view.js)
  watchExtraDeg:      10,    // watch zone = glare box + this much each side (22 = 12 + 10)

  /* The demo drives and example trips are PICKED with this tight limit, not
     with the driver's own setting: a drive that is glare under a 6 deg / 7 deg
     box below a 10 deg visor line is glare under Standard and any looser
     setting too, so the picks never need to change. */
  demoLimit: {left:6, right:7, visor:10, hold:5},

  /* Cloud rule: sky factor 1 at <= cloudClear %, 0 at >= cloudOvercast %. */
  cloudClear:         30,
  cloudOvercast:      90,
  wxCellDeg:         0.5,    // weather grid: one cloud value per half-degree cell (~55 x 45 km)

  /* Sustained-exposure gating (live drive, replay, planner). */
  highMinSec:          5,    // seconds in the cone to CONFIRM high glare
  marginalMinSec:      3,    // seconds to confirm marginal
  releaseSec:          2,    // hold a warning this long after it clears (anti-flicker)

  /* Services and keys. The ShadeMap key is visible to anyone who opens the
     page source once deployed -- that is normal for a browser map key. */
  shadeMapApiKey: "eyJhbGciOiJIUzI1NiJ9.eyJlbWFpbCI6InJmZ3V5c0BnbWFpbC5jb20iLCJjcmVhdGVkIjoxNzgxOTk1OTE4NDUwLCJpYXQiOjE3ODE5OTU5MTh9.fft6LyVaQmINbPIJz6PBHzJumZ_Y2sE87pXcQMyC3eM",
  osrmBase:  "https://router.project-osrm.org",          // demo routing server, no SLA
  photon:    "https://photon.komoot.io/api/",              // place search + suggestions as you type (OSM data, business names, ranked near you)
  nominatim: "https://nominatim.openstreetmap.org/search" // fallback only, on submit (its rules forbid as-you-type)
};

/* =====================  SUN + GLARE MATH  ====================== */
/* SunCalc gives azimuth measured from SOUTH, positive toward west, in radians.
   Drivers and maps use compass bearings from NORTH, clockwise, in degrees:
   add 180 and wrap. */
function sunPosition(date,lat,lng){
  const p=SunCalc.getPosition(date,lat,lng);
  return { az:(p.azimuth*180/Math.PI+180+360)%360, el:p.altitude*180/Math.PI };
}
function angleDiff(a,b){ let d=Math.abs(a-b)%360; return d>180?360-d:d; }
/* signed off-axis: + means the sun is clockwise of the heading (driver's RIGHT). */
function signedOff(heading,az){ return ((az-heading+540)%360)-180; }
function clamp(v,a,b){ return v<a?a:(v>b?b:v); }

/* Instantaneous geometry for one moment: {tier, score 0..1, d}.
   "high"     = sun inside the visor-unblockable band AND within the glare box
                across: coneLeftDeg to the left of the heading, coneRightDeg to
                the right (equal by default; a driver can drag them apart in the
                Driver's view, since the driver's pillar is closer than the far one)
   "marginal" = the box widened by watchExtraDeg each side, and slightly higher sun
   score is a continuous severity for colouring and the log. */
/* How blinding the sun is by its height (0..1), for a visor line at `visor` deg.
   LOWEST IS WORST: full weight from the horizon to LOW_SUN deg up, easing to
   0.6 at the visor line, then fading out through the marginal band.
   Until 2026-10-17 this peaked in the MIDDLE of the band (9 deg), on the idea
   that a sun near the horizon is dimmed by haze; a 2 deg sun scored ~0.4. Ray's
   own I-580 drive (blinded with the sun 2-8 deg up, visor useless) and the FARS
   fatal crashes with drivers blinded by a sun 0.2-2.6 deg up say otherwise: a
   very low sun is the one nothing can block. */
const LOW_SUN=4;
function sunSeverity(el,visor){
  if(el<0) return 0;
  if(el<=LOW_SUN) return 1;
  if(el<=visor) return 1-0.4*(el-LOW_SUN)/Math.max(1,visor-LOW_SUN);
  return clamp(0.6*(1-(el-visor)/4),0,0.6);                  // above the visor line: marginal, fading
}
function glareGeom(el,az,hdg){
  const d=angleDiff(hdg,az);
  if(el<CONFIG.sunElevMin) return {tier:"safe",score:0,d};
  const elevF=sunSeverity(el,CONFIG.sunElevMax);
  const aimF =clamp((CONFIG.coneMarginalDeg-d)/CONFIG.coneMarginalDeg,0,1);
  const s=signedOff(hdg,az), wx=CONFIG.watchExtraDeg;     // + = sun to the driver's right
  let tier="safe";
  if(s>-CONFIG.coneLeftDeg && s<CONFIG.coneRightDeg && el<=CONFIG.sunElevMax) tier="high";
  else if(s>-CONFIG.coneLeftDeg-wx && s<CONFIG.coneRightDeg+wx && el<=CONFIG.sunMarginalElevMax) tier="marginal";
  return {tier,score:elevF*aimF,d};
}

/* Clear-sky factor: 1 when clear, ramps to 0 as cloud cover reaches overcast.
   null (unknown) -> 1: assume clear and never hide a real glare. */
function skyFactor(cloud){
  if(cloud===null||cloud===undefined) return 1;
  return clamp((CONFIG.cloudOvercast-cloud)/(CONFIG.cloudOvercast-CONFIG.cloudClear),0,1);
}
/* The cloud rule, in one place: overcast removes glare, partly cloudy turns
   a red warning into amber. With the defaults: >= 81% cloud -> safe,
   54-81% -> high becomes marginal. */
function applySky(tier,sky){
  if(sky<=0.15) return "safe";
  if(sky<0.6 && tier==="high") return "marginal";
  return tier;
}
const RANK={safe:0,marginal:1,high:2};

/* Share of a day's traffic in each hour, midnight to 11 PM. Same table as
   HOURLY_TRAFFIC in solguard.py: a typical urban weekday shape, NOT measured
   per road. Caltrans PeMS has real hourly counts; this is the stand-in. */
const HOURLY_TRAFFIC=[0.8,0.5,0.4,0.4,0.8,2.2,4.5,6.2,6.0,5.2,5.0,5.3,
                      5.6,5.7,6.2,6.9,7.4,7.6,6.3,4.6,3.5,2.9,2.3,1.5];
const HOURLY_SUM=HOURLY_TRAFFIC.reduce((a,b)=>a+b,0);
/* Fraction of the day's traffic passing per hour at this clock time,
   blended between hours so the count doesn't jump on the hour. */
function trafficShare(d){
  const t=minsOfDay(d)/60-0.5, h=Math.floor(t), f=t-h;
  const a=HOURLY_TRAFFIC[(h+24)%24], b=HOURLY_TRAFFIC[(h+25)%24];
  return (a+(b-a)*f)/HOURLY_SUM;
}

/* =========================  GEO HELPERS  ======================== */
function bearing(a,b){ // a,b = [lat,lng] -> compass degrees
  const y=Math.sin((b[1]-a[1])*Math.PI/180)*Math.cos(b[0]*Math.PI/180);
  const x=Math.cos(a[0]*Math.PI/180)*Math.sin(b[0]*Math.PI/180)-
          Math.sin(a[0]*Math.PI/180)*Math.cos(b[0]*Math.PI/180)*Math.cos((b[1]-a[1])*Math.PI/180);
  return (Math.atan2(y,x)*180/Math.PI+360)%360;
}
function haversine(a,b){ const R=6371000,t=Math.PI/180;
  const dLat=(b[0]-a[0])*t,dLng=(b[1]-a[1])*t;
  const s=Math.sin(dLat/2)**2+Math.cos(a[0]*t)*Math.cos(b[0]*t)*Math.sin(dLng/2)**2;
  return 2*R*Math.asin(Math.sqrt(s)); }
/* a point distM metres from (lat,lng) along a compass bearing */
function offsetPoint(lat,lng,brgDeg,distM){
  const R=6371000, br=brgDeg*Math.PI/180, dr=distM/R, la=lat*Math.PI/180, lo=lng*Math.PI/180;
  const la2=Math.asin(Math.sin(la)*Math.cos(dr)+Math.cos(la)*Math.sin(dr)*Math.cos(br));
  const lo2=lo+Math.atan2(Math.sin(br)*Math.sin(dr)*Math.cos(la),Math.cos(dr)-Math.sin(la)*Math.sin(la2));
  return [la2*180/Math.PI, lo2*180/Math.PI];
}

/* =========================  DATE HELPERS  ======================= */
/* Always build dates from LOCAL parts. toISOString() is UTC and silently
   shifts the day for anyone east of Greenwich. */
const pad2=n=>String(n).padStart(2,"0");
function ymd(d){ return d.getFullYear()+"-"+pad2(d.getMonth()+1)+"-"+pad2(d.getDate()); }
function fromYmd(s,mins){ const [Y,M,D]=String(s).split("-").map(Number);
  return new Date(Y,M-1,D,Math.floor((mins||0)/60),(mins||0)%60,0); }
function minsOfDay(d){ return d.getHours()*60+d.getMinutes(); }
function hhmm(mins){ return pad2(Math.floor(mins/60))+":"+pad2(mins%60); }
function clockText(d){ return d.toLocaleTimeString([], {hour:"numeric",minute:"2-digit"}); }

/* =============================  WEATHER  ============================
   One hourly cloud-cover cache shared by every tab, keyed by weather cell and
   UTC day. Open-Meteo's forecast API covers ~3 months back to 16 days ahead;
   older dates fall back to its archive. A cell/day that neither has is stored
   as "no data" so we never re-ask, and lookups return null -> clear sky. */
const WX = { days:new Map(), inflight:new Map() };   // "cell|YYYY-MM-DD" -> 24 hourly values

function wxCell(lat,lon){ const s=CONFIG.wxCellDeg;
  return Math.floor(lat/s)+":"+Math.floor(lon/s); }
function wxCellCentre(cell){ const s=CONFIG.wxCellDeg, [a,b]=cell.split(":").map(Number);
  return [(a+0.5)*s,(b+0.5)*s]; }
const utcDay=ms=>new Date(ms).toISOString().slice(0,10);

/* Cloud % at (lat,lon) for the hour nearest `ms`, or null if not loaded / no data. */
function cloudAt(lat,lon,ms){
  const r=Math.round(ms/3600000)*3600000;            // nearest whole hour
  const arr=WX.days.get(wxCell(lat,lon)+"|"+utcDay(r));
  if(!arr) return null;
  const v=arr[new Date(r).getUTCHours()];
  return (v===null||v===undefined)?null:v;
}
function cloudLoaded(lat,lon,ms){
  const r=Math.round(ms/3600000)*3600000;
  return WX.days.has(wxCell(lat,lon)+"|"+utcDay(r));
}

/* Make sure every cell touched by `points` ([[lat,lon],...]) is loaded for the
   UTC days spanned by msFrom..msTo. One multi-location request per call. */
async function wxEnsure(points,msFrom,msTo){
  const cells=[...new Set(points.map(p=>wxCell(p[0],p[1])))];
  const days=[]; for(let t=msFrom-3600000; t<=msTo+3600000; t+=86400000) days.push(utcDay(t));
  days.push(utcDay(msTo+3600000));
  const uniqDays=[...new Set(days)].sort();
  const need=cells.filter(c=>uniqDays.some(d=>!WX.days.has(c+"|"+d)));
  if(!need.length) return;
  const start=uniqDays[0], end=uniqDays[uniqDays.length-1];
  const key=need.join(",")+"|"+start+"|"+end;
  if(WX.inflight.has(key)) return WX.inflight.get(key);
  const job=(async()=>{
    const lats=need.map(c=>wxCellCentre(c)[0].toFixed(2)).join(",");
    const lons=need.map(c=>wxCellCentre(c)[1].toFixed(2)).join(",");
    const q="?latitude="+lats+"&longitude="+lons+"&hourly=cloud_cover&timezone=GMT&start_date="+start+"&end_date="+end;
    let got=null, answered=false;
    for(const base of ["https://api.open-meteo.com/v1/forecast","https://archive-api.open-meteo.com/v1/archive"]){
      try{
        const j=await (await fetch(base+q)).json();
        answered=true;                                // the service replied, even if "out of range"
        const arr=Array.isArray(j)?j:[j];
        if(arr.length===need.length && arr.every(x=>x&&x.hourly&&x.hourly.cloud_cover)){ got=arr; break; }
      }catch(_){}
    }
    if(!answered) return;                             // offline: don't record "no data", try again later
    need.forEach((c,i)=>{
      uniqDays.forEach((d,di)=>{
        if(WX.days.has(c+"|"+d)) return;
        // times come back as UTC hours without an offset, 24 per day in order
        const day=got ? got[i].hourly.cloud_cover.slice(di*24,di*24+24) : new Array(24).fill(null);
        WX.days.set(c+"|"+d, day);
      });
    });
  })();
  WX.inflight.set(key,job);
  try{ await job; } finally{ WX.inflight.delete(key); }
}
