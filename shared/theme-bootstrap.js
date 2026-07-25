(function () {
  try {
    var key = document.currentScript && document.currentScript.getAttribute('data-theme-key');
    if (!key) return;
    var theme = localStorage.getItem(key);
    document.documentElement.dataset.theme =
      theme === 'light' || theme === 'dark' ? theme : 'light';
  } catch (e) {}
})();
