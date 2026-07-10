'use strict';
/* Завхоз · Ладога — вся клиентская логика. Ванильный JS, без сборки. */
const BUILD = '2026-07-09 · сборка 5 (редактор позиций)';

// ================= состояние =================
const LS = { ost:'zavhoz.ostatki', ostRaw:'zavhoz.ostatkiRaw', camp:'zavhoz.camp', set:'zavhoz.settings', redits:'zavhoz.raskladkaEdits' };
const load = (k, def) => { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? def; } catch { return def; } };
const save = (k, v) => localStorage.setItem(k, JSON.stringify(v));

let RASKLADKA = [];
let RASKLADKA_BASE = [];                                           // как в raskladka.json (репозиторий)
let redits = load(LS.redits, { added:[], edited:{}, removed:[] }); // правки поверх базы, живут в браузере
const POS_META = new Map();                                        // текущее имя → {origin:'base'|'added', baseName}

// merged = база − удалённые + правки + добавленные
function rebuildRaskladka(){
  POS_META.clear();
  const removed = new Set(redits.removed);
  const out = [];
  for (const p of RASKLADKA_BASE){
    if (removed.has(p.pozitsiya)) continue;
    const item = redits.edited[p.pozitsiya] ? { ...p, ...redits.edited[p.pozitsiya] } : p;
    POS_META.set(item.pozitsiya, { origin:'base', baseName:p.pozitsiya });
    out.push(item);
  }
  for (const a of redits.added){
    POS_META.set(a.pozitsiya, { origin:'added', baseName:null });
    out.push(a);
  }
  RASKLADKA = out;
}
let ostatki    = load(LS.ost, {});                                 // {"Гречка":1.2,...} в базовых единицах; отсутствует = не пересчитано
let ostatkiRaw = load(LS.ostRaw, {});                              // {"Рис":"2×450г+4×700г+2кг",...} как ввели/сказали — для показа
let camp     = load(LS.camp, { lyudi:22, patrul:5, planDney:7, rezhim:'plan' });
let settings = load(LS.set, { workerUrl:'', model:'google/gemini-2.0-flash-001' });

const $  = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

// ================= расчёт закупки (порт zakupka.py) =================
const SHTUCHNYE = ['банка','шт','упак','десяток','кочан','бутылка','канистра','рулон','плитка','пачка'];
const IST_ORDER = ['Озон','Пятёрочка','Курки','Исмаил','Консервы'];
const IST_NAMES = {
  'Озон':'📦 ОЗОН (безнал, око телефон)',
  'Пятёрочка':'🛒 ПЯТЁРОЧКА (нал, НЕ на заправке)',
  'Курки':'🍪 КУРКИ (печенье/сушки, у причала)',
  'Исмаил':'🥬 ИСМАИЛ (овощи-фрукты, у причала)',
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

// ================= парсер количества с пачками =================
// Понимает: "5.7" · "2х450г 4х700 2кг" · "1 мешок 2 кг" · "3 по 0,9л" · "2 десятка"
// Для кг/л складывает пачки в базовую единицу. Для шт/десяток/кочан — просто считает.
function amountKind(edinica){
  const e = (edinica||'').toLowerCase();
  if (e.includes('кг')) return { base:'кг', small:'г',  measure:true };
  if (e.includes('л'))  return { base:'л',  small:'мл', measure:true };
  return { base:edinica, small:null, measure:false };
}
const CONTAINER = /(пачк\w*|мешо?к\w*|мешк\w*|банк\w*|бутыл\w*|коробк\w*)/;
// определить единицу в куске текста (без \b — он ломается на кириллице)
function detectUnit(t){
  if (/кг|kg/.test(t)) return 'кг';
  if (/мл|ml/.test(t)) return 'мл';
  if (/(?:гр|г|g)(?![а-яёa-z])/i.test(t)) return 'г';
  if (/(?:л|l)(?![а-яёa-z])/i.test(t))   return 'л';
  return null;
}
// size в единице `unit` → в «маленькую» (г/мл). packish: безъединичное считать пачкой (г/мл), иначе базой (кг/л)
function toSmall(size, unit, packish){
  if (unit === 'кг' || unit === 'л')      return size * 1000;
  if (unit === 'г'  || unit === 'мл')     return size;
  return packish ? size : size * 1000;
}
// → { ok, value(базовые ед.), pretty(нормализованная строка) } или { ok:false }
function parseAmount(raw, edinica){
  const kind = amountKind(edinica);
  let s = (raw||'').toString().toLowerCase().trim();
  if (!s) return { ok:false };
  s = s.replace(/(\d)[.,](\d)/g, '$1.$2');                 // десятичная запятая → точка (0,9 → 0.9)
  const terms = s.split(/[,;+\n]+/).map(t=>t.trim()).filter(Boolean);
  let totalSmall = 0, totalCount = 0, anyNum = false;
  const parts = [];
  const add = (count, size, unit, packish) => {
    anyNum = true;
    if (kind.measure){
      const small = toSmall(size, unit, packish) * count;
      totalSmall += small;
      parts.push(count > 1 ? `${count}×${size}${unit||kind.small}` : `${size}${unit||(packish?kind.small:kind.base)}`);
    } else {
      totalCount += count * size;
      parts.push(count > 1 ? `${count}×${size}` : `${size}`);
    }
  };
  for (let t of terms){
    const cont = t.match(CONTAINER);
    if (cont){
      // «1 мешок 2 кг», «2 пачки по 450» → одна пачка на терм: count перед контейнером, size после
      const before = t.slice(0, cont.index);
      const after  = t.slice(cont.index + cont[0].length);
      const cm = before.match(/(\d+(?:\.\d+)?)\s*$/);
      const count = cm ? Number(cm[1]) : 1;
      const sm = after.match(/\d+(?:\.\d+)?/);
      if (sm){ add(count, Number(sm[0]), detectUnit(after) || detectUnit(t), true); }
      else if (!kind.measure){ add(count, 1, null, false); }   // «5 банок» штучного → 5
      else { anyNum = true; parts.push(`${count}шт?`); }        // мешок без веса — не знаем массу
      continue;
    }
    // без контейнера: нормализуем множители и вытаскиваем группы «count × size unit» и одиночные числа
    let n = (' ' + t + ' ').replace(/[×хx*]/gi, ' x ').replace(/ по /g, ' x ').replace(/ на /g, ' x ');
    const re = /(\d+(?:\.\d+)?)(?:\s*x\s*(\d+(?:\.\d+)?))?\s*(кг|kg|мл|ml|гр|г|g|л|l)?/gi;
    let m, found = false;
    while ((m = re.exec(n)) !== null){
      if (m[0].trim() === '') { re.lastIndex++; continue; }
      found = true;
      const mult = m[2] != null;
      const count = mult ? Number(m[1]) : 1;
      const size  = mult ? Number(m[2]) : Number(m[1]);
      const unit  = m[3] ? detectUnit(m[3]) : null;
      add(count, size, unit, mult);                            // одиночное без ед. → база; с ×  → пачка
    }
    if (!found) continue;
  }
  if (!anyNum) return { ok:false };
  const value = kind.measure ? Math.round(totalSmall/1000 * 1000)/1000 : totalCount;
  return { ok:true, value, pretty: parts.join(' + ') };
}
// это выражение (а не просто число)? — чтобы решать, показывать ли расшифровку
function isExpr(raw){ return /[^\d.,\s]/.test((raw||'').toString()); }

// ================= редактор позиций =================
let peCur = null; // текущее имя редактируемой позиции или null для новой

function peFillSelects(){
  const eds = [...new Set(['кг','л','шт','десяток','кочан', ...RASKLADKA.map(p=>p.edinica).filter(Boolean)])];
  $('#peEd').innerHTML  = eds.map(e=>`<option>${esc(e)}</option>`).join('');
  $('#peIst').innerHTML = IST_ORDER.map(i=>`<option>${esc(i)}</option>`).join('');
  $('#peCatList').innerHTML = [...new Set(RASKLADKA.map(p=>p.kategoriya))].map(c=>`<option value="${esc(c)}">`).join('');
}
function peTipSync(){
  const t = $('#peTip').value;
  $('.pe-masshtab').hidden = (t !== 'масштаб');
  $('.pe-fix').hidden = (t !== 'фикс');
}
function openPosEditor(name){
  peCur = name;
  peFillSelects();
  const p = name ? RASKLADKA.find(x=>x.pozitsiya===name) : null;
  $('#peTitle').textContent = p ? 'Изменить позицию' : 'Новая позиция';
  $('#peName').value   = p ? p.pozitsiya : '';
  $('#peCat').value    = p ? p.kategoriya : '';
  $('#peEd').value     = p ? p.edinica : 'кг';
  $('#peIst').value    = p ? p.istochnik : IST_ORDER[0];
  $('#peTip').value    = p ? p.tip : 'масштаб';
  $('#peRashod').value = p && p.rashod_v_den   != null ? p.rashod_v_den   : '';
  $('#peMin').value    = p && p.min_dney       != null ? p.min_dney       : '';
  $('#peCel').value    = p && p.celevoy_dney   != null ? p.celevoy_dney   : '';
  $('#peFix').value    = p && p.fix_kolichestvo!= null ? p.fix_kolichestvo: '';
  $('#peFas').value    = p ? p.fasovka : '';
  $('#peZam').value    = p ? p.zametki : '';
  $('#peDelete').hidden = !p;
  peTipSync();
  $('#posEditor').hidden = false;
  $('#peName').focus();
}
function closePosEditor(){ $('#posEditor').hidden = true; peCur = null; }

function peCollect(){
  const num = v => { const s=(v||'').toString().trim().replace(',','.'); if(s==='')return null; const n=parseFloat(s); return isFinite(n)?n:null; };
  const int = v => { const n=num(v); return n==null?null:Math.round(n); };
  return {
    kategoriya: $('#peCat').value.trim() || 'Разное',
    pozitsiya:  $('#peName').value.trim(),
    edinica:    $('#peEd').value,
    rashod_v_den: num($('#peRashod').value),
    min_dney:     int($('#peMin').value),
    celevoy_dney: int($('#peCel').value),
    fix_kolichestvo: num($('#peFix').value),
    fasovka: $('#peFas').value.trim(),
    zametki: $('#peZam').value.trim(),
    istochnik: $('#peIst').value,
    tip: $('#peTip').value,
  };
}
function peSave(){
  const obj = peCollect();
  if (!obj.pozitsiya){ toast('Название пустое'); return; }
  const clash = RASKLADKA.find(x => x.pozitsiya === obj.pozitsiya && x.pozitsiya !== peCur);
  if (clash){ toast('Такая позиция уже есть'); return; }
  if (obj.tip === 'масштаб'){
    if (!(obj.rashod_v_den > 0)){ toast('Для типа «масштаб» нужен расход на чел/день'); return; }
    if (obj.min_dney == null) obj.min_dney = 3;
    if (obj.celevoy_dney == null) obj.celevoy_dney = 7;
  }
  if (obj.tip === 'фикс' && !(obj.fix_kolichestvo > 0)){ toast('Для типа «фикс» нужно количество'); return; }
  if (peCur){
    const meta = POS_META.get(peCur);
    if (meta.origin === 'base') redits.edited[meta.baseName] = obj;
    else {
      const i = redits.added.findIndex(a => a.pozitsiya === peCur);
      if (i >= 0) redits.added[i] = obj; else redits.added.push(obj);
    }
    if (obj.pozitsiya !== peCur){                       // переименование → переносим остаток
      if (peCur in ostatki){ ostatki[obj.pozitsiya] = ostatki[peCur]; delete ostatki[peCur]; }
      if (peCur in ostatkiRaw){ ostatkiRaw[obj.pozitsiya] = ostatkiRaw[peCur]; delete ostatkiRaw[peCur]; }
      save(LS.ost, ostatki); save(LS.ostRaw, ostatkiRaw);
    }
  } else {
    redits.added.push(obj);
  }
  save(LS.redits, redits); rebuildRaskladka(); renderOstatki(); updateOstStat();
  closePosEditor(); toast('Сохранено');
}
function peDelete(){
  if (!peCur) return;
  if (!confirm(`Удалить позицию «${peCur}»?`)) return;
  const meta = POS_META.get(peCur);
  if (meta.origin === 'base'){ redits.removed.push(meta.baseName); delete redits.edited[meta.baseName]; }
  else redits.added = redits.added.filter(a => a.pozitsiya !== peCur);
  delete ostatki[peCur]; delete ostatkiRaw[peCur];
  save(LS.ost, ostatki); save(LS.ostRaw, ostatkiRaw); save(LS.redits, redits);
  rebuildRaskladka(); renderOstatki(); updateOstStat();
  closePosEditor(); toast('Удалено');
}
function initPosEditor(){
  $('#posAdd').addEventListener('click', () => openPosEditor(null));
  $('#peSave').addEventListener('click', peSave);
  $('#peCancel').addEventListener('click', closePosEditor);
  $('#peDelete').addEventListener('click', peDelete);
  $('#peTip').addEventListener('change', peTipSync);
  $('#posEditor').addEventListener('click', e => { if (e.target.id === 'posEditor') closePosEditor(); });
  $('#sRaskladka').addEventListener('click', () => {
    const clean = RASKLADKA.map(({kategoriya,pozitsiya,edinica,rashod_v_den,min_dney,celevoy_dney,fix_kolichestvo,fasovka,zametki,istochnik,tip}) =>
      ({kategoriya,pozitsiya,edinica,rashod_v_den,min_dney,celevoy_dney,fix_kolichestvo,fasovka,zametki,istochnik,tip}));
    const blob = new Blob([JSON.stringify(clean,null,1)],{type:'application/json'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'raskladka.json'; a.click();
    URL.revokeObjectURL(a.href);
    toast('Скачано — положи в репозиторий вместо старой');
  });
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
    for (const i of checked){
      const it = pendingItems[i];
      ostatki[it.pozitsiya] = it.qty;
      ostatkiRaw[it.pozitsiya] = it.detali || String(it.qty);
    }
    save(LS.ost, ostatki); save(LS.ostRaw, ostatkiRaw); box.hidden = true; renderOstatki();
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
      const kind = amountKind(p.edinica);
      const rawInit = has ? (ostatkiRaw[p.pozitsiya] ?? String(ostatki[p.pozitsiya])) : '';
      const row = document.createElement('div');
      row.className = 'row' + (has?' has-val':'');
      row.innerHTML =
        `<span class="row-name">${esc(p.pozitsiya)}</span>
         <input class="row-in${has?' filled':''}" type="text" inputmode="${kind.measure?'text':'decimal'}"
                placeholder="—" value="${esc(rawInit)}" aria-label="${esc(p.pozitsiya)}"
                ${kind.measure?`title="можно пачками: 2×450г 4×700 2кг"`:''}>
         <span class="row-unit">${esc(p.edinica)}</span>
         <button class="row-x" title="убрать">×</button>
         <small class="row-calc" hidden></small>`;
      const inp  = row.querySelector('.row-in');
      const calc = row.querySelector('.row-calc');
      row.querySelector('.row-name').addEventListener('click', () => openPosEditor(p.pozitsiya));
      const showCalc = (raw, r) => {
        if (r && r.ok && isExpr(raw)) { calc.textContent = `= ${r.value} ${p.edinica} · ${r.pretty}`; calc.hidden = false; }
        else calc.hidden = true;
      };
      if (has) showCalc(rawInit, parseAmount(rawInit, p.edinica));
      inp.addEventListener('input', () => {
        const raw = inp.value.trim();
        if (raw === ''){
          delete ostatki[p.pozitsiya]; delete ostatkiRaw[p.pozitsiya];
          row.classList.remove('has-val'); inp.classList.remove('filled'); calc.hidden = true;
        } else {
          const r = parseAmount(raw, p.edinica);
          if (r.ok){
            ostatki[p.pozitsiya] = r.value; ostatkiRaw[p.pozitsiya] = raw;
            row.classList.add('has-val'); inp.classList.add('filled'); showCalc(raw, r);
          }
        }
        saveOstDebounced(); updateOstStat();
      });
      row.querySelector('.row-x').addEventListener('click', () => {
        delete ostatki[p.pozitsiya]; delete ostatkiRaw[p.pozitsiya];
        save(LS.ost, ostatki); save(LS.ostRaw, ostatkiRaw); renderOstatki(); updateOstStat();
      });
      wrap.appendChild(row);
    }
    list.appendChild(wrap);
  }
  updateOstStat();
}
let saveT; const saveOstDebounced = () => { clearTimeout(saveT); saveT = setTimeout(()=>{ save(LS.ost, ostatki); save(LS.ostRaw, ostatkiRaw); }, 400); };
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
    const blob=new Blob([JSON.stringify({ostatki,ostatkiRaw,camp,settings},null,2)],{type:'application/json'});
    const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='zavhoz-backup.json'; a.click();
  });
  $('#sReset').addEventListener('click', ()=>{
    if (!confirm('Сбросить остатки, параметры лагеря и настройки?')) return;
    localStorage.removeItem(LS.ost); localStorage.removeItem(LS.ostRaw); localStorage.removeItem(LS.camp); localStorage.removeItem(LS.set); localStorage.removeItem(LS.redits);
    ostatki={}; ostatkiRaw={}; redits={added:[],edited:{},removed:[]}; rebuildRaskladka(); camp={lyudi:22,patrul:5,planDney:7,rezhim:"plan"}; settings={workerUrl:'',model:'google/gemini-2.0-flash-001'};
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
    const r = await fetch('raskladka.json?v=5'); RASKLADKA_BASE = await r.json(); rebuildRaskladka();
  } catch(e){ toast('Не загрузилась раскладка'); return; }
  renderOstatki();
  $('#ostSearch').addEventListener('input', renderOstatki);
  $('#ostClear').addEventListener('click', ()=>{ if(confirm('Очистить все введённые остатки?')){ ostatki={}; ostatkiRaw={}; save(LS.ost,ostatki); save(LS.ostRaw,ostatkiRaw); renderOstatki(); }});
  $('#calcBtn').addEventListener('click', renderZakupka);
  $('#hideUnknown').addEventListener('change', renderZakupka);
  initCampForm(); initSettings(); initVoice(); initPosEditor();
  { const v = $('#verStamp'); if (v) v.textContent = `Завхоз · Ладога · ${BUILD}`; }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(()=>{});
}
boot();
