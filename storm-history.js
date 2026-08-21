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

  var input = document.getElementById("sh-address");
  var errorEl = document.getElementById("sh-error");
  var mapEl = document.getElementById("sh-map");
  var mapNote = document.getElementById("sh-mapnote");
  var panelAddress = document.getElementById("sh-panel-address");
  var panelSub = document.getElementById("sh-panel-sub");
  var eventsEl = document.getElementById("sh-events");
  var emptyEl = document.getElementById("sh-empty");
  var chips = Array.prototype.slice.call(document.querySelectorAll(".sh-chip"));

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
  /* How much of the ten-year field to keep on screen once an address is
     chosen. Wide enough to show the storms that went either side of the
     house, tight enough that the dots stay countable. */
  var NEARBY_KM = 8;

  var EMPTY = { type: "FeatureCollection", features: [] };

  var hail = null;
  var reports = null;
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

  function prettyDate(iso) {
    var d = new Date(iso.length > 10 ? iso : iso + "T12:00:00Z");
    if (isNaN(d)) return iso;
    return d.toLocaleDateString("en-US", {
      year: "numeric", month: "long", day: "numeric", timeZone: "UTC",
    });
  }

  function loadData() {
    if (hail && reports) return Promise.resolve();
    return Promise.all([
      fetch("data/hail-cells.json").then(function (r) { return r.json(); }),
      fetch("data/storm-reports.geojson").then(function (r) { return r.json(); }),
    ]).then(function (res) {
      hail = res[0];
      reports = res[1];
    });
  }

  /* ---- map -------------------------------------------------------------- */

  function hailPoints(keep) {
    return {
      type: "FeatureCollection",
      features: (keep ? hail.cells.filter(keep) : hail.cells).map(function (c) {
        return {
          type: "Feature",
          geometry: { type: "Point", coordinates: [c[2], c[3]] },
          properties: { date: c[0], in: c[1] },
        };
      }),
    };
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
      /* Both layers start empty. The whole ten-year field on load is a wash of
         colour that answers no question — the map only has something to say
         once there is an address to say it about. */
      map.addSource("hail", { type: "geojson", data: EMPTY });
      map.addLayer({
        id: "hail",
        type: "circle",
        source: "hail",
        paint: {
          /* Radius tracks the 1.5km buffer across zooms rather than being a
             fixed pixel blob, so the dot means the same thing at every scale. */
          "circle-radius": [
            "interpolate", ["exponential", 2], ["zoom"],
            7, 2,
            11, 14,
            14, 90,
          ],
          /* Purple for hail, amber for wind — the palette from the preview.
             Stops are set to our own distribution: cells run 1.0 to 4.0 in,
             median 1.25. */
          "circle-color": [
            "interpolate", ["linear"], ["get", "in"],
            1.0, "#cbb6ef",
            1.5, "#a97fe0",
            2.0, "#8b5cd6",
            2.5, "#6a2fc0",
          ],
          "circle-opacity": 0.45,
          "circle-stroke-width": 0.5,
          "circle-stroke-color": "rgba(255,255,255,0.25)",
        },
      });

      map.addSource("reports", { type: "geojson", data: EMPTY });
      map.addLayer({
        id: "reports",
        type: "circle",
        source: "reports",
        /* The chip says Wind, so the layer shows wind. NWS hail reports stay
           in the results list for the address — they are real events — but
           they are not drawn under a wind label. */
        filter: ["==", ["get", "kind"], "wind"],
        paint: {
          "circle-radius": 5,
          /* Coloured by the gust the spotter actually recorded, converted from
             the knots Storm Events stores. Our reports run 45 to 94 mph. */
          "circle-color": [
            "interpolate", ["linear"], ["*", ["get", "mag"], 1.15078],
            45, "#ffe07a",
            58, "#ffb43d",
            70, "#ff7a1a",
            85, "#e63a1a",
          ],
          "circle-stroke-width": 1.5,
          "circle-stroke-color": "#ffffff",
        },
      });

      /* The note stays until a search puts something on the map — an empty
         basemap with no explanation reads as broken. */
    });
  }

  chips.forEach(function (chip) {
    chip.addEventListener("click", function () {
      var on = chip.classList.toggle("is-on");
      chip.setAttribute("aria-pressed", String(on));
      if (!map || !map.getLayer(chip.dataset.layer)) return;
      map.setLayoutProperty(chip.dataset.layer, "visibility", on ? "visible" : "none");
    });
  });

  /* ---- lookup ----------------------------------------------------------- */

  function eventsAt(lon, lat) {
    var out = [];

    hail.cells.forEach(function (c) {
      if (distanceKm(lon, lat, c[2], c[3]) <= HAIL_RADIUS_KM) {
        out.push({
          date: c[0],
          label: c[1].toFixed(2).replace(/0$/, "") + '" hail',
          source: "NEXRAD radar" + (c[4] ? " (" + c[4] + ")" : ""),
        });
      }
    });

    reports.features.forEach(function (f) {
      var g = f.geometry.coordinates;
      if (distanceKm(lon, lat, g[0], g[1]) > REPORT_RADIUS_KM) return;
      var p = f.properties;
      var label;
      if (p.kind === "hail") {
        label = (p.mag ? p.mag + '" ' : "") + "hail reported nearby";
      } else {
        var mph = p.mag ? Math.round(p.mag * 1.15078) : null;
        label = (mph ? mph + " mph " : "") + "wind reported nearby";
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
    panelSub.textContent =
      events.length === 1 ? "1 recorded event, most recent first"
                          : events.length + " recorded events, most recent first";

    events.forEach(function (e) {
      var li = document.createElement("li");
      li.className = "sh-event";
      var d = document.createElement("span");
      d.className = "sh-event-date";
      d.textContent = prettyDate(e.date);
      var v = document.createElement("span");
      v.className = "sh-event-value";
      v.textContent = e.label;
      var s = document.createElement("span");
      s.className = "sh-event-source";
      s.textContent = e.source;
      li.appendChild(d);
      li.appendChild(v);
      li.appendChild(s);
      eventsEl.appendChild(li);
    });
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

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var address = (input.value || "").trim();
    if (!address) return;
    say("");

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
        /* v6: the coordinate lives on properties, not on a center array */
        var c = f.properties.coordinates;
        var lon = c.longitude;
        var lat = c.latitude;
        var name = f.properties.full_address || f.properties.name || address;

        var events = eventsAt(lon, lat);
        render(name, events);

        if (map) {
          if (marker) marker.remove();
          marker = new mapboxgl.Marker({ color: "#9db9dc" }).setLngLat([lon, lat]).addTo(map);

          /* Ten years over five counties is a texture, not a map. Once there
             is an address, show the cells around it and get close enough that
             each one reads as a single event. */
          var hailSrc = map.getSource("hail");
          if (hailSrc) {
            hailSrc.setData(
              hailPoints(function (c) {
                return distanceKm(lon, lat, c[2], c[3]) <= NEARBY_KM;
              })
            );
          }
          var repSrc = map.getSource("reports");
          if (repSrc) {
            repSrc.setData({
              type: "FeatureCollection",
              features: reports.features.filter(function (f) {
                var g = f.geometry.coordinates;
                return distanceKm(lon, lat, g[0], g[1]) <= NEARBY_KM;
              }),
            });
          }
          if (mapNote) mapNote.hidden = true;
          map.flyTo({ center: [lon, lat], zoom: 13.5, duration: 900 });
        }

        recordSearch(
          address,
          events.length ? events.length + " events, most recent " + events[0].date
                        : "no recorded events"
        );
      })
      .catch(function () {
        say("Something went wrong looking that up. Call us and we'll check it for you.");
      })
      .then(function () { form.classList.remove("is-busy"); });
  });

  loadData().then(initMap);
})();
