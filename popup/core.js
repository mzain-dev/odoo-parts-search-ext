// Shared by every popup mode: connection to the Odoo tab, screen switching,
// formatting and the row/list building blocks. Each mode file in
// popup/modes/ reads what it needs from window.PI and registers itself with
// PI.registerMode(); popup/main.js wires the mode toggle and startup.
(function () {
  const $ = (id) => document.getElementById(id);

  // odooTabId / odooOrigin track the Odoo tab currently in front (see
  // main.js checkOdooTab); activeType is the selected mode.
  const state = {
    odooTabId: null,
    odooOrigin: null, // e.g. https://digandlift.odoo.com - for "open in Odoo" links
    activeType: 'part',
    currentScreenKey: null // null until showScreen() runs for the first time
  };

  const screens = {
    notOdoo: $('not-odoo-screen'),
    error: $('error-screen'),
    part: $('part-mode'),
    customer: $('customer-mode'),
    landed: $('landed-mode'),
    stockouts: $('stockouts-mode')
  };
  const errorTextEl = $('error-text');

  function showScreen(name) {
    state.currentScreenKey = name;
    Object.entries(screens).forEach(([key, el]) => {
      if (el) el.style.display = key === name ? 'block' : 'none';
    });
  }

  function sendToOdoo(type, extra) {
    return new Promise((resolve) => {
      if (!state.odooTabId) {
        resolve({ ok: false, error: 'Not connected to your Odoo tab.' });
        return;
      }
      chrome.tabs.sendMessage(state.odooTabId, Object.assign({ type }, extra), (response) => {
        if (chrome.runtime.lastError) {
          resolve({
            ok: false,
            error: 'Could not reach Odoo tab. Try reloading the Odoo page and reopening this popup.'
          });
          return;
        }
        resolve(response || { ok: false, error: 'No response from Odoo tab.' });
      });
    });
  }

  function showFatalError(message) {
    errorTextEl.textContent = message;
    showScreen('error');
  }

  function debounce(fn, ms) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), ms);
    };
  }

  function num(n) {
    return (typeof n === 'number' ? n : 0).toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  // Purchases/sales span multiple currencies (OMR/USD/AED/...) - always show
  // which one an amount is actually in rather than a bare number.
  function formatMoney(amount, currency) {
    return currency ? `${num(amount)} ${currency}` : num(amount);
  }

  // "≈ X OMR" note for a non-OMR amount, or null when there's nothing useful
  // to add (already OMR, or the conversion couldn't be resolved).
  function omrNote(currency, amountOmr) {
    if (currency === 'OMR' || typeof amountOmr !== 'number') return null;
    return `≈ ${num(amountOmr)} OMR`;
  }

  function formatDate(str) {
    if (!str) return '—';
    return String(str).slice(0, 10);
  }

  function clear(el) {
    el.innerHTML = '';
  }

  function emptyNote(container, text) {
    clear(container);
    const p = document.createElement('p');
    p.className = 'empty-message';
    p.textContent = text;
    container.appendChild(p);
  }

  function copyToClipboard(text, btnEl) {
    const original = btnEl.textContent;
    navigator.clipboard.writeText(text).then(() => {
      btnEl.textContent = 'Copied!';
      btnEl.classList.add('copied');
      setTimeout(() => {
        btnEl.textContent = original;
        btnEl.classList.remove('copied');
      }, 1500);
    }).catch(() => {
      btnEl.textContent = 'Could not copy';
      setTimeout(() => { btnEl.textContent = original; }, 1500);
    });
  }

  function buildStatGrid(container, tiles) {
    clear(container);
    for (const t of tiles) {
      const tile = document.createElement('div');
      tile.className = 'stat-tile' + (t.highlight ? ' highlight' : '');
      const label = document.createElement('span');
      label.className = 'stat-label';
      label.textContent = t.label;
      const value = document.createElement('div');
      value.className = 'stat-value' + (t.small ? ' small' : '');
      value.textContent = t.value;
      if (t.badge) value.appendChild(t.badge);
      tile.appendChild(label);
      tile.appendChild(value);
      if (t.sub) {
        const sub = document.createElement('div');
        sub.className = 'stat-sub';
        sub.textContent = t.sub;
        tile.appendChild(sub);
      }
      container.appendChild(tile);
    }
  }

  function trendBadge(trend) {
    if (!trend || trend === 'insufficient_data') return null;
    const span = document.createElement('span');
    span.className = `trend-badge trend-${trend}`;
    span.textContent = trend;
    return span;
  }

  // Local (Omani vendor) vs Foreign (import) - foreign purchases are the
  // ones that can carry a landed cost (freight/duty); local ones normally
  // won't, so this badge explains at a glance why a landed-cost figure is or
  // isn't showing for a given purchase.
  function purchaseTypeBadge(type) {
    if (!type) return null;
    const span = document.createElement('span');
    span.className = `ptype-badge ptype-${type.toLowerCase()}`;
    span.textContent = type;
    return span;
  }

  // Returns the row element rather than appending it, so callers that need
  // to control placement (grouped sections, paginated lists) can do so;
  // lineRow() below is the append-directly convenience wrapper most call
  // sites still want.
  // A sub-line can be a plain string (neutral gray metadata) or
  // { text, tone } to carry semantic color - tone is one of
  // success/warning/info/danger/primary. Keeps status/insight text visually
  // prominent instead of every line reading as the same flat gray.
  function appendSubLine(parent, value) {
    if (!value) return;
    const isToned = typeof value === 'object';
    const el = document.createElement('div');
    el.className = 'line-row-sub' + (isToned && value.tone ? ` tone-${value.tone}` : '');
    el.textContent = isToned ? value.text : value;
    parent.appendChild(el);
  }

  // subLines: array of sub-line values (string or {text,tone}, falsy entries
  // skipped) - an array rather than fixed sub/sub2/sub3 params since some
  // rows need a variable number of status lines (delivery + invoice + a
  // late-landed-cost warning, for instance).
  function buildLineRow({ title, subLines, value, subValue, titleBadge }) {
    const row = document.createElement('div');
    row.className = 'line-row';
    const main = document.createElement('div');
    main.className = 'line-row-main';
    const t = document.createElement('div');
    t.className = 'line-row-title';
    t.textContent = title;
    if (titleBadge) {
      t.appendChild(document.createTextNode(' '));
      t.appendChild(titleBadge);
    }
    main.appendChild(t);
    for (const line of (subLines || [])) appendSubLine(main, line);
    const valWrap = document.createElement('div');
    valWrap.className = 'line-row-value';
    valWrap.textContent = value;
    appendSubLine(valWrap, subValue);
    row.appendChild(main);
    row.appendChild(valWrap);
    return row;
  }

  function lineRow(container, opts) {
    container.appendChild(buildLineRow(opts));
  }

  // Renders the first `pageSize` items plus a "Show N more" button that
  // reveals the next page in place - keeps long lists (purchase/sales
  // history, orders, top products) from all rendering at once.
  function renderExpandableList(container, items, buildRowFn, pageSize = 10) {
    let shown = Math.min(pageSize, items.length);

    function render() {
      clear(container);
      for (const item of items.slice(0, shown)) container.appendChild(buildRowFn(item));
      if (shown < items.length) {
        const remaining = items.length - shown;
        const btn = document.createElement('button');
        btn.className = 'show-more-btn';
        btn.textContent = `Show more (${remaining} more)`;
        btn.addEventListener('click', () => {
          shown = Math.min(shown + pageSize, items.length);
          render();
        });
        container.appendChild(btn);
      }
    }
    render();
  }

  function groupHeader(container, label, meta) {
    const header = document.createElement('div');
    header.className = 'group-header';
    const labelEl = document.createElement('span');
    labelEl.className = 'group-header-label';
    labelEl.textContent = label;
    header.appendChild(labelEl);
    if (meta) {
      const metaEl = document.createElement('span');
      metaEl.className = 'group-header-meta';
      metaEl.textContent = meta;
      header.appendChild(metaEl);
    }
    container.appendChild(header);
  }

  // Wires a .sort-bar's buttons to a callback and returns them, so the
  // active state can be reset (e.g. when a new part/customer is selected)
  // without re-attaching listeners.
  function wireSortBar(barEl, onSelect) {
    const buttons = Array.from(barEl.querySelectorAll('.sort-btn'));
    buttons.forEach((btn) => {
      btn.addEventListener('click', () => {
        buttons.forEach((b) => b.classList.toggle('active', b === btn));
        onSelect(btn.dataset.sort);
      });
    });
    return buttons;
  }

  function resetSortBar(buttons, sortValue) {
    buttons.forEach((b) => b.classList.toggle('active', b.dataset.sort === sortValue));
  }

  // ---------------- Rows that expand, and "open in Odoo" ----------------

  function openInOdoo(model, id) {
    if (!state.odooOrigin || !id) return;
    chrome.tabs.create({ url: `${state.odooOrigin}/web#id=${id}&model=${model}&view_type=form` });
  }

  function smallButton(label, onClick) {
    const btn = document.createElement('button');
    btn.className = 'show-more-btn';
    btn.textContent = label;
    btn.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    return btn;
  }

  function detailNote(container, text, tone) {
    const p = document.createElement('p');
    p.className = 'landed-detail-note' + (tone ? ` line-row-sub tone-${tone}` : '');
    p.textContent = text;
    container.appendChild(p);
    return p;
  }

  // A row that expands in place on click. The detail area is built the first
  // time it's opened (buildDetail may fetch from Odoo) and kept after that.
  // links: [{ label, model, id }] rendered as "Open ... in Odoo" buttons.
  function expandableRow(rowOpts, links, buildDetail) {
    const wrapper = document.createElement('div');
    const row = buildLineRow(rowOpts);
    row.classList.add('clickable-row');
    const detail = document.createElement('div');
    detail.className = 'customer-drilldown';
    detail.style.display = 'none';
    let built = false;
    row.addEventListener('click', () => {
      const opening = detail.style.display === 'none';
      detail.style.display = opening ? 'block' : 'none';
      if (!opening || built) return;
      built = true;
      const usable = (links || []).filter((l) => l.id && state.odooOrigin);
      if (usable.length) {
        const actions = document.createElement('div');
        actions.className = 'landed-detail-actions';
        for (const l of usable) actions.appendChild(smallButton(l.label, () => openInOdoo(l.model, l.id)));
        detail.appendChild(actions);
      }
      if (buildDetail) buildDetail(detail);
    });
    wrapper.appendChild(row);
    wrapper.appendChild(detail);
    return wrapper;
  }

  // Modes register { onShow, onEscape } hooks - see popup/main.js.
  const modes = {};
  function registerMode(name, hooks) {
    modes[name] = hooks || {};
  }

  window.PI = {
    $, state, modes, registerMode, showScreen, sendToOdoo, showFatalError,
    debounce, num, formatMoney, omrNote, formatDate, clear, emptyNote, copyToClipboard, buildStatGrid, trendBadge, purchaseTypeBadge, appendSubLine, buildLineRow, lineRow, renderExpandableList, groupHeader, wireSortBar, resetSortBar, openInOdoo, smallButton, detailNote, expandableRow
  };
})();
