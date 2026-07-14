const CACHE = 'todo-v2';

// ===== サーバー通知（Web Push）の設定（ページ側と同じ値） =====
const SUPABASE_URL = 'https://cihuqwuobvxwcaualnqm.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNpaHVxd3VvYnZ4d2NhdWFsbnFtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQwNDgxMDksImV4cCI6MjA5OTYyNDEwOX0._6azXkdBZBOlTgJjoY883owzERciIwLNiCnKKRlaNoU';
const VAPID_PUBLIC_KEY = 'BO-4D_QEtm_L1X15NbV_CMu7S2S_JfotEtTJaC78HD9t52O9G_SMjtKHY-5blrcPO36GJ4mVgcTjHiIe64Y_bTY';
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

// ===== 通知の中身 =====
function showNight(today) {
  return self.registration.showNotification('🌙 明日の準備', {
    body: '明日のやることリストを作りましょう',
    tag: 'night-' + today,
    icon: './icon-192.png',
    badge: './icon-192.png',
    data: { url: './index.html?view=tomorrow' }
  });
}

function showMorning(today, lists) {
  const items = lists[today] || [];
  const title = items.length ? `☀️ 今日やること（${items.length}件）` : '☀️ おはようございます';
  const body = items.length
    ? items.slice(0, 4).map(i => '・' + i.text).join('\n') + (items.length > 4 ? `\n…他${items.length - 4}件` : '')
    : '今日のリストはまだありません';
  return self.registration.showNotification(title, {
    body,
    tag: 'morning-' + today,
    icon: './icon-192.png',
    badge: './icon-192.png',
    data: { url: './index.html?view=today' }
  });
}

// ===== ローカルチェック：時間を過ぎていたら通知を出す（サーバー通知の保険） =====
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
    await showNight(today);
  } else if (hm >= settings.morning && hm < settings.night && notified.morning !== today) {
    notified.morning = today;
    await kvSet('notified', notified);
    await showMorning(today, lists);
  }
}

// ===== サーバーからのプッシュ通知（時間ぴったりに届く） =====
self.addEventListener('push', e => {
  let data = {};
  try { data = e.data.json(); } catch (err) {}
  e.waitUntil((async () => {
    const today = dayKey();
    const notified = (await kvGet('notified')) || {};
    if (data.type === 'night') {
      notified.night = today; // ローカルチェックと二重にならないように
      await kvSet('notified', notified);
      await showNight(today);
    } else if (data.type === 'morning') {
      notified.morning = today;
      await kvSet('notified', notified);
      const lists = (await kvGet('lists')) || {};
      await showMorning(today, lists);
    } else {
      await checkAndNotify();
    }
  })());
});

// 購読が無効化されたら自動で登録し直す
self.addEventListener('pushsubscriptionchange', e => {
  e.waitUntil((async () => {
    const sub = await self.registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: Uint8Array.from(
        [...atob((VAPID_PUBLIC_KEY + '='.repeat((4 - VAPID_PUBLIC_KEY.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/'))].map(c => c.charCodeAt(0))
      )
    });
    const j = sub.toJSON();
    const settings = (await kvGet('settings')) || { night: '21:00', morning: '07:00' };
    const next = hm => {
      const [h, m] = hm.split(':').map(Number);
      const d = new Date();
      d.setHours(h, m, 0, 0);
      if (d <= new Date()) d.setDate(d.getDate() + 1);
      return d.toISOString();
    };
    await fetch(SUPABASE_URL + '/rest/v1/push_subscriptions?on_conflict=endpoint', {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates,return=minimal'
      },
      body: JSON.stringify({
        endpoint: sub.endpoint,
        p256dh: j.keys.p256dh,
        auth: j.keys.auth,
        next_night_at: next(settings.night),
        next_morning_at: next(settings.morning),
        updated_at: new Date().toISOString()
      })
    });
  })());
});

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
