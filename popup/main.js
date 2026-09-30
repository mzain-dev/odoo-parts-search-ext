// Startup and mode switching. Tracks which Odoo tab is in front (the popup
// can also run as a side panel, which stays open across tab switches) and
// calls each mode's onShow / onEscape hooks registered in popup/modes/.
(function () {
  const { $, state, modes, showScreen } = window.PI;

  const searchTypeToggleEl = document.querySelector('.search-type-toggle');
  const typeButtons = Array.from(document.querySelectorAll('.type-btn'));
  const errorBackBtn = $('error-back-btn');

  function showActiveMode() {
    showScreen(state.activeType);
    const hooks = modes[state.activeType];
    if (hooks && hooks.onShow) hooks.onShow();
  }

  typeButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.type === state.activeType) return;
      state.activeType = btn.dataset.type;
      typeButtons.forEach((b) => b.classList.toggle('active', b === btn));
      showActiveMode();
    });
  });

  errorBackBtn.addEventListener('click', () => showScreen(state.activeType));

  // Re-checks which tab is active and updates the connection accordingly.
  // Called once on load, and again on every tab switch/navigation - a side
  // panel (unlike a popup) stays open across those, so it must keep tracking
  // whichever tab is actually in front rather than freezing on whatever was
  // true when it first opened.
  function checkOdooTab() {
    const manifest = chrome.runtime.getManifest();
    const patterns =
      (manifest.content_scripts && manifest.content_scripts[0] && manifest.content_scripts[0].matches) || [];

    chrome.tabs.query({ active: true, currentWindow: true, url: patterns }, (tabs) => {
      const tab = tabs && tabs[0];
      if (!tab) {
        state.odooTabId = null;
        searchTypeToggleEl.style.display = 'none';
        showScreen('notOdoo');
        return;
      }

      // Jump to the mode screen on the very first load, or if we were
      // previously disconnected/errored - but if the user was already
      // mid-search on one Odoo tab and switches to a second Odoo tab, leave
      // their in-progress view alone instead of wiping it on every switch.
      const key = state.currentScreenKey;
      const wasDisconnected = key === null || key === 'notOdoo' || key === 'error';

      state.odooTabId = tab.id;
      try { state.odooOrigin = tab.url ? new URL(tab.url).origin : null; } catch (err) { state.odooOrigin = null; }
      searchTypeToggleEl.style.display = 'flex';
      if (wasDisconnected) showActiveMode();
    });
  }

  // Neither listener reads the tab's URL beyond changeInfo.url - checkOdooTab()
  // re-resolves the active tab itself via the same host-permission-scoped
  // query used on load, so no extra "tabs" permission is needed.
  chrome.tabs.onActivated.addListener(() => checkOdooTab());
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (tab.active && changeInfo.url) checkOdooTab();
  });

  // Escape backs out of whichever detail view the current mode has open.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const hooks = modes[state.activeType];
    if (hooks && hooks.onEscape) hooks.onEscape();
  });

  checkOdooTab();
})();
