const yearEl = document.getElementById("year");
if (yearEl) yearEl.textContent = new Date().getFullYear();

// The quote form submits natively so Netlify can process it and redirect to
// /thanks. Intercepting it here would block that redirect, so the only JS is
// disabling the button to prevent a double submission.
const form = document.getElementById("contact-form");
if (form) {
  form.addEventListener("submit", function () {
    const button = form.querySelector("button[type=submit]");
    if (button) {
      button.disabled = true;
      button.textContent = "Sending…";
    }
  });
}

const prefersReducedMotion = window.matchMedia(
  "(prefers-reduced-motion: reduce)"
).matches;

// Hero video. The markup ships no src, so nothing is fetched until this runs —
// phones and reduced-motion visitors never download the footage at all, and the
// <video> paints its poster instead, which is the still we want in both cases.
const heroVideo = document.querySelector("[data-hero-video]");
if (heroVideo) {
  const wantsVideo =
    window.matchMedia("(min-width: 768px)").matches && !prefersReducedMotion;
  if (wantsVideo) {
    heroVideo.src = heroVideo.dataset.src;
    // The autoplay attribute is evaluated at parse time, when there was no
    // source to act on, so playback is kicked off explicitly. A rejected
    // promise just leaves the poster up, which is a fine resting state.
    const started = heroVideo.play();
    if (started && started.catch) started.catch(function () {});
  }
}

// Populated by the dropdown block below. Collapsing the hamburger panel also
// collapses any accordion inside it, so reopening the menu starts clean.
const dropdownClosers = [];

// Collapsed nav (below 1024px)
const navToggle = document.getElementById("nav-toggle");
const nav = document.getElementById("site-nav");

if (navToggle && nav) {
  const setNav = (open) => {
    navToggle.setAttribute("aria-expanded", String(open));
    nav.classList.toggle("is-open", open);
    if (!open) dropdownClosers.forEach((close) => close());
  };

  navToggle.addEventListener("click", function () {
    setNav(navToggle.getAttribute("aria-expanded") !== "true");
  });

  // Tapping a destination should close the panel behind it
  nav.addEventListener("click", function (e) {
    if (e.target.closest("a")) setNav(false);
  });

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") setNav(false);
  });

  // Leaving mobile widths with the panel open would otherwise strand the class
  window.matchMedia("(min-width: 1024px)").addEventListener("change", function (e) {
    if (e.matches) setNav(false);
  });
}

// Service Areas dropdown
// ---------------------------------------------------------------------------
// Every open/close path — hover, click, keyboard — goes through setOpen, so
// aria-expanded and the visual state can never disagree. That is why hover is
// wired in JS rather than left to a CSS :hover rule.
const isDesktopNav = window.matchMedia("(min-width: 1024px)");

document.querySelectorAll("[data-nav-dropdown]").forEach((group) => {
  const toggle = group.querySelector(".nav-group-toggle");
  const panel = group.querySelector(".nav-panel");
  if (!toggle || !panel) return;

  const items = Array.from(panel.querySelectorAll("a"));
  const isOpen = () => toggle.getAttribute("aria-expanded") === "true";

  const setOpen = (open) => {
    group.classList.toggle("is-open", open);
    toggle.setAttribute("aria-expanded", String(open));
  };

  dropdownClosers.push(() => setOpen(false));

  const focusItem = (i) => {
    if (!items.length) return;
    // A panel still computed as visibility:hidden cannot take focus, and the
    // class was set in this same task — force the style flush first.
    void panel.offsetHeight;
    items[(i + items.length) % items.length].focus();
  };

  toggle.addEventListener("click", () => setOpen(!isOpen()));

  // Hover belongs to desktop only; on touch the click above is the whole
  // interaction. Leaving via the gap under the button is covered by the
  // panel's ::before bridge, which is a descendant and so not a mouseleave.
  group.addEventListener("mouseenter", () => {
    if (isDesktopNav.matches) setOpen(true);
  });
  group.addEventListener("mouseleave", () => {
    if (isDesktopNav.matches && !group.contains(document.activeElement)) {
      setOpen(false);
    }
  });

  group.addEventListener("keydown", (e) => {
    const index = items.indexOf(document.activeElement);

    if (e.key === "Escape") {
      if (!isOpen()) return;
      // Keep the document-level handler from collapsing the whole menu too
      e.stopPropagation();
      setOpen(false);
      toggle.focus();
      return;
    }

    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!isOpen()) {
        setOpen(true);
        focusItem(0);
      } else {
        focusItem(index < 0 ? 0 : index + 1);
      }
      return;
    }

    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (!isOpen()) {
        setOpen(true);
        focusItem(items.length - 1);
      } else {
        focusItem(index < 0 ? items.length - 1 : index - 1);
      }
      return;
    }

    if (index >= 0 && e.key === "Home") {
      e.preventDefault();
      focusItem(0);
    } else if (index >= 0 && e.key === "End") {
      e.preventDefault();
      focusItem(items.length - 1);
    }
  });

  // Tabbing past the last item closes it behind you
  group.addEventListener("focusout", (e) => {
    if (!group.contains(e.relatedTarget)) setOpen(false);
  });

  document.addEventListener("click", (e) => {
    if (!group.contains(e.target)) setOpen(false);
  });

  // Crossing the breakpoint swaps floating panel for accordion; reset either way
  isDesktopNav.addEventListener("change", () => setOpen(false));
});

const header = document.querySelector(".site-header");
// The media box, not the <img> — the image is swapped for a cropped background
// on narrow screens, where its own box would collapse to zero height.
// .city-hero-media is included so a city page with an image hero also switches
// when that hero clears the header, rather than on the first pixel of scroll.
const heroMedia = document.querySelector(".hero-media, .city-hero-media");
const revealEls = Array.from(document.querySelectorAll(".reveal"));

function show(el) {
  el.classList.add("in-view");
}

if (prefersReducedMotion) {
  // No observer, no transition — everything is simply present.
  revealEls.forEach(show);
} else {
  // Stagger within each group of siblings rather than across the whole page,
  // so a long list doesn't end up with a visibly delayed tail. Pills use a
  // tighter step because there are far more of them per row.
  const groups = new Map();
  revealEls.forEach((el) => {
    const group = groups.get(el.parentElement) || [];
    group.push(el);
    groups.set(el.parentElement, group);
  });
  groups.forEach((els, parent) => {
    /* Step per group. The values cards run tighter than the default: four
       cards across that width at 80ms read as four separate arrivals rather
       than one gesture. The service-area pills stay at 30 — there are far
       more of them per row. */
    const isPills = parent.classList.contains("area-list");
    const step = isPills ? 30 : 80;
    const cap = isPills ? 9 : 5;
    els.forEach((el, i) => {
      el.style.transitionDelay = `${Math.min(i, cap) * step}ms`;
    });
  });

  // Set by the first callback of any kind, intersecting or not. An
  // IntersectionObserver delivers an initial callback for every target shortly
  // after observe(), so in a working browser this flips almost immediately.
  let observerDelivered = false;

  const observer = new IntersectionObserver(
    (entries) => {
      observerDelivered = true;
      entries.forEach((entry) => {
        // isIntersecting covers the normal case; the boundingClientRect check
        // catches an element that was already scrolled past before it was
        // observed, which would otherwise stay hidden.
        if (entry.isIntersecting || entry.boundingClientRect.top < 0) {
          show(entry.target);
          observer.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.15 }
  );

  revealEls.forEach((el) => observer.observe(el));

  // Backstop. A jump with no intermediate frames — loading straight to /#contact,
  // or a fast fling — can carry an element from below the viewport to above it
  // without the observer ever seeing an intersecting state, so it never fires
  // and the element stays invisible. This sweeps anything already past the fold.
  const sweep = () => {
    let remaining = false;
    revealEls.forEach((el) => {
      if (el.classList.contains("in-view")) return;
      if (el.getBoundingClientRect().top < window.innerHeight) {
        show(el);
        observer.unobserve(el);
      } else {
        remaining = true;
      }
    });
    if (!remaining) window.removeEventListener("scroll", onSweep);
  };

  let sweepQueued = false;
  function onSweep() {
    if (sweepQueued) return;
    sweepQueued = true;
    requestAnimationFrame(() => {
      sweepQueued = false;
      sweep();
    });
  }

  window.addEventListener("scroll", onSweep, { passive: true });
  window.addEventListener("load", sweep);

  // Dead-observer fallback. Everything wearing .reveal starts at opacity 0 and
  // is only made visible by JavaScript, so if callbacks never arrive the page
  // stays blank — 45 elements on the homepage alone, including the storm
  // lookup copy. The existing sweep is not a safety net for this: it queues
  // through requestAnimationFrame, so it dies in exactly the conditions that
  // kill the observer.
  //
  // This checks whether the observer has delivered anything at all, rather
  // than whether anything is in view — most pages legitimately have every
  // .reveal below the fold at load, so "nothing revealed yet" is normal and
  // "nothing delivered yet" is not. If it has not, the effect is abandoned and
  // the content is shown, which is always the right trade: a missing fade
  // costs nothing, missing copy costs the page.
  setTimeout(() => {
    if (observerDelivered) return;
    revealEls.forEach(show);
    observer.disconnect();
  }, 2000);
}

// Header state is independent of the reveals — it must track scroll on every
// pass, so it stays on a cheap rAF-throttled listener.
function updateHeader() {
  headerQueued = false;
  if (!header) return;
  // Switch before the hero's white CTA bar slides under the transparent
  // header, which would otherwise leave white nav text on a white strip.
  //
  // Pages with no hero — thanks, privacy — are solid the whole way down.
  // They used to fall back to scrollY > 0, which stripped is-solid at the top
  // and left the 65%-navy header washed out over a white page, with a white
  // logo on top of it.
  const solid = heroMedia
    ? heroMedia.getBoundingClientRect().bottom <= header.offsetHeight
    : true;
  header.classList.toggle("is-solid", solid);
}

let headerQueued = false;
function onScroll() {
  if (headerQueued) return;
  headerQueued = true;
  requestAnimationFrame(updateHeader);
}

window.addEventListener("scroll", onScroll, { passive: true });
window.addEventListener("resize", onScroll);
updateHeader();

  /* Keep the footer's bottom clearance equal to the sticky bar's real height.

     The CSS fallback is a hardcoded token, which was already one pixel short
     of what the bar actually renders. Measuring removes that class of drift
     for good: if the label ever wraps to two lines, or a line is added, the
     footer pads by the new height without anyone editing a number.

     offsetHeight already includes the safe-area inset, since that inset is
     part of the bar's own bottom padding — so the measured value replaces the
     fallback's calc() rather than adding to it. */
  const stickyBar = document.querySelector(".sticky-call");

  if (stickyBar && typeof ResizeObserver === "function") {
    const syncStickyClearance = function () {
      const h = stickyBar.offsetHeight;
      // Zero above 768px, where the bar is display:none. Leaving the property
      // alone there keeps the fallback in place for the next resize down.
      if (h > 0) {
        document.documentElement.style.setProperty(
          "--sticky-clearance",
          h + "px"
        );
      }
    };

    new ResizeObserver(syncStickyClearance).observe(stickyBar);
    syncStickyClearance();
  }

  /* Anchor scrolling, capped.

     scroll-behavior: smooth paces by distance, so a jump from the top of the
     homepage to #contact is a ~5,000px ride. This animates it here instead and
     clamps the duration, so short hops still feel proportional and long ones
     stop being a journey.

     The CSS keeps scroll-behavior: smooth as the no-JS fallback; each step
     passes behavior:"instant" so the native smoothing does not fight the
     rAF loop by re-easing every frame. */
  const SCROLL_CAP_MS = 600;
  const SCROLL_MIN_MS = 220;

  function anchorOffsetFor(el) {
    // Mirrors what the CSS does natively: the scrollport is inset by
    // scroll-padding-top, and the target adds its own scroll-margin-top.
    const headerH = parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue("--header-h")
    );
    const margin = parseFloat(getComputedStyle(el).scrollMarginTop);
    return (headerH || 0) + (margin || 0);
  }

  function scrollToAnchor(el) {
    const start = window.scrollY;
    const maxScroll =
      document.documentElement.scrollHeight - window.innerHeight;
    const end = Math.max(
      0,
      Math.min(
        maxScroll,
        el.getBoundingClientRect().top + start - anchorOffsetFor(el)
      )
    );
    const distance = end - start;
    if (Math.abs(distance) < 1) return;

    // Already a boolean — .matches was applied where it is defined.
    if (prefersReducedMotion) {
      window.scrollTo({ top: end, behavior: "instant" });
      return;
    }

    // Proportional under the cap, clamped above it.
    const duration = Math.min(
      SCROLL_CAP_MS,
      Math.max(SCROLL_MIN_MS, Math.abs(distance) * 0.45)
    );
    const startedAt = performance.now();
    // ease-out cubic, so it arrives settled rather than stopping dead
    const ease = (t) => 1 - Math.pow(1 - t, 3);

    function step(now) {
      const t = Math.min(1, (now - startedAt) / duration);
      window.scrollTo({ top: start + distance * ease(t), behavior: "instant" });
      if (t < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  document.addEventListener("click", function (event) {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

    const link = event.target.closest && event.target.closest('a[href*="#"]');
    if (!link || link.target === "_blank") return;

    let url;
    try {
      url = new URL(link.getAttribute("href"), window.location.href);
    } catch (e) {
      return;
    }
    // Only same-document anchors. A link to another page's section navigates.
    if (
      url.origin !== window.location.origin ||
      url.pathname !== window.location.pathname ||
      !url.hash ||
      url.hash === "#"
    ) {
      return;
    }

    let target;
    try {
      target = document.querySelector(url.hash);
    } catch (e) {
      return;
    }
    if (!target) return;

    event.preventDefault();
    scrollToAnchor(target);
    // Keep the URL and the back button honest, without a second jump.
    if (window.history && window.history.pushState) {
      window.history.pushState(null, "", url.hash);
    }
  });

  /* Roof system diagram.

     The nine descriptions live once, in the .rs-fallback list, which has to be
     in the page anyway for the no-JS case. This reads the copy back out of it
     rather than carrying a second copy in a JSON blob — they can never drift.

     role and tabindex are applied here, not in the markup: without this script
     the shapes do nothing, and announcing them as buttons would be a lie. */
  const rsFigure = document.querySelector(".rs-image");
  const rsList = document.querySelector(".rs-list");

  if (rsFigure && rsList) {
    const rsMarkers = Array.from(rsFigure.querySelectorAll(".rs-layer"));
    const rsHeads = Array.from(rsList.querySelectorAll(".rs-list-item"));

    // Every description is in the markup and open by default, so the page
    // reads straight through without this script. Collapsing them is the
    // enhancement, which is why aria-expanded is introduced here rather than
    // in the HTML — asserting "false" on content that is visibly open would
    // be a lie to anything that trusts the attribute.
    rsHeads.forEach(function (btn) {
      btn.setAttribute("aria-expanded", "false");
    });

    // One open at a time. Passing null closes them all, which is what the
    // open row's own button does — and then no marker is highlighted either,
    // because nothing is selected.
    function rsShow(id) {
      rsHeads.forEach(function (btn) {
        btn.setAttribute("aria-expanded", String(btn.dataset.layer === id));
      });
      rsMarkers.forEach(function (el) {
        const on = el.dataset.layer === id;
        el.classList.toggle("is-active", on);
        el.setAttribute("aria-pressed", String(on));
      });
    }

    rsHeads.forEach(function (btn) {
      btn.addEventListener("click", function () {
        const isOpen = btn.getAttribute("aria-expanded") === "true";
        rsShow(isOpen ? null : btn.dataset.layer);
      });
    });

    // The markers are a second way in for anyone who reaches for the drawing
    // itself; they open the matching row rather than toggling it, so clicking
    // around the image never leaves the list closed.
    rsMarkers.forEach(function (el) {
      el.setAttribute("aria-pressed", "false");
      el.addEventListener("click", function () {
        rsShow(el.dataset.layer);
      });
    });

    rsShow("deck");
  }

/* Address autocomplete — Mapbox Search Box.
   -------------------------------------------------------------------------
   One implementation, two callers: the storm history page's own field and the
   lookup block injected into five other pages. Written here because every page
   that needs it already loads this file.

   Sessions are the money. A session is minted once and reused across every
   keystroke of one search, then reset after a /retrieve — billing groups the
   suggests and the retrieve together, so per-keystroke tokens would multiply
   the bill by the length of the address. At 500 free sessions a month this is
   the tightest limit on the account by a factor of 60, which is also why the
   caller sets minChars: a session starts on the first suggest call, so the
   character count is the real throttle, not the debounce. */
window.AddressAutocomplete = (function () {
  /* The service area, in one place. Suggestions outside it are not offered at
     all, which is cheaper and kinder than offering an address we have no data
     for and then explaining that we have no data for it. */
  var AREA = { minLon: -91.0, minLat: 33.9, maxLon: -88.4, maxLat: 35.05 };
  var TUPELO = [-88.7034, 34.2576];

  function newSession() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "s-" + Date.now() + "-" + Math.round(Math.random() * 1e9);
  }

  function attach(opts) {
    var input = opts.input;
    var listEl = opts.listEl;
    var token = opts.token;
    var minChars = opts.minChars || 3;
    var debounceMs = Math.max(opts.debounceMs || 300, 300);
    var prefix = opts.idPrefix || "ac";
    var onChoose = opts.onChoose;
    if (!input || !listEl || !token) return null;

    var session = newSession();
    var timer = null;
    var items = [];
    var activeIndex = -1;

    function close() {
      items = [];
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

    function label(item) {
      return item.name + (item.place_formatted ? ", " + item.place_formatted : "");
    }

    function draw(list) {
      items = list;
      listEl.innerHTML = "";
      if (!list.length) { close(); return; }

      list.forEach(function (item, i) {
        var li = document.createElement("li");
        li.className = "sh-suggestion";
        li.id = prefix + "-suggestion-" + i;
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
          pick(i);
        });
        listEl.appendChild(li);
      });

      listEl.hidden = false;
      input.setAttribute("aria-expanded", "true");
      highlight(-1);
    }

    function suggest(q) {
      if (q.length < minChars) { close(); return; }
      var url =
        "https://api.mapbox.com/search/searchbox/v1/suggest?q=" + encodeURIComponent(q) +
        "&session_token=" + encodeURIComponent(session) +
        "&country=us&types=address&limit=6" +
        "&proximity=" + TUPELO.join(",") +
        "&bbox=" + [AREA.minLon, AREA.minLat, AREA.maxLon, AREA.maxLat].join(",") +
        "&access_token=" + token;

      fetch(url)
        .then(function (r) { return r.json(); })
        .then(function (data) { draw((data && data.suggestions) || []); })
        .catch(close);
    }

    function pick(i) {
      var item = items[i];
      if (!item) return;
      var typed = label(item);
      input.value = typed;
      close();
      onChoose(item, typed, api);
    }

    input.addEventListener("input", function () {
      var q = input.value.trim();
      clearTimeout(timer);
      timer = setTimeout(function () { suggest(q); }, debounceMs);
    });

    input.addEventListener("keydown", function (e) {
      if (listEl.hidden) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        highlight((activeIndex + 1) % items.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        highlight((activeIndex - 1 + items.length) % items.length);
      } else if (e.key === "Enter" && activeIndex >= 0) {
        e.preventDefault();
        pick(activeIndex);
      } else if (e.key === "Escape") {
        close();
      }
    });

    input.addEventListener("blur", function () {
      setTimeout(close, 120);
    });

    var api = {
      close: close,
      hasActive: function () { return activeIndex >= 0 && !listEl.hidden; },
      chooseActive: function () { pick(activeIndex); },
      sessionToken: function () { return session; },
      /* A retrieve ends the session; the next search starts a new one. */
      resetSession: function () { session = newSession(); },
    };
    return api;
  }

  return { attach: attach, AREA: AREA, TUPELO: TUPELO };
})();

/* The lookup block, on five pages. Selecting a suggestion goes straight to the
   storm page with the address; the form's plain GET submit is untouched, so
   typing it out and pressing enter still works with JavaScript off or the
   dropdown ignored. No /retrieve here — the storm page geocodes what it is
   given against the 100,000/month tier, and a retrieve would buy a coordinate
   this page has no use for. */
(function () {
  var block = document.querySelector(".lookup-cta-field");
  if (!block) return;
  var input = document.getElementById("lookup-cta-address");
  var listEl = document.getElementById("lookup-cta-suggest");
  var token = "__MAPBOX_TOKEN__";
  if (!input || !listEl || token.indexOf("pk.") !== 0) return;

  window.AddressAutocomplete.attach({
    input: input,
    listEl: listEl,
    token: token,
    /* 5, not the storm page's 3. "123 M" is not a committed searcher, and the
       first suggest call is what opens a billable session. On the storm page
       someone has already chosen to be there; here they are browsing. */
    minChars: 5,
    debounceMs: 300,
    idPrefix: "lookup-cta",
    onChoose: function (item, typed) {
      window.location.href = "/storm-history?address=" + encodeURIComponent(typed);
    },
  });
})();
