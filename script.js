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

// Collapsed nav (below 768px)
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
  window.matchMedia("(min-width: 769px)").addEventListener("change", function (e) {
    if (e.matches) setNav(false);
  });
}

// Service Areas dropdown
// ---------------------------------------------------------------------------
// Every open/close path — hover, click, keyboard — goes through setOpen, so
// aria-expanded and the visual state can never disagree. That is why hover is
// wired in JS rather than left to a CSS :hover rule.
const isDesktopNav = window.matchMedia("(min-width: 769px)");

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
    const isPills = parent.classList.contains("area-list");
    const step = isPills ? 30 : 80;
    const cap = isPills ? 9 : 5;
    els.forEach((el, i) => {
      el.style.transitionDelay = `${Math.min(i, cap) * step}ms`;
    });
  });

  const observer = new IntersectionObserver(
    (entries) => {
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
}

// Header state is independent of the reveals — it must track scroll on every
// pass, so it stays on a cheap rAF-throttled listener.
function updateHeader() {
  headerQueued = false;
  if (!header) return;
  // Switch before the hero's white CTA bar slides under the transparent
  // header, which would otherwise leave white nav text on a white strip.
  const solid = heroMedia
    ? heroMedia.getBoundingClientRect().bottom <= header.offsetHeight
    : window.scrollY > 0;
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
