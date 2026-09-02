import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { StoreProvider } from './lib/store';
import { requestPersistence } from './lib/idb';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <StoreProvider>
      <App />
    </StoreProvider>
  </StrictMode>,
);

// Ask the browser to keep our cached audio around under storage pressure.
void requestPersistence();

/*
 * The studio is served from this machine and needs no offline cache — a
 * service worker can only make it stale, which one once did: an old shell
 * kept showing after a rebuild. Any worker an earlier build left on this
 * origin is torn down, along with its caches.
 */
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  void navigator.serviceWorker.getRegistrations().then((regs) => {
    for (const reg of regs) void reg.unregister();
  });
  if ('caches' in window) {
    void caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k))));
  }
}
