/* Apply before CSS loads to avoid a flash; preference belongs to this device. */
(() => {
  'use strict';
  const key = 'nook-theme';
  const valid = value => ['system', 'light', 'dark'].includes(value);
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  let preference = 'system';
  try { const saved = localStorage.getItem(key); if (valid(saved)) preference = saved; } catch {}
  function apply() {
    const dark = preference === 'dark' || (preference === 'system' && system.matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#211e1b' : '#fbf7f2');
  }
  apply();
  system.addEventListener('change', apply);
  window.addEventListener('storage', event => {
    if (event.key !== key && event.key !== null) return;
    preference = valid(event.newValue) ? event.newValue : 'system';
    apply();
    const picker = document.getElementById('theme-preference');
    if (picker) picker.value = preference;
  });
  document.addEventListener('DOMContentLoaded', () => {
    const picker = document.getElementById('theme-preference');
    picker.value = preference;
    picker.addEventListener('change', () => {
      preference = valid(picker.value) ? picker.value : 'system';
      try { localStorage.setItem(key, preference); } catch {}
      apply();
    });
  });
})();
