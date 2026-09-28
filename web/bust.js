(async () => {
  try {
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
  } catch (err) {
    console.warn('could not fully clear:', err);
  }
  // replace(), so going back does not land here again.
  sessionStorage.setItem('pwa-kit:updated', '1');
  location.replace('/');
})();
