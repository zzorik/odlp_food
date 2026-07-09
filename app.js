'use strict';
/* Завхоз · Ладога — вся клиентская логика. Ванильный JS, без сборки. */

// ================= состояние =================
const LS = { ost:'zavhoz.ostatki', camp:'zavhoz.camp', set:'zavhoz.settings' };
const load = (k, def) => { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? def; } catch { return def; } };
const save = (k, v) => localStorage.setItem(k, JSON.stringify(v));

let RASKLADKA = [];
let ostatki  = load(LS.ost, {});                                   // {"Гречка":1.2,...}  отсутствует = не пересчитано
let camp     = load(LS.camp, { lyudi:22, patrul:5, planDney:7, rezhim:'plan' });
let settings = load(LS.set, { workerUrl:'', model:'google/gemini-2.0-flash-001' });

const $  = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

// ================= расчёт закупки (порт zakupka.py) =================
const SHTUCHNYE = ['банка','шт','упак','десяток','кочан','бутылка','канистра','рулон','плитка','пачка'];
const IST_ORDER = ['Озон','Пятёрочка','Курки_Исмаил','Консервы'];
const IST_NAMES = {
  'Озон':'📦 ОЗОН (безнал, око телефон)',
  'Пятёрочка':'🛒 ПЯТЁРОЧКА (нал, НЕ на заправке)',
  'Курки_Исмаил':'🏪 КУРКИ ИСМАИЛ (у причала, заведующая)',
  'Консервы':'🐟 КОНСЕРВЫ (WhatsApp, через Мурмашку)',
};
const round1 = x => Math.round(x*10)/10;

function schitatZakupku(rask, ost, { lyudi, patrul=5, planDney=7, rezhim='plan' }){
  const eff = lyudi + patrul, poIst = {}, krit = [];
  const push = (i, it) => (poIst[i] ||= []).push(it);
  for (const p of rask){
    const ostatok = (p.pozitsiya in ost) ? ost[p.pozitsiya] : null;
    if (p.tip === 'масштаб'){
      if (p.rashod_v_den == null) continue;
      const rd = p.rashod_v_den * eff;
      const minZ = rd * (p.min_dney || 0);
      const cel  = rd * Math.min(p.celevoy_dney ?? planDney, planDney);
      let nuzhno, status;
      if (ostatok == null){ nuzhno = cel; status = '?'; }
      else if (ostatok < minZ){
        nuzhno = cel - ostatok; status = '🔴';
        krit.push({ pozitsiya:p.pozitsiya, ostalos_dney:round1(rd>0 ? ostatok/rd : 999), minimum_dney:p.min_dney });
      }
      else if (ostatok < cel){ nuzhno = cel - ostatok; status = '🟡'; }
      else continue;
      const sh = SHTUCHNYE.some(s => p.edinica.includes(s));
      nuzhno = sh ? Math.round(nuzhno + 0.4) : round1(nuzhno);
      if (nuzhno > 0) push(p.istochnik, { status, pozitsiya:p.pozitsiya, kolichestvo:nuzhno, edinica:p.edinica, fasovka:p.fasovka, zametki:p.zametki });
    }
    else if (p.tip === 'фикс'){
      if (p.fix_kolichestvo == null) continue;
      if (ostatok != null && ostatok < p.fix_kolichestvo)
        push(p.istochnik, { status:'⚪', pozitsiya:p.pozitsiya, kolichestvo:round1(p.fix_kolichestvo-ostatok), edinica:p.edinica, fasovka:p.fasovka, zametki:p.zametki });
      else if (ostatok == null)
        push(p.istochnik, { status:'?', pozitsiya:p.pozitsiya, kolichestvo:p.fix_kolichestvo, edinica:p.edinica, fasovka:p.fasovka, zametki:p.zametki });
    }
    else if (p.tip === 'при_окончании'){
      if (ostatok === 0)
        push(p.istochnik, { status:'⚪', pozitsiya:p.pozitsiya, kolichestvo:1, edinica:p.edinica, fasovka:p.fasovka, zametki:(p.zametki ? p.zametki+' (закончилось)' : 'закончилось') });
    }
  }
  return { kritichno:krit, po_istochnikam:poIst, parametry:{ lyudi, patrul, plan_dney:planDney, rezhim } };
}

// поиск позиции по имени (точно → вхождение), порт naiti_pozitsiyu
function naitiPozitsiyu(name){
  const n = name.toLowerCase().trim();
  return RASKLADKA.find(p => p.pozitsiya.toLowerCase() === n)
      || RASKLADKA.find(p => { const x = p.pozitsiya.toLowerCase(); return x.includes(n) || n.includes(x); })
      || null;
}

// ================= промпт (переиспользован из golos.py) =================
function buildPrompt(reqText){
  const pozicii = RASKLADKA.map(p => `- ${p.pozitsiya} (${p.edinica})`).join('\n');
  return `Ты помощник завхоза лагеря на Ладоге. Завхоз голосом наговаривает, что лежит на складе. Тебе нужно разобрать его речь в структурированный JSON.

ГЛАВНОЕ ПРАВИЛО: всегда приводи количества к БАЗОВЫМ единицам, указанным в раскладке:
- Позиции с единицей «кг» → в килограммах (4 пачки по 900 г = 3.6 кг)
- Позиции с единицей «л» → в литрах
- Позиции с единицей «шт», «десяток», «кочан» → в штуках/десятках/кочанах

Правила разбора речи:
- Завхоз может говорить в любом порядке, перескакивая между позициями
- Может возвращаться к позиции: «а, ещё одна тушёнка нашлась» — прибавь
- «Треть пачки», «половина», «на глаз» — округляй разумно, детали пиши в поле «детали»
- Банки бывают разные — обязательно учитывай вес: «5 банок по 500 г» = 2.5 кг
- Если сказан только вес — просто суммируй веса
- Если сказано только количество без веса, а позиция взвешивается — положи кусок в «непонятно»

Формат ответа — ТОЛЬКО валидный JSON, без пояснений и markdown:
{
  "позиции": { "<название из раскладки>": { "количество": <число>, "единица": "<кг/л/шт/десяток/кочан>", "детали": "<как было сказано>" } },
  "непонятно": ["<куски речи, которые не удалось разобрать>"]
}

Список позиций раскладки (используй ТОЧНО эти названия слева):
${pozicii}

${reqText}`;
}

// ================= сеть → OpenRouter через Worker =================
async function callModel(messages){
  if (!settings.workerUrl) throw new Error('нет URL Worker — задай в ⚙');
  const res = await fetch(settings.workerUrl, {
    method:'POST', headers:{ 'Content-Type':'application/json' },
    body: JSON.stringify({ model:settings.model, messages, response_format:{type:'json_object'}, temperature:0 }),
  });
  if (!res.ok) throw new Error(`Worker/OpenRouter ${res.status}: ${(await res.text()).slice(0,180)}`);
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content ?? '';
  let raw = content.trim();
  if (raw.startsWith('```')){ raw = raw.replace(/^```(json)?/i,'').replace(/```$/,'').trim(); }
  return JSON.parse(raw);
}

async function parseText(text){
  const messages = [{ role:'user', content: buildPrompt(`Речь завхоза (текст):\n${text}`) }];
  return callModel(messages);
}
async function parseAudio(wavB64){
  const messages = [{ role:'user', content: [
    { type:'text', text: buildPrompt('Речь завхоза — в приложенном аудио. Расшифруй её и разбери.') },
    { type:'input_audio', input_audio:{ data: wavB64, format:'wav' } },
  ]}];
  return callModel(messages);
}

// ================= запись голоса → WAV 16кГц моно =================
let mediaRec = null, chunks = [], recTimer = null, recStart = 0;

async function toggleMic(){
  if (mediaRec && mediaRec.state === 'recording'){ mediaRec.stop(); return; }
  if (!settings.workerUrl){ toast('Сначала задай URL Worker в ⚙'); switchView('settings'); return; }
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio:true }); }
  catch { toast('Нет доступа к микрофону'); return; }
  chunks = [];
  const mime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm'
            : MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : '';
  mediaRec = new MediaRecorder(stream, mime ? { mimeType:mime } : undefined);
  mediaRec.ondataavailable = e => e.data.size && chunks.push(e.data);
  mediaRec.onstop = async () => {
    stream.getTracks().forEach(t => t.stop());
    setRec(false);
    const blob = new Blob(chunks, { type: mediaRec.mimeType || 'audio/webm' });
    try {
      setStatus('Расшифровываю и разбираю…');
      const wavB64 = await blobToWavB64(blob);
      const parsed = await parseAudio(wavB64);
      showConfirm(parsed);
      setStatus('', true);
    } catch (e){ setStatus('Ошибка: ' + e.message, false, true); }
  };
  mediaRec.start();
  setRec(true);
}

function setRec(on){
  const b = $('#micBtn');
  b.classList.toggle('rec', on);
  if (on){
    recStart = Date.now();
    recTimer = setInterval(() => {
      const s = Math.floor((Date.now()-recStart)/1000);
      $('.mic-label').textContent = `Стоп · ${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;
    }, 250);
  } else {
    clearInterval(recTimer);
    $('.mic-label').textContent = 'Записать голосом';
  }
}

// декодируем что угодно → PCM моно 16кГц → WAV base64
async function blobToWavB64(blob){
  const arrBuf = await blob.arrayBuffer();
  const AC = window.AudioContext || window.webkitAudioContext;
  const tmp = new AC();
  const decoded = await tmp.decodeAudioData(arrBuf.slice(0));
  tmp.close?.();
  const targetRate = 16000;
  const off = new OfflineAudioContext(1, Math.ceil(decoded.duration*targetRate), targetRate);
  const src = off.createBufferSource(); src.buffer = decoded; src.connect(off.destination); src.start();
  const rendered = await off.startRendering();
  const wav = encodeWav(rendered.getChannelData(0), targetRate);
  return arrayBufferToBase64(wav);
}
function encodeWav(samples, rate){
  const buf = new ArrayBuffer(44 + samples.length*2), v = new DataView(buf);
  const w = (o,s) => { for (let i=0;i<s.length;i++) v.setUint8(o+i, s.charCodeAt(i)); };
  w(0,'RIFF'); v.setUint32(4, 36+samples.length*2, true); w(8,'WAVE'); w(12,'fmt ');
  v.setUint32(16,16,true); v.setUint16(20,1,true); v.setUint16(22,1,true);
  v.setUint32(24,rate,true); v.setUint32(28,rate*2,true); v.setUint16(32,2,true); v.setUint16(34,16,true);
  w(36,'data'); v.setUint32(40, samples.length*2, true);
  let o = 44;
  for (let i=0;i<samples.length;i++){ const s = Math.max(-1,Math.min(1,samples[i])); v.setInt16(o, s<0?s*0x8000:s*0x7fff, true); o+=2; }
  return buf;
}
function arrayBufferToBase64(buf){
  let bin=''; const bytes=new Uint8Array(buf), chunk=0x8000;
  for (let i=0;i<bytes.length;i+=chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i,i+chunk));
  return btoa(bin);
}

// ================= подтверждение распознанного =================
let pendingItems = [];
function showConfirm(parsed){
  pendingItems = [];
  const pos = parsed?.['позиции'] || {};
  for (const [name, d] of Object.entries(pos)){
    const p = naitiPozitsiyu(name);
    if (!p) continue;
    const qty = Number(d['количество']);
    if (!isFinite(qty)) continue;
    pendingItems.push({ pozitsiya:p.pozitsiya, edinica:p.edinica, qty, detali:d['детали']||'' });
  }
  const unknown = parsed?.['непонятно'] || [];
  const box = $('#confirm');
  if (!pendingItems.length && !unknown.length){
    box.innerHTML = `<div class="empty">Ничего не разобрал 🤷 Попробуй ещё раз, чётче по позициям.</div>`;
    box.hidden = false; return;
  }
  box.innerHTML =
    `<h3>Распознал — что записываем?</h3>` +
    pendingItems.map((it,i)=>`
      <label class="cf-item">
        <input type="checkbox" data-i="${i}" checked>
        <span class="cf-name">${esc(it.pozitsiya)}
          ${it.detali?`<small class="cf-det">${esc(it.detali)}</small>`:''}
        </span>
        <span class="cf-qty">${it.qty} ${esc(it.edinica)}</span>
      </label>`).join('') +
    (unknown.length?`<div class="cf-unknown">🤔 не разобрал: ${unknown.map(esc).join(' · ')}</div>`:'') +
    `<div class="cf-actions">
       <button class="btn" id="cfCancel">Отмена</button>
       <button class="btn btn-primary" id="cfSave">Записать в остатки</button>
     </div>`;
  box.hidden = false;
  $('#cfCancel').onclick = () => { box.hidden = true; };
  $('#cfSave').onclick = () => {
    const checked = $$('#confirm input[type=checkbox]').filter(c=>c.checked).map(c=>+c.dataset.i);
    for (const i of checked){ const it = pendingItems[i]; ostatki[it.pozitsiya] = it.qty; }
    save(LS.ost, ostatki); box.hidden = true; renderOstatki();
    toast(`Записал: ${checked.length} поз.`);
  };
}

// ================= рендер: остатки =================
function renderOstatki(){
  const q = ($('#ostSearch').value||'').toLowerCase().trim();
  const list = $('#ostList'); list.innerHTML = '';
  const byCat = {};
  for (const p of RASKLADKA){
    if (q && !p.pozitsiya.toLowerCase().includes(q)) continue;
    (byCat[p.kategoriya] ||= []).push(p);
  }
  for (const [cat, items] of Object.entries(byCat)){
    const wrap = document.createElement('div'); wrap.className='cat';
    wrap.innerHTML = `<div class="cat-title">${esc(cat)}</div>`;
    for (const p of items){
      const has = p.pozitsiya in ostatki;
      const row = document.createElement('div');
      row.className = 'row' + (has?' has-val':'');
      row.innerHTML =
        `<span class="row-name">${esc(p.pozitsiya)}${p.fasovka?`<small>${esc(p.fasovka)}</small>`:''}</span>
         <input class="row-in${has?' filled':''}" type="number" inputmode="decimal" step="any"
                placeholder="—" value="${has?ostatki[p.pozitsiya]:''}" aria-label="${esc(p.pozitsiya)}">
         <span class="row-unit">${esc(p.edinica)}</span>
         <button class="row-x" title="убрать">×</button>`;
      const inp = row.querySelector('.row-in');
      inp.addEventListener('input', () => {
        const val = inp.value.trim().replace(',', '.');
        if (val === ''){ delete ostatki[p.pozitsiya]; row.classList.remove('has-val'); inp.classList.remove('filled'); }
        else { const n = parseFloat(val); if (isFinite(n)){ ostatki[p.pozitsiya]=n; row.classList.add('has-val'); inp.classList.add('filled'); } }
        saveOstDebounced(); updateOstStat();
      });
      row.querySelector('.row-x').addEventListener('click', () => {
        delete ostatki[p.pozitsiya]; save(LS.ost, ostatki); renderOstatki(); updateOstStat();
      });
      wrap.appendChild(row);
    }
    list.appendChild(wrap);
  }
  updateOstStat();
}
let saveT; const saveOstDebounced = () => { clearTimeout(saveT); saveT = setTimeout(()=>save(LS.ost, ostatki), 400); };
function updateOstStat(){ $('#ostFilled').textContent = Object.keys(ostatki).length; $('#ostTotal').textContent = RASKLADKA.length; }

// ================= рендер: закупка =================
function renderZakupka(){
  const hide = $('#hideUnknown').checked;
  const res = schitatZakupku(RASKLADKA, ostatki, camp);
  const box = $('#zkResult'); box.innerHTML = '';

  if (res.kritichno.length){
    const k = document.createElement('div'); k.className='krit';
    k.innerHTML = `<h3>🔴 Критично — запас ниже минимума</h3><ul>` +
      res.kritichno.map(c=>`<li><b>${esc(c.pozitsiya)}</b> — на ${c.ostalos_dney} дн (мин ${c.minimum_dney})</li>`).join('') + `</ul>`;
    box.appendChild(k);
  }

  let anything = false;
  for (const ist of IST_ORDER){
    let items = res.po_istochnikam[ist]; if (!items) continue;
    if (hide) items = items.filter(it => it.status !== '?');
    if (!items.length) continue;
    anything = true;
    const card = document.createElement('div'); card.className='card src';
    const plain = plainList(ist, items);
    card.innerHTML =
      `<div class="src-head"><h3>${esc(IST_NAMES[ist]||ist)}</h3>
         <button class="copybtn">📋 Копировать</button></div>` +
      items.map(it=>`
        <div class="zk-item">
          <span class="zk-dot">${it.status}</span>
          <span class="zk-nm"><b class="zk-qty">${it.kolichestvo} ${esc(it.edinica)}</b> ${esc(it.pozitsiya)}
            ${it.fasovka?`<span class="zk-fas"> · ${esc(it.fasovka)}</span>`:''}
            ${it.zametki?`<span class="zk-zm">⚠ ${esc(it.zametki)}</span>`:''}
          </span>
        </div>`).join('');
    const btn = card.querySelector('.copybtn');
    btn.addEventListener('click', () => copy(plain, btn));
    box.appendChild(card);
  }

  if (!res.kritichno.length && !anything){
    box.innerHTML = `<div class="empty">Всё под завязку 🎉 либо остатки не введены.<br>Заполни таблицу на вкладке «Остатки».</div>`;
    return;
  }
  const lg = document.createElement('div'); lg.className='legend';
  lg.textContent = '🔴 критично · 🟡 плановое · ⚪ фикс · ? не пересчитано';
  box.appendChild(lg);
}
function plainList(ist, items){
  const lines = [ (IST_NAMES[ist]||ist).replace(/^[^ ]+ /,'') ]; // без эмодзи в начале
  for (const it of items){
    let l = `${it.status} ${it.pozitsiya} — ${it.kolichestvo} ${it.edinica}`;
    if (it.fasovka) l += ` (${it.fasovka})`;
    if (it.zametki) l += ` · ${it.zametki}`;
    lines.push(l);
  }
  return lines.join('\n');
}

// ================= копирование / тосты =================
async function copy(text, btn){
  try { await navigator.clipboard.writeText(text); }
  catch { const ta=document.createElement('textarea'); ta.value=text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); }
  if (btn){ btn.classList.add('done'); const t=btn.textContent; btn.textContent='✓ Скопировано'; setTimeout(()=>{btn.classList.remove('done');btn.textContent=t;},1400); }
  toast('Скопировано в буфер');
}
let toastT;
function toast(msg){ const t=$('#toast'); t.textContent=msg; t.hidden=false; clearTimeout(toastT); toastT=setTimeout(()=>t.hidden=true,2200); }
function setStatus(msg, done=false, err=false){
  const s=$('#parseStatus');
  if (!msg){ s.hidden = true; return; }
  s.hidden=false; s.textContent=msg; s.classList.toggle('err', err);
  if (done) setTimeout(()=>{ s.hidden=true; }, 800);
}
const esc = s => String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

// ================= навигация / формы =================
function switchView(name){
  $$('.tab').forEach(t=>t.classList.toggle('is-active', t.dataset.view===name));
  $$('.view').forEach(v=>v.classList.toggle('is-active', v.id==='view-'+name));
  if (name==='zakupka') renderZakupka();
}
function initTabs(){ $$('.tab').forEach(t=>t.addEventListener('click', ()=>switchView(t.dataset.view))); }

function initCampForm(){
  $('#fLyudi').value=camp.lyudi; $('#fPatrul').value=camp.patrul; $('#fPlan').value=camp.planDney;
  $$('.seg').forEach(b=>b.classList.toggle('is-active', b.dataset.rezhim===camp.rezhim));
  const upd = () => {
    camp.lyudi = +$('#fLyudi').value||0; camp.patrul = +$('#fPatrul').value||0; camp.planDney = +$('#fPlan').value||1;
    save(LS.camp, camp);
  };
  ['#fLyudi','#fPatrul','#fPlan'].forEach(s=>$(s).addEventListener('input', upd));
  $$('.seg').forEach(b=>b.addEventListener('click', ()=>{
    camp.rezhim=b.dataset.rezhim; save(LS.camp,camp);
    $$('.seg').forEach(x=>x.classList.toggle('is-active', x===b));
  }));
}

function initSettings(){
  $('#sWorker').value=settings.workerUrl; $('#sModel').value=settings.model;
  const upd = () => { settings.workerUrl=$('#sWorker').value.trim(); settings.model=$('#sModel').value.trim()||'google/gemini-2.0-flash-001'; save(LS.set,settings); };
  $('#sWorker').addEventListener('input',upd); $('#sModel').addEventListener('input',upd);
  $('#sExport').addEventListener('click', ()=>{
    const blob=new Blob([JSON.stringify({ostatki,camp,settings},null,2)],{type:'application/json'});
    const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='zavhoz-backup.json'; a.click();
  });
  $('#sReset').addEventListener('click', ()=>{
    if (!confirm('Сбросить остатки, параметры лагеря и настройки?')) return;
    localStorage.removeItem(LS.ost); localStorage.removeItem(LS.camp); localStorage.removeItem(LS.set);
    ostatki={}; camp={lyudi:22,patrul:5,planDney:7,rezhim:'plan'}; settings={workerUrl:'',model:'google/gemini-2.0-flash-001'};
    initCampForm(); $('#sWorker').value=''; $('#sModel').value=settings.model; renderOstatki(); toast('Сброшено');
  });
}

function initVoice(){
  $('#micBtn').addEventListener('click', toggleMic);
  $('#typeToggle').addEventListener('click', ()=>{ const b=$('#typeBox'); b.hidden=!b.hidden; });
  $('#typeSend').addEventListener('click', async ()=>{
    const t=$('#typeArea').value.trim(); if(!t){ toast('Пусто'); return; }
    try { setStatus('Разбираю текст…'); const p=await parseText(t); showConfirm(p); setStatus('',true); }
    catch(e){ setStatus('Ошибка: '+e.message,false,true); }
  });
  if (!settings.workerUrl){ $('#micBtn').disabled=false; } // не блокируем — по клику подскажем
}

function initNet(){
  const upd=()=>$('#net').classList.toggle('off', !navigator.onLine);
  addEventListener('online',upd); addEventListener('offline',upd); upd();
}

// ================= старт =================
async function boot(){
  initTabs(); initNet();
  try {
    const r = await fetch('raskladka.json'); RASKLADKA = await r.json();
  } catch(e){ toast('Не загрузилась раскладка'); return; }
  renderOstatki();
  $('#ostSearch').addEventListener('input', renderOstatki);
  $('#ostClear').addEventListener('click', ()=>{ if(confirm('Очистить все введённые остатки?')){ ostatki={}; save(LS.ost,ostatki); renderOstatki(); }});
  $('#calcBtn').addEventListener('click', renderZakupka);
  $('#hideUnknown').addEventListener('change', renderZakupka);
  initCampForm(); initSettings(); initVoice();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(()=>{});
}
boot();
