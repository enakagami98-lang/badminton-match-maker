const CACHE = 'todo-v1';
const FILES = ['./index.html', './manifest.json', './icon-192.png', './icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request))
  );
});

// ===== IndexedDB（ページ側と共有） =====
function idb() {
  return new Promise((res, rej) => {
    const req = indexedDB.open('daily-todo', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}
function kvGet(key) {
  return idb().then(db => new Promise((res, rej) => {
    const r = db.transaction('kv').objectStore('kv').get(key);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
}
function kvSet(key, val) {
  return idb().then(db => new Promise((res, rej) => {
    const r = db.transaction('kv', 'readwrite').objectStore('kv').put(val, key);
    r.onsuccess = () => res();
    r.onerror = () => rej(r.error);
  }));
}

// 深夜3時までは「前日」として扱う（ページ側と同じルール）
function dayKey(offsetDays = 0) {
  const d = new Date(Date.now() - 3 * 3600 * 1000 + offsetDays * 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ===== 時間になったら通知を出す =====
async function checkAndNotify() {
  const settings = (await kvGet('settings')) || { night: '21:00', morning: '07:00' };
  const notified = (await kvGet('notified')) || {};
  const lists = (await kvGet('lists')) || {};
  const today = dayKey();
  const now = new Date();
  const hm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  if (hm >= settings.night && notified.night !== today) {
    notified.night = today;
    await kvSet('notified', notified);
    await self.registration.showNotification('🌙 明日の準備', {
      body: '明日のやることリストを作りましょう',
      tag: 'night-' + today,
      icon: './icon-192.png',
      badge: './icon-192.png',
      data: { url: './index.html?view=tomorrow' }
    });
  } else if (hm >= settings.morning && hm < settings.night && notified.morning !== today) {
    notified.morning = today;
    await kvSet('notified', notified);
    const items = lists[today] || [];
    const title = items.length ? `☀️ 今日やること（${items.length}件）` : '☀️ おはようございます';
    const body = items.length
      ? items.slice(0, 4).map(i => '・' + i.text).join('\n') + (items.length > 4 ? `\n…他${items.length - 4}件` : '')
      : '今日のリストはまだありません';
    await self.registration.showNotification(title, {
      body,
      tag: 'morning-' + today,
      icon: './icon-192.png',
      badge: './icon-192.png',
      data: { url: './index.html?view=today' }
    });
  }
}

self.addEventListener('message', e => {
  if (e.data === 'check') e.waitUntil(checkAndNotify());
});

self.addEventListener('periodicsync', e => {
  if (e.tag === 'todo-check') e.waitUntil(checkAndNotify());
});

// 通知タップでアプリを開く
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || './index.html', self.location.href).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if (w.url.startsWith(self.registration.scope)) {
        try { await w.navigate(url); } catch (err) {}
        return w.focus();
      }
    }
    return self.clients.openWindow(url);
  })());
});
