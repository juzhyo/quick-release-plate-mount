(() => {
  const variantEl = document.getElementById('variant');
  const countryEl = document.getElementById('dest-country');
  const postalEl = document.getElementById('dest-postal');
  const getRatesBtn = document.getElementById('get-rates');
  const ratesBox = document.getElementById('rate-options');
  const checkoutBtn = document.getElementById('checkout');
  const statusEl = document.getElementById('buybar-status');

  // This script is loaded on every page, but the buy bar only exists on pages
  // that sell. Bail out early rather than throwing on a null element.
  if (!variantEl || !countryEl || !postalEl || !getRatesBtn || !ratesBox || !checkoutBtn || !statusEl) {
    return;
  }

  let selectedQuoteId = null;

  function setStatus(msg) { statusEl.textContent = msg || ''; }

  // ---- Hide / reveal the bar on scroll -------------------------------------
  // Hidden while the buyer reads the top of the page; revealed once they start
  // moving down, or as soon as the buy section itself comes into view. Scrolling
  // back up near the top tucks it away again so the hero stays uncluttered.
  const bar = document.querySelector('.buybar');
  const REVEAL_AFTER_PX = 220;   // past the hero, on any screen
  let lastY = window.scrollY;
  let ticking = false;

  function setBarVisible(visible) {
    if (!bar) return;
    bar.dataset.visible = visible ? 'true' : 'false';
  }

  // Only now that the script is definitely running do we let CSS hide the bar.
  // Until this point `html.no-js` keeps it visible, so a JS failure can never
  // leave the buy bar unreachable.
  document.documentElement.classList.remove('no-js');

  function updateBar() {
    const y = window.scrollY;
    const goingDown = y > lastY;
    const nearTop = y < REVEAL_AFTER_PX;

    // A programmatic jump to the buy point always wins while it is settling.
    // Without this, the direction logic can hide the bar mid-flight on a long
    // smooth scroll and the buyer arrives at a hidden bar.
    if (forceVisible) {
      setBarVisible(true);
      lastY = y;
      ticking = false;
      return;
    }

    const show = buySectionIsVisible() || (!nearTop && goingDown);

    setBarVisible(show);

    lastY = y;
    ticking = false;
  }

  // Cleared once a jump has settled (or the buyer scrolls by hand again).
  let forceVisible = false;

  // How far the purchase area is from the top of the DOCUMENT, measured on a
  // clone position rather than the sticky element itself. Measuring the sticky
  // bar's own getBoundingClientRect always reports "on screen" because it is
  // pinned to the viewport - that self-reference makes it useless as a signal.
  let buySectionDocTop = null;

  function measureBuySection() {
    const target = document.getElementById('buy');
    if (!target) { buySectionDocTop = null; return; }
    // Temporarily neutralise sticky so we get the element's true document offset.
    const prev = target.style.position;
    const prevVis = target.style.visibility;
    target.style.position = 'static';
    target.style.visibility = 'hidden';
    const top = target.getBoundingClientRect().top + window.scrollY;
    target.style.position = prev;
    target.style.visibility = prevVis;
    buySectionDocTop = top;
  }

  function buySectionIsVisible() {
    if (buySectionDocTop === null) return false;
    const viewportBottomDoc = window.scrollY + window.innerHeight;
    // Reveal once the top of the purchase area is within ~1 viewport of the fold.
    return viewportBottomDoc >= buySectionDocTop - window.innerHeight * 0.25;
  }

  window.addEventListener('scroll', () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(updateBar);
  }, { passive: true });

  // A deliberate wheel/touch drag hands control back to the scroll logic.
  ['wheel', 'touchmove'].forEach((evt) => {
    window.addEventListener(evt, () => { forceVisible = false; }, { passive: true });
  });

  window.addEventListener('resize', () => {
    measureBuySection();
    updateBar();
  }, { passive: true });

  measureBuySection();

  // Any explicit Buy link (nav button, hero CTA) scrolls to the point where the
  // bar lives and reveals it. The bar is sticky and parked at the document
  // bottom alongside the footer, so "the instance where the footer appears" is
  // simply the end of the page - there is no separate fixed buy offset.
  function goToBuy(e) {
    if (e) e.preventDefault();

    // Scroll to the very bottom (clamped to the real max scroll, which lets us
    // land precisely rather than relying on the browser's own anchor maths).
    const maxScroll = Math.max(0, document.body.scrollHeight - window.innerHeight);
    window.scrollTo({
      top: maxScroll,
      behavior: prefersReducedMotion() ? 'auto' : 'smooth'
    });

    // Reveal immediately rather than waiting for the scroll to settle, so the
    // bar is already in place as the page arrives. forceVisible stops the
    // scroll handler from hiding it again mid-flight.
    forceVisible = true;
    setBarVisible(true);

    // Released once we have arrived (or after a short grace period, in case the
    // scroll is interrupted and 'scrollend' never fires).
    clearTimeout(window.__buySettle);
    window.__buySettle = setTimeout(() => { forceVisible = false; }, 900);
  }

  function prefersReducedMotion() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  document.querySelectorAll('a[href="#buy"]').forEach((link) => {
    link.addEventListener('click', goToBuy);
  });

  // Someone landing on /#buy directly should get the same treatment.
  if (window.location.hash === '#buy') {
    requestAnimationFrame(() => goToBuy(null));
  }

  setBarVisible(false);
  updateBar();

  // A quote is cached server-side against the variant it was priced for, so
  // switching kits invalidates it — make the buyer re-fetch rather than let
  // them check out and hit a server-side rejection.
  function invalidateQuote(msg) {
    selectedQuoteId = null;
    checkoutBtn.disabled = true;
    ratesBox.innerHTML = '';
    if (msg) setStatus(msg);
  }

  variantEl.addEventListener('change', () => {
    invalidateQuote('Kit changed — get shipping again for this kit.');
  });

  getRatesBtn.addEventListener('click', async () => {
    if (!postalEl.value.trim()) {
      setStatus('Enter a postal code to get shipping quotes.');
      return;
    }
    setStatus('Fetching live courier rates…');
    ratesBox.innerHTML = '';
    checkoutBtn.disabled = true;
    selectedQuoteId = null;

    try {
      const res = await fetch('/api/shipping-rates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          destinationCountry: countryEl.value,
          destinationPostal: postalEl.value.trim(),
          variant: variantEl.value
        })
      });

      if (!res.ok) throw new Error('rate lookup failed');
      const data = await res.json();

      if (!data.quotes || data.quotes.length === 0) {
        setStatus("No couriers currently serve that address — email us and we'll sort it manually.");
        return;
      }

      data.quotes.forEach((q, i) => {
        const id = `rate-${i}`;
        const label = document.createElement('label');
        label.innerHTML = `
          <input type="radio" name="rate" value="${q.quoteId}" ${i === 0 ? 'checked' : ''}>
          ${q.carrier} ${q.service} — ${q.currency} ${q.amount.toFixed(2)} (${q.etaDays}d)
        `;
        ratesBox.appendChild(label);
      });

      selectedQuoteId = data.quotes[0].quoteId;
      ratesBox.querySelectorAll('input[name="rate"]').forEach(input => {
        input.addEventListener('change', (e) => { selectedQuoteId = e.target.value; });
      });

      checkoutBtn.disabled = false;
      setStatus('Rates from courier partners — prices confirmed at checkout.');
    } catch (err) {
      console.error(err);
      setStatus("Couldn't reach the shipping service. Please try again.");
    }
  });

  checkoutBtn.addEventListener('click', async () => {
    if (!selectedQuoteId) return;
    checkoutBtn.disabled = true;
    setStatus('Redirecting to secure checkout…');

    try {
      const res = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          variant: variantEl.value,
          quoteId: selectedQuoteId
        })
      });

      if (!res.ok) throw new Error('checkout session creation failed');
      const { url } = await res.json();
      window.location.href = url;
    } catch (err) {
      console.error(err);
      setStatus("Checkout couldn't start. Please try again or email support.");
      checkoutBtn.disabled = false;
    }
  });
})();
