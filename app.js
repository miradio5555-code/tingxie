const $ = (id) => document.getElementById(id);
const RATE = 16000;
const FRAME = 2048;         // ~128 ms per audio frame
const MIN_CHUNK = 1.5;      // s: shortest phrase sent to Whisper
const MAX_CHUNK = 12;       // s: forced cut for non-stop speech
const PAUSE = 0.5;          // s: silence that ends a phrase
const STORE = 'cc-lecture';

let segments = []; // {start, text}
let recording = false;
let t0 = 0;
let timerId = null;
let stream = null;
let recognition = null;
let audio = null;           // {ctx, src, proc}
let pending = 0;            // chunks waiting for Whisper
let sendQueue = Promise.resolve();
let STATIC = false;         // no server (phone-only): Word is built in the browser
const MOBILE = /Android|iPhone|iPad/i.test(navigator.userAgent);
let wakeLock = null;
let draftText = '';         // instant browser draft shown until Whisper returns

const fmt = (s) => {
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const p = (n) => String(n).padStart(2, '0');
  return (h ? p(h) + ':' : '') + p(m) + ':' + p(r);
};
const setStatus = (t) => ($('status').textContent = t);
const now = () => (Date.now() - t0) / 1000;
const defaultName = () => {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `讲座 ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}`;
};
const lectureName = () => $('name').value.trim() || ($('name').value = defaultName());

function render() {
  const list = $('list');
  if (!segments.length) {
    list.innerHTML = '<div class="empty">点击“开始录音”或上传音频文件</div>';
    return;
  }
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  list.innerHTML = '';
  segments.forEach((s, i) => {
    const d = document.createElement('div');
    d.className = 'seg';
    d.innerHTML = `<span class="t">${fmt(s.start)}</span><span class="x" contenteditable="true"></span>`;
    const x = d.querySelector('.x');
    x.textContent = s.text;
    x.addEventListener('input', () => { segments[i].text = x.textContent; scheduleSave(); });
    list.appendChild(d);
  });
  if (atBottom) list.scrollTop = list.scrollHeight;
}
function add(start, text) {
  text = (text || '').trim();
  if (!text) return;
  segments.push({ start: Math.max(0, start), text });
  segments.sort((a, b) => a.start - b.start);
  render();
  scheduleSave();
}

// ---------- autosave: browser backup + Word file in ~/Documents/凑凑听写 ----------
let saveTimer = null;
function scheduleSave(delay = 2000) {
  try { localStorage.setItem(STORE, JSON.stringify({ name: $('name').value, segments })); } catch {}
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveWord, delay);
}
async function saveWord() {
  if (!segments.length) return;
  const name = lectureName();
  if (STATIC) { $('saved').textContent = `✓ 已保存在浏览器中 · ${new Date().toLocaleTimeString()}`; return; }
  try {
    const res = await fetch('/api/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, title: name, segments }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    $('saved').textContent = `✓ 已保存到 文稿/凑凑听写/${name}.docx · ${new Date().toLocaleTimeString()}`;
  } catch (e) {
    $('saved').textContent = '⚠ Word 保存失败：' + e.message;
  }
}

// ---------- Whisper: phrase-by-phrase recording, cut at pauses ----------
function encodeWav(samples) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, RATE, true); v.setUint32(28, RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}
function resample(data, from) {
  if (from === RATE) return data;
  const ratio = from / RATE, out = new Float32Array(Math.floor(data.length / ratio));
  for (let i = 0; i < out.length; i++) out[i] = data[Math.floor(i * ratio)];
  return out;
}

function startWhisper() {
  const ctx = new AudioContext({ sampleRate: RATE });
  const src = ctx.createMediaStreamSource(stream);
  const proc = ctx.createScriptProcessor(FRAME, 1, 1);
  const frameSec = FRAME / ctx.sampleRate;
  let frames = [], dur = 0, silent = 0, hasSpeech = false, start = 0, noise = 0.003;

  const flush = () => {
    if (hasSpeech) {
      const all = new Float32Array(frames.reduce((n, f) => n + f.length, 0));
      let o = 0; frames.forEach((f) => { all.set(f, o); o += f.length; });
      send(encodeWav(resample(all, ctx.sampleRate)), start);
    }
    frames = []; dur = 0; silent = 0; hasSpeech = false; start = now();
  };

  proc.onaudioprocess = (e) => {
    const d = new Float32Array(e.inputBuffer.getChannelData(0));
    let sum = 0; for (let i = 0; i < d.length; i++) sum += d[i] * d[i];
    const rms = Math.sqrt(sum / d.length);
    const speech = rms > Math.max(0.006, noise * 3);
    if (!speech) noise = noise * 0.95 + rms * 0.05; // adapt to classroom background noise
    $('level').style.width = Math.min(100, rms * 600) + '%';

    if (!frames.length) start = now() - frameSec;
    frames.push(d); dur += frameSec;
    if (speech) { hasSpeech = true; silent = 0; } else silent += frameSec;

    if (!hasSpeech && dur > 1) { frames = frames.slice(-2); dur = 2 * frameSec; start = now() - dur; } // keep short pre-roll
    else if ((hasSpeech && silent >= PAUSE && dur >= MIN_CHUNK) || dur >= MAX_CHUNK) flush();
  };
  src.connect(proc);
  proc.connect(ctx.destination);
  audio = { ctx, src, proc, flush };
}

function send(blob, start) {
  pending++;
  updatePending();
  sendQueue = sendQueue.then(async () => {
    try {
      const context = segments.map((s) => s.text).join('').slice(-80);
      const r = await sendAudio(blob, 'phrase.wav', context);
      r.segments.forEach((s) => add(start + s.start, s.text));
      draftText = '';
      $('draft').textContent = '';
    } catch (err) { setStatus('识别错误：' + err.message); }
    pending--;
    updatePending();
  });
}
const updatePending = () => ($('pending').textContent = pending ? `识别中… (${pending})` : '');

async function sendAudio(blob, name, prompt = '') {
  const fd = new FormData();
  fd.append('prompt', prompt);
  fd.append('audio', blob, name);
  const res = await fetch('/api/transcribe', { method: 'POST', body: fd });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.status);
  return data;
}

// ---------- browser speech recognition (instant draft, or the whole engine) ----------
function startBrowser(final) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    if (final) throw new Error('此浏览器不支持实时识别，请使用 Chrome，或选择 Whisper');
    return;
  }
  recognition = new SR();
  recognition.lang = 'zh-CN';
  recognition.continuous = !MOBILE; // Android Chrome duplicates text in continuous mode
  recognition.interimResults = true;
  recognition.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (!r.isFinal) interim += r[0].transcript;
      else if (final) add(now() - 2, r[0].transcript);
      else draftText = (draftText + r[0].transcript).slice(-80);
    }
    $('draft').textContent = (final ? '' : draftText) + interim;
  };
  // Chrome stops after silence; restart while still recording.
  recognition.onend = () => { if (recording && recognition) try { recognition.start(); } catch {} };
  recognition.onerror = (e) => { if (final && e.error !== 'no-speech') setStatus('识别错误：' + e.error); };
  recognition.start();
}

// ---------- recording control ----------
async function start() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
  } catch { return setStatus('无法访问麦克风，请允许权限'); }
  lectureName();
  recording = true;
  // Continue the timeline when resuming the same lecture.
  t0 = Date.now() - (segments.length ? (segments[segments.length - 1].start + 3) * 1000 : 0);
  try {
    if ($('engine').value === 'browser') startBrowser(true);
    else { startWhisper(); try { startBrowser(false); } catch {} }
  } catch (e) { recording = false; stream.getTracks().forEach((t) => t.stop()); return setStatus(e.message); }
  $('ctl').classList.add('on');
  $('btnRec').textContent = '■ 停止';
  $('btnRec').className = 'rec';
  $('engine').disabled = true;
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
  setStatus(STATIC ? '录音中… 请保持屏幕常亮，不要切换到其他应用' : '录音中… 文字会逐句出现，并自动保存到 Word');
  timerId = setInterval(() => ($('timer').textContent = fmt(now())), 250);
}

function stop() {
  recording = false;
  clearInterval(timerId);
  if (recognition) { const r = recognition; recognition = null; r.stop(); }
  if (audio) { audio.flush(); audio.proc.disconnect(); audio.src.disconnect(); audio.ctx.close(); audio = null; }
  if (stream) stream.getTracks().forEach((t) => t.stop());
  $('ctl').classList.remove('on');
  $('level').style.width = '0';
  $('btnRec').textContent = '● 继续录音';
  $('btnRec').className = 'primary';
  $('engine').disabled = false;
  $('draft').textContent = '';
  try { wakeLock?.release(); } catch {}
  setStatus('已停止');
  sendQueue.then(() => saveWord());
}

$('btnRec').onclick = () => (recording ? stop() : start());

// ---------- phone: Voice Memos file -> Groq Whisper large-v3 (no server) ----------
const GROQ_KEY = 'cc-groq-key';
const GROQ_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const GROQ_MAX = 24 * 1024 * 1024; // Groq free tier accepts up to 25 MB per request
const PART_SEC = 600;              // long recordings are split into ~10 min parts
const ZH_PROMPT = '以下是普通话的课堂讲座，使用简体中文，带标点符号。';
const FULLWIDTH = { ',': '，', '?': '？', '!': '！', ':': '：', ';': '；' };
// The field is the source of truth; localStorage only restores it between visits.
const groqKey = () => $('groqKey').value.trim() || (() => { try { return localStorage.getItem(GROQ_KEY) || ''; } catch { return ''; } })();

async function groqTranscribe(blob, name, context) {
  const fd = new FormData();
  fd.append('file', blob, name);
  fd.append('model', 'whisper-large-v3');
  fd.append('language', 'zh');
  fd.append('response_format', 'verbose_json');
  fd.append('temperature', '0');
  fd.append('prompt', ZH_PROMPT + context.slice(-60));
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(GROQ_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + groqKey() }, body: fd });
    if (res.status === 429 && attempt < 3) { // free-tier rate limit: wait and retry
      const wait = Number(res.headers.get('retry-after')) || 20;
      setStatus(`Groq 限速，${wait} 秒后重试…`);
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) throw new Error('Groq 密钥无效，请检查');
    if (!res.ok) throw new Error(data.error?.message || 'Groq ' + res.status);
    return (data.segments || [])
      .filter((x) => !(x.no_speech_prob > 0.6))
      .map((x) => ({ start: x.start, text: x.text.trim().replace(/[,?!:;]/g, (c) => FULLWIDTH[c]) }))
      .filter((x) => x.text);
  }
}

// Decodes a long recording to 16 kHz mono and cuts it into parts at the quietest moment near each boundary.
async function splitAudio(file) {
  const bytes = await file.arrayBuffer();
  let buf;
  try { buf = await new OfflineAudioContext(1, 1, RATE).decodeAudioData(bytes); }
  catch { buf = await new OfflineAudioContext(1, 1, 44100).decodeAudioData(bytes); }
  const data = resample(buf.getChannelData(0), buf.sampleRate);
  const parts = [], win = RATE / 10; // 100 ms windows
  let pos = 0;
  while (pos < data.length) {
    let end = Math.min(data.length, pos + PART_SEC * RATE);
    if (end < data.length) {
      let best = end, bestE = Infinity;
      for (let w = end - 15 * RATE; w < end; w += win) { // look for a pause in the last 15 s
        let e = 0; for (let i = w; i < w + win; i++) e += data[i] * data[i];
        if (e < bestE) { bestE = e; best = w + win / 2; }
      }
      end = Math.floor(best);
    }
    parts.push({ start: pos / RATE, blob: encodeWav(data.subarray(pos, end)) });
    pos = end;
  }
  return parts;
}

async function transcribeFileGroq(f) {
  if (!groqKey()) { setStatus('请先在上方填写 Groq 密钥'); $('groqKey').focus(); return; }
  const base = segments.length ? segments[segments.length - 1].start + 1 : 0;
  const t = Date.now();
  let parts;
  if (f.size <= GROQ_MAX) parts = [{ start: 0, blob: f, name: f.name }];
  else {
    setStatus('录音较长，正在切分…');
    parts = await splitAudio(f);
  }
  for (let i = 0; i < parts.length; i++) {
    setStatus(`识别中… ${i + 1} / ${parts.length}`);
    const context = segments.map((s) => s.text).join('');
    const segs = await groqTranscribe(parts[i].blob, parts[i].name || `part${i + 1}.wav`, context);
    segs.forEach((s) => add(base + parts[i].start + s.start, s.text));
  }
  setStatus(`✓ 完成（${Math.round((Date.now() - t) / 1000)} 秒）· 点击“保存 Word”`);
  $('btnOpen').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

$('btnUpload').onclick = () => $('file').click();
$('file').onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  if (!$('name').value.trim() || /^讲座 \d{4}-/.test($('name').value)) $('name').value = f.name.replace(/\.[^.]+$/, '');
  if (STATIC) {
    $('btnUpload').disabled = true;
    try { await transcribeFileGroq(f); } catch (err) { setStatus('错误：' + err.message); }
    $('btnUpload').disabled = false;
    return;
  }
  setStatus('识别中：' + f.name + '（长录音需要几分钟）');
  try {
    const r = await sendAudio(f, f.name);
    const base = segments.length ? segments[segments.length - 1].start + 1 : 0;
    r.segments.forEach((s) => add(base + s.start, s.text));
    setStatus('完成');
  } catch (err) { setStatus('错误：' + err.message); }
};

// ---------- exports ----------
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const guard = () => (segments.length ? true : (setStatus('还没有内容'), false));
const openPath = (name) => fetch('/api/open', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
}).then((r) => r.ok || setStatus('文件还不存在'));

async function buildDocx(name) {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel } = window.docx;
  const doc = new Document({
    styles: { default: { document: { run: { font: 'Microsoft YaHei', size: 24 } } } },
    sections: [{
      children: [
        new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: name })] }),
        ...segments.map((s) => new Paragraph({
          spacing: { after: 120 },
          children: [new TextRun({ text: `[${fmt(s.start)}] `, color: '2F6BFF', size: 20 }), new TextRun({ text: s.text })],
        })),
      ],
    }],
  });
  return Packer.toBlob(doc);
}
// Phone: share sheet (Save to Files / Word) when available, otherwise a normal download.
async function saveDocxHere() {
  const name = lectureName();
  const blob = await buildDocx(name);
  const file = new File([blob], name + '.docx', { type: blob.type });
  if (MOBILE && navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  download(blob, name + '.docx');
}
$('btnOpen').onclick = async () => {
  if (!guard()) return;
  if (STATIC) return saveDocxHere();
  await saveWord(); openPath(lectureName());
};
$('btnFolder').onclick = () => openPath('');

$('btnXlsx').onclick = () => {
  if (!guard()) return;
  const rows = [['序号', '时间', '内容'], ...segments.map((s, i) => [i + 1, fmt(s.start), s.text])];
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [{ wch: 6 }, { wch: 10 }, { wch: 80 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '转写');
  XLSX.writeFile(wb, `${lectureName()}.xlsx`);
};

$('btnTxt').onclick = () => {
  if (!guard()) return;
  const txt = segments.map((s) => `[${fmt(s.start)}] ${s.text}`).join('\n');
  download(new Blob([txt], { type: 'text/plain;charset=utf-8' }), `${lectureName()}.txt`);
};

$('btnNew').onclick = () => {
  if (recording) return;
  if (segments.length && !confirm('开始新讲座？当前讲座已保存在 Word 中。')) return;
  segments = [];
  $('name').value = defaultName();
  $('timer').textContent = '00:00';
  $('btnRec').textContent = '● 开始录音';
  $('saved').textContent = '';
  render();
  scheduleSave();
};
$('name').addEventListener('change', () => scheduleSave(0));

// ---------- init ----------
try {
  const s = JSON.parse(localStorage.getItem(STORE) || 'null');
  if (s) { segments = s.segments || []; $('name').value = s.name || ''; }
} catch {}
if (!$('name').value) $('name').value = defaultName();
if (segments.length) { render(); $('btnRec').textContent = '● 继续录音'; }

function enableStatic() {
  STATIC = true;
  $('engine').querySelector('[value=whisper]').remove();
  $('engine').value = 'browser';
  $('btnFolder').hidden = true;
  $('btnUpload').textContent = '上传录音（语音备忘录）';
  $('btnUpload').className = 'primary';
  $('groqBox').hidden = false;
  try { $('groqKey').value = localStorage.getItem(GROQ_KEY) || ''; } catch {}
  $('btnOpen').textContent = '保存 Word';
  if (!(window.SpeechRecognition || window.webkitSpeechRecognition)) setStatus('此浏览器不支持语音识别，请使用 Chrome（安卓）或 Safari');
}
fetch('/api/config').then((r) => (r.ok ? r.json() : Promise.reject())).then((c) => {
  if (!c.whisper) $('engine').querySelector('[value=whisper]').textContent += ' — 未安装';
  else $('engine').value = 'whisper';
}).catch(enableStatic);

function saveKey() {
  const k = $('groqKey').value.trim();
  try {
    localStorage.setItem(GROQ_KEY, k);
    if (localStorage.getItem(GROQ_KEY) !== k) throw new Error('readback');
    setStatus(k ? '✓ 密钥已保存在本机' : '');
  } catch {
    setStatus('⚠ 无法保存密钥（请关闭 Safari 无痕模式）。本次使用有效，下次需重新粘贴');
  }
}
$('groqKey').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
['input', 'change', 'blur', 'paste'].forEach((ev) => $('groqKey').addEventListener(ev, () => setTimeout(saveKey, 0)));
