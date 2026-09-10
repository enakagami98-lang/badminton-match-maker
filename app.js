// ===== STATE =====
let state = {
  players: [],          // { id, active }
  courts: 0,
  matchIndex: 0,
  matches: [],          // [{ courts:[{back:[a,b], front:[c,d]}], rest:[], results:[null|'back'|'front'] }]
  wins: {},             // { playerId: wins }
  games: {},            // { playerId: games }
  pairHistory: {},      // "a-b" -> count (ペア履歴)
  opponentHistory: {},  // "a-b" -> count (対戦相手履歴)
  restHistory: [],      // per match: [playerId, ...]
  viewingIndex: 0,
};

function save() {
  try { localStorage.setItem('bm_state', JSON.stringify(state)); } catch(e) {}
}
function load() {
  try {
    const s = localStorage.getItem('bm_state');
    if (s) { state = JSON.parse(s); return true; }
  } catch(e) {}
  return false;
}

// ===== SETUP =====
function adjustSetup(type, delta) {
  const el = document.getElementById('input-' + (type === 'players' ? 'players' : 'courts'));
  let v = parseInt(el.value) || 0;
  if (type === 'players') v = Math.max(4, Math.min(40, v + delta));
  else v = Math.max(1, Math.min(10, v + delta));
  el.value = v;
}

function startGame() {
  const n = parseInt(document.getElementById('input-players').value) || 12;
  const c = parseInt(document.getElementById('input-courts').value) || 3;
  if (n < 4) { showToast('参加者は4名以上必要です'); return; }
  if (c < 1) { showToast('コートは1面以上必要です'); return; }

  state = {
    players: Array.from({length: n}, (_, i) => ({ id: i + 1, active: true })),
    courts: c,
    matchIndex: 0,
    matches: [],
    wins: {},
    games: {},
    pairHistory: {},
    opponentHistory: {},
    lastPlayedMatchIndex: {}, // 各プレイヤーが最後に出た試合番号
    restHistory: [],
    viewingIndex: 0,
  };
  for (let i = 1; i <= n; i++) { state.wins[i] = 0; state.games[i] = 0; state.lastPlayedMatchIndex[i] = -1; }

  generateNextMatch();
  save();
  showScreen('match');
  renderMatch();
}

// ===== MATCH GENERATION =====
function getActivePlayers() {
  return state.players.filter(p => p.active).map(p => p.id);
}

function generateNextMatch() {
  const active = getActivePlayers();
  const maxCourts = Math.min(state.courts, Math.floor(active.length / 4));
  const playing = maxCourts * 4;
  const restCount = active.length - playing;

  // Decide who rests
  let rest = [];
  if (restCount > 0) {
    // 1コート・8人以上 → 直前に出た人を強制休みにする厳格モード
    if (maxCourts === 1 && active.length >= 8) {
      rest = selectRestOneCourt(active, restCount);
    } else {
      // 複数コート → 従来ロジック（連続休みを避ける）
      const lastRest = state.restHistory.length > 0 ? state.restHistory[state.restHistory.length - 1] : [];
      const notLastRest = active.filter(p => !lastRest.includes(p));
      const candidates = notLastRest.length >= restCount ? notLastRest : active;
      rest = shuffle([...candidates]).slice(0, restCount);
    }
  }
  state.restHistory.push(rest);

  const playingPlayers = active.filter(p => !rest.includes(p));
  const shuffled = shuffle([...playingPlayers]);

  // Assign to courts trying to avoid repeated pairs
  const courtAssignments = assignCourts(shuffled, maxCourts);

  const match = {
    courts: courtAssignments,
    rest: rest,
    results: Array(maxCourts).fill(null),
  };
  state.matches.push(match);
  state.matchIndex = state.matches.length - 1;
  state.viewingIndex = state.matchIndex;
}

function assignCourts(players, numCourts) {
  let best = null;
  let bestScore = Infinity;

  for (let attempt = 0; attempt < 300; attempt++) {
    const arr = shuffle([...players]);
    let score = 0;
    const courts = [];
    for (let i = 0; i < numCourts; i++) {
      const back  = [arr[i*4],   arr[i*4+1]];
      const front = [arr[i*4+2], arr[i*4+3]];
      const group4 = [arr[i*4], arr[i*4+1], arr[i*4+2], arr[i*4+3]];

      // ペア重複ペナルティ
      score += getPairScore(back[0], back[1]) + getPairScore(front[0], front[1]);
      // 同じ4人が同コートに連続で入るペナルティ（最重要）
      score += getGroupScore(group4) * 20;
      // 対戦相手重複ペナルティ
      score += getOpponentScore(back, front);

      courts.push({ back, front });
    }
    if (score < bestScore) {
      bestScore = score;
      best = courts;
    }
    if (score === 0) break;
  }
  return best;
}

// 同じ4人組が直近2試合で同コートにいたか
function getGroupScore(group4) {
  if (state.matches.length === 0) return 0;
  const sorted = [...group4].sort((a,b) => a-b).join('-');
  let score = 0;
  const checkCount = Math.min(2, state.matches.length);
  for (let i = 0; i < checkCount; i++) {
    const match = state.matches[state.matches.length - 1 - i];
    for (const court of match.courts) {
      const g = [...court.back, ...court.front].sort((a,b) => a-b).join('-');
      if (g === sorted) score += (i === 0) ? 1 : 0.3;
    }
  }
  return score;
}

function getPairScore(a, b) {
  const key = [a, b].sort((x, y) => x - y).join('-');
  return state.pairHistory[key] || 0;
}

// 対戦相手（ネット越し）の重複スコア
function getOpponentScore(back, front) {
  let score = 0;
  back.forEach(a => front.forEach(b => {
    const key = [a,b].sort((x,y)=>x-y).join('-');
    score += (state.opponentHistory[key] || 0) * 0.5;
  }));
  return score;
}

// ===== 1コート厳格休み選択 =====
// 直前に出た人を強制休みにし、連続出場を防ぐ
function selectRestOneCourt(active, restCount) {
  if (state.matches.length === 0) {
    // 初戦: 休み履歴なし → シャッフルで選ぶ
    return shuffle([...active]).slice(0, restCount);
  }

  const lastMatch = state.matches[state.matches.length - 1];
  // 直前の試合に出た全プレイヤー
  const lastPlayed = [...new Set(lastMatch.courts.flatMap(c => [...c.back, ...c.front]))]
    .filter(p => active.includes(p));
  const canPlay = active.filter(p => !lastPlayed.includes(p));

  if (canPlay.length >= 4) {
    // ===== 厳格モード: lastPlayedは全員休み =====
    const extraNeeded = restCount - lastPlayed.length;
    let extra = [];
    if (extraNeeded > 0) {
      // canPlayの中から追加で休む人を選ぶ（前回休んだ人は除外優先）
      const lastRested = state.restHistory.length > 0 ? state.restHistory[state.restHistory.length - 1] : [];
      const notRestedLast = canPlay.filter(p => !lastRested.includes(p));
      const restedLast    = canPlay.filter(p =>  lastRested.includes(p));
      if (notRestedLast.length >= extraNeeded) {
        extra = shuffle([...notRestedLast]).slice(0, extraNeeded);
      } else {
        extra = [...notRestedLast, ...shuffle([...restedLast]).slice(0, extraNeeded - notRestedLast.length)];
      }
    } else if (extraNeeded < 0) {
      // lastPlayedが多すぎる（複数コートから1コートへの移行時など）
      // 最近出た順に多く休ませる
      const sorted = [...lastPlayed].sort((a, b) =>
        (state.lastPlayedMatchIndex[b] ?? -1) - (state.lastPlayedMatchIndex[a] ?? -1)
      );
      return sorted.slice(0, restCount);
    }
    return [...lastPlayed, ...extra];
  } else {
    // ===== フォールバック: 人が足りず完全回避不可 =====
    // canPlay全員を出場させ、lastPlayedから「最も長く休んでいた人」を優先して出場
    const forcedPlay = 4 - canPlay.length;
    const sortedLastPlayed = [...lastPlayed].sort((a, b) =>
      (state.lastPlayedMatchIndex[a] ?? -1) - (state.lastPlayedMatchIndex[b] ?? -1) // 長く休んだ順
    );
    const forcedToPlay = sortedLastPlayed.slice(0, forcedPlay);
    const mustRest     = sortedLastPlayed.slice(forcedPlay);
    const needFromCanPlay = restCount - mustRest.length;
    const extraRest = needFromCanPlay > 0 ? shuffle([...canPlay]).slice(0, needFromCanPlay) : [];
    return [...mustRest, ...extraRest];
  }
}

// ペア・対戦相手の履歴を記録
function recordMatchHistory(courts) {
  const matchIdx = state.matchIndex;
  if (!state.lastPlayedMatchIndex) state.lastPlayedMatchIndex = {};
  courts.forEach(c => {
    incPair(c.back[0], c.back[1]);
    incPair(c.front[0], c.front[1]);
    // 出場記録を更新
    [...c.back, ...c.front].forEach(p => {
      state.lastPlayedMatchIndex[p] = matchIdx;
    });
    c.back.forEach(a => c.front.forEach(b => {
      const key = [a,b].sort((x,y)=>x-y).join('-');
      state.opponentHistory[key] = (state.opponentHistory[key] || 0) + 1;
    }));
  });
}

function incPair(a, b) {
  const key = [a, b].sort((x, y) => x - y).join('-');
  state.pairHistory[key] = (state.pairHistory[key] || 0) + 1;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ===== RENDER =====
function renderMatch() {
  const match = state.matches[state.viewingIndex];
  if (!match) return;

  const isLatest = state.viewingIndex === state.matchIndex;
  document.getElementById('match-title').textContent = `${state.viewingIndex + 1}試合目`;

  // Stats
  const active = getActivePlayers();
  const restCount = match.rest.length;
  const statsEl = document.getElementById('match-stats');
  statsEl.innerHTML = `
    <div class="stat-item">
      <div class="stat-icon">👥</div>
      <div class="stat-label">参加人数</div>
      <div><span class="stat-value">${state.players.filter(p=>p.active).length}</span><span class="stat-unit">名</span></div>
    </div>
    <div class="stat-item">
      <div class="stat-icon">🏟</div>
      <div class="stat-label">コート数</div>
      <div><span class="stat-value">${match.courts.length}</span><span class="stat-unit">面</span></div>
    </div>
    <div class="stat-item">
      <div class="stat-icon">☕</div>
      <div class="stat-label">休み</div>
      <div><span class="stat-value">${restCount}</span><span class="stat-unit">名</span></div>
    </div>
  `;

  // Courts
  const grid = document.getElementById('courts-grid');
  grid.innerHTML = '';
  grid.className = 'courts-grid' + (match.courts.length === 1 ? ' single' : '');

  match.courts.forEach((court, i) => {
    const result = match.results[i];
    const decided = result !== null;
    const div = document.createElement('div');
    div.className = 'court-card' + (decided ? ' decided' : '');
    div.style.animationDelay = (i * 0.05) + 's';

    const backWin = result === 'back';
    const frontWin = result === 'front';

    div.innerHTML = `
      <div class="court-header">コート ${i + 1}</div>
      <div class="court-body">
        <div class="court-field">
          <div class="field-side">
            <div class="field-side-label">奥側ペア</div>
            <div class="field-players">
              <div class="player-num ${backWin ? 'winner' : ''}">${court.back[0]}</div>
              <div class="player-num ${backWin ? 'winner' : ''}">${court.back[1]}</div>
            </div>
          </div>
          <div class="court-net">
            <div class="net-post"></div>
            <div class="net-line"></div>
            <div class="vs-badge">VS</div>
            <div class="net-line"></div>
            <div class="net-post"></div>
          </div>
          <div class="field-side">
            <div class="field-side-label">手前ペア</div>
            <div class="field-players">
              <div class="player-num ${frontWin ? 'winner' : ''}">${court.front[0]}</div>
              <div class="player-num ${frontWin ? 'winner' : ''}">${court.front[1]}</div>
            </div>
          </div>
        </div>
        ${isLatest ? `
        <div class="court-win-btns">
          <button class="btn-win ${backWin ? 'selected' : ''}" onclick="recordWin(${i}, 'back')">奥側ペアが勝ち</button>
          <button class="btn-win ${frontWin ? 'selected' : ''}" onclick="recordWin(${i}, 'front')">手前ペアが勝ち</button>
        </div>
        ${decided ? '<div class="decided-badge">✅ 結果登録済み</div>' : '<div style="text-align:center;margin-top:6px;font-size:11px;color:#bbb">勝ったペアを選択</div>'}
        ` : `
        ${decided ? '<div class="decided-badge">✅ ' + (backWin ? '奥側ペアが勝ち' : '手前ペアが勝ち') + '</div>' : '<div style="text-align:center;margin-top:8px;font-size:11px;color:#bbb">未登録</div>'}
        `}
      </div>
    `;
    grid.appendChild(div);
  });

  // Rest
  const restEl = document.getElementById('rest-section');
  if (match.rest.length > 0) {
    restEl.style.display = 'block';
    restEl.innerHTML = `
      <div class="rest-header">
        <div class="rest-title">☕ 今回の休み（${match.rest.length}名）</div>
        <div class="rest-hint">🔄 休む人は毎回変わるように自動調整されます</div>
      </div>
      <div class="rest-players">
        ${match.rest.map(p => `<div class="rest-player">${p}</div>`).join('')}
      </div>
    `;
  } else {
    restEl.style.display = 'none';
  }

  // Ranking
  renderRanking();
}

function renderRanking() {
  const el = document.getElementById('ranking-section');
  const ranked = getRanked();
  const top3 = ranked.slice(0, 3);
  const rest = ranked.slice(3);

  const crowns = ['👑', '🥈', '🥉'];
  const rankClass = ['rank1', 'rank2', 'rank3'];
  const rankLabel = ['1位', '2位', '3位'];

  let top3HTML = top3.map((p, i) => `
    <div class="top3-item ${rankClass[i]}">
      <div class="top3-crown">${crowns[i]}</div>
      <div class="top3-rank">${rankLabel[i]}</div>
      <div class="top3-num">${p.id}</div>
      <div class="top3-rate">勝率 ${p.rate.toFixed(3)}</div>
      <div class="top3-record">${p.wins}勝 / ${p.losses}敗</div>
    </div>
  `).join('');

  let listHTML = rest.map((p, i) => `
    <div class="rank-row">
      <div class="rank-pos">${i + 4}位</div>
      <div class="rank-player">${p.id}</div>
      <div class="rank-rate">勝率 ${p.rate.toFixed(3)}</div>
      <div class="rank-record">${p.wins}勝 / ${p.losses}敗</div>
    </div>
  `).join('');

  el.innerHTML = `
    <div class="ranking-title">🏆 個人勝率ランキング</div>
    ${top3.length > 0 ? `<div class="top3">${top3HTML}</div>` : ''}
    ${rest.length > 0 ? `<div class="rank-list">${listHTML}</div>` : ''}
    ${ranked.length === 0 ? '<div style="text-align:center;color:var(--text-sub);font-size:14px;padding:20px 0">まだ結果がありません</div>' : ''}
  `;
}

function getRanked() {
  return state.players
    .filter(p => p.active || state.games[p.id] > 0)
    .map(p => {
      const wins = state.wins[p.id] || 0;
      const games = state.games[p.id] || 0;
      const losses = games - wins;
      const rate = games > 0 ? wins / games : 0;
      return { id: p.id, wins, losses, games, rate };
    })
    .filter(p => p.games > 0)
    .sort((a, b) => {
      if (b.rate !== a.rate) return b.rate - a.rate;
      if (b.wins !== a.wins) return b.wins - a.wins;
      return a.id - b.id;
    });
}

// ===== ACTIONS =====
function recordWin(courtIndex, side) {
  if (state.viewingIndex !== state.matchIndex) return;
  const match = state.matches[state.matchIndex];
  const prev = match.results[courtIndex];

  // Undo previous
  if (prev !== null) {
    const court = match.courts[courtIndex];
    const prevWinners = prev === 'back' ? court.back : court.front;
    const prevLosers = prev === 'back' ? court.front : court.back;
    prevWinners.forEach(p => { state.wins[p]--; state.games[p]--; });
    prevLosers.forEach(p => { state.games[p]--; });
  }

  // Record new
  match.results[courtIndex] = side;
  const court = match.courts[courtIndex];
  const winners = side === 'back' ? court.back : court.front;
  const losers = side === 'back' ? court.front : court.back;
  winners.forEach(p => { state.wins[p] = (state.wins[p] || 0) + 1; state.games[p] = (state.games[p] || 0) + 1; });
  losers.forEach(p => { state.games[p] = (state.games[p] || 0) + 1; });

  save();
  renderMatch();
}

function nextMatch() {
  // If viewing older match, just go to latest
  if (state.viewingIndex < state.matchIndex) {
    state.viewingIndex = state.matchIndex;
    renderMatch();
    return;
  }

  const match = state.matches[state.matchIndex];
  // Check if all results entered
  const unresolved = match.results.filter(r => r === null).length;
  if (unresolved > 0) {
    showToast(`まだ ${unresolved} コートの結果が未登録です`);
  }

  // Record pairs before generating new match
  recordMatchHistory(match.courts);

  generateNextMatch();
  save();
  renderMatch();

  // Scroll to top
  document.querySelector('.courts-container').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function navigateMatch(delta) {
  const newIndex = state.viewingIndex + delta;
  if (newIndex < 0 || newIndex >= state.matches.length) return;
  state.viewingIndex = newIndex;
  renderMatch();
}

function endGame() {
  if (!confirm('試合を終了して最終結果を表示しますか？')) return;
  showFinal();
}

// ===== ADJUST =====
function openAdjust() {
  const grid = document.getElementById('adjust-grid');
  grid.innerHTML = '';
  state.players.forEach(p => {
    const div = document.createElement('div');
    div.className = 'player-chip' + (p.active ? '' : ' inactive');
    div.dataset.id = p.id;
    div.innerHTML = p.id + (p.active ? '<span class="chip-check">✓</span>' : '');
    div.onclick = () => {
      div.classList.toggle('inactive');
      div.innerHTML = p.id + (div.classList.contains('inactive') ? '' : '<span class="chip-check">✓</span>');
    };
    grid.appendChild(div);
  });
  // コート数を現在値にセット
  document.getElementById('modal-courts').value = state.courts;
  document.getElementById('modal-courts-display').textContent = state.courts;
  openModal('modal-adjust');
}

function adjustModalCourts(delta) {
  const el = document.getElementById('modal-courts');
  let v = parseInt(el.value) || 1;
  v = Math.max(1, Math.min(10, v + delta));
  el.value = v;
}

function addPlayers() {
  const count = parseInt(document.getElementById('add-count').value) || 1;
  const maxId = state.players.reduce((m, p) => Math.max(m, p.id), 0);
  for (let i = 0; i < count; i++) {
    const newId = maxId + i + 1;
    state.players.push({ id: newId, active: true });
    state.wins[newId] = 0;
    state.games[newId] = 0;
    state.lastPlayedMatchIndex[newId] = -1;
  }
  openAdjust(); // refresh grid
}

function applyAdjust() {
  const chips = document.querySelectorAll('#adjust-grid .player-chip');
  chips.forEach(chip => {
    const id = parseInt(chip.dataset.id);
    const p = state.players.find(x => x.id === id);
    if (p) p.active = !chip.classList.contains('inactive');
  });

  const active = getActivePlayers();
  if (active.length < 4) {
    showToast('参加者は4名以上必要です');
    return;
  }

  // コート数を更新
  const newCourts = parseInt(document.getElementById('modal-courts').value) || state.courts;
  state.courts = Math.max(1, Math.min(10, newCourts));

  closeModal('modal-adjust');

  // Generate new match with updated players
  recordPairs(state.matches[state.matchIndex].courts);
  generateNextMatch();
  save();
  renderMatch();
  showToast('人数を更新して次の試合を組みました');
}

// ===== HISTORY =====
function openHistory() {
  const el = document.getElementById('history-content');
  if (state.matches.length === 0) {
    el.innerHTML = '<div style="text-align:center;color:var(--text-sub);padding:20px">まだ試合がありません</div>';
    openModal('modal-history');
    return;
  }

  const prev = state.matches.slice(0, state.viewingIndex);
  if (prev.length === 0) {
    el.innerHTML = '<div style="text-align:center;color:var(--text-sub);padding:20px">前の試合はありません</div>';
    openModal('modal-history');
    return;
  }

  el.innerHTML = prev.slice().reverse().map((match, revIdx) => {
    const idx = prev.length - 1 - revIdx;
    const courtHTML = match.courts.map((court, ci) => {
      const result = match.results[ci];
      const backWin = result === 'back';
      const frontWin = result === 'front';
      return `
        <div class="history-court">
          <div class="history-court-name">コート ${ci + 1}</div>
          <div class="history-match">
            <div class="history-pair">
              <div class="history-pnum ${backWin ? 'win' : ''}">${court.back[0]}</div>
              <div class="history-pnum ${backWin ? 'win' : ''}">${court.back[1]}</div>
            </div>
            <div class="history-vs">VS</div>
            <div class="history-pair">
              <div class="history-pnum ${frontWin ? 'win' : ''}">${court.front[0]}</div>
              <div class="history-pnum ${frontWin ? 'win' : ''}">${court.front[1]}</div>
            </div>
            ${result === null ? '<span style="font-size:11px;color:#bbb;margin-left:8px">未登録</span>' : ''}
          </div>
        </div>
      `;
    }).join('');
    const restHTML = match.rest.length > 0
      ? `<div class="history-rest">☕ 休み：${match.rest.join('、')}</div>`
      : '';
    return `
      <div class="history-round">
        <div class="history-round-title">${idx + 1}試合目</div>
        ${courtHTML}
        ${restHTML}
      </div>
    `;
  }).join('');

  openModal('modal-history');
}

// ===== FINAL =====
function showFinal() {
  const ranked = getRanked();
  const top3 = ranked.slice(0, 3);
  const rest = ranked.slice(3);
  const totalMatches = state.matches.length;

  document.getElementById('final-subtitle').textContent = `全${totalMatches}試合 完了`;

  const crowns = ['👑', '🥈', '🥉'];
  const rankClass = ['rank1', 'rank2', 'rank3'];
  const rankLabel = ['1位', '2位', '3位'];

  document.getElementById('final-top3').innerHTML = top3.map((p, i) => `
    <div class="final-top3-item ${rankClass[i]}">
      <div class="final-crown">${crowns[i]}</div>
      <div class="final-rank-label">${rankLabel[i]}</div>
      <div class="final-num">${p.id}</div>
      <div class="final-rate">勝率 ${p.rate.toFixed(3)}</div>
      <div class="final-record">${p.wins}勝 / ${p.losses}敗</div>
    </div>
  `).join('');

  document.getElementById('final-all-ranking').innerHTML = `
    <div class="rank-list">
      ${rest.map((p, i) => `
        <div class="rank-row">
          <div class="rank-pos">${i + 4}位</div>
          <div class="rank-player">${p.id}</div>
          <div class="rank-rate">勝率 ${p.rate.toFixed(3)}</div>
          <div class="rank-record">${p.wins}勝 / ${p.losses}敗</div>
        </div>
      `).join('')}
      ${ranked.length === 0 ? '<div style="text-align:center;color:var(--text-sub);padding:20px">データなし</div>' : ''}
    </div>
  `;

  showScreen('final');
}

function restartGame() {
  if (!confirm('データを消去して最初からやり直しますか？')) return;
  localStorage.removeItem('bm_state');
  showScreen('setup');
}

// ===== UTILS =====
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById('screen-' + name).classList.add('active');
}

function openModal(id) {
  document.getElementById(id).classList.add('active');
}
function closeModal(id) {
  document.getElementById(id).classList.remove('active');
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2500);
}

// ===== INIT =====
window.addEventListener('load', () => {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
  if (load() && state.matches.length > 0) {
    state.viewingIndex = state.matchIndex;
    showScreen('match');
    renderMatch();
  }
});
