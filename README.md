# SolGuard

Warns drivers before a low sun blinds them, and maps where it happens on every California state highway.

**Try it:** https://rfguys-design.github.io/REPO-NAME/

- **Drive:** plan a route and see it coloured by glare at the time you leave. Find a shadier route or a better time to leave, or drive it with live glare warnings.
- **Highway glare:** for Caltrans, counties and cities. Every state highway, scored in both directions, with a year of glare data to download as a CSV.

This repository holds only the published website. The source code, data pipeline and development log are kept separately and are available to judges on request.

Built for the 2026 Congressional App Challenge.

## Data and services

- Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors
- Sun position: [SunCalc](https://github.com/mourner/suncalc)
- Map: [Leaflet](https://leafletjs.com)
- Terrain and building shadows: [ShadeMap](https://shademap.app)
- Routing: [OSRM](https://project-osrm.org)
- Place search: [Photon](https://photon.komoot.io) (komoot), with [Nominatim](https://nominatim.org) as a fallback
- Weather: [Open-Meteo](https://open-meteo.com)
- Elevation: Terrarium tiles (AWS Open Data / Mapzen)
- Traffic counts: Caltrans
- Fatal crashes: NHTSA FARS, 2015–2024
