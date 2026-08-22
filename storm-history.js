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
  var panelAddress = document.getElementById("sh-panel-address");
  var panelSub = document.getElementById("sh-panel-sub");
  var eventsEl = document.getElementById("sh-events");
  var emptyEl = document.getElementById("sh-empty");
  var chips = Array.prototype.slice.call(document.querySelectorAll(".sh-chip"));
  var listEl = document.getElementById("sh-suggest");
  var currencyEl = document.getElementById("sh-currency");

  /* The service area, and the box the generator pulled data for. Searches
     outside it get told so rather than returning a confident "nothing found"
     for somewhere we have no data. */
  var AREA = { minLon: -91.0, minLat: 33.9, maxLon: -88.4, maxLat: 35.05 };
  var CENTER = [-89.7, 34.45];

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
      style: "mapbox://styles/mapbox/standard",
      config: { basemap: { lightPreset: "night" } },
      center: CENTER,
      zoom: 7.2,
      attributionControl: false,
    });
    map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), "top-right");

    map.on("load", function () {
      /* Both sources start empty. The whole ten-year field on load is a wash
         of colour that answers no question — the map only has something to say
         once there is an address to say it about. */
      /* Sources: swath bands for hail, an envelope for wind, the address's
         own cell, and the wind points themselves. A detection stands for a
         ~5.5 x 4.6km cell — drawing it as a dot understated it by two orders
         of magnitude, so the cells are drawn at true size and unioned. */
      map.addSource("hail-bands", { type: "geojson", data: EMPTY });
      map.addSource("wind-env", { type: "geojson", data: EMPTY });
      map.addSource("reports", { type: "geojson", data: EMPTY });
      map.addSource("addr-glow", { type: "geojson", data: EMPTY });

      map.addLayer({
        id: "wind-env",
        type: "fill",
        source: "wind-env",
        slot: "top",
        paint: {
          /* Deliberately fainter than the hail bands. A gust report is one
             observation at one point, not a measured footprint, and it should
             not look like stronger evidence than a radar sweep.

             At 0.30, amber over purple composited to a pink that belonged to
             neither ramp and read as a third hazard. There is no blend mode to
             blame — Mapbox fill layers composite source-over — so the fix is
             less alpha and a lower position in the stack: wind is the backdrop
             the hail sits on, and the hail keeps its own colour. */
          "fill-color": "#f5a63c",
          "fill-opacity": 0.18,
          "fill-emissive-strength": 1,
        },
      });

      map.addLayer({
        id: "hail-bands",
        type: "fill",
        source: "hail-bands",
        slot: "top",
        paint: {
          /* Nested by construction: each band is the union of every cell at or
             above its threshold, so bigger hail always sits inside smaller.
             Larger sizes read deeper, on the same ramp as the legend. */
          /* Every band visibly distinct from the one under it. The old base was
             pale enough to read as grey haze, which made the cores look like
             separate islands rather than the middle of one shape. */
          "fill-color": [
            "interpolate", ["linear"], ["get", "min"],
            1.0, "#cdb6ee",
            1.5, "#b189e6",
            1.75, "#9a63dd",
            2.0, "#8340d2",
            2.5, "#6b21c0",
          ],
          "fill-opacity": [
            "interpolate", ["linear"], ["get", "min"],
            1.0, 0.42,
            1.75, 0.6,
            2.5, 0.78,
          ],
          "fill-emissive-strength": 1,
        },
      });
      map.addLayer({
        id: "hail-bands-line",
        type: "line",
        source: "hail-bands",
        slot: "top",
        paint: {
          "line-color": [
            "interpolate", ["linear"], ["get", "min"],
            1.0, "#d4cbe2",
            2.5, "#a53dff",
          ],
          "line-width": 1,
          "line-opacity": 0.7,
          "line-emissive-strength": 1,
        },
      });

      map.addLayer({
        id: "reports",
        type: "circle",
        source: "reports",
        slot: "top",
        filter: ["==", ["get", "kind"], "wind"],
        paint: {
          "circle-emissive-strength": 1,
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
         interpolated exponentially on base 2, which is exactly how web
         mercator scales, so it holds a constant ~5km on the ground at every
         zoom instead of swelling as you zoom in. */
      map.addLayer({
        id: "addr-glow",
        type: "circle",
        source: "addr-glow",
        slot: "top",
        paint: {
          "circle-color": "#dbeaff",
          "circle-blur": 1,
          "circle-opacity": 0.5,
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
          "circle-opacity": 0.95,
          "circle-emissive-strength": 1,
        },
      });
    });
  }

  chips.forEach(function (chip) {
    chip.addEventListener("click", function () {
      var on = chip.classList.toggle("is-on");
      chip.setAttribute("aria-pressed", String(on));
      if (!map) return;
      /* One chip, several layers: a hazard is a band plus its outline, or an
         envelope plus the points inside it. */
      var groups = { hail: ["hail-bands", "hail-bands-line"], reports: ["wind-env", "reports"] };
      (groups[chip.dataset.layer] || []).forEach(function (id) {
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

  function render(address, events) {
    panelAddress.textContent = address;
    eventsEl.innerHTML = "";

    if (!events.length) {
      panelSub.textContent = "No recorded events in the last ten years.";
      emptyEl.hidden = false;
      return;
    }
    emptyEl.hidden = true;

    /* Two questions, two sections. Recency-first buried twelve in-cell hail
       dates under a couple of nearby wind reports, which is the wrong answer
       to "what happened at my house". */
    /* Both sections newest first. Ranking the in-cell list by size put a 2016
       hailstorm above a 2025 one, which reads as "we have nothing recent". */
    var here = events.filter(function (e) { return e.here; })
      .sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : 0; });
    var near = events.filter(function (e) { return !e.here; })
      .sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : 0; });

    panelSub.textContent =
      here.length
        ? here.length + (here.length === 1 ? " event at this address" : " events at this address")
          + ", " + near.length + " nearby — select one to see that day"
        : "No detections in the cell containing this address; "
          + near.length + " nearby — select one to see that day";

    section("At your address", here, "Nothing was detected in the cell containing this address.");
    section("Nearby", near, "Nothing else was recorded within a few miles.");
  }

  function section(title, rows, emptyText) {
    var head = document.createElement("li");
    head.className = "sh-section";
    head.setAttribute("role", "presentation");
    head.textContent = title;
    eventsEl.appendChild(head);

    if (!rows.length) {
      /* Say it plainly. A hidden heading reads as "we found nothing anywhere",
         which is a different claim. */
      var none = document.createElement("li");
      none.className = "sh-section-empty";
      none.textContent = emptyText;
      eventsEl.appendChild(none);
      return;
    }

    rows.forEach(function (e) {
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
    });
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

    fitToStorm();
  }

  /* Only the address the homeowner typed is stored — never the coordinate the
     geocoder returned. Mapbox's temporary geocoding tier, which is the free
     one, does not permit storing its results. */
  function recordSearch(address, summary) {
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
  function runLookup(lon, lat, name, typed) {
    if (!window.StormGrid) {
      /* Without the shared grid module there is no containment test, and the
         page would quietly answer a different, worse question. Better to stop
         than to under-report someone's storm history. */
      console.error("storm-grid.js failed to load — containment unavailable");
      say("Something didn't load on this page. Refresh, or call us and we'll check the address for you.");
      return;
    }
    addrBucket = window.StormGrid.bucketOf(lat, lon);
    var events = eventsAt(lon, lat);
    current = { lon: lon, lat: lat, date: null };
    render(name, events);

    if (map) {
      if (marker) marker.remove();
      marker = new mapboxgl.Marker({ color: "#9db9dc" }).setLngLat([lon, lat]).addTo(map);
      if (mapNote) mapNote.hidden = true;
      if (events.length) {
        selectDate(biggestDate(events, lon, lat));
      } else {
        map.flyTo({ center: [lon, lat], zoom: 13.5, duration: 900 });
      }
    }

    recordSearch(
      typed,
      events.length ? events.length + " events, most recent " + events[0].date
                    : "no recorded events"
    );
  }

  /* ---- address autocomplete --------------------------------------------- */

  /* Search Box API: /suggest while typing, /retrieve once one is chosen. A
     session groups the two for billing, so it is minted per search and reset
     after a retrieve rather than per keystroke. */
  var sessionToken = newSession();
  var suggestTimer = null;
  var suggestions = [];
  var activeIndex = -1;

  function newSession() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "s-" + Date.now() + "-" + Math.round(Math.random() * 1e9);
  }

  function closeSuggestions() {
    suggestions = [];
    activeIndex = -1;
    listEl.hidden = true;
    listEl.innerHTML = "";
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  }

  function highlight(i) {
    activeIndex = i;
    Array.prototype.forEach.call(listEl.children, function (li, n) {
      var on = n === i;
      li.classList.toggle("is-active", on);
      li.setAttribute("aria-selected", String(on));
    });
    if (i >= 0 && listEl.children[i]) {
      input.setAttribute("aria-activedescendant", listEl.children[i].id);
      listEl.children[i].scrollIntoView({ block: "nearest" });
    }
  }

  function drawSuggestions(items) {
    suggestions = items;
    listEl.innerHTML = "";
    if (!items.length) { closeSuggestions(); return; }

    items.forEach(function (item, i) {
      var li = document.createElement("li");
      li.className = "sh-suggestion";
      li.id = "sh-suggestion-" + i;
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", "false");

      var name = document.createElement("span");
      name.className = "sh-suggestion-name";
      name.textContent = item.name;
      var ctx = document.createElement("span");
      ctx.className = "sh-suggestion-context";
      ctx.textContent = item.place_formatted || "";
      li.appendChild(name);
      li.appendChild(ctx);

      /* mousedown, not click: blur would close the list first. */
      li.addEventListener("mousedown", function (ev) {
        ev.preventDefault();
        choose(i);
      });
      listEl.appendChild(li);
    });

    listEl.hidden = false;
    input.setAttribute("aria-expanded", "true");
    highlight(-1);
  }

  function suggest(q) {
    if (!hasToken() || q.length < 3) { closeSuggestions(); return; }
    var url =
      "https://api.mapbox.com/search/searchbox/v1/suggest?q=" + encodeURIComponent(q) +
      "&session_token=" + encodeURIComponent(sessionToken) +
      "&country=us&types=address&limit=6" +
      "&proximity=" + CENTER.join(",") +
      "&bbox=" + [AREA.minLon, AREA.minLat, AREA.maxLon, AREA.maxLat].join(",") +
      "&access_token=" + MAPBOX_TOKEN;

    fetch(url)
      .then(function (r) { return r.json(); })
      .then(function (data) { drawSuggestions((data && data.suggestions) || []); })
      .catch(function () { closeSuggestions(); });
  }

  function choose(i) {
    var item = suggestions[i];
    if (!item) return;
    var typed = item.name + (item.place_formatted ? ", " + item.place_formatted : "");
    input.value = typed;
    closeSuggestions();
    say("");
    form.classList.add("is-busy");

    var url =
      "https://api.mapbox.com/search/searchbox/v1/retrieve/" + encodeURIComponent(item.mapbox_id) +
      "?session_token=" + encodeURIComponent(sessionToken) +
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
        /* A retrieve ends the session; the next search starts a new one. */
        sessionToken = newSession();
      });
  }

  input.addEventListener("input", function () {
    var q = input.value.trim();
    clearTimeout(suggestTimer);
    /* 300ms: a session allows 50 suggests, and one request per keystroke
       burns through both the allowance and the user's data for nothing. */
    suggestTimer = setTimeout(function () { suggest(q); }, 300);
  });

  input.addEventListener("keydown", function (e) {
    if (listEl.hidden) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      highlight((activeIndex + 1) % suggestions.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      highlight((activeIndex - 1 + suggestions.length) % suggestions.length);
    } else if (e.key === "Enter" && activeIndex >= 0) {
      e.preventDefault();
      choose(activeIndex);
    } else if (e.key === "Escape") {
      closeSuggestions();
    }
  });

  input.addEventListener("blur", function () {
    setTimeout(closeSuggestions, 120);
  });

  /* ---- the button, for anyone who types it all out and hits enter -------- */

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    if (activeIndex >= 0 && !listEl.hidden) { choose(activeIndex); return; }

    var address = (input.value || "").trim();
    if (!address) return;
    say("");
    closeSuggestions();

    if (!hasToken()) {
      say("Address lookup is not configured yet. Call us and we'll check it for you.");
      return;
    }

    var url =
      "https://api.mapbox.com/search/geocode/v6/forward?q=" + encodeURIComponent(address) +
      "&country=us&types=address&limit=1&autocomplete=false" +
      "&bbox=" + [AREA.minLon, AREA.minLat, AREA.maxLon, AREA.maxLat].join(",") +
      "&access_token=" + MAPBOX_TOKEN;

    form.classList.add("is-busy");
    loadData()
      .then(function () { return fetch(url); })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var f = data && data.features && data.features[0];
        if (!f) {
          say("We couldn't find that address in our service area. Check the spelling, or call us and we'll look it up.");
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
    loadData().then(initMap);
  }
})();
