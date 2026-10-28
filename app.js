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
let sent = 0, got = 0, frameCount = 0;
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
  let ctx;
  try { ctx = new AudioContext({ sampleRate: RATE }); } catch { ctx = new AudioContext(); } // older iOS rejects a custom rate
  ctx.resume?.(); // iOS starts contexts suspended
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
    frameCount++;
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
  ['touchstart', 'click'].forEach((ev) => document.addEventListener(ev, () => ctx.state === 'suspended' && ctx.resume(), { once: false }));
}

function send(blob, start) {
  pending++; sent++;
  updatePending();
  sendQueue = sendQueue.then(async () => {
    try {
      const context = segments.map((s) => s.text).join('').slice(-80);
      const segs = STATIC
        ? await groqTranscribe(blob, 'phrase.wav', context)
        : (await sendAudio(blob, 'phrase.wav', context)).segments;
      segs.forEach((s) => add(start + s.start, s.text));
      got++;
      if (STATIC && recording) setStatus('录音中… 识别正常');
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
  let fails = 0;
  recognition.onend = () => {
    if (!(recording && recognition)) return;
    if (fails > 5) { setStatus('浏览器识别无法继续（' + (lastErr || '未知') + '）。请点“刷新”，或改用 Groq 实时'); return; }
    setTimeout(() => { try { recognition?.start(); } catch {} }, fails ? 400 : 0);
  };
  let lastErr = '';
  recognition.onresult = ((orig) => (e) => { fails = 0; orig(e); })(recognition.onresult);
  recognition.onerror = (e) => {
    if (e.error === 'no-speech' || e.error === 'aborted') return;
    lastErr = e.error; fails++;
    if (final) setStatus('识别错误：' + e.error + (e.error === 'not-allowed' ? '（请在 设置→Safari/Siri 中允许听写与麦克风）' : ''));
  };
  recognition.start();
}

// ---------- recording control ----------
async function start() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
  } catch { return setStatus('无法访问麦克风，请允许权限'); }
  if (STATIC && $('engine').value === 'groq' && !groqKey()) {
    stream.getTracks().forEach((t) => t.stop());
    $('groqKey').focus();
    return setStatus('请先在上方填写 Groq 密钥');
  }
  lectureName();
  recording = true;
  // Continue the timeline when resuming the same lecture.
  t0 = Date.now() - (segments.length ? (segments[segments.length - 1].start + 3) * 1000 : 0);
  try {
    if ($('engine').value === 'browser') {
      startBrowser(true);
      if (MOBILE) stream.getTracks().forEach((t) => t.stop()); // iOS speech recognition fails while another mic stream is open
    }
    else { startWhisper(); if (!STATIC) try { startBrowser(false); } catch {} }
  } catch (e) { recording = false; stream.getTracks().forEach((t) => t.stop()); return setStatus(e.message); }
  $('ctl').classList.add('on');
  $('btnRec').textContent = '■ 停止';
  $('btnRec').className = 'rec';
  $('engine').disabled = true;
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
  setStatus(STATIC ? '录音中… 请保持屏幕常亮，不要切换到其他应用' : '录音中… 文字会逐句出现，并自动保存到 Word');
  sent = got = frameCount = 0;
  timerId = setInterval(() => {
    $('timer').textContent = fmt(now());
    if (!audio || !STATIC) return;
    const sec = Math.floor(now());
    if (audio.ctx.state !== 'running') setStatus('⚠ 音频未启动，请点一下屏幕');
    else if (sec > 3 && !frameCount) setStatus('⚠ 没有收到声音，请检查麦克风权限，再点“刷新”');
    else if (!sent && sec > 8) setStatus('已收到声音，但没检测到说话——请靠近麦克风大声说话（上方蓝条应跳动）');
    else if (sent > got + 3 && !got) setStatus('已发送 ' + sent + ' 句，等待 Groq 返回…');
  }, 250);
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
const GROQ_MAX = 8 * 1024 * 1024;  // bigger files are cut up: small requests survive flaky phone networks (Groq limit is 25 MB)
const PART_SEC = 300;              // parts of ~5 min (~10 MB as 16 kHz WAV)
const ZH_PROMPT = '以下是普通话的课堂讲座，使用简体中文，带标点符号。';
const FULLWIDTH = { ',': '，', '?': '？', '!': '！', ':': '：', ';': '；' };
// Phrases Whisper invents on silence in Chinese audio (learned from video subtitles).
const HALLUCINATION = /字幕|订阅|點贊|点赞|打赏|明镜|Amara|感谢观看|謝謝觀看|请不吝|下次再见|ZhaoYun|中文字幕/i;
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
  const mb = (blob.size / 1048576).toFixed(1);
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(GROQ_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + groqKey().replace(/[^\x21-\x7e]/g, '') }, body: fd });
    } catch (e) { // Safari reports every network failure as "Load failed"
      if (attempt < 2) { setStatus(`网络不稳定，重试 ${attempt + 1}/2…`); await new Promise((r) => setTimeout(r, 2000)); continue; }
      throw new Error(`无法连接 Groq（${mb} MB，${e.message}）。请检查网络/VPN/内容拦截器，并换 Wi‑Fi 重试`);
    }
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
      .filter((x) => !(x.no_speech_prob > 0.6) && !(HALLUCINATION.test(x.text) && x.text.length < 40))
      .map((x) => ({ start: x.start, text: x.text.trim().replace(/[,?!:;]/g, (c) => FULLWIDTH[c]) }))
      .filter((x) => x.text);
  }
}

// Decodes a long recording to 16 kHz mono and cuts it into parts at the quietest moment near each boundary.
async function splitAudio(file) {
  const bytes = await file.arrayBuffer();
  let buf;
  try { buf = await new OfflineAudioContext(1, 1, RATE).decodeAudioData(bytes.slice(0)); }
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

let resumeJob = null; // {parts, next, base, t}: lets a failed upload continue from the failed part

async function transcribeFileGroq(f) {
  if (!groqKey()) { setStatus('请先在上方填写 Groq 密钥'); $('groqKey').focus(); return; }
  const base = segments.length ? segments[segments.length - 1].start + 1 : 0;
  const t = Date.now();
  const mb = (f.size / 1048576).toFixed(1);
  setStatus(`读取文件 ${mb} MB…`);
  let buf;
  try { buf = await f.arrayBuffer(); } // forces iOS to materialise the file (iCloud / lazy Files reference)
  catch (e) { throw new Error(`无法读取文件（${e.message}）。请在“文件”App 中先点开下载该录音，再重试`); }
  const local = new File([buf], f.name || 'rec.m4a', { type: f.type || 'audio/mp4' });
  let parts;
  if (local.size <= GROQ_MAX) parts = [{ start: 0, blob: local, name: local.name }];
  else {
    setStatus(`录音较长（${mb} MB），正在切分…`);
    try { parts = await splitAudio(local); }
    catch (e) { throw new Error(`无法解码录音（${e.message}）。请改用 .m4a 或 .wav 格式`); }
  }
  await runParts({ parts, next: 0, base, t });
}

async function runParts(job) {
  resumeJob = null;
  $('btnResume').hidden = true;
  let lock = null;
  try { lock = await navigator.wakeLock?.request('screen'); } catch {}
  try {
    for (let i = job.next; i < job.parts.length; i++) {
      job.next = i;
      setStatus(`识别中… ${i + 1} / ${job.parts.length}（${(job.parts[i].blob.size / 1048576).toFixed(1)} MB）· 请保持此页面打开`);
      const context = segments.map((s) => s.text).join('');
      const segs = await groqTranscribe(job.parts[i].blob, job.parts[i].name || `part${i + 1}.wav`, context);
      segs.forEach((s) => add(job.base + job.parts[i].start + s.start, s.text));
    }
  } catch (e) {
    resumeJob = job;
    $('btnResume').textContent = `继续识别（从第 ${job.next + 1} / ${job.parts.length} 段）`;
    $('btnResume').hidden = false;
    throw e;
  } finally {
    try { lock?.release(); } catch {}
  }
  setStatus(`✓ 完成（${Math.round((Date.now() - job.t) / 1000)} 秒）· 点击“保存 Word”`);
  $('btnOpen').scrollIntoView({ behavior: 'smooth', block: 'center' });
}
$('btnResume').onclick = async () => {
  if (!resumeJob) return;
  $('btnResume').disabled = true;
  try { await runParts(resumeJob); } catch (err) { setStatus('错误：' + err.message); }
  $('btnResume').disabled = false;
};

$('btnUpload').onclick = () => $('file').click();
$('file').onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  if (STATIC && segments.length) {
    if (confirm('识别新录音前清空当前内容？\n（未保存的请先点“取消”，再点“保存 Word”）\n\n确定 = 新讲座　取消 = 不识别')) {
      segments = []; render(); resumeJob = null; $('btnResume').hidden = true;
      $('name').value = '';
    } else return;
  }
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
  if (segments.length && !confirm(STATIC ? '开始新讲座？当前内容将被清空——如需保留，请先点“保存 Word”。' : '开始新讲座？当前讲座已保存在 Word 中。')) return;
  resumeJob = null; $('btnResume').hidden = true;
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
  const opt = $('engine').querySelector('[value=whisper]');
  opt.value = 'groq';
  opt.textContent = 'Groq 实时（更准，需密钥）';
  try { $('engine').value = localStorage.getItem(GROQ_KEY) ? 'groq' : 'browser'; } catch { $('engine').value = 'browser'; }
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
$('btnRefresh').onclick = async () => {
  if (recording && !confirm('正在录音，刷新会中断录音（已识别的文字会保留）。继续？')) return;
  try { localStorage.setItem(STORE, JSON.stringify({ name: $('name').value, segments })); } catch {}
  try { (await caches?.keys?.() || []).forEach((k) => caches.delete(k)); } catch {}
  try { (await navigator.serviceWorker?.getRegistrations?.() || []).forEach((r) => r.unregister()); } catch {}
  location.replace(location.pathname + '?r=' + Date.now());
};
$('groqKey').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
['input', 'change', 'blur', 'paste'].forEach((ev) => $('groqKey').addEventListener(ev, () => setTimeout(saveKey, 0)));
