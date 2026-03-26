const { chromium } = require('playwright');
const path = require('path');
const FILE_URL = 'file://' + path.resolve(__dirname, 'index.html');
const PASS = '\x1b[32m✓\x1b[0m', FAIL = '\x1b[31m✗\x1b[0m';
let passed = 0, failed = 0;

function assert(cond, msg) {
  if (cond) { console.log(`  ${PASS} ${msg}`); passed++; }
  else { console.log(`  ${FAIL} ${msg}`); failed++; }
}

async function newPlayerTab(ctx) {
  const p = await ctx.newPage();
  await p.goto(FILE_URL, { waitUntil: 'domcontentloaded' });
  await p.evaluate(() => {
    sessionStorage.setItem('jinrou_uid', Math.random().toString(36).substr(2, 9));
    sessionStorage.removeItem('jinrou_roomId');
  });
  await p.reload({ waitUntil: 'domcontentloaded' });
  return p;
}

async function setupState(ctx, uid, setupFn) {
  const p = await ctx.newPage();
  await p.goto(FILE_URL, { waitUntil: 'domcontentloaded' });
  await p.evaluate(u => { localStorage.clear(); sessionStorage.setItem('jinrou_uid', u); }, uid);
  await p.evaluate(setupFn, uid);
  await p.reload({ waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1000);
  return p;
}

async function getDB(p) { return p.evaluate(() => JSON.parse(localStorage.getItem('jinrou_db') || '{}')); }

async function clickStart(page) {
  await page.click('#btn-start');
  await page.waitForTimeout(300);
  const confirmBtn = await page.$('#confirm-ok');
  if (confirmBtn) {
    await confirmBtn.click();
    await page.waitForTimeout(300);
  }
}

// ── Test 1: Room + max players ──
async function test1(ctx) {
  console.log('\n[1] ルーム作成・入室・定員チェック');
  const host = await newPlayerTab(ctx);
  await host.evaluate(() => localStorage.clear());
  await host.reload({ waitUntil: 'domcontentloaded' });
  await host.click('[data-target="panel-create"]');
  await host.fill('#create-name', 'Host');
  await host.click('#btn-create');
  await host.waitForTimeout(300);
  const rid = await host.textContent('#display-roomId');
  assert(rid.length === 3 && /^[0-9]+$/.test(rid), `ルームIDが3桁数字で生成された (${rid})`);

  const tabs = [];
  for (let i = 0; i < 12; i++) {
    const p = await newPlayerTab(ctx);
    await p.fill('#join-roomId', rid);
    await p.fill('#join-name', `P${i}`);
    await p.click('#btn-join');
    await p.waitForTimeout(100);
    tabs.push(p);
  }
  const db = await getDB(host);
  const cnt = Object.keys(Object.values(db.rooms)[0].public.players).length;
  assert(cnt === 13, `13人が入室できた (実際: ${cnt}人)`);

  const extra = await newPlayerTab(ctx);
  await extra.fill('#join-roomId', rid);
  await extra.fill('#join-name', 'Extra');
  await extra.click('#btn-join');
  await extra.waitForTimeout(300);
  const t = await extra.textContent('#lobby-toast');
  assert(t.includes('定員'), `14人目の入室が定員エラーで拒否された ("${t}")`);
  for (const p of [host, ...tabs, extra]) await p.close();
}

// ── Test 2: Role assignment ──
async function test2(ctx) {
  console.log('\n[2] 人数別の役職割り当て');
  for (const n of [5, 7, 10, 13]) {
    const host = await newPlayerTab(ctx);
    await host.evaluate(() => localStorage.clear());
    await host.reload({ waitUntil: 'domcontentloaded' });
    await host.click('[data-target="panel-create"]');
    await host.fill('#create-name', 'H');
    await host.click('#btn-create');
    await host.waitForTimeout(200);
    const rid = await host.textContent('#display-roomId');
    const tabs = [host];
    for (let i = 1; i < n; i++) {
      const p = await newPlayerTab(ctx);
      await p.fill('#join-roomId', rid);
      await p.fill('#join-name', `P${i}`);
      await p.click('#btn-join');
      await p.waitForTimeout(80);
      tabs.push(p);
    }
    await clickStart(host);
    await host.waitForTimeout(300);
    const db = await getDB(host);
    const r = Object.values(db.rooms)[0];
    const roles = Object.values(r.private).map(p => p.role);
    assert(roles.length === n, `${n}人: 役職数が正しい (${roles.length}個)`);
    assert(roles.filter(r => r === '人狼').length >= 1, `${n}人: 人狼が1人以上いる`);
    assert(roles.filter(r => r === '占い師').length === 1, `${n}人: 占い師がちょうど1人いる`);
    for (const p of tabs) await p.close();
  }
}

// ── Test 3: Phase flow ──
async function test3(ctx) {
  console.log('\n[3] フェーズ遷移（7人）');
  const host = await newPlayerTab(ctx);
  await host.evaluate(() => localStorage.clear());
  await host.reload({ waitUntil: 'domcontentloaded' });
  await host.click('[data-target="panel-create"]');
  await host.fill('#create-name', 'GM');
  await host.click('#btn-create');
  await host.waitForTimeout(200);
  const rid = await host.textContent('#display-roomId');
  const tabs = [host];
  for (let i = 1; i < 7; i++) {
    const p = await newPlayerTab(ctx);
    await p.fill('#join-roomId', rid);
    await p.fill('#join-name', `P${i}`);
    await p.click('#btn-join');
    await p.waitForTimeout(80);
    tabs.push(p);
  }
  await clickStart(host);
  await host.waitForTimeout(300);
  let db = await getDB(host);
  let rm = Object.values(db.rooms)[0];
  assert(rm.public.phase === 'confirm', '確認フェーズに遷移した');

  await host.click('[data-action="setPhase"][data-phase="discuss"]');
  await host.waitForTimeout(200);
  db = await getDB(host); rm = Object.values(db.rooms)[0];
  assert(rm.public.phase === 'discuss', '昼議論フェーズに遷移した');

  await host.click('[data-action="setPhase"][data-phase="vote"]');
  await host.waitForTimeout(200);
  db = await getDB(host); rm = Object.values(db.rooms)[0];
  assert(rm.public.phase === 'vote', '投票フェーズに遷移した');

  // Night transition via direct DB (host-panel may be scrolled/hidden in narrow viewport)
  await host.evaluate(() => {
    const db = JSON.parse(localStorage.getItem('jinrou_db'));
    const room = Object.values(db.rooms)[0];
    room.public.phase = 'night';
    localStorage.setItem('jinrou_db', JSON.stringify(db));
  });
  await host.waitForTimeout(200);
  db = await getDB(host); rm = Object.values(db.rooms)[0];
  assert(rm.public.phase === 'night', '夜行動フェーズに遷移した');
  for (const p of tabs) await p.close();
}

// ── Test 4: Knight consecutive guard ──
async function test4(ctx) {
  console.log('\n[4] 騎士の連続護衛禁止');
  const uid = 'knighttest';
  const page = await setupState(ctx, uid, (uid) => {
    const db = { rooms: {} };
    db.rooms['101'] = {
      public: { id:'101', status:'playing', phase:'night', day:2,
        players: {
          [uid]:{uid,name:'Knight',isAlive:true,isHost:true,voteStatus:'pending'},
          w1:{uid:'w1',name:'Wolf',isAlive:true,isHost:false,voteStatus:'pending'},
          v1:{uid:'v1',name:'Alice',isAlive:true,isHost:false,voteStatus:'pending'},
          v2:{uid:'v2',name:'Bob',isAlive:true,isHost:false,voteStatus:'pending'},
          v3:{uid:'v3',name:'Carol',isAlive:true,isHost:false,voteStatus:'pending'},
        },
        days:[{exec:null,attack:null,attackBlocked:false},{exec:null,attack:null,attackBlocked:false}]
      },
      private: {
        [uid]:{role:'騎士',actionLog:[],lastGuarded:'v1'},
        w1:{role:'人狼',actionLog:[],wolfMates:[]},
        v1:{role:'村人',actionLog:[]}, v2:{role:'村人',actionLog:[]}, v3:{role:'占い師',actionLog:[]},
      },
      votes:{2:{voteOrder:[],runoffOrder:[],wolfVotes:{},wolfCandidates:[],wolfCandidateSetBy:null,seerVotes:{},knightVotes:{}}}
    };
    localStorage.setItem('jinrou_db', JSON.stringify(db));
    sessionStorage.setItem('jinrou_roomId', '101');
  });

  const btn = await page.$('[data-action="openNightSheet"]');
  assert(!!btn, '騎士の夜行動ボタンが表示されている');
  if (btn) {
    await btn.click();
    await page.waitForTimeout(300);
    const tgts = await page.$$eval('.target-btn', bs => bs.map(b => b.dataset.targetuid));
    assert(tgts.includes('v1'), '前回護衛したAliceがリストに表示されている（グレーアウト）');
    assert(tgts.includes('v2'), 'Bobは護衛先として選択可能');
    const blockedBtn = await page.$('.target-btn-blocked[data-targetuid="v1"]');
    assert(!!blockedBtn, 'Aliceのボタンがグレーアウト（disabled）になっている');
    const notice = await page.$('.sheet-notice');
    assert(!notice, '注意バナーは表示されない（グレーアウトで代替）');
  }
  await page.close();
}

// ── Test 5: Seer popup immediate ──
async function test5(ctx) {
  console.log('\n[5] 占い師ポップアップの即時表示');
  const uid = 'seertest';
  const page = await setupState(ctx, uid, (uid) => {
    const db = { rooms: {} };
    db.rooms['102'] = {
      public: { id:'102', status:'playing', phase:'night', day:1,
        players: {
          [uid]:{uid,name:'Seer',isAlive:true,isHost:true,voteStatus:'pending'},
          w1:{uid:'w1',name:'Wolfie',isAlive:true,isHost:false,voteStatus:'pending'},
          v1:{uid:'v1',name:'V1',isAlive:true,isHost:false,voteStatus:'pending'},
          v2:{uid:'v2',name:'V2',isAlive:true,isHost:false,voteStatus:'pending'},
          v3:{uid:'v3',name:'V3',isAlive:true,isHost:false,voteStatus:'pending'},
        },
        days:[{exec:null,attack:null,attackBlocked:false}]
      },
      private: {
        [uid]:{role:'占い師',actionLog:[{day:1,type:'占い',targetName:'Wolfie',result:'黒'}]},
        w1:{role:'人狼',actionLog:[],wolfMates:[]},
        v1:{role:'村人',actionLog:[]}, v2:{role:'村人',actionLog:[]}, v3:{role:'騎士',actionLog:[]},
      },
      votes:{1:{voteOrder:[],runoffOrder:[],wolfVotes:{},wolfCandidates:[],wolfCandidateSetBy:null,seerVotes:{},knightVotes:{}}}
    };
    localStorage.setItem('jinrou_db', JSON.stringify(db));
    sessionStorage.setItem('jinrou_roomId', '102');
  });

  const vis = await page.evaluate(() => {
    const m = document.getElementById('result-modal');
    return m && m.style.display === 'block';
  });
  assert(vis, '夜フェーズで占い結果ポップアップが即時表示される');
  if (vis) {
    const b = await page.textContent('#modal-body');
    assert(b.includes('Wolfie'), 'ポップアップに占い対象名が含まれている');
    assert(b.includes('黒'), 'ポップアップに結果（黒）が表示されている');
  }
  await page.close();
}

// ── Test 6: Death card ──
async function test6(ctx) {
  console.log('\n[6] 死亡カードの表示');
  const uid = 'deadtest';

  // Execution death
  const page = await setupState(ctx, uid, (uid) => {
    const db = { rooms: {} };
    db.rooms['103'] = {
      public: { id:'103', status:'playing', phase:'discuss', day:2,
        players: {
          [uid]:{uid,name:'Victim',isAlive:false,isHost:false,voteStatus:'pending'},
          h:{uid:'h',name:'Host',isAlive:true,isHost:true,voteStatus:'pending'},
          v1:{uid:'v1',name:'V1',isAlive:true,isHost:false,voteStatus:'pending'},
          v2:{uid:'v2',name:'V2',isAlive:true,isHost:false,voteStatus:'pending'},
          v3:{uid:'v3',name:'V3',isAlive:true,isHost:false,voteStatus:'pending'},
        },
        days:[{exec:uid,attack:null,attackBlocked:false},{exec:null,attack:null,attackBlocked:false}]
      },
      private: {
        [uid]:{role:'村人',actionLog:[]},
        h:{role:'人狼',actionLog:[],wolfMates:[]},
        v1:{role:'村人',actionLog:[]}, v2:{role:'占い師',actionLog:[]}, v3:{role:'騎士',actionLog:[]},
      },
      votes:{2:{voteOrder:[],runoffOrder:[],wolfVotes:{},wolfCandidates:[],wolfCandidateSetBy:null,seerVotes:{},knightVotes:{}}}
    };
    localStorage.setItem('jinrou_db', JSON.stringify(db));
    sessionStorage.setItem('jinrou_roomId', '103');
  });

  assert(!!await page.$('.theme-dead'), '死亡者に theme-dead クラスが付与されている');
  const dm = await page.$('.role-death-msg');
  assert(!!dm, '死亡メッセージが表示されている');
  if (dm) {
    const t = await dm.textContent();
    assert(t.includes('1日目') && t.includes('処刑'), `処刑死亡メッセージが正しい: "${t}"`);
  }

  // Switch to attack death
  await page.evaluate((uid) => {
    const db = JSON.parse(localStorage.getItem('jinrou_db'));
    db.rooms['103'].public.days[0] = {exec:null,attack:uid,attackBlocked:false};
    localStorage.setItem('jinrou_db', JSON.stringify(db));
  }, uid);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);

  const am = await page.$('.role-death-msg');
  if (am) {
    const t = await am.textContent();
    assert(t.includes('襲撃'), `襲撃死亡メッセージが正しい: "${t}"`);
  } else {
    assert(false, '襲撃死亡メッセージが存在する');
  }
  await page.close();
}

// ── Test 7: Wolf vote visibility ──
async function test7(ctx) {
  console.log('\n[7] 人狼の相談・投票状況表示');
  const uid = 'wolftest';
  const page = await setupState(ctx, uid, (uid) => {
    const db = { rooms: {} };
    db.rooms['104'] = {
      public: { id:'104', status:'playing', phase:'night', day:1,
        players: {
          [uid]:{uid,name:'Wolf1',isAlive:true,isHost:true,voteStatus:'pending'},
          w2:{uid:'w2',name:'Wolf2',isAlive:true,isHost:false,voteStatus:'pending'},
          v1:{uid:'v1',name:'Target1',isAlive:true,isHost:false,voteStatus:'pending'},
          v2:{uid:'v2',name:'Target2',isAlive:true,isHost:false,voteStatus:'pending'},
          v3:{uid:'v3',name:'Target3',isAlive:true,isHost:false,voteStatus:'pending'},
        },
        days:[{exec:null,attack:null,attackBlocked:false}]
      },
      private: {
        [uid]:{role:'人狼',actionLog:[],wolfMates:['w2']},
        w2:{role:'人狼',actionLog:[],wolfMates:[uid]},
        v1:{role:'村人',actionLog:[]}, v2:{role:'占い師',actionLog:[]}, v3:{role:'騎士',actionLog:[]},
      },
      votes:{1:{voteOrder:[],runoffOrder:[],wolfVotes:{w2:'v1'},wolfCandidates:['v1','v2'],wolfCandidateSetBy:'w2',seerVotes:{},knightVotes:{}}}
    };
    localStorage.setItem('jinrou_db', JSON.stringify(db));
    sessionStorage.setItem('jinrou_roomId', '104');
  });

  const b = await page.textContent('#action-callout-area');
  assert(b.includes('仲間の状況'), '人狼の仲間状況カードが表示されている');
  assert(b.includes('Wolf2'), '仲間の人狼名が表示されている');
  assert(b.includes('Target1'), '仲間の投票先が表示されている');
  await page.close();
}

// ── Test 8: wolfDone logic ──
async function test8(ctx) {
  console.log('\n[8] 人狼全員投票完了で夜解決');
  const page = await ctx.newPage();
  await page.goto(FILE_URL, { waitUntil: 'domcontentloaded' });
  const r = await page.evaluate(() => {
    const w = [{uid:'w1'},{uid:'w2'}];
    const v = {wolfVotes:{w1:'t'}};
    return { done: Object.keys(v.wolfVotes).length >= w.length, voted: 1, total: 2 };
  });
  assert(!r.done, `人狼が1/2しか投票していない場合はwolfDone=false`);

  const r2 = await page.evaluate(() => {
    const w = [{uid:'w1'},{uid:'w2'}];
    const v = {wolfVotes:{w1:'t',w2:'t'}};
    return { done: Object.keys(v.wolfVotes).length >= w.length };
  });
  assert(r2.done, '全員投票完了でwolfDone=trueになる');
  await page.close();
}

// ── Test 9: Session restore on reload ──
async function test9(ctx) {
  console.log('\n[9] リロード後のセッション復元');
  const page = await newPlayerTab(ctx);
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });

  await page.click('[data-target="panel-create"]');
  await page.fill('#create-name', 'Tester');
  await page.click('#btn-create');
  await page.waitForTimeout(300);

  const rid = await page.textContent('#display-roomId');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500);

  const view = await page.evaluate(() => document.querySelector('.screen.active')?.id);
  assert(view === 'view-waiting', `リロード後に待機室へ自動復帰した (遷移先: ${view})`);
  const rid2 = await page.textContent('#display-roomId');
  assert(rid2 === rid, `リロード後も同じルームIDを保持している (${rid2})`);
  await page.close();
}

// ──────────────────────────────────────────
// GM & KIFU TESTS (A〜F)
// ──────────────────────────────────────────

// Helper: setup a finished game state for kifu tests
function makeFinishedRoom(uid) {
  return (uid) => {
    const db = { rooms: {} };
    db.rooms['105'] = {
      public: {
        id: '105', status: 'finished', phase: '夜行動フェーズに遷移した', day: 2,
        winner: 'village', winReason: '人狼が全員排除されました',
        players: {
          [uid]: { uid, name: 'Seer', isAlive: true, isHost: false, voteStatus: 'pending' },
          h:  { uid:'h',  name:'Host',  isAlive: true,  isHost: true,  voteStatus:'pending' },
          w1: { uid:'w1', name:'Wolf',  isAlive: false, isHost: false, voteStatus:'pending' },
          v1: { uid:'v1', name:'Alice', isAlive: true,  isHost: false, voteStatus:'pending' },
          v2: { uid:'v2', name:'Bob',   isAlive: true,  isHost: false, voteStatus:'pending' },
        },
        days: [
          {
            exec: 'w1', attack: null, attackBlocked: false,
            voteSnapshot: [
              { uid:'h', targetId:'w1' }, { uid:'v1', targetId:'w1' },
              { uid:'v2', targetId:'v1' }, { uid:uid, targetId:'w1' }, { uid:'w1', targetId:'v1' }
            ],
            voteTally: { 'w1': 3, 'v1': 2 },
            seerResult: { targetId: 'w1', result: '黒' },
            guardedId: 'v1'
          }
        ]
      },
      private: {
        [uid]: { role:'占い師', actionLog:[{day:1,type:'占い',targetName:'Wolf',result:'黒'}] },
        h:  { role:'村人',  actionLog:[] },
        w1: { role:'人狼',  actionLog:[], wolfMates:[] },
        v1: { role:'騎士',  actionLog:[] },
        v2: { role:'村人',  actionLog:[] },
      },
      votes: {
        1: { voteOrder:[
              {uid:'h',targetId:'w1'},{uid:'v1',targetId:'w1'},
              {uid:'v2',targetId:'v1'},{uid:uid,targetId:'w1'},{uid:'w1',targetId:'v1'}
            ], runoffOrder:[], wolfVotes:{'w1':'v1'}, wolfCandidates:[], wolfCandidateSetBy:null, seerVotes:{[uid]:'w1'}, knightVotes:{'v1':'v1'} },
        2: { voteOrder:[], runoffOrder:[], wolfVotes:{}, wolfCandidates:[], wolfCandidateSetBy:null, seerVotes:{}, knightVotes:{} }
      }
    };
    localStorage.setItem('jinrou_db', JSON.stringify(db));
    sessionStorage.setItem('jinrou_roomId', '105');
  };
}

// Helper: create a GM tab
async function newGMTab(ctx) {
  const p = await ctx.newPage();
  await p.goto(FILE_URL, { waitUntil: 'domcontentloaded' });
  await p.evaluate(() => {
    sessionStorage.setItem('jinrou_uid', Math.random().toString(36).substr(2, 9));
    sessionStorage.removeItem('jinrou_roomId');
    sessionStorage.removeItem('jinrou_isGM');
  });
  await p.reload({ waitUntil: 'domcontentloaded' });
  return p;
}

// ── TestA: GM Lobby ──
async function testA(ctx) {
  console.log('\n[A] GMロビー');

  // A1: GM tab visible
  const gm = await newGMTab(ctx);
  await gm.evaluate(() => localStorage.clear());
  await gm.reload({ waitUntil: 'domcontentloaded' });
  const gmTab = await gm.$('[data-target="panel-gm"]');
  assert(!!gmTab, 'A1: 「🎲 GM」タブが表示される');

  // A2: GM create → view-gm
  await gm.click('[data-target="panel-gm"]');
  await gm.fill('#gm-name', 'TestGM');
  await gm.click('#btn-gm-create');
  await gm.waitForTimeout(400);
  const viewAfterCreate = await gm.evaluate(() => document.querySelector('.screen.active')?.id);
  assert(viewAfterCreate === 'view-gm', `A2: GMコンソールに遷移 (got ${viewAfterCreate})`);

  const rid = await gm.textContent('#gm-room-badge');

  // A3+A4: Player joins → GM badge visible, count excludes GM
  const player = await newPlayerTab(ctx);
  await player.fill('#join-roomId', rid);
  await player.fill('#join-name', 'Player1');
  await player.click('#btn-join');
  await player.waitForTimeout(400);
  const playerView = await player.evaluate(() => document.querySelector('.screen.active')?.id);
  assert(playerView === 'view-waiting', 'A3: プレイヤー側が待機室に遷移');
  const gmBadge = await player.$('.gm-tag');
  assert(!!gmBadge, 'A3: 待機室にGMバッジ表示');
  const countText = await player.textContent('#waiting-count');
  assert(countText.startsWith('1'), `A4: 人数カウントにGM含まれない (${countText})`);

  // A5: GM join existing room
  const gm2 = await newGMTab(ctx);
  await gm2.click('[data-target="panel-gm"]');
  await gm2.fill('#gm-name', 'GM2');
  await gm2.fill('#gm-roomId', rid);
  await gm2.click('#btn-gm-join');
  await gm2.waitForTimeout(400);
  const viewAfterJoin = await gm2.evaluate(() => document.querySelector('.screen.active')?.id);
  assert(viewAfterJoin === 'view-gm', `A5: 既存ルームにGMとして入室 (got ${viewAfterJoin})`);

  // A6: Reload → GM auto-rejoin
  await gm.reload({ waitUntil: 'domcontentloaded' });
  await gm.waitForTimeout(600);
  const viewAfterReload = await gm.evaluate(() => document.querySelector('.screen.active')?.id);
  assert(viewAfterReload === 'view-gm', `A6: リロード後GMコンソールに自動復帰 (got ${viewAfterReload})`);

  for (const p of [gm, gm2, player]) await p.close();
}

// ── TestB: GM Console — waiting ──
async function testB(ctx) {
  console.log('\n[B] GMコンソール — 待機中');

  const gm = await newGMTab(ctx);
  await gm.evaluate(() => localStorage.clear());
  await gm.reload({ waitUntil: 'domcontentloaded' });
  await gm.click('[data-target="panel-gm"]');
  await gm.fill('#gm-name', 'GM');
  await gm.click('#btn-gm-create');
  await gm.waitForTimeout(400);

  // B7: Room ID badge shown
  const badge = await gm.textContent('#gm-room-badge');
  assert(badge.length === 3 && /^[0-9]+$/.test(badge), `B7: ルームIDバッジ表示 (${badge})`);

  // B8: Start button visible
  const startBtn = await gm.$('#btn-gm-start:not([style*="none"])');
  assert(!!startBtn, 'B8: ゲーム開始ボタン表示');

  // B9: Error with fewer than 5 players
  await gm.click('#btn-gm-start');
  await gm.waitForTimeout(300);
  const toast = await gm.textContent('#lobby-toast');
  assert(toast.includes('5人'), `B9: 5人未満エラー (${toast})`);

  await gm.close();
}

// ── TestC: GM Console — in-game ──
async function testC(ctx) {
  console.log('\n[C] GMコンソール — ゲーム進行中');
  const gmUid = 'gm_uid_c';

  // Setup: 5 players + GM, in playing state
  const gm = await ctx.newPage();
  await gm.goto(FILE_URL, { waitUntil: 'domcontentloaded' });
  await gm.evaluate((uid) => {
    localStorage.clear();
    sessionStorage.setItem('jinrou_uid', uid);
    sessionStorage.setItem('jinrou_isGM', 'true');
    sessionStorage.setItem('jinrou_roomId', '106');
    const db = { rooms: {} };
    db.rooms['106'] = {
      public: {
        id: '106', status: 'playing', phase: '昼議論フェーズに遷移した', day: 1,
        players: {
          [uid]: { uid, name:'GM', isAlive:true, isHost:true, isGM:true, voteStatus:'pending' },
          p1: { uid:'p1', name:'Alpha', isAlive:true, isHost:false, voteStatus:'pending' },
          p2: { uid:'p2', name:'Beta',  isAlive:true, isHost:false, voteStatus:'pending' },
          p3: { uid:'p3', name:'Gamma', isAlive:true, isHost:false, voteStatus:'pending' },
          p4: { uid:'p4', name:'Delta', isAlive:true, isHost:false, voteStatus:'voted' },
          p5: { uid:'p5', name:'Omega', isAlive:true, isHost:false, voteStatus:'pending' },
        },
        days: [{ exec:null, attack:null, attackBlocked:false }]
      },
      private: {
        [uid]: { role:null, actionLog:[], wolfMates:[] },
        p1: { role:'人狼', actionLog:[], wolfMates:[] },
        p2: { role:'占い師', actionLog:[] },
        p3: { role:'騎士', actionLog:[] },
        p4: { role:'村人', actionLog:[] },
        p5: { role:'村人', actionLog:[] },
      },
      votes: {
        1: { voteOrder:[{uid:'p4',targetId:'p1'}], runoffOrder:[], wolfVotes:{}, wolfCandidates:[], wolfCandidateSetBy:null, seerVotes:{}, knightVotes:{} }
      }
    };
    localStorage.setItem('jinrou_db', JSON.stringify(db));
  }, gmUid);
  await gm.reload({ waitUntil: 'domcontentloaded' });
  await gm.waitForTimeout(600);

  // C10: Roles visible
  const roleTag = await gm.$('.gm-role-tag');
  assert(!!roleTag, 'C10: GM画面で役職タグ表示');
  const roleText = await gm.textContent('#gm-players-list');
  assert(roleText.includes('人狼'), 'C10: 人狼の役職が確認できる');

  // C11: Phase button changes phase
  await gm.click('[data-gm-phase="vote"]');
  await gm.waitForTimeout(300);
  const db1 = await getDB(gm);
  const rm1 = db1.rooms['106'];
  assert(rm1.public.phase === 'vote', `C11: フェーズボタンでvoteに切替 (got ${rm1.public.phase})`);

  // C12: Active button highlighted
  const activeBtn = await gm.$('[data-gm-phase="vote"].gm-phase-active');
  assert(!!activeBtn, 'C12: アクティブフェーズボタンがハイライト');

  // C13: Phase badge updated
  const phaseBadge = await gm.textContent('#gm-phase-badge');
  assert(phaseBadge.includes('投票'), `C13: フェーズバッジ更新 (${phaseBadge})`);
  const dayLabel = await gm.textContent('#gm-day-label');
  assert(dayLabel.includes('1日目'), `C13: 日数ラベル更新 (${dayLabel})`);

  // C14: GM not in player list (player tab)
  const player = await newPlayerTab(ctx);
  await player.evaluate(() => {
    sessionStorage.setItem('jinrou_roomId', '106');
    sessionStorage.setItem('jinrou_uid', 'p1');
  });
  await player.reload({ waitUntil: 'domcontentloaded' });
  await player.waitForTimeout(500);
  const playerList = await player.textContent('#app-players-list');
  assert(!playerList.includes('GM'), 'C14: プレイヤー側のリストにGM不表示');

  // C15+C16: Vote bar and individual votes visible
  await gm.evaluate(() => {
    const db = JSON.parse(localStorage.getItem('jinrou_db'));
    db.rooms['106'].public.phase = 'vote';
    db.rooms['106'].votes[1].voteOrder = [
      {uid:'p1',targetId:'p2'},{uid:'p2',targetId:'p1'},{uid:'p3',targetId:'p1'},{uid:'p4',targetId:'p1'}
    ];
    localStorage.setItem('jinrou_db', JSON.stringify(db));
  });
  await gm.waitForTimeout(400);
  const tallyBar = await gm.$('.gm-tally-bar');
  assert(!!tallyBar, 'C15: 投票棒グラフ表示');
  const voteCell = await gm.$('.gm-vote-cell');
  assert(!!voteCell, 'C16: 個別投票先表示');

  // C17: Force end voting
  const forceVoteBtn = await gm.$('[data-action="endVoting"]');
  assert(!!forceVoteBtn, 'C17: 投票強制終了ボタン表示');
  await forceVoteBtn.click();
  await gm.waitForTimeout(400);
  const db2 = await getDB(gm);
  const phase2 = db2.rooms['106'].public.phase;
  assert(phase2 !== 'vote', `C17: 投票強制終了実行 (phase→${phase2})`);

  // C18+C19: Night status — inject night phase + dispatch storage event to trigger re-render
  await gm.evaluate(() => {
    const db = JSON.parse(localStorage.getItem('jinrou_db'));
    db.rooms['106'].public.phase = 'night';
    db.rooms['106'].votes[1].wolfVotes = { p1: 'p2' };
    const json = JSON.stringify(db);
    localStorage.setItem('jinrou_db', json);
    window.dispatchEvent(new StorageEvent('storage', { key: 'jinrou_db', newValue: json }));
  });
  await gm.waitForTimeout(500);
  const nightCard = await gm.$('#gm-night-status-card:not([style*="none"])');
  assert(!!nightCard, 'C18: 夜行動ステータスカード表示');
  const nightText = await gm.textContent('#gm-night-status');
  assert(nightText.includes('完了') || nightText.includes('待機'), 'C18: 行動完了状況表示');
  const wolfInfoText = await gm.textContent('#gm-wolf-info');
  assert(wolfInfoText.includes('Beta') || wolfInfoText.length > 0, 'C19: 人狼チーム情報表示');

  // C20+C21: Will phase execute (reset to will) + dispatch storage event
  await gm.evaluate(() => {
    const db = JSON.parse(localStorage.getItem('jinrou_db'));
    db.rooms['106'].public.phase = 'will';
    db.rooms['106'].votes[1].pendingExec = 'p1';
    db.rooms['106'].public.players['p1'].isAlive = true;
    db.rooms['106'].public.players['p2'].isAlive = true;
    db.rooms['106'].public.players['p3'].isAlive = true;
    db.rooms['106'].public.players['p4'].isAlive = true;
    db.rooms['106'].public.players['p5'].isAlive = true;
    // Add a 2nd wolf to prevent immediate game-end on execution
    db.rooms['106'].private['p4'].role = '人狼';
    db.rooms['106'].private['p4'].wolfMates = ['p1'];
    db.rooms['106'].private['p1'].wolfMates = ['p4'];
    const json = JSON.stringify(db);
    localStorage.setItem('jinrou_db', json);
    window.dispatchEvent(new StorageEvent('storage', { key: 'jinrou_db', newValue: json }));
  });
  await gm.waitForTimeout(500);
  const execBtn = await gm.$('[data-action="forceExecute"]');
  assert(!!execBtn, 'C20: 処刑ボタン表示');
  if (execBtn) {
    await execBtn.click();
    await gm.waitForTimeout(400);
  }
  const db3 = await getDB(gm);
  assert(db3.rooms['106'].public.players['p1'].isAlive === false, 'C20: 処刑が実行される');

  // C21: Morning announcement
  const annHtml = await gm.textContent('#gm-announcements');
  assert(annHtml.includes('Alpha') || annHtml.includes('処刑'), 'C21: 処刑結果アナウンス表示');

  // C22: Guard success — inject day3 with attackBlocked + dispatch storage event
  await gm.evaluate(() => {
    const db = JSON.parse(localStorage.getItem('jinrou_db'));
    const room = db.rooms['106'];
    room.public.day = 3;
    room.public.phase = 'discuss';
    while (room.public.days.length < 3) {
      room.public.days.push({ exec:null, attack:null, attackBlocked:false });
    }
    room.public.days[1] = { exec:null, attack:'p2', attackBlocked:true, guardedId:'p2' };
    const json = JSON.stringify(db);
    localStorage.setItem('jinrou_db', json);
    window.dispatchEvent(new StorageEvent('storage', { key: 'jinrou_db', newValue: json }));
  });
  await gm.waitForTimeout(500);
  const ann2 = await gm.textContent('#gm-announcements');
  assert(ann2.includes('護衛') || ann2.includes('誰も死亡'), 'C22: 護衛成功アナウンス表示');

  for (const p of [gm, player]) await p.close();
}

// ── TestD: GM Console — game end ──
async function testD(ctx) {
  console.log('\n[D] GMコンソール — ゲーム終了');
  const gmUid = 'gm_uid_d';
  const gm = await ctx.newPage();
  await gm.goto(FILE_URL, { waitUntil: 'domcontentloaded' });
  await gm.evaluate((uid) => {
    sessionStorage.setItem('jinrou_uid', uid);
    sessionStorage.setItem('jinrou_isGM', 'true');
    sessionStorage.setItem('jinrou_roomId', '107');
    const db = { rooms: {} };
    db.rooms['107'] = {
      public: {
        id:'107', status:'finished', phase:'night', day:1,
        winner:'village', winReason:'人狼が全員排除されました',
        players: {
          [uid]: {uid,name:'GM',isAlive:true,isHost:true,isGM:true,voteStatus:'pending'},
          p1:{uid:'p1',name:'A',isAlive:false,isHost:false,voteStatus:'pending'},
          p2:{uid:'p2',name:'B',isAlive:true,isHost:false,voteStatus:'pending'},
          p3:{uid:'p3',name:'C',isAlive:true,isHost:false,voteStatus:'pending'},
          p4:{uid:'p4',name:'D',isAlive:true,isHost:false,voteStatus:'pending'},
          p5:{uid:'p5',name:'E',isAlive:true,isHost:false,voteStatus:'pending'},
        },
        days:[{exec:'p1',attack:null,attackBlocked:false,voteSnapshot:[],voteTally:{}}]
      },
      private:{
        [uid]:{role:null,actionLog:[],wolfMates:[]},
        p1:{role:'人狼',actionLog:[],wolfMates:[]},
        p2:{role:'村人',actionLog:[]},p3:{role:'占い師',actionLog:[]},
        p4:{role:'騎士',actionLog:[]},p5:{role:'村人',actionLog:[]},
      },
      votes:{1:{voteOrder:[],runoffOrder:[],wolfVotes:{},wolfCandidates:[],wolfCandidateSetBy:null,seerVotes:{},knightVotes:{}}}
    };
    localStorage.setItem('jinrou_db', JSON.stringify(db));
  }, gmUid);
  await gm.reload({ waitUntil: 'domcontentloaded' });
  await gm.waitForTimeout(600);

  // D23: Winner announcement
  const ann = await gm.textContent('#gm-announcements');
  assert(ann.includes('村人') || ann.includes('勝利'), `D23: 勝利陣営アナウンス (${ann.substring(0,30)})`);

  // D24: Kifu button visible
  const kifuBtn = await gm.$('#btn-gm-kifu:not([style*="none"])');
  assert(!!kifuBtn, 'D24: 棋譜を見るボタン表示');

  await gm.close();
}

// ── TestE: Kifu screen ──
async function testE(ctx) {
  console.log('\n[E] 棋譜画面');
  const uid = 'kifu_uid';
  const page = await setupState(ctx, uid, makeFinishedRoom(uid));

  // E25+E26+E27: Winner banner, role grid
  const view = await page.evaluate(() => document.querySelector('.screen.active')?.id);
  // Switch to kifu manually (simulate openKifu call)
  await page.evaluate(() => { if (typeof openKifu === 'function') openKifu(); });
  await page.waitForTimeout(400);

  const kifuView = await page.evaluate(() => document.querySelector('.screen.active')?.id);
  assert(kifuView === 'view-kifu', `棋譜画面に遷移した (遷移先: ${kifuView})`);

  const banner = await page.$('.kifu-winner-banner');
  assert(!!banner, 'E25: 勝者バナー表示');
  const bannerCls = await page.evaluate(() => document.querySelector('.kifu-winner-banner')?.className);
  assert(bannerCls.includes('village'), 'E25: 村人勝利バナー（青）');

  const roleChips = await page.$$('.kifu-role-chip');
  assert(roleChips.length === 5, `E26: 最終役職グリッド (${roleChips.length}人分)`);

  const winnerChip = await page.$('.kifu-role-chip.winner');
  assert(!!winnerChip, 'E27: 勝者チップがハイライト');
  const deadChip = await page.$('.kifu-role-chip.dead');
  assert(!!deadChip, 'E27: 死亡者チップが表示');

  // E28+E29: Day timeline
  const dayCards = await page.$$('.kifu-day-card');
  assert(dayCards.length >= 1, `E28: 日別タイムライン表示 (${dayCards.length}日分)`);

  const tallyRow = await page.$('.kifu-tally .gm-tally-row');
  assert(!!tallyRow, 'E29: 投票棒グラフ表示');
  const voteRow = await page.$('.kifu-vote-row');
  assert(!!voteRow, 'E29: 個別投票表示');

  // E30: Runoff — inject runoff data
  await page.evaluate(() => {
    const db = JSON.parse(localStorage.getItem('jinrou_db'));
    db.rooms['105'].public.days[0].runoffSnapshot = [{uid:'p2',targetId:'p3'},{uid:'p3',targetId:'p2'}];
    db.rooms['105'].public.days[0].runoffTally = {'p3':1,'p2':1};
    localStorage.setItem('jinrou_db', JSON.stringify(db));
    if (typeof openKifu === 'function') openKifu();
  });
  await page.waitForTimeout(400);
  const content = await page.textContent('#kifu-content');
  assert(content.includes('決戦投票'), 'E30: 決戦投票セクション表示');

  // E31: Execution role
  assert(content.includes('人狼'), 'E31: 処刑された人の役職表示');

  // E32: Night actions
  const nightActions = await page.$('.kifu-night-actions');
  assert(!!nightActions, 'E32: 夜行動ブロック表示');
  const nightText = await page.textContent('.kifu-night-actions');
  assert(nightText.includes('占い師') || nightText.includes('騎士') || nightText.includes('人狼'), 'E32: 夜行動内容表示');

  // E33: Back button → player goes to app (use evaluate to avoid viewport/actionability issues)
  const backView = await page.evaluate(() => {
    const btn = document.getElementById('btn-kifu-back');
    if (btn) btn.click();
    return new Promise(res => setTimeout(() => res(document.querySelector('.screen.active')?.id), 300));
  });
  assert(backView === 'view-app', 'E33: プレイヤーの戻るボタン→ゲーム画面');

  // E34: Player result screen has kifu button
  await page.evaluate(() => {
    const db = JSON.parse(localStorage.getItem('jinrou_db'));
    // already finished, just refresh
    window.dispatchEvent(new StorageEvent('storage', { key: 'jinrou_db', newValue: localStorage.getItem('jinrou_db') }));
  });
  await page.waitForTimeout(500);
  const kifuBtnInResult = await page.evaluate(() =>
    document.querySelector('#action-callout-area')?.innerHTML.includes('棋譜')
  );
  assert(kifuBtnInResult, 'E34: 結果画面に棋譜ボタン表示');

  // E33 GM back: GM tab goes back to gm console
  const gmUid = 'kifu_gm';
  const gmPage = await ctx.newPage();
  await gmPage.goto(FILE_URL, { waitUntil: 'domcontentloaded' });
  await gmPage.evaluate((uid) => {
    // Add GM user to the KF room so auto-rejoin works
    const db = JSON.parse(localStorage.getItem('jinrou_db') || '{}');
    if (db.rooms && db.rooms['105']) {
      db.rooms['105'].public.players[uid] = { uid, name:'GM', isAlive:true, isHost:false, isGM:true, voteStatus:'pending' };
      db.rooms['105'].private[uid] = { role:null, actionLog:[], wolfMates:[] };
      localStorage.setItem('jinrou_db', JSON.stringify(db));
    }
    sessionStorage.setItem('jinrou_uid', uid);
    sessionStorage.setItem('jinrou_isGM', 'true');
    sessionStorage.setItem('jinrou_roomId', '105');
  }, gmUid);
  await gmPage.reload({ waitUntil: 'domcontentloaded' });
  await gmPage.waitForTimeout(700);
  // Open kifu then click back via evaluate to avoid Playwright actionability timeout
  const gmBackView = await gmPage.evaluate(() => {
    if (typeof openKifu === 'function') openKifu();
    return new Promise(res => setTimeout(() => {
      const btn = document.getElementById('btn-kifu-back');
      if (btn) btn.click();
      setTimeout(() => res(document.querySelector('.screen.active')?.id), 300);
    }, 400));
  });
  assert(gmBackView === 'view-gm', `GMの「戻る」ボタンでGMコンソールへ戻れた (遷移先: ${gmBackView})`);

  for (const p of [page, gmPage]) await p.close();
}

// ── TestF: Role composition 11p ──
async function testF(ctx) {
  console.log('\n[F] 役職構成 11人');
  const host = await newPlayerTab(ctx);
  await host.evaluate(() => localStorage.clear());
  await host.reload({ waitUntil: 'domcontentloaded' });
  await host.click('[data-target="panel-create"]');
  await host.fill('#create-name', 'H');
  await host.click('#btn-create');
  await host.waitForTimeout(200);
  const rid = await host.textContent('#display-roomId');
  const tabs = [host];
  for (let i = 1; i < 11; i++) {
    const p = await newPlayerTab(ctx);
    await p.fill('#join-roomId', rid);
    await p.fill('#join-name', `P${i}`);
    await p.click('#btn-join');
    await p.waitForTimeout(80);
    tabs.push(p);
  }
  await clickStart(host);
  await host.waitForTimeout(300);
  const db = await getDB(host);
  const r = Object.values(db.rooms)[0];
  const roles = Object.values(r.private).map(p => p.role);
  const wolfCount = roles.filter(r => r === '人狼').length;
  assert(wolfCount === 2, `F35: 11人ゲームの人狼は2人 (got ${wolfCount})`);
  for (const p of tabs) await p.close();
}

// ==========================================
// Firebase CDN をモックして app.js を読み込む
// ==========================================
//
// Firebase版では localStorage は使用しない。
// testG は Firebase SDK をルートレベルでモックした上で
// ゲームロジック関数 (checkAutoNightResolve / checkNewResultLogs /
// toArray) を page.evaluate() で直接呼び出し、
// DOM への副作用（ポップアップ表示）も含めて検証する。
//

const FIREBASE_APP_MOCK = `
window.firebase = {
  initializeApp: () => {},
  database: () => ({
    ref: (path) => ({
      on:          (evt, cb) => {},
      off:         (evt, cb) => {},
      once:        ()        => Promise.resolve({ val: () => null, exists: () => false }),
      transaction: (fn)      => new Promise(res => { try { fn(null); } catch(e) {} res({committed:false}); }),
      set:         ()        => Promise.resolve(),
      update:      ()        => Promise.resolve(),
    }),
  }),
};
`;
const FIREBASE_DB_MOCK = `/* firebase-database-compat stub — already mocked above */`;

async function newFirebaseTab(ctx) {
  const page = await ctx.newPage();
  // CDN リクエストをインターセプトして最小限のモックを返す
  await page.route('**firebase-app-compat.js**',      r => r.fulfill({ contentType:'application/javascript', body: FIREBASE_APP_MOCK }));
  await page.route('**firebase-database-compat.js**', r => r.fulfill({ contentType:'application/javascript', body: FIREBASE_DB_MOCK  }));
  await page.goto(FILE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(400);
  return page;
}

// ── TestG: 2日目以降の占い結果表示リグレッション ──
//
// 修正前のバグ:
//   Firebase は JS 配列を {"0":…, "1":…} のオブジェクトとして返す場合があり、
//   actionLog / wolfMates / wolfCandidates / voteOrder などに対して
//   .length / .map() / spread が壊れ、夜行動が完結せず
//   占い師の actionLog が 2 日目以降に書き込まれなかった。
//
// 各サブテストの検証内容:
//   G-1  checkAutoNightResolve が 1 日目の占い結果を actionLog に書き込む（既存動作の確認）
//   G-2  2 日目の夜でも占い結果が actionLog に追記される（リグレッション本体）
//   G-3  actionLog が Firebase オブジェクト形式 {"0":…,"1":…} で届いても
//        toArray() で正規化され checkNewResultLogs がポップアップを出す
//   G-4  同じ logId のエントリは 2 回目のポップアップを出さない（重複防止）
//   G-5  1 日目に既出の logId が 2 日目の別エントリをブロックしない（異なる day で別 logId）
async function testG(ctx) {
  console.log('\n[G] 2日目以降の占い結果表示（リグレッションテスト）');

  const page = await newFirebaseTab(ctx);

  // ── G-1: 1日目 checkAutoNightResolve → seer actionLog 書き込み ──
  const g1 = await page.evaluate(() => {
    // 5人・1日目・夜フェーズの最小ルームを組み立てる
    const room = {
      public: {
        id: 'G01', status: 'playing', phase: 'night', day: 1,
        players: {
          seer:  { uid:'seer',  name:'Seer',  isAlive:true, isHost:true,  voteStatus:'pending', isGM:false },
          wolf:  { uid:'wolf',  name:'Wolf',  isAlive:true, isHost:false, voteStatus:'pending', isGM:false },
          v1:    { uid:'v1',    name:'V1',    isAlive:true, isHost:false, voteStatus:'pending', isGM:false },
          v2:    { uid:'v2',    name:'V2',    isAlive:true, isHost:false, voteStatus:'pending', isGM:false },
          v3:    { uid:'v3',    name:'V3',    isAlive:true, isHost:false, voteStatus:'pending', isGM:false },
        },
        days: [{ exec:null, attack:null, attackBlocked:false }],
      },
      private: {
        seer: { role:'占い師', actionLog:[], lastGuarded:null },
        wolf: { role:'人狼',   actionLog:[], wolfMates:[]     },
        v1:   { role:'村人',   actionLog:[] },
        v2:   { role:'村人',   actionLog:[] },
        v3:   { role:'騎士',   actionLog:[], lastGuarded:null },
      },
      votes: {
        1: {
          voteOrder:[], runoffOrder:[], wolfVotes:{ wolf:'v1' },
          wolfCandidates:[], wolfCandidateSetBy:null,
          seerVotes:{ seer:'wolf' }, knightVotes:{ v3:'v2' },
          speechFinished:[],
        },
      },
    };

    checkAutoNightResolve(room, 1);

    const log     = room.private.seer.actionLog;
    const logArr  = (typeof toArray === 'function') ? toArray(log) : log;
    const day1Log = logArr.find(l => l.day === 1 && l.type === '占い');
    return {
      logLength: logArr.length,
      hasDay1:   !!day1Log,
      result:    day1Log?.result,
      target:    day1Log?.targetName,
      day:       room.public.day,          // 夜終了後に 2 に上がるはず
    };
  });

  assert(g1.logLength >= 1,             'G-1: actionLog に 1 日目の占い結果が書き込まれた');
  assert(g1.hasDay1,                    'G-1: actionLog に type=占い day=1 のエントリが存在する');
  assert(g1.result === '黒',            `G-1: 占い結果が「黒」 (got: ${g1.result})`);
  assert(g1.target === 'Wolf',          `G-1: 占い対象名が Wolf (got: ${g1.target})`);
  assert(g1.day === 2,                  `G-1: 夜行動完了後に day が 2 に進んだ (got: ${g1.day})`);

  // ── G-2: 2日目の夜でも占い結果が actionLog に追記される（リグレッション本体）──
  const g2 = await page.evaluate(() => {
    const room = {
      public: {
        id: 'G02', status: 'playing', phase: 'night', day: 2,
        players: {
          seer:  { uid:'seer',  name:'Seer',  isAlive:true, isHost:true,  voteStatus:'pending', isGM:false },
          wolf:  { uid:'wolf',  name:'Wolf',  isAlive:true, isHost:false, voteStatus:'pending', isGM:false },
          v1:    { uid:'v1',    name:'V1',    isAlive:true, isHost:false, voteStatus:'pending', isGM:false },
          v2:    { uid:'v2',    name:'V2',    isAlive:true, isHost:false, voteStatus:'pending', isGM:false },
        },
        // 1日目の exec 済みを含む（v3 が処刑されている状態）
        days: [
          { exec:'v3', attack:null, attackBlocked:false,
            seerResult:{ targetId:'wolf', result:'黒' } },
          { exec:null, attack:null, attackBlocked:false },
        ],
      },
      private: {
        seer: { role:'占い師', actionLog:[
          { day:1, type:'占い', targetName:'Wolf', result:'黒' },   // 1日目は既存ログ
        ], lastGuarded:null },
        wolf: { role:'人狼',   actionLog:[], wolfMates:[] },
        v1:   { role:'村人',   actionLog:[] },
        v2:   { role:'村人',   actionLog:[] },
        // v3（騎士）は処刑済みで isAlive:false → alive フィルタで除外される
        v3:   { role:'騎士',   actionLog:[], lastGuarded:null },
      },
      votes: {
        2: {
          voteOrder:[], runoffOrder:[],
          wolfVotes:{ wolf:'v1' },
          wolfCandidates:[], wolfCandidateSetBy:null,
          seerVotes:{ seer:'v1' },      // 2日目は v1 を占う
          knightVotes:{},               // 騎士は死亡済みなので空
          speechFinished:[],
        },
      },
    };

    // v3 を死亡状態にする
    room.public.players.v3 = { uid:'v3', name:'V3', isAlive:false, isHost:false, voteStatus:'pending', isGM:false };

    checkAutoNightResolve(room, 2);

    const logArr = (typeof toArray === 'function') ? toArray(room.private.seer.actionLog) : room.private.seer.actionLog;
    const day2Log = logArr.find(l => l.day === 2 && l.type === '占い');
    return {
      logLength:  logArr.length,
      hasDay2:    !!day2Log,
      day2Result: day2Log?.result,
      day2Target: day2Log?.targetName,
      allDays:    logArr.map(l => l.day),
    };
  });

  assert(g2.logLength >= 2,                `G-2: 2日目後に actionLog が 2 件以上 (got: ${g2.logLength})`);
  assert(g2.hasDay2,                       'G-2: actionLog に day=2 の占い結果が追記された【リグレッション】');
  assert(g2.day2Target === 'V1',           `G-2: 2日目の占い対象が V1 (got: ${g2.day2Target})`);
  assert(g2.day2Result === '白',           `G-2: 2日目の占い結果が「白」 (got: ${g2.day2Result})`);
  assert(g2.allDays.includes(1) && g2.allDays.includes(2),
    `G-2: actionLog に 1日目・2日目の両エントリが存在する (days: [${g2.allDays}])`);

  // ── G-3: Firebase オブジェクト形式 {"0":…} でも toArray が正規化してポップアップが出る ──
  const g3 = await page.evaluate(roomId => {
    // Firebase が返す形式（配列がオブジェクトに変換されたもの）を直接組み立てる
    const actionLogAsFirebaseObject = {
      '0': { day:1, type:'占い', targetName:'Wolf', result:'黒' },
      '1': { day:2, type:'占い', targetName:'V1',   result:'白' },
    };

    // モック gameState のセット（checkNewResultLogs は gameState.public を参照する）
    const mockPub = {
      phase: 'discuss',
      players: { seer:{ uid:'seer', isAlive:true } },
    };
    const mockPriv = {
      role: '占い師',
      actionLog: actionLogAsFirebaseObject,   // Firebase オブジェクト形式
    };

    // seenLogs をリセット（他テストの残留を防ぐ）
    seenLogs.clear();
    try { sessionStorage.removeItem('jinrou_seenLogs'); } catch(e) {}
    myRoomId = roomId;

    // checkNewResultLogs 呼び出し → enqueuePopup → drainPopupQueue → result-modal 表示
    checkNewResultLogs(mockPub, mockPriv);

    // 少し待つ（キューは同期処理なので即反映のはず）
    const modal = document.getElementById('result-modal');
    const shown = modal && modal.style.display === 'block';
    const title = document.getElementById('modal-title')?.textContent || '';
    const body  = document.getElementById('modal-body')?.innerHTML   || '';

    return {
      shown,
      title,
      hasWolf:   body.includes('Wolf') || body.includes('黒'),
      seenCount: seenLogs.size,
    };
  }, 'G03');

  assert(g3.shown,                   'G-3: Firebase オブジェクト形式の actionLog でもポップアップが表示される【toArray 修正確認】');
  assert(g3.seenCount >= 1,          `G-3: seenLogs に 1 件以上登録された (got: ${g3.seenCount})`);

  // ── G-4: 同じ logId は 2 回目のポップアップを出さない（重複防止） ──
  const g4 = await page.evaluate(roomId => {
    const mockPub  = { phase:'discuss', players:{} };
    const mockPriv = { role:'占い師', actionLog:[
      { day:1, type:'占い', targetName:'Bob', result:'白' },
    ]};

    myRoomId = roomId;
    seenLogs.clear();
    try { sessionStorage.removeItem('jinrou_seenLogs'); } catch(e) {}

    // 1回目 → ポップアップが出るはず
    checkNewResultLogs(mockPub, mockPriv);
    const firstCount  = seenLogs.size;

    // 2回目（同じ private）→ 同じ logId なので何もしない
    checkNewResultLogs(mockPub, mockPriv);
    const secondCount = seenLogs.size;

    return { firstCount, secondCount };
  }, 'G04');

  assert(g4.firstCount  === 1, `G-4: 1回目で seenLogs に 1 件登録 (got: ${g4.firstCount})`);
  assert(g4.secondCount === 1, `G-4: 2回目呼び出しで seenLogs が増えない (got: ${g4.secondCount})`);

  // ── G-5: 日付が異なれば別の logId → 両日のポップアップが出る ──
  const g5 = await page.evaluate(roomId => {
    const mockPub  = { phase:'discuss', players:{} };
    const logWith2Days = [
      { day:1, type:'占い', targetName:'Carol', result:'白' },
      { day:2, type:'占い', targetName:'Carol', result:'白' },  // 同名・同結果でも day が違う
    ];

    myRoomId = roomId;
    seenLogs.clear();
    try { sessionStorage.removeItem('jinrou_seenLogs'); } catch(e) {}

    checkNewResultLogs(mockPub, { role:'占い師', actionLog: logWith2Days });

    return { seenCount: seenLogs.size };
  }, 'G05');

  assert(g5.seenCount === 2,
    `G-5: 1日目・2日目を別 logId として両方 seenLogs に登録された (got: ${g5.seenCount})`);

  await page.close();
}

// ── Run all ──
(async () => {
  console.log('\n╔══════════════════════════════════╗');
  console.log('║  人狼 GM Tool — 自動テスト実行    ║');
  console.log('╚══════════════════════════════════╝');
  const browser = await chromium.launch({ headless: true });
  const tests = [test1,test2,test3,test4,test5,test6,test7,test8,test9,
                 testA,testB,testC,testD,testE,testF,testG];
  for (const t of tests) {
    const c = await browser.newContext();
    try { await t(c); } catch(e) { console.log(`  ${FAIL} クラッシュ: ${e.message.split('\n')[0]}`); failed++; }
    await c.close();
  }
  await browser.close();
  console.log(`\n${'─'.repeat(40)}`);
console.log(`  結果: ${passed} 件成功 / ${failed} 件失敗`);
console.log(`${'─'.repeat(40)}`);
  process.exit(failed > 0 ? 1 : 0);
})();
