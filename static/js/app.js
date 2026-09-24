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

    // The purchase section always wins: if it is on screen the buyer is looking
    // at the form, regardless of which way they scrolled to get there. This also
    // covers programmatic jumps (anchor links, scrollIntoView) where the
    // direction of travel is not meaningful.
    const show = buySectionIsVisible() || (!nearTop && goingDown);

    setBarVisible(show);

    lastY = y;
    ticking = false;
  }

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

  window.addEventListener('resize', () => {
    measureBuySection();
    updateBar();
  }, { passive: true });

  measureBuySection();

  // Any explicit Buy link should also reveal the bar immediately.
  document.querySelectorAll('a[href="#buy"]').forEach((link) => {
    link.addEventListener('click', () => setBarVisible(true));
  });

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
