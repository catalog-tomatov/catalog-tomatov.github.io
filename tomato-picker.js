(function (root, factory) {
  const api = factory(typeof module !== 'undefined' && module.exports
    ? require('./tomato-traits-2627.js') : root.TOMATO_TRAITS_2627);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.TomatoPicker = api; api.mount(); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (traits) {
  'use strict';
  // Bind actual catalog IDs here when the new sowing varieties are published.
  // Sowing numbers and fuzzy name matches are never catalog identities.
  const newBindings = Object.freeze({});
  const features = [['colors', 3], ['size', 3], ['shapes', 2.5], ['habit', 1.5],
    ['maturity', 1], ['uses', 1], ['patterns', .75], ['growth', .5],
    ['flavourNotes', .5], ['texture', .5], ['extraTraits', .5]];
  const distanceCache = new Map();
  const profileFor = product => traits.getProfile(product.id, newBindings);
  function getEligibleProducts(products, cart, place) {
    const excluded = new Set(cart.map(p => String(p.id)));
    const excludedProfiles = new Set(cart.map(profileFor).filter(Boolean).map(p => p.key));
    const seen = new Set(), seenProfiles = new Set();
    return products.filter(p => {
      const id = String(p.id), profile = profileFor(p);
      if (p.available !== true || excluded.has(id) || seen.has(id) || !profile ||
          excludedProfiles.has(profile.key) || seenProfiles.has(profile.key) ||
          !traits.matchesGrowingPlace(profile, place)) return false;
      seen.add(id); seenProfiles.add(profile.key); return true;
    });
  }
  function validateCount(raw, availableCount) {
    const value = String(raw).trim();
    if (!/^\d+$/.test(value)) return { valid: false, message: 'Введите целое число сортов, минимум 10.' };
    const count = Number(value);
    if (!Number.isSafeInteger(count) || count < 10) return { valid: false, message: 'Минимум — 10 разных сортов томатов.' };
    if (count > availableCount) return { valid: false, message: `Для этого места доступно ${availableCount} разных сортов вне корзины.` };
    return { valid: true, count };
  }
  function diversityScore(first, second) {
    let score = 0, knownWeight = 0;
    for (const [field, weight] of features) {
      const left = first[field], right = second[field];
      if (left == null || right == null) continue;
      let distance;
      if (Array.isArray(left) || Array.isArray(right)) {
        if (!Array.isArray(left) || !Array.isArray(right) || !left.length || !right.length) continue;
        const union = new Set([...left, ...right]);
        distance = 1 - new Set(left.filter(x => right.includes(x))).size / union.size;
      } else if (field === 'maturity') {
        const order = { early: 0, mid: 1, late: 2 };
        if (!(left in order) || !(right in order)) continue;
        distance = Math.abs(order[left] - order[right]) / 2;
      } else distance = left === right ? 0 : 1;
      score += weight * distance; knownWeight += weight;
    }
    // Missing facts neither lower known differences nor claim extra novelty.
    return knownWeight ? score / knownWeight : .5;
  }
  function distance(first, second) {
    if (!first.key || !second.key) return diversityScore(first, second);
    const key = [first.key, second.key].sort().join('|');
    if (!distanceCache.has(key)) distanceCache.set(key, diversityScore(first, second));
    return distanceCache.get(key);
  }
  function candidateWeights(pool, selected, place, preferGrowth) {
    const wanted = place === 'greenhouse' ? 'indeterminate' : place === 'outdoor' ? 'determinate' : null;
    return pool.map(item => {
      const distances = selected.map(other => distance(item.profile, other.profile));
      const variety = distances.length ? .6 * Math.min(...distances) + .4 * distances.reduce((a, b) => a + b, 0) / distances.length : 0;
      // The full pool retains positive weight; no top-score cutoff or ID tie-break.
      const weight = 1 + variety;
      return preferGrowth && wanted && item.profile.growth === wanted ? weight * 40 : weight;
    });
  }
  function randomUnit(rng) {
    const value = rng();
    if (!Number.isFinite(value) || value < 0 || value >= 1) throw new RangeError('Invalid random source');
    return value;
  }
  function weightedPick(pool, weights, rng) {
    let needle = randomUnit(rng) * weights.reduce((a, b) => a + b, 0);
    for (let i = 0; i < pool.length; i++) { needle -= weights[i]; if (needle < 0) return pool[i]; }
    return pool[pool.length - 1];
  }
  function badges(product) {
    // Exactly the markers used by the existing catalog cards.
    return { isHit: product.isHit === true || String(product.title).includes('[hit]'),
      isNew: product.isNew === true || String(product.title).includes('[new]') };
  }
  function createPreview({ products, cart, place, count, cucumber, rng = Math.random }) {
    const eligible = getEligibleProducts(products, cart, place);
    const validation = validateCount(count, eligible.length);
    if (!validation.valid) throw new RangeError(validation.message);
    const pools = { hit: [], new: [], other: [] };
    eligible.forEach(product => {
      const group = traits.getCatalogGroup(badges(product));
      pools[group].push({ product, profile: profileFor(product), group });
    });
    const plan = traits.planQuotas(validation.count, Object.fromEntries(Object.entries(pools).map(([g, items]) => [g, items.length])));
    const selected = [], used = { hit: 0, new: 0, other: 0 };
    const wanted = place === 'greenhouse' ? 'indeterminate' : place === 'outdoor' ? 'determinate' : null;
    const desired = place === 'greenhouse' ? Math.floor(count * .6) + 1 : Math.ceil(count * .6);
    let preferred = 0;
    for (let step = 0; step < count; step++) {
      let group, bestLag = -Infinity;
      for (const name of traits.metadata.roundingPriority) {
        if (used[name] >= plan.actualCounts[name]) continue;
        const lag = plan.actualCounts[name] * (step + 1) / count - used[name];
        if (lag > bestLag) { bestLag = lag; group = name; }
      }
      const pool = pools[group];
      const item = weightedPick(pool, candidateWeights(pool, selected, place, preferred < desired), rng);
      selected.push(item); used[group]++; pool.splice(pool.indexOf(item), 1);
      if (wanted && item.profile.growth === wanted) preferred++;
    }
    const items = selected.map(item => ({ ...item.product }));
    let cucumberUnavailable = false;
    if (cucumber) {
      const names = new Set(traits.metadata.cucumberNames);
      const excluded = new Set(cart.map(p => String(p.id))), seen = new Set();
      const available = products.filter(p => {
        const id = String(p.id);
        if (p.available !== true || excluded.has(id) || seen.has(id) || !names.has(p.title)) return false;
        seen.add(id); return true;
      });
      if (available.length) items.push({ ...available[Math.floor(randomUnit(rng) * available.length)] });
      else cucumberUnavailable = true;
    }
    return { items, tomatoCount: selected.length, place, groupCounts: used,
      total: items.reduce((sum, p) => sum + Number(p.price), 0), cucumberUnavailable, consumed: false };
  }
  function addPreview(preview, products, cart, addToCart) {
    if (!preview || preview.consumed) return { ok: false, message: 'Этот набор уже добавлен.' };
    const fresh = new Map(products.map(p => [String(p.id), p]));
    const excluded = new Set(cart.map(p => String(p.id)));
    const ids = new Set();
    const items = [];
    for (const original of preview.items) {
      const id = String(original.id), product = fresh.get(id);
      if (!product || product.available !== true || excluded.has(id) || ids.has(id) ||
          Number(product.price) !== Number(original.price) || product.title !== original.title) {
        return { ok: false, message: 'Каталог или корзина изменились. Подберите набор ещё раз.' };
      }
      ids.add(id); items.push(product);
    }
    preview.consumed = true;
    items.forEach(product => addToCart(product, 1));
    return { ok: true };
  }

  function createInfoCard(closeInfo, returnFocus) {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'info-picker-card';
    const heading = document.createElement('span'); heading.className = 'info-picker-heading';
    const title = document.createElement('strong'); title.textContent = 'Подбери мне';
    const action = document.createElement('span'); action.className = 'info-picker-cta'; action.textContent = 'НАЖМИ';
    heading.append(title, action);
    const copy = document.createElement('span'); copy.className = 'info-picker-copy';
    copy.textContent = 'Если трудно выбрать, я помогу. Ответьте на три вопроса — подберём разные сорта для вашего набора.';
    button.append(heading, copy);
    button.addEventListener('click', () => { closeInfo(); open(returnFocus); });
    return button;
  }
  let dialog, state = { step: 0, place: '', countText: '', cucumber: null, preview: null }, focusReturn, previousOverflow;
  const $ = id => document.getElementById(id);
  function showError(message) {
    $('pickerError').textContent = message;
    $('pickerError').hidden = !message;
  }
  function capacity() { return state.place ? getEligibleProducts(products, cart, state.place).length : 0; }
  function renderStep() {
    showError('');
    document.querySelectorAll('[data-picker-step]').forEach(el => { el.hidden = Number(el.dataset.pickerStep) !== state.step; });
    $('pickerBack').hidden = state.step === 0;
    $('pickerProgress').textContent = state.step < 3 ? `Шаг ${state.step + 1} из 3` : 'Ваш набор';
    const titles = ['Где будете выращивать томаты?', 'Сколько сортов томатов подобрать?', 'Добавить огурец к набору?', 'Набор для вас'];
    $('pickerTitle').textContent = titles[state.step];
    document.querySelectorAll('[data-picker-place]').forEach(b => b.setAttribute('aria-pressed', String(state.place === b.dataset.pickerPlace)));
    document.querySelectorAll('[data-picker-cucumber]').forEach(b => b.setAttribute('aria-pressed', String(state.cucumber === (b.dataset.pickerCucumber === 'yes'))));
    $('pickerCount').value = state.countText;
    $('pickerCount').max = String(capacity());
    $('pickerCount').setAttribute('aria-invalid', 'false');
    $('pickerCapacity').textContent = `Доступно разных сортов вне корзины: ${capacity()}.`;
    $('pickerBuild').disabled = state.cucumber === null;
    $('pickerTitle').focus({ preventScroll: true });
    dialog.scrollTop = 0;
  }
  function open(returnFocus) {
    focusReturn = returnFocus || document.activeElement;
    previousOverflow = document.body.style.overflow;
    if (state.preview?.consumed) { state.preview = null; state.step = 0; }
    dialog.showModal(); document.body.style.overflow = 'hidden'; renderStep();
  }
  function renderPreview() {
    const container = $('pickerProducts'); container.replaceChildren();
    state.preview.items.forEach(product => {
      const source = Array.from(document.querySelectorAll('#catalog .product')).find(card => card.dataset.productId === String(product.id));
      if (!source) return;
      const card = source.cloneNode(true);
      card.className = 'picker-product'; card.removeAttribute('style');
      ['data-product-id', 'data-search', 'data-available', 'data-is-hit', 'data-is-new', 'aria-disabled'].forEach(a => card.removeAttribute(a));
      card.querySelectorAll('.product-number, .controls, .add-btn, .cart-stamp').forEach(el => el.remove());
      card.querySelector('.product-price').textContent = `${Number(product.price).toLocaleString('ru-RU')} ₽`;
      const details = document.createElement('details'), summary = document.createElement('summary'), description = document.createElement('p');
      details.className = 'picker-product-details';
      summary.appendChild(card); description.textContent = product.description;
      details.append(summary, description); container.appendChild(details);
    });
    $('pickerTotal').textContent = `${state.preview.total.toLocaleString('ru-RU')} ₽`;
    $('pickerResultNote').textContent = state.preview.cucumberUnavailable
      ? 'Доступных огурцов вне корзины сейчас нет. Подобрали томаты.'
      : `Томаты: ${state.preview.tomatoCount} сортов${state.preview.items.length > state.preview.tomatoCount ? ' и один огурец' : ''}. По одному пакету каждого.`;
    $('pickerAdd').disabled = false;
  }
  function build() {
    if (!catalogReady || document.querySelector('.header')?.classList.contains('season-closed')) {
      showError('Каталог пока недоступен. Попробуйте после загрузки.'); return;
    }
    const validation = validateCount(state.countText, capacity());
    if (!validation.valid) { state.step = 1; renderStep(); showError(validation.message); $('pickerCount').setAttribute('aria-invalid', 'true'); $('pickerCount').focus(); return; }
    try {
      state.preview = createPreview({ products, cart, place: state.place, count: validation.count, cucumber: state.cucumber });
      state.step = 3; renderStep(); renderPreview();
    } catch (error) { showError('Не удалось подобрать набор. Проверьте количество и попробуйте ещё раз.'); }
  }
  function mount() {
    dialog = $('tomatoPicker');
    const info = $('infoToggle');
    info.setAttribute('tabindex', '0'); info.setAttribute('role', 'button'); info.setAttribute('aria-label', 'Важная информация');
    info.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); info.click(); } });
    $('pickerClose').addEventListener('click', () => dialog.close());
    dialog.addEventListener('keydown', event => {
      if (event.key !== 'Tab') return;
      const focusable = Array.from(dialog.querySelectorAll('button:not(:disabled), input, summary, [tabindex="0"]')).filter(el => el.getClientRects().length);
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (!focusable.includes(document.activeElement) ||
          (event.shiftKey && document.activeElement === first) ||
          (!event.shiftKey && document.activeElement === last)) {
        event.preventDefault(); (event.shiftKey ? last : first)?.focus();
      }
    });
    dialog.addEventListener('close', () => { document.body.style.overflow = previousOverflow; if (focusReturn?.isConnected) focusReturn.focus({ preventScroll: true }); });
    dialog.addEventListener('click', event => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
    });
    $('pickerBack').addEventListener('click', () => { state.step = Math.max(0, state.step - 1); renderStep(); });
    document.querySelectorAll('[data-picker-place]').forEach(button => button.addEventListener('click', () => { state.place = button.dataset.pickerPlace; state.step = 1; renderStep(); $('pickerCount').focus(); }));
    $('pickerCount').addEventListener('input', () => { state.countText = $('pickerCount').value; showError(''); $('pickerCount').setAttribute('aria-invalid', 'false'); });
    $('pickerQuantityForm').addEventListener('submit', event => {
      event.preventDefault();
      const validation = validateCount(state.countText, capacity());
      if (!validation.valid) { showError(validation.message); $('pickerCount').setAttribute('aria-invalid', 'true'); $('pickerCount').focus(); return; }
      state.step = 2; renderStep();
    });
    document.querySelectorAll('[data-picker-cucumber]').forEach(button => button.addEventListener('click', () => { state.cucumber = button.dataset.pickerCucumber === 'yes'; renderStep(); button.focus(); }));
    $('pickerBuild').addEventListener('click', build);
    $('pickerReroll').addEventListener('click', build);
    $('pickerAdd').addEventListener('click', () => {
      if (!catalogReady || orderSending || readPendingOrderRequest()) { showError('Дождитесь завершения текущего действия с заказом.'); return; }
      const result = addPreview(state.preview, products, cart, addToCart);
      if (!result.ok) { showError(result.message); return; }
      $('pickerAdd').disabled = true; dialog.close(); showToast('🍅 Набор добавлен в корзину');
    });
  }
  return { getEligibleProducts, validateCount, diversityScore, candidateWeights, createPreview, addPreview, createInfoCard, mount };
});
