/* Storm history lookup.
   ---------------------------------------------------------------------------
   One address in, that location's storm history out. Nothing aggregate, no
   other addresses, no scoring — this page is for the homeowner standing in
   the yard, not for us.

   Data is static: data/hail-cells.json and data/storm-reports.geojson are
   generated at build time and committed. No backend, no API in the request
   path except Mapbox for the basemap and for turning the typed address into
   a coordinate.

   Versions targeted, checked against docs.mapbox.com:
     Mapbox GL JS  v3.28.1
     Geocoding     v6  (/search/geocode/v6/forward — note v6 returns the
                        coordinate at properties.coordinates, not v5's
                        center array)
     Basemap       mapbox://styles/mapbox/standard with lightPreset "night".
                   The classic dark style is no longer actively maintained.
*/
(function () {
  "use strict";

  /* Substituted by build.sh from the MAPBOX_TOKEN environment variable, which
     lives in Netlify's site settings. The token reaches the browser either way
     — a public pk. token in a static page is normal — but keeping it out of the
     repository keeps GitHub's push protection happy and means rotating it does
     not need a commit. Restrict it by URL in the Mapbox account. */
  var MAPBOX_TOKEN = "__MAPBOX_TOKEN__";

  /* Unsubstituted placeholder means the build had no token: degrade to the
     "not configured" message rather than firing doomed requests at Mapbox. */
  function hasToken() {
    return MAPBOX_TOKEN && MAPBOX_TOKEN.indexOf("__MAPBOX") !== 0;
  }

  var form = document.getElementById("sh-lookup");
  if (!form) return;

  /* Everything this page needs out of storm-grid.js, checked on load.

     build.sh has now shipped a broken grid module twice: once the file was
     written only into dist/ and 404'd everywhere else, once the global was
     missing four of the seven functions. Both degraded silently — the first
     answered a worse question, the second waited for someone to select a date
     before throwing. A check that runs at load catches the next one without
     depending on anybody reproducing the right sequence. */
  /* Injected by build.sh, which scrapes this file for every StormGrid member
     it actually calls. Hand-maintaining this list drifted three times — twice
     losing an export, once demanding functions the page had stopped using and
     omitting all five it had started using. It is derived now, not written. */
  var GRID_API = "__GRID_API__".split(",").filter(Boolean);

  function checkGridModule() {
    if (!window.StormGrid) return ["storm-grid.js did not load"];
    var missing = [];
    for (var i = 0; i < GRID_API.length; i++) {
      if (typeof window.StormGrid[GRID_API[i]] === "undefined") missing.push(GRID_API[i]);
    }
    return missing;
  }


  var input = document.getElementById("sh-address");
  var errorEl = document.getElementById("sh-error");
  var mapEl = document.getElementById("sh-map");
  var mapNote = document.getElementById("sh-mapnote");
  var styleChip = document.getElementById("sh-basemap");
  var panelAddress = document.getElementById("sh-panel-address");
  var panelSub = document.getElementById("sh-panel-sub");
  var eventsEl = document.getElementById("sh-events");
  var emptyEl = document.getElementById("sh-empty");
  var chips = Array.prototype.slice.call(document.querySelectorAll(".sh-chip"));
  var listEl = document.getElementById("sh-suggest");
  var currencyEl = document.getElementById("sh-currency");
  var collapsedEl = document.getElementById("sh-collapsed");
  var collapsedAddrEl = document.getElementById("sh-collapsed-address");
  var collapsedChangeEl = document.getElementById("sh-collapsed-change");
  var freshEl = document.getElementById("sh-freshness");
  var freshLeadEl = document.getElementById("sh-freshness-lead");
  var freshDetailEl = document.getElementById("sh-freshness-detail");

  /* The service area, and the box the generator pulled data for. Searches
     outside it get told so rather than returning a confident "nothing found"
     for somewhere we have no data. */
  var AREA = { minLon: -91.0, minLat: 33.9, maxLon: -88.4, maxLat: 35.05 };
  var CENTER = [-89.7, 34.45];
  /* Proximity bias for address search. CENTER is the centroid of the whole
     bbox, which sits in open country between towns; biasing to it ranked rural
     road names above the streets people actually type. Tupelo is the largest
     population centre in the area and where most searches come from. */
  var TUPELO = [-88.7034, 34.2576];

  /* A radar hail cell is a storm-scale detection, not a damage footprint.
     1.5km is the radius the generator buffered to; the hit test is the same
     circle, done as a distance rather than a polygon so the page does not
     have to ship a geometry library to compute what one subtraction gives. */
  var HAIL_RADIUS_KM = 1.5;
  var REPORT_RADIUS_KM = 5;


  var EMPTY = { type: "FeatureCollection", features: [] };

  /* The reference map reads clearly because it shows one storm on one day.
     Ten years at once cannot look like that, so a date in the results acts as
     a filter: pick one and the map shows that day alone, over a wide enough
     radius to see the storm pass the house rather than just the dots on it. */
  var STORM_KM = 25;
  var current = null;   // { lon, lat, date }

  var hail = null;
  var reports = null;
  var index = null;
  /* The address's own bucket, from the shared grid module. Set on every
     lookup and used for containment. */
  var addrBucket = null;
  var map = null;
  var marker = null;
  var submitted = {};

  /* ---- helpers ---------------------------------------------------------- */

  function say(msg) {
    if (!errorEl) return;
    errorEl.textContent = msg || "";
    errorEl.hidden = !msg;
  }

  function distanceKm(aLon, aLat, bLon, bLat) {
    var R = 6371;
    var dLat = ((bLat - aLat) * Math.PI) / 180;
    var dLon = ((bLon - aLon) * Math.PI) / 180;
    var la1 = (aLat * Math.PI) / 180;
    var la2 = (bLat * Math.PI) / 180;
    var h =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.sin(dLon / 2) * Math.sin(dLon / 2) * Math.cos(la1) * Math.cos(la2);
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  /* "2.3 mi NE" beats "nearby": it tells a homeowner whether to walk outside
     and look, or to stop reading. */
  function bearingFrom(lon, lat, toLon, toLat) {
    var dLon = ((toLon - lon) * Math.PI) / 180;
    var la1 = (lat * Math.PI) / 180;
    var la2 = (toLat * Math.PI) / 180;
    var y = Math.sin(dLon) * Math.cos(la2);
    var x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLon);
    var deg = (Math.atan2(y, x) * 180) / Math.PI;
    var names = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
    return names[Math.round(((deg + 360) % 360) / 45) % 8];
  }

  function awayFrom(lon, lat, toLon, toLat) {
    var miles = distanceKm(lon, lat, toLon, toLat) * 0.621371;
    return miles.toFixed(1) + " mi " + bearingFrom(lon, lat, toLon, toLat);
  }

  function prettyDate(iso) {
    var d = new Date(iso.length > 10 ? iso : iso + "T12:00:00Z");
    if (isNaN(d)) return iso;
    return d.toLocaleDateString("en-US", {
      year: "numeric", month: "long", day: "numeric", timeZone: "UTC",
    });
  }

  function loadData() {
    if (hail && reports) return Promise.resolve();
    return fetch("data/storm-index.json")
      .then(function (r) { return r.json(); })
      .then(function (idx) {
        index = idx;
        /* Split by year so the weekly refresh only rewrites the current
           year's file instead of a 500KB blob every run. The lookup needs
           every year, so they are fetched together and flattened here. */
        var jobs = [];
        idx.years.forEach(function (y) {
          jobs.push(fetch("data/hail-" + y + ".json").then(function (r) { return r.json(); }));
          jobs.push(fetch("data/reports-" + y + ".json").then(function (r) { return r.json(); }));
        });
        return Promise.all(jobs);
      })
      .then(function (parts) {
        var cells = [];
        var reps = [];
        parts.forEach(function (p) {
          if (p.cells) cells = cells.concat(p.cells);
          if (p.reports) reps = reps.concat(p.reports);
        });
        cells.sort(function (a, b) { return a[0] < b[0] ? 1 : -1; });
        hail = { cells: cells };
        /* [date, kind, val, lon, lat, src] */
        reports = {
          features: reps
            .sort(function (a, b) { return a[0] < b[0] ? 1 : -1; })
            .map(function (r) {
              return {
                type: "Feature",
                geometry: { type: "Point", coordinates: [r[3], r[4]] },
                properties: { date: r[0], kind: r[1], val: r[2], src: r[5] },
              };
            }),
        };
        showCurrency();
      });
  }

  /* Per layer, from the data itself. The two are months apart when Storm
     Events is the only wind source, and a homeowner must never read "no wind"
     when the truth is "no wind data that recent". */
  function showCurrency() {
    if (!index || !currencyEl) return;
    var bits = [];
    if (index.hail && index.hail.through) bits.push("Hail data current through " + prettyDate(index.hail.through));
    if (index.wind && index.wind.through) bits.push("wind through " + prettyDate(index.wind.through));
    currencyEl.textContent = bits.join(" \u00b7 ") + ".";
    currencyEl.hidden = false;
  }

  /* ---- map -------------------------------------------------------------- */

  /* The address's cell at its actual 0.05 degree bounds, derived from the
     bucket indices rather than drawn around the detection's coordinate — the
     detection can sit anywhere inside the cell. */
  var HAIL_BANDS = [1.0, 1.5, 1.75, 2.0, 2.5];
  var HAIL_COLORS = ["#cdb6ee", "#b189e6", "#9a63dd", "#8340d2", "#6b21c0"];

  /* Fade timings. The bands finish at 4 * 60 + 360 = 600ms — the shape builds
     inward from the widest to the core, which is the order the data actually
     nests. The glow follows once they have settled. Fading out on a date
     switch is deliberately much shorter than fading in: it is not information,
     it is just getting the old shape off the screen before the new one lands.
     Two swaths cross-fading would read as one shape that is wrong. */
  var FADE_MS = 360;
  var STAGGER_MS = 60;
  var FADE_OUT_MS = 180;
  var GLOW_MS = 180;
  var GLOW_DELAY = FADE_MS + (HAIL_BANDS.length - 1) * STAGGER_MS;

  var reducedMotion =
    window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* The band layers are per-band now, so the ramps that were data-driven
     expressions have to be resolved to a value per band instead. Same numbers,
     read at the same stops. */
  function interpAt(x, pairs) {
    if (x <= pairs[0][0]) return pairs[0][1];
    for (var i = 0; i < pairs.length - 1; i++) {
      var a = pairs[i], c = pairs[i + 1];
      if (x >= a[0] && x <= c[0]) {
        var t = c[0] === a[0] ? 0 : (x - a[0]) / (c[0] - a[0]);
        return a[1] + (c[1] - a[1]) * t;
      }
    }
    return pairs[pairs.length - 1][1];
  }

  function bandOpacity(i, b) {
    return interpAt(HAIL_BANDS[i], [
      [b.hailFill[0], b.hailFill[1]],
      [b.hailFill[2], b.hailFill[3]],
      [b.hailFill[4], b.hailFill[5]],
    ]);
  }

  function lineColorFor(i, b) {
    var lo = b.hailLine.lo, hi = b.hailLine.hi;
    var t = (HAIL_BANDS[i] - HAIL_BANDS[0]) /
      (HAIL_BANDS[HAIL_BANDS.length - 1] - HAIL_BANDS[0]);
    var mix = function (c1, c2) {
      var p = function (h) { return [1, 3, 5].map(function (k) { return parseInt(h.substr(k, 2), 16); }); };
      var a = p(c1), c = p(c2);
      return "#" + a.map(function (v, k) {
        return Math.round(v + (c[k] - v) * t).toString(16).padStart(2, "0");
      }).join("");
    };
    return mix(lo, hi);
  }

  /* Envelope geometry, in kilometres.

     A 0.05-degree cell measures 5.57km N-S by 4.56km E-W, so its centroid sits
     3.60km from its farthest corner. The perpendicular half-reach is set above
     that, which is what makes the hard constraint structural rather than
     hopeful: every cell whose centroid feeds a band lies wholly inside that
     band's envelope, so the map can never contradict the panel's "in your
     area". Verified over the whole archive — see tools/verify-envelopes.mjs. */
  var CELL_HALF_DIAG_KM = 3.6;
  /* W must clear the half-diagonal, or a cell can poke out of the band drawn
     for its own size and the map contradicts the panel. L is set well above W
     on purpose: at L=7.5 a lone detection fitted to an aspect of 1.35, which
     reads as a circle. Storms are not circular, and a shape that says
     "somewhere around here, equally, in all directions" is a worse
     description of a hail swath than an elongated one. */
  var HAIL_W = 4.2;    // perpendicular half-reach per cell
  var HAIL_L = 11;     // along-axis reach: sets taper length and elongation
  /* Cells whose centres are within 8km touch orthogonally (4.56/5.57km) or
     diagonally (7.20km); anything further apart is a separate storm and gets
     its own lozenge. At 12km the day's cells merged into one 60x47km blob
     with an aspect of 1.3 — a shape that says "everywhere" and taught the
     reader nothing. */
  var HAIL_LINK_KM = 8;
  /* Wind reads wider and lighter, sitting behind the hail: a gust report is one
     observation at one point, not a measured footprint. */
  var WIND_W = 8;
  var WIND_L = 18;
  var WIND_LINK_KM = 25;

  /* The address is a point, not a parcel. A drawn rectangle invited the
     reading that the box is "your property" and that its edges mean
     something; they are grid bounds, an artefact of how the radar data is
     binned. A soft glow says "here" without claiming an extent. */
  function addressGlow() {
    if (!current) return EMPTY;
    return {
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        properties: {},
        geometry: { type: "Point", coordinates: [current.lon, current.lat] },
      }],
    };
  }

  function hailBands(dayCells) {
    var g = window.StormGrid.GRID_DEG;
    /* Cell centres, not the reported radar centroids. A detection's centroid
       can sit anywhere inside its cell — one in the archive lies 2.67km from
       its cell's centre, which puts the cell's far corner 5.89km away, outside
       any envelope fitted to the centroid. Fitting to centres makes every
       point's worst case the same 3.60km half-diagonal, which the 4.4km
       half-reach covers. That is what turns the panel/map agreement from a
       tuning accident into a property of the geometry. */
    return window.StormGrid.fitEnvelopes(
      dayCells.map(function (c) { return [c[6] * g, c[5] * g]; }),
      dayCells.map(function (c) { return c[1]; }),
      HAIL_BANDS, HAIL_L, HAIL_W, HAIL_LINK_KM
    );
  }

  function windEnvelope(points) {
    return window.StormGrid.fitEnvelopes(
      points,
      points.map(function () { return 1; }),
      [1], WIND_L, WIND_W, WIND_LINK_KM
    );
  }

  /* Two basemaps, one set of storm layers.

     A homeowner reading a dark vector map is reading an abstraction; on
     imagery they can find their own roof under the swath, which is the point
     of the page. Satellite is the default for that reason, with the vector
     view kept for orientation when the imagery is too busy.

     Standard Satellite rather than the classic satellite-streets style: it is
     Mapbox Standard with an imagery base, so it keeps roads and place labels
     AND keeps the bottom/middle/top slots. The classic style has no slots, and
     every layer here is placed with slot: "top".

     The colour ramps were tuned against a flat dark ground. Over imagery the
     same alphas turn to haze on grass and vanish over parking lots, so each
     basemap carries its own paint and neither is fixed by breaking the other. */
  var BASEMAPS = {
    satellite: {
      label: "Satellite",
      style: "mapbox://styles/mapbox/standard-satellite",
      light: "day",
      /* Lower than the dark view, not higher. The first cut raised these to
         0.55-0.88 on the theory that imagery would wash the bands out; it
         does the opposite — a 0.88 fill hides the roof the reader came to
         look at, which is the whole reason for showing imagery. Separation
         comes from the strokes instead, so the bands stay legible and the
         ground stays visible through them. */
      hailFill: [1.0, 0.2, 1.75, 0.3, 2.5, 0.44],
      hailLine: { width: 2, opacity: 1, lo: "#ffffff", hi: "#d19bff" },
      windFill: 0.13,
      windLine: { width: 1.8, opacity: 0.9 },
      /* White on white: over a bright roof or a parking lot the pale glow
         disappeared entirely. Navy reads as a shadow against every surface in
         the imagery, and the core keeps a ring so it never sits on its own
         value. */
      glow: "#071d37",
      glowOpacity: 0.55,
      coreStroke: "#071d37",
    },
    dark: {
      label: "Map",
      style: "mapbox://styles/mapbox/standard",
      light: "night",
      hailFill: [1.0, 0.42, 1.75, 0.6, 2.5, 0.78],
      hailLine: { width: 1, opacity: 0.7, lo: "#d4cbe2", hi: "#a53dff" },
      windFill: 0.18,
      windLine: { width: 1, opacity: 0.45 },
      glow: "#dbeaff",
      glowOpacity: 0.5,
      coreStroke: "#0a1420",
    },
  };
  var basemap = "satellite";

  function initMap() {
    if (map || !mapEl) return;
    if (!hasToken()) {
      if (mapNote) {
        mapNote.textContent =
          "Map unavailable — no Mapbox token configured. The lookup below still works.";
      }
      return;
    }
    if (typeof mapboxgl === "undefined") return;

    mapboxgl.accessToken = MAPBOX_TOKEN;
    map = new mapboxgl.Map({
      container: "sh-map",
      style: BASEMAPS[basemap].style,
      config: { basemap: { lightPreset: BASEMAPS[basemap].light } },
      center: CENTER,
      zoom: 7.2,
      attributionControl: false,
    });
    map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), "top-right");

    /* style.load, not load: it fires on the first style AND on every switch,
       and setStyle discards every source and layer added after the initial
       load. One handler rebuilds them either way, so the two paths cannot
       drift apart. */
    map.on("style.load", function () {
      /* setConfigProperty, not a config option on setStyle: setStyle's options
         are diff/localIdeographFontFamily and it ignores anything else, so the
         light preset silently failed to apply on every switch after the first.
         Applied here it runs on the initial load and on each switch alike. */
      try { map.setConfigProperty("basemap", "lightPreset", BASEMAPS[basemap].light); }
      catch (e) { console.warn("storm-history: lightPreset not applied", e); }
      addStormLayers();
      applyChips();
      /* Repaint the selected date without re-framing. Calling selectDate here
         would call fitToStorm and throw away wherever the reader had panned
         to, which is exactly what a basemap toggle must not do. */
      /* The rebuilt style has every layer back at opacity 0, so this is a
         first draw again as far as the fade is concerned. */
      drawnDate = null;
      if (current && current.date) paintDate(current.date);
    });
  }

  function addStormLayers() {
    var b = BASEMAPS[basemap];

    /* Both sources start empty. The whole ten-year field on load is a wash of
       colour that answers no question — the map only has something to say once
       there is an address to say it about. */
    map.addSource("hail-bands", { type: "geojson", data: EMPTY });
    map.addSource("wind-env", { type: "geojson", data: EMPTY });
    map.addSource("reports", { type: "geojson", data: EMPTY });
    map.addSource("addr-glow", { type: "geojson", data: EMPTY });

    /* Wind first, so it is the backdrop the hail sits on. Amber over purple
       composited to a pink belonging to neither ramp. */
    map.addLayer({
      id: "wind-env",
      type: "fill",
      source: "wind-env",
      slot: "top",
      paint: {
        "fill-color": "#f5a63c",
        /* Fades with the FIRST hail band, not on its own schedule: it is the
           ground the swath sits on, so it has to be there as the swath arrives
           rather than turning up under it. */
        "fill-opacity": 0,
        "fill-opacity-transition": { duration: FADE_MS, delay: 0 },
        "fill-emissive-strength": 1,
      },
    });
    map.addLayer({
      id: "wind-env-line",
      type: "line",
      source: "wind-env",
      slot: "top",
      paint: {
        "line-color": "#f5a63c",
        "line-width": b.windLine.width,
        "line-opacity": 0,
        "line-opacity-transition": { duration: FADE_MS, delay: 0 },
        "line-emissive-strength": 1,
      },
    });

    /* One layer per band, not one layer for all five.

       The stagger needs a different delay per band, and a paint transition
       applies to a whole layer — a data-driven fill-opacity expression would
       move every band at once however it is written. Five fills and five
       lines is the cost of the effect; the filter on each keeps them fed from
       the single source. */
    HAIL_BANDS.forEach(function (min, i) {
      /* Nested by construction: each band contains every band above it, so
         bigger hail always sits inside smaller. Larger sizes read deeper, on
         the same ramp as the legend. Lowest threshold added first so the
         cores paint over their surrounds. */
      map.addLayer({
        id: "hail-band-" + i,
        type: "fill",
        source: "hail-bands",
        slot: "top",
        filter: ["==", ["get", "min"], min],
        paint: {
          "fill-color": HAIL_COLORS[i],
          /* Starts hidden. paintDate raises it to bandOpacity(i) once the
             geometry for the day is in. */
          "fill-opacity": 0,
          "fill-opacity-transition": { duration: FADE_MS, delay: i * STAGGER_MS },
          "fill-emissive-strength": 1,
        },
      });
      /* The stroke is what keeps one band readable against the next over
         imagery, where the fills alone stop separating. It rides the same
         delay as its own fill so an outline never arrives ahead of it. */
      map.addLayer({
        id: "hail-band-line-" + i,
        type: "line",
        source: "hail-bands",
        slot: "top",
        filter: ["==", ["get", "min"], min],
        paint: {
          "line-color": lineColorFor(i, b),
          "line-width": b.hailLine.width,
          "line-opacity": 0,
          "line-opacity-transition": { duration: FADE_MS, delay: i * STAGGER_MS },
          "line-emissive-strength": 1,
        },
      });
    });

    map.addLayer({
      id: "reports",
      type: "circle",
      source: "reports",
      slot: "top",
      filter: ["==", ["get", "kind"], "wind"],
      paint: {
        "circle-emissive-strength": 1,
        "circle-opacity": 0,
        "circle-opacity-transition": { duration: FADE_MS, delay: 0 },
        "circle-stroke-opacity": 0,
        "circle-stroke-opacity-transition": { duration: FADE_MS, delay: 0 },
        "circle-radius": [
          "interpolate", ["linear"], ["coalesce", ["get", "val"], 45],
          45, 4,
          95, 9,
        ],
        "circle-color": [
          "interpolate", ["linear"], ["coalesce", ["get", "val"], 45],
          45, "#e3dcc9",
          58, "#ebc984",
          70, "#faaa42",
          85, "#ff801f",
        ],
        "circle-stroke-width": 1.5,
        "circle-stroke-color": "#ffffff",
      },
    });

    /* On top of everything: a glow locating the address. The radius is
       interpolated exponentially on base 2, which is exactly how web mercator
       scales, so it holds a constant ~5km on the ground at every zoom instead
       of swelling as you zoom in. */
    map.addLayer({
      id: "addr-glow",
      type: "circle",
      source: "addr-glow",
      slot: "top",
      paint: {
        "circle-color": b.glow,
        "circle-blur": 1,
        /* Last in, once the bands have settled — it answers "and here is you",
           which only means something after the shape exists. */
        "circle-opacity": 0,
        "circle-opacity-transition": { duration: GLOW_MS, delay: GLOW_DELAY },
        "circle-emissive-strength": 1,
        "circle-radius": [
          "interpolate", ["exponential", 2], ["zoom"],
          7, 4.9,
          12, 157.8,
        ],
      },
    });
    map.addLayer({
      id: "addr-core",
      type: "circle",
      source: "addr-glow",
      slot: "top",
      paint: {
        "circle-color": "#ffffff",
        "circle-radius": 3.5,
        "circle-opacity": 0,
        "circle-opacity-transition": { duration: GLOW_MS, delay: GLOW_DELAY },
        "circle-stroke-opacity": 0,
        "circle-stroke-opacity-transition": { duration: GLOW_MS, delay: GLOW_DELAY },
        "circle-stroke-width": 1.5,
        "circle-stroke-color": b.coreStroke,
        "circle-emissive-strength": 1,
      },
    });
  }

  /* One chip, several layers: a hazard is a band plus its outline, or an
     envelope plus the points inside it. */
  var CHIP_LAYERS = {
    hail: HAIL_BANDS.map(function (_, i) { return "hail-band-" + i; })
      .concat(HAIL_BANDS.map(function (_, i) { return "hail-band-line-" + i; })),
    reports: ["wind-env", "wind-env-line", "reports"],
  };

  function applyChips() {
    chips.forEach(function (chip) {
      if (!chip.dataset.layer) return;
      var on = chip.classList.contains("is-on");
      (CHIP_LAYERS[chip.dataset.layer] || []).forEach(function (id) {
        if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
      });
    });
  }

  function setBasemap(next) {
    if (!map || next === basemap || !BASEMAPS[next]) return;
    basemap = next;
    /* setStyle keeps the camera. Sources, layers and the marker's DOM element
       are handled by the style.load rebuild above. */
    map.setStyle(BASEMAPS[next].style);
    if (styleChip) {
      styleChip.textContent = BASEMAPS[next === "satellite" ? "dark" : "satellite"].label;
      styleChip.setAttribute("aria-pressed", String(next === "satellite"));
      styleChip.setAttribute(
        "aria-label",
        "Switch to " + BASEMAPS[next === "satellite" ? "dark" : "satellite"].label.toLowerCase() + " view"
      );
    }
  }

  chips.forEach(function (chip) {
    chip.addEventListener("click", function () {
      /* The basemap chip is a mode switch, not a layer toggle: it carries no
         .is-on state of its own and must not fall through to the layer code. */
      if (chip === styleChip) {
        setBasemap(basemap === "satellite" ? "dark" : "satellite");
        return;
      }
      var on = chip.classList.toggle("is-on");
      chip.setAttribute("aria-pressed", String(on));
      if (!map) return;
      (CHIP_LAYERS[chip.dataset.layer] || []).forEach(function (id) {
        if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
      });
      /* Hail and wind cover different ground on the same day, so the frame
         follows whichever hazards are showing. */
      if (current && current.date) fitToStorm();
    });
  });

  /* ---- lookup ----------------------------------------------------------- */

  function eventsAt(lon, lat) {
    var out = [];

    hail.cells.forEach(function (c) {
      /* Containment, not proximity. A cell is ~5.6 x 4.6km, so its centroid
         can sit 3.6km from an address the cell still covers — the old 1.5km
         radius threw away roughly three quarters of genuine in-cell hits.
         Indices come from the file; nothing is recomputed here. */
      var here = addrBucket && c[5] === addrBucket[0] && c[6] === addrBucket[1];
      var near = !here && distanceKm(lon, lat, c[2], c[3]) <= REPORT_RADIUS_KM;
      if (!here && !near) return;
      var size = c[1].toFixed(2).replace(/0$/, "");
      out.push({
        date: c[0],
        /* "in your area" is what the data supports: radar estimated hail
           somewhere in the cell containing this address. Not "on your roof". */
        label: here
          ? size + '" hail estimated in your area'
          : size + '" hail estimated ' + awayFrom(lon, lat, c[2], c[3]),
        source: "NEXRAD radar" + (c[4] ? " (" + c[4] + ")" : ""),
        here: !!here,
        size: c[1],
      });
    });

    reports.features.forEach(function (f) {
      var g = f.geometry.coordinates;
      if (distanceKm(lon, lat, g[0], g[1]) > REPORT_RADIUS_KM) return;
      var p = f.properties;
      var label;
      var where = awayFrom(lon, lat, g[0], g[1]);
      if (p.kind === "hail") {
        label = (p.val ? p.val + '" ' : "") + "hail reported " + where;
      } else if (p.val) {
        /* Already mph — the generator normalises Storm Events' knots, so
           converting here would turn a 66 mph gust into 76. */
        label = p.val + " mph wind reported " + where;
      } else {
        /* A real report with no measured gust. Saying nothing hides a storm;
           saying 0 mph invents a reading. */
        label = "wind damage reported " + where;
      }
      out.push({ date: (p.date || "").slice(0, 10), label: label, source: p.src });
    });

    out.sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : 0; });
    return out;
  }

  /* Back to the state before any address was checked. Leaving the previous
     address's events on screen under a new address's error message would
     attribute one home's storm history to another. */
  function resetPanel() {
    current = null;
    addrBucket = null;
    panelAddress.textContent = "No address checked yet";
    panelSub.textContent = "Results will appear here.";
    eventsEl.innerHTML = "";
    emptyEl.hidden = true;
    if (freshEl) freshEl.hidden = true;
    setCollapsed(false);
    if (map) {
      /* Nothing is drawn any more, so the next selection is a first draw and
         should fade straight in rather than fading out an empty map first. */
      cancelFade();
      drawnDate = null;
      ["hail-bands", "wind-env", "reports", "addr-glow"].forEach(function (id) {
        var src = map.getSource(id);
        if (src) src.setData(EMPTY);
      });
    }
    if (marker) { marker.remove(); marker = null; }
    if (mapNote) { mapNote.textContent = "Select a date to see that storm."; mapNote.hidden = false; }
  }

  /* How far the archive reaches, said in the panel where the answer is.

     The wording is measured against the data, not assumed. Both feeds are
     current to within a few days — wind is NOT months behind, because the
     NWS Local Storm Report feed fills the gap ahead of the verified Storm
     Events release. What actually keeps a storm from last night off this map
     is the radar feed's own ~1 day lag — SWDI publishes in daily batches — now
     that the archive refreshes every six hours rather than weekly. */
  function showFreshness(events) {
    if (!freshEl || !index) return;
    var hail = index.hail && index.hail.through;
    var wind = index.wind && index.wind.through;
    if (!hail && !wind) { freshEl.hidden = true; return; }

    freshLeadEl.textContent = events.length
      ? "A storm in the last few days may not be here yet."
      : "An empty map is not the same as nothing happened.";

    var through = hail && wind && hail !== wind
      ? "Hail data reaches " + prettyDate(hail) + " and wind reports " + prettyDate(wind) + "."
      : "Hail and wind data both reach " + prettyDate(hail || wind) + ".";

    freshDetailEl.textContent = through +
      " We refresh several times a day, and the radar feed itself runs about a day" +
      " behind, so a storm from the last day or two may not be here yet." +
      " If you saw a storm come over your house, that is a reason to have someone look at the" +
      " roof \u2014 not a reason to wait for it to show up here.";
    freshEl.hidden = false;
  }

  /* Once a lookup has succeeded, the heading, the lead and the search box are
     instructions the reader has already followed — and on a phone they are most
     of a screen standing between them and the answer. The class goes on the
     root element; the mobile breakpoint is what acts on it, so desktop keeps
     the full intro whatever this is set to.

     Reversible on purpose: "change" puts the input back, prefilled, rather
     than making the reader reload to search again. */
  function setCollapsed(on, address) {
    document.documentElement.classList.toggle("sh-has-results", !!on);
    if (on && collapsedAddrEl) collapsedAddrEl.textContent = address || "";
  }

  if (collapsedChangeEl) {
    collapsedChangeEl.addEventListener("click", function () {
      setCollapsed(false);
      if (input) {
        /* Prefilled with what is being shown, so "change" means edit rather
           than start over. */
        if (current && current.address) input.value = current.address;
        input.focus();
        input.select();
      }
    });
  }

  function render(address, events) {
    panelAddress.textContent = address;
    setCollapsed(true, address);
    eventsEl.innerHTML = "";
    showFreshness(events);

    if (!events.length) {
      panelSub.textContent = "No recorded events in the last ten years.";
      emptyEl.hidden = false;
      return;
    }
    emptyEl.hidden = true;

    /* One list, strictly newest first, in-cell and nearby together.

       The split used to be two headed sections. The distinction still matters,
       but it already lives on the row — "in your area" versus "2.6 mi SE" —
       and saying it twice cost the thing a storm list is actually for, which
       is reading down it in time order. The count line above keeps the split
       visible as a summary.

       Sorted on a parsed timestamp rather than on the string. These dates are
       ISO, so lexical order happens to agree, but that is a property of the
       format and not of the data — the moment anything upstream hands over a
       formatted date, a string sort silently produces "April, August,
       December". This is the third time the order has had to be fixed; sorting
       the actual value is what stops it being fixed a fourth. */
    var ts = function (e) { return Date.parse(e.date + "T00:00:00Z"); };
    var rows = events.slice().sort(function (a, b) { return ts(b) - ts(a); });

    var here = events.filter(function (e) { return e.here; }).length;
    var near = events.length - here;

    panelSub.textContent =
      here
        ? here + (here === 1 ? " event at this address" : " events at this address")
          + ", " + near + " nearby — select one to see that day"
        : "No detections in the cell containing this address; "
          + near + " nearby — select one to see that day";

    rows.forEach(addEventRow);
  }

  function addEventRow(e) {
    var li = document.createElement("li");
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "sh-event";
    btn.dataset.date = e.date;
    btn.setAttribute("aria-pressed", "false");

    var d = document.createElement("span");
    d.className = "sh-event-date";
    d.textContent = prettyDate(e.date);
    var v = document.createElement("span");
    v.className = "sh-event-value";
    v.textContent = e.label;
    var src = document.createElement("span");
    src.className = "sh-event-source";
    src.textContent = e.source;
    btn.appendChild(d);
    btn.appendChild(v);
    btn.appendChild(src);
    btn.addEventListener("click", function () { selectDate(btn.dataset.date); });

    li.appendChild(btn);
    eventsEl.appendChild(li);
  }

  /* Contours only ever represent one storm day, so a date is always selected
     once there are results — there is no "everything at once" state to return
     to. Interpolating across separate storms would invent a shape no storm
     had. */
  function biggestDate(events, lon, lat) {
    var best = null;
    var bestCount = -1;
    var seen = {};
    events.forEach(function (e) {
      if (seen[e.date]) return;
      seen[e.date] = true;
      var n = hail.cells.filter(function (c) {
        return c[0] === e.date && distanceKm(lon, lat, c[2], c[3]) <= STORM_KM;
      }).length;
      /* events arrive newest first, so a strict > keeps the more recent day
         when two are the same size. */
      if (n > bestCount) {
        bestCount = n;
        best = e.date;
      }
    });
    return best;
  }

  /* Frame the storm, not the house.

     Sitting at address zoom showed a handful of cells with no visible relation
     to the pin — a fragment of a storm rather than a storm. Fitting to the
     day's own footprint lets a track read as a track. The pin is always in the
     bounds, so a house well outside the storm still shows its distance from
     it rather than dropping off screen.

     Which hazards count is whatever the chips have switched on: hail and wind
     footprints for the same day are different shapes, so the frame follows
     the toggle. */
  function stormBounds() {
    if (!current || !current.date) return null;
    var date = current.date;
    var lon = current.lon;
    var lat = current.lat;
    var b = new mapboxgl.LngLatBounds([lon, lat], [lon, lat]);

    if (hazardOn("hail")) {
      hail.cells.forEach(function (c) {
        if (c[0] === date && distanceKm(lon, lat, c[2], c[3]) <= STORM_KM) b.extend([c[2], c[3]]);
      });
    }
    if (hazardOn("reports")) {
      reports.features.forEach(function (f) {
        var p = f.properties;
        if (p.date !== date || p.kind !== "wind") return;
        var g = f.geometry.coordinates;
        if (distanceKm(lon, lat, g[0], g[1]) <= STORM_KM) b.extend(g);
      });
    }
    return b;
  }

  function hazardOn(layerId) {
    var chip = chips.filter(function (c) { return c.dataset.layer === layerId; })[0];
    return !chip || chip.classList.contains("is-on");
  }

  function fitToStorm() {
    if (!map) return;
    var b = stormBounds();
    if (!b) return;

    /* Padding has to clear the furniture sitting on top of the map — chips at
       the top left, legend and attribution at the bottom left — or the fitted
       content hides underneath them. The detail panel sits beside the map
       rather than over it at every breakpoint, so it needs no allowance.

       Capped against the container: Mapbox throws if padding exceeds the
       canvas, which a 360px-tall phone map would hit with desktop numbers. */
    var box = map.getContainer().getBoundingClientRect();
    var cap = function (want, extent) { return Math.max(12, Math.min(want, Math.round(extent * 0.18))); };
    var padding = {
      top: cap(70, box.height),
      bottom: cap(100, box.height),
      left: cap(90, box.width),
      right: cap(60, box.width),
    };

    map.fitBounds(b, {
      padding: padding,
      /* A single-cell day would otherwise slam to street level over one blob;
         a day spanning the state would pull back until everything is a speck. */
      maxZoom: 11,
      minZoom: 7,
      /* Animated, so the move reads as pulling back to show the whole storm
         rather than teleporting somewhere else. */
      duration: 900,
      essential: true,
    });
  }

  function selectDate(date) {
    if (!current) return;

    /* No date means nothing to draw. The map used to keep whatever was last
       loaded, so it showed dots belonging to no selected day — a state the
       page never explained. */
    if (!date) {
      current.date = null;
      Array.prototype.forEach.call(eventsEl.querySelectorAll(".sh-event"), function (b) {
        b.classList.remove("is-selected");
        b.setAttribute("aria-pressed", "false");
      });
      if (map) {
        cancelFade();
        drawnDate = null;
        ["hail-bands", "wind-env", "reports", "addr-glow"].forEach(function (id) {
          var src = map.getSource(id);
          if (src) src.setData(EMPTY);
        });
      }
      if (mapNote) {
        mapNote.textContent = "Select a date to see that storm.";
        mapNote.hidden = false;
      }
      return;
    }

    current.date = date;
    if (mapNote) mapNote.hidden = true;

    Array.prototype.forEach.call(eventsEl.querySelectorAll(".sh-event"), function (b) {
      var on = !!date && b.dataset.date === date;
      b.classList.toggle("is-selected", on);
      b.setAttribute("aria-pressed", String(on));
    });

    if (!map) return;
    paintDate(date);
    fitToStorm();
  }

  /* Geometry currently on the map, or null. Not the same as current.date: it
     is what has actually been drawn, which is what decides whether a switch
     needs to fade the old shape out first. */
  var drawnDate = null;
  var fadeTimer = null;

  function cancelFade() {
    if (fadeTimer) { clearTimeout(fadeTimer); fadeTimer = null; }
  }

  /* Raise or drop every geometry layer. `stagger` is false for the way out and
     for reduced motion, so the shape leaves as one piece. */
  function setGeomOpacity(on, dur, stagger) {
    var b = BASEMAPS[basemap];
    var t = function (delay) { return { duration: dur, delay: stagger ? delay : 0 }; };
    var set = function (id, prop, value, delay) {
      if (!map.getLayer(id)) return;
      map.setPaintProperty(id, prop + "-transition", t(delay));
      map.setPaintProperty(id, prop, value);
    };

    HAIL_BANDS.forEach(function (_, i) {
      set("hail-band-" + i, "fill-opacity", on ? bandOpacity(i, b) : 0, i * STAGGER_MS);
      set("hail-band-line-" + i, "line-opacity", on ? b.hailLine.opacity : 0, i * STAGGER_MS);
    });
    set("wind-env", "fill-opacity", on ? b.windFill : 0, 0);
    set("wind-env-line", "line-opacity", on ? b.windLine.opacity : 0, 0);
    set("reports", "circle-opacity", on ? 1 : 0, 0);
    set("reports", "circle-stroke-opacity", on ? 1 : 0, 0);

    var glowDur = stagger ? GLOW_MS : dur;
    var glowT = { duration: glowDur, delay: stagger ? GLOW_DELAY : 0 };
    ["addr-glow", "addr-core"].forEach(function (id) {
      if (!map.getLayer(id)) return;
      map.setPaintProperty(id, "circle-opacity-transition", glowT);
      map.setPaintProperty(id, "circle-opacity",
        on ? (id === "addr-glow" ? b.glowOpacity : 0.95) : 0);
      if (id === "addr-core") {
        map.setPaintProperty(id, "circle-stroke-opacity-transition", glowT);
        map.setPaintProperty(id, "circle-stroke-opacity", on ? 1 : 0);
      }
    });
  }

  /* Drawing only — no camera. Called by selectDate, and again after a basemap
     switch to restore the geometry onto the rebuilt style. */
  function paintDate(date) {
    if (!map || !current) return;
    /* A selection mid-fade replaces it outright rather than queueing behind
       it — the pending timer is the only thing that could stack. */
    cancelFade();

    if (reducedMotion || drawnDate === null) {
      drawGeometry(date);
      setGeomOpacity(true, reducedMotion ? 0 : FADE_MS, !reducedMotion);
      drawnDate = date;
      return;
    }

    /* Out, then in. Cross-fading two swaths would put a shape on screen that
       belongs to neither day. */
    setGeomOpacity(false, FADE_OUT_MS, false);
    fadeTimer = setTimeout(function () {
      fadeTimer = null;
      drawGeometry(date);
      setGeomOpacity(true, FADE_MS, true);
      drawnDate = date;
    }, FADE_OUT_MS);
  }

  function drawGeometry(date) {
    if (!map || !current) return;
    var lon = current.lon;
    var lat = current.lat;
    var radius = STORM_KM;

    /* Clear first, then draw. Every layer is emptied before anything is
       computed, so a throw halfway through leaves a blank map and a visible
       message rather than the previous date's geometry sitting under the new
       date's panel. That exact failure shipped a map showing 2.0" cores on a
       day whose largest stone was 1.5" — the panel had updated and the
       drawing had not, and nothing on screen said so. */
    ["hail-bands", "wind-env", "reports", "addr-glow"].forEach(function (id) {
      var src = map.getSource(id);
      if (src) src.setData(EMPTY);
    });

    try {
      var cells = hail.cells.filter(function (c) {
        return c[0] === date && distanceKm(lon, lat, c[2], c[3]) <= radius;
      });
      var bandSrc = map.getSource("hail-bands");
      if (bandSrc) bandSrc.setData(hailBands(cells));

      var glowSrc = map.getSource("addr-glow");
      if (glowSrc) glowSrc.setData(addressGlow());

      var dayReports = reports.features.filter(function (f) {
        if (f.properties.date !== date) return false;
        var g = f.geometry.coordinates;
        return distanceKm(lon, lat, g[0], g[1]) <= radius;
      });
      var repSrc = map.getSource("reports");
      if (repSrc) repSrc.setData({ type: "FeatureCollection", features: dayReports });

      var envSrc = map.getSource("wind-env");
      if (envSrc) {
        envSrc.setData(windEnvelope(
          dayReports.filter(function (f) { return f.properties.kind === "wind"; })
            .map(function (f) { return f.geometry.coordinates; })
        ));
      }
    } catch (err) {
      console.error("storm-history: could not draw " + date, err);
      if (mapNote) {
        mapNote.textContent =
          "The storm map couldn't be drawn for this date. The dates and sizes listed below are unaffected.";
        mapNote.hidden = false;
      }
      return;
    }
  }

  /* Only the address the homeowner typed is stored — never the coordinate the
     geocoder returned. Mapbox's temporary geocoding tier, which is the free
     one, does not permit storing its results. */
  function recordSearch(address, summary, topDate) {
    if (submitted[address]) return;
    submitted[address] = true;
    var body = new URLSearchParams({
      "form-name": "quote",
      name: "Storm history lookup",
      phone: "",
      email: "",
      address: address,
      message: "Searched " + new Date().toISOString().slice(0, 10) + " — " + summary,
      page: "Storm History",
      /* The date the notification should draw. Sending it means the function
         fetches one year file instead of all eleven to work out which storm
         mattered. Still no coordinate: a date is not a location, and the
         address string is the same one already in the field above. */
      storm_date: topDate || "",
    });
    fetch("/", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    }).catch(function () { /* a failed lead record must never break the result */ });
  }

  /* Runs the lookup once a coordinate is known, whichever path found it.
     `typed` is what the homeowner actually chose or wrote — that string is
     what gets stored, never the coordinate Mapbox returned. */
  /* The bbox the archive was built over. An address outside it has no data,
     which is not the same fact as "no storms happened there". */
  function inServiceArea(lon, lat) {
    return lon >= AREA.minLon && lon <= AREA.maxLon &&
           lat >= AREA.minLat && lat <= AREA.maxLat;
  }

  function runLookup(lon, lat, name, typed) {
    if (!window.StormGrid) {
      /* Without the shared grid module there is no containment test, and the
         page would quietly answer a different, worse question. Better to stop
         than to under-report someone's storm history. */
      console.error("storm-grid.js failed to load — containment unavailable");
      say("Something didn't load on this page. Refresh, or call us and we'll check the address for you.");
      return;
    }
    /* Checked here rather than in each caller, so the autocomplete path and
       the typed-and-submitted path cannot answer differently. Returning zero
       events for an address we simply have no data for would read as "no
       storms here", which is a claim the page must never make. */
    if (!inServiceArea(lon, lat)) {
      say("That address is outside our coverage area, so we don't have storm history for it. " +
          "We cover north Mississippi — call us and we'll tell you whether we can still help.");
      resetPanel();
      return;
    }

    addrBucket = window.StormGrid.bucketOf(lat, lon);
    var events = eventsAt(lon, lat);
    /* `typed` is what the reader actually chose or wrote, which is what the
       "change" control puts back in the field — not the geocoder's expanded
       form, which is longer and not what they typed. */
    current = { lon: lon, lat: lat, date: null, address: typed };
    render(name, events);

    /* Chosen once, used twice: the date the map opens on is the date the
       notification draws, so David's email and the homeowner's screen are
       showing the same storm. */
    var topDate = events.length ? biggestDate(events, lon, lat) : "";

    if (map) {
      if (marker) marker.remove();
      marker = new mapboxgl.Marker({ color: "#9db9dc" }).setLngLat([lon, lat]).addTo(map);
      if (mapNote) mapNote.hidden = true;
      if (events.length) {
        selectDate(topDate);
      } else {
        map.flyTo({ center: [lon, lat], zoom: 13.5, duration: 900 });
      }
    }

    recordSearch(
      typed,
      events.length ? events.length + " events, most recent " + events[0].date
                    : "no recorded events",
      topDate
    );
  }

  /* ---- address autocomplete --------------------------------------------- */

  /* Shared with the lookup block on five other pages — one implementation, in
     script.js, which this page already loads. It owns the session token, the
     debounce and the service-area constraints; this page supplies only what is
     particular to it: a 3-character minimum, because someone here has already
     chosen to look their address up, and a /retrieve on selection, because
     this is the page that needs the coordinate. */
  var ac = window.AddressAutocomplete && window.AddressAutocomplete.attach({
    input: input,
    listEl: listEl,
    token: MAPBOX_TOKEN,
    minChars: 3,
    debounceMs: 300,
    idPrefix: "sh",
    onChoose: function (item, typed, self) {
      say("");
      form.classList.add("is-busy");

      var url =
        "https://api.mapbox.com/search/searchbox/v1/retrieve/" +
        encodeURIComponent(item.mapbox_id) +
        "?session_token=" + encodeURIComponent(self.sessionToken()) +
        "&access_token=" + MAPBOX_TOKEN;

      loadData()
        .then(function () { return fetch(url); })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          var f = data && data.features && data.features[0];
          if (!f) { say("We couldn't place that address. Call us and we'll look it up."); return; }
          var c = f.geometry.coordinates;
          runLookup(c[0], c[1], typed, typed);
        })
        .catch(function () {
          say("Something went wrong looking that up. Call us and we'll check it for you.");
        })
        .then(function () {
          form.classList.remove("is-busy");
          self.resetSession();
        });
    },
  });

  /* ---- the button, for anyone who types it all out and hits enter -------- */

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    if (ac && ac.hasActive()) { ac.chooseActive(); return; }

    var address = (input.value || "").trim();
    if (!address) return;
    say("");
    if (ac) ac.close();

    if (!hasToken()) {
      say("Address lookup is not configured yet. Call us and we'll check it for you.");
      return;
    }

    var url =
      /* Deliberately no bbox here, unlike /suggest. Filtering server-side
         made an address in Memphis and a misspelled address in Tupelo return
         the identical empty result, so the page had to guess which had
         happened and told everyone to check their spelling. Resolving the
         address first and testing the coordinate ourselves lets the two be
         told apart and answered honestly. */
      "https://api.mapbox.com/search/geocode/v6/forward?q=" + encodeURIComponent(address) +
      "&country=us&types=address&limit=1&autocomplete=false" +
      "&proximity=" + TUPELO.join(",") +
      "&access_token=" + MAPBOX_TOKEN;

    form.classList.add("is-busy");
    loadData()
      .then(function () { return fetch(url); })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var f = data && data.features && data.features[0];
        if (!f) {
          /* No longer "in our service area": coverage is a separate answer
             now, given above. Reaching here means the geocoder could not
             resolve the text at all. */
          say("We couldn't find that address. Check the spelling, or call us and we'll look it up.");
          return;
        }
        var c = f.properties.coordinates;
        runLookup(c.longitude, c.latitude, f.properties.full_address || f.properties.name || address, address);
      })
      .catch(function () {
        say("Something went wrong looking that up. Call us and we'll check it for you.");
      })
      .then(function () { form.classList.remove("is-busy"); });
  });

  /* Fail here, visibly, rather than part-way through someone's lookup. */
  /* Arriving from the lookup block on another page: the address rides in the
     query string, so the visitor lands on a result rather than on an empty
     field they have to fill in twice. Geocoded here exactly as a typed
     submission is — the block deliberately does not use the Search Box
     autocomplete, so no session is spent getting here. */
  function prefillFromQuery() {
    var q = new URLSearchParams(window.location.search).get("address");
    if (!q) return;
    q = q.trim().slice(0, 200);
    if (!q) return;
    input.value = q;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  }

  var gridProblems = checkGridModule();
  if (gridProblems.length) {
    console.error("storm-history: grid module unusable —", gridProblems.join(", "));
    say(
      "This tool isn't working right now — " + gridProblems.join(", ") +
      ". Refresh the page, or call us and we'll check the address for you."
    );
    input.disabled = true;
    form.querySelector("button[type=submit]").disabled = true;
    if (mapNote) {
      mapNote.textContent = "Storm map unavailable.";
      mapNote.hidden = false;
    }
  } else {
    loadData().then(initMap).then(prefillFromQuery);
  }
})();
