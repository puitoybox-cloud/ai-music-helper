const STORAGE_KEY = "aiMusicHelperProject";

const selectOptions = {
  genre: ["J-POP", "アニソン", "バラード", "ロック", "EDM", "オーケストラ", "かわいい系", "かっこいい系", "ジャズ", "Lo-fi", "エレクトロ", "その他"],
  mood: ["明るい", "切ない", "かわいい", "神秘的", "爽やか", "エモい", "壮大", "激しい", "優しい", "不穏", "幻想的", "泣ける", "希望的", "その他"],
  key: ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B", "Cm", "C#m", "Dm", "D#m", "Em", "Fm", "F#m", "Gm", "G#m", "Am", "A#m", "Bm"],
  bpm: ["60", "70", "80", "90", "100", "110", "120", "130", "140", "150", "160"],
  timeSignature: ["4/4", "3/4", "6/8", "2/4", "12/8", "その他"],
  vocalType: ["女性ソロ", "男性ソロ", "少女声", "少年声", "中性的", "デュエット", "コーラス中心", "インスト", "その他"],
  language: ["日本語", "英語", "日本語＋英語", "インスト", "その他"],
  outputType: ["汎用AI音楽用", "Suno向け", "Udio向け", "TopMediai向け", "短めプロンプト", "詳細プロンプト"],
};

const otherFieldMap = { genre: "genreOther", mood: "moodOther", timeSignature: "timeSignatureOther", vocalType: "vocalTypeOther", language: "languageOther" };
const checklistItems = ["AIで曲を作る", "ステム分離する", "Logic Proで編集する", "MIDIを作る", "VoiSonaで歌わせる", "RVCまたはApplioで自分の声に変える", "ミックスする", "書き出す"];
const lyricLabels = { lyricsIntro: "イントロ", lyricsVerseA: "Aメロ", lyricsVerseB: "Bメロ", lyricsChorus: "サビ", lyricsInterlude: "間奏", lyricsFinalChorus: "ラスサビ" };
const fieldIds = ["title", ...Object.keys(selectOptions), ...Object.values(otherFieldMap), "reference", ...Object.keys(lyricLabels), "promptJa", "promptEn"];
const voisonaDictionary = {
  "思い出": "おもいで", "未来": "みらい", "世界": "せかい", "記憶": "きおく", "希望": "きぼう", "奇跡": "きせき", "明日": "あした", "今日": "きょう", "昨日": "きのう", "永遠": "えいえん", "約束": "やくそく",
  "走る": "はしる", "行く": "いく", "帰る": "かえる", "笑う": "わらう", "泣く": "なく", "生きる": "いきる", "消える": "きえる", "輝く": "かがやく",
  "夢": "ゆめ", "光": "ひかり", "空": "そら", "星": "ほし", "月": "つき", "風": "かぜ", "君": "きみ", "僕": "ぼく", "私": "わたし", "心": "こころ", "涙": "なみだ", "愛": "あい", "声": "こえ", "歌": "うた", "音": "おと", "今": "いま", "時": "とき",
};
const voisonaBrackets = /[「」『』（）]/g;
const voisonaPunctuation = /[、。，．]/g;
const voisonaSymbols = /[!！?？…・♪♡☆★\-—〜~]/g;
let midiState = null;

class MidiReader {
  constructor(buffer) { this.view = new DataView(buffer); this.pos = 0; }
  readUint8() { return this.view.getUint8(this.pos++); }
  readUint16() { const v = this.view.getUint16(this.pos); this.pos += 2; return v; }
  readUint32() { const v = this.view.getUint32(this.pos); this.pos += 4; return v; }
  readString(len) { let s = ""; for (let i = 0; i < len; i++) s += String.fromCharCode(this.readUint8()); return s; }
  readBytes(len) { const bytes = new Uint8Array(this.view.buffer, this.pos, len); this.pos += len; return bytes; }
  readVarLen() { let value = 0, b; do { b = this.readUint8(); value = (value << 7) | (b & 0x7f); } while (b & 0x80); return value; }
}

function parseMidiFile(buffer) {
  const r = new MidiReader(buffer);
  if (r.readString(4) !== "MThd") throw new Error("MIDIヘッダーが見つかりません");
  const headerLength = r.readUint32();
  const format = r.readUint16();
  const trackCount = r.readUint16();
  const division = r.readUint16();
  r.pos += Math.max(0, headerLength - 6);
  if (division & 0x8000) throw new Error("SMPTE time divisionのMIDIには未対応です");
  const ticksPerQuarter = division;
  const tracks = [];
  const globalTempoEvents = [];
  const globalTimeSignatures = [];
  for (let t = 0; t < trackCount; t++) {
    if (r.readString(4) !== "MTrk") throw new Error("MTrkチャンクを読み込めません");
    const end = r.pos + r.readUint32();
    let tick = 0, runningStatus = null;
    const notes = [], tempos = [], timeSignatures = [];
    while (r.pos < end) {
      tick += r.readVarLen();
      let status = r.readUint8();
      if (status < 0x80) { r.pos--; status = runningStatus; }
      else if (status < 0xf0) runningStatus = status;
      if (status === 0xff) {
        const type = r.readUint8();
        const len = r.readVarLen();
        const bytes = r.readBytes(len);
        if (type === 0x51 && len >= 3) { const mpqn = (bytes[0] << 16) | (bytes[1] << 8) | bytes[2]; tempos.push({ tick, bpm: Math.round((60000000 / mpqn) * 10) / 10 }); }
        if (type === 0x58 && len >= 2) { timeSignatures.push({ tick, numerator: bytes[0], denominator: 2 ** bytes[1] }); }
      } else if (status === 0xf0 || status === 0xf7) {
        r.readBytes(r.readVarLen());
      } else if (status >= 0x80 && status <= 0xef) {
        const command = status & 0xf0;
        const channel = status & 0x0f;
        const data1 = r.readUint8();
        const needsTwo = command !== 0xc0 && command !== 0xd0;
        const data2 = needsTwo ? r.readUint8() : 0;
        if (command === 0x90 && data2 > 0) notes.push({ tick, note: data1, velocity: data2, channel });
      } else { throw new Error("未対応のMIDIイベントを検出しました"); }
    }
    r.pos = end;
    tempos.forEach((e) => globalTempoEvents.push(e));
    timeSignatures.forEach((e) => globalTimeSignatures.push(e));
    tracks.push({ index: t, notes, tempos, timeSignatures });
  }
  globalTempoEvents.sort((a,b)=>a.tick-b.tick); globalTimeSignatures.sort((a,b)=>a.tick-b.tick);
  const firstTempo = globalTempoEvents[0]?.bpm || null;
  const firstSignature = globalTimeSignatures[0] || { numerator: 4, denominator: 4, tick: 0 };
  return { format, trackCount, ticksPerQuarter, bpm: firstTempo, timeSignature: firstSignature, tracks, tempoEvents: globalTempoEvents, timeSignatures: globalTimeSignatures };
}

function ticksPerMeasureAt(midi, tick) {
  const sig = [...midi.timeSignatures].reverse().find((s) => s.tick <= tick) || { numerator: 4, denominator: 4 };
  return midi.ticksPerQuarter * 4 * sig.numerator / sig.denominator;
}

function getTrackMeasureCounts(midi, trackIndex) {
  const track = midi.tracks[trackIndex];
  const counts = [];
  track.notes.forEach((note) => {
    const tpm = ticksPerMeasureAt(midi, note.tick);
    const measure = Math.floor(note.tick / tpm);
    counts[measure] = (counts[measure] || 0) + 1;
  });
  return counts.map((count, index) => ({ measure: index + 1, count: count || 0 })).filter((item) => item.count > 0);
}

function getSelectedMidiTrackIndex() { const v = $("midiTrackSelect")?.value; return v === "" ? -1 : Number(v); }

function serializeMidiState() {
  if (!midiState) return null;
  return { fileName: midiState.fileName, parsed: midiState.parsed };
}

function restoreMidiState(saved) {
  if (!saved?.parsed) return;
  midiState = { fileName: saved.fileName || "読み込み済みMIDI", parsed: saved.parsed };
  $("midiFileName").textContent = `${midiState.fileName}（保存データ）`;
  populateMidiTrackSelect(); renderMidiAnalysis(); updateMidiLyricsAllocation();
}

function populateMidiTrackSelect() {
  const select = $("midiTrackSelect");
  select.innerHTML = "";
  if (!midiState) { select.disabled = true; select.appendChild(new Option("MIDI読み込み後に選択", "")); return; }
  midiState.parsed.tracks.forEach((track) => select.appendChild(new Option(`トラック${track.index + 1}：${track.notes.length}音`, String(track.index))));
  const best = midiState.parsed.tracks.reduce((a, b) => (b.notes.length > a.notes.length ? b : a), midiState.parsed.tracks[0]);
  select.value = String(best?.index || 0); select.disabled = false;
}

function renderMidiAnalysis() {
  const summary = $("midiSummary"), list = $("midiMeasureCounts"); list.innerHTML = "";
  if (!midiState) { summary.textContent = "MIDIを読み込むと、BPM・拍子・トラック別音符数・小節ごとの音符数を表示します。"; return; }
  const midi = midiState.parsed, trackIndex = getSelectedMidiTrackIndex();
  const trackLines = midi.tracks.map((t) => `トラック${t.index + 1}: ${t.notes.length}音`).join(" / ");
  const sig = midi.timeSignature || { numerator: 4, denominator: 4 };
  const counts = getTrackMeasureCounts(midi, trackIndex);
  const total = counts.reduce((sum, item) => sum + item.count, 0);
  summary.innerHTML = `ファイル：${midiState.fileName}<br>Format ${midi.format} / TPQN：${midi.ticksPerQuarter} / 拍子：${sig.numerator}/${sig.denominator} / BPM：${midi.bpm || "未検出"}<br>トラック別音符数：${trackLines}<br><strong>選択トラック合計：${total}音</strong>`;
  counts.forEach((item) => { const row = document.createElement("div"); row.className = "measure-item"; row.innerHTML = `<span>${item.measure}小節目</span><strong>${item.count}音</strong>`; list.appendChild(row); });
}

function splitJapaneseLyrics(text) {
  const combineYoon = $("midiCombineSmallYoon").checked;
  const combineLong = $("midiLongVowelMode").checked;
  const countSmallTsu = $("midiSmallTsuMode").checked;
  const chars = Array.from(text.normalize("NFKC")).filter((ch) => /[ぁ-ゖー]/.test(ch));
  const units = [];
  chars.forEach((ch) => {
    if (combineYoon && "ゃゅょぁぃぅぇぉゎ".includes(ch) && units.length) units[units.length - 1] += ch;
    else if (ch === "ー" && combineLong && units.length) units[units.length - 1] += ch;
    else if (ch === "っ" && !countSmallTsu && units.length) units[units.length - 1] += ch;
    else units.push(ch);
  });
  return units;
}

function convertKanjiToHiragana(text) {
  return Object.entries(voisonaDictionary)
    .sort((a, b) => b[0].length - a[0].length)
    .reduce((result, [word, reading]) => result.replaceAll(word, reading), text);
}

function normalizeVoisonaSpaces(text) {
  return text.split("\n").map((line) => line.replace(/[\t 　]+/g, " ").trim()).join("\n").replace(/\n{3,}/g, "\n\n");
}

function applyVoisonaCleanup(text, options = {}) {
  let result = text.normalize("NFKC");
  if (options.brackets) result = result.replace(voisonaBrackets, "");
  if (options.punctuation) result = result.replace(voisonaPunctuation, "");
  if (options.symbols) result = result.replace(voisonaSymbols, "");
  result = normalizeVoisonaSpaces(result);
  if (options.newlinesToSpaces) result = result.replace(/\n+/g, " ").replace(/[\t 　]+/g, " ").trim();
  return result;
}

function getVoisonaEditableText() {
  return $("voisonaHiraganaLyrics")?.value || "";
}

function updateVoisonaOutput() {
  if (!$("voisonaSeparatedOutput")) return;
  const cleaned = applyVoisonaCleanup(getVoisonaEditableText(), { brackets: true, punctuation: true, symbols: true, newlinesToSpaces: $("voisonaNewlineMode")?.value === "space" });
  const units = splitJapaneseLyrics(cleaned);
  const sep = $("voisonaOutputFormat")?.value === "space" ? " " : " / ";
  $("voisonaSeparatedOutput").value = units.join(sep);
}

function getVoisonaProjectData() {
  return {
    kanjiLyrics: $("voisonaKanjiLyrics")?.value || "",
    hiraganaLyrics: $("voisonaHiraganaLyrics")?.value || "",
    cleanedLyrics: applyVoisonaCleanup(getVoisonaEditableText(), { brackets: true, punctuation: true, symbols: true, newlinesToSpaces: $("voisonaNewlineMode")?.value === "space" }),
    outputFormat: $("voisonaOutputFormat")?.value || "slash",
    newlineMode: $("voisonaNewlineMode")?.value || "keep",
    separatedOutput: $("voisonaSeparatedOutput")?.value || "",
  };
}

function setVoisonaProjectData(data) {
  if (!$("voisonaKanjiLyrics")) return;
  $("voisonaKanjiLyrics").value = data?.kanjiLyrics || "";
  $("voisonaHiraganaLyrics").value = data?.hiraganaLyrics || data?.cleanedLyrics || "";
  $("voisonaOutputFormat").value = data?.outputFormat || "slash";
  $("voisonaNewlineMode").value = data?.newlineMode || "keep";
  updateVoisonaOutput();
}

function setupVoisonaEvents() {
  if (!$("voisonaKanjiLyrics")) return;
  $("voisonaConvertButton").addEventListener("click", () => { $("voisonaHiraganaLyrics").value = convertKanjiToHiragana($("voisonaKanjiLyrics").value); updateVoisonaOutput(); scheduleAutoSave(); showToast("簡易ひらがな変換しました"); });
  $("voisonaRemoveSymbolsButton").addEventListener("click", () => { $("voisonaHiraganaLyrics").value = applyVoisonaCleanup(getVoisonaEditableText(), { brackets: true, punctuation: true, symbols: true, newlinesToSpaces: $("voisonaNewlineMode").value === "space" }); updateVoisonaOutput(); scheduleAutoSave(); showToast("記号を整理しました"); });
  $("voisonaRemoveBracketsButton").addEventListener("click", () => { $("voisonaHiraganaLyrics").value = applyVoisonaCleanup(getVoisonaEditableText(), { brackets: true }); updateVoisonaOutput(); scheduleAutoSave(); showToast("鍵かっこを省きました"); });
  $("voisonaRemovePunctuationButton").addEventListener("click", () => { $("voisonaHiraganaLyrics").value = applyVoisonaCleanup(getVoisonaEditableText(), { punctuation: true }); updateVoisonaOutput(); scheduleAutoSave(); showToast("句読点を省きました"); });
  $("voisonaNormalizeLinesButton").addEventListener("click", () => { $("voisonaHiraganaLyrics").value = applyVoisonaCleanup(getVoisonaEditableText(), { newlinesToSpaces: $("voisonaNewlineMode").value === "space" }); updateVoisonaOutput(); scheduleAutoSave(); showToast("改行を整理しました"); });
  $("voisonaNormalizeSpacesButton").addEventListener("click", () => { $("voisonaHiraganaLyrics").value = normalizeVoisonaSpaces(getVoisonaEditableText()); updateVoisonaOutput(); scheduleAutoSave(); showToast("空白を整理しました"); });
  $("voisonaSendToMidiButton").addEventListener("click", () => { $("midiLyricsInput").value = applyVoisonaCleanup(getVoisonaEditableText(), { brackets: true, punctuation: true, symbols: true, newlinesToSpaces: true }); updateMidiLyricsAllocation(); scheduleAutoSave(); showToast("MIDI歌詞割り当て補助へ送りました"); });
  ["voisonaKanjiLyrics", "voisonaHiraganaLyrics", "voisonaOutputFormat", "voisonaNewlineMode"].forEach((id) => $(id).addEventListener("input", () => { updateVoisonaOutput(); scheduleAutoSave(); }));
}

function updateMidiLyricsAllocation() {
  const units = splitJapaneseLyrics($("midiLyricsInput")?.value || "");
  $("midiLyricsSyllableCount").textContent = `${units.length}音`;
  const output = $("midiLyricsOutput"), warning = $("midiWarning");
  const warnings = [];
  if (!midiState) { output.value = ""; warnings.push("歌メロだけのMIDIを使ってください"); }
  else {
    const counts = getTrackMeasureCounts(midiState.parsed, getSelectedMidiTrackIndex());
    const total = counts.reduce((sum, item) => sum + item.count, 0);
    const sep = $("midiOutputSeparator").value === "space" ? " " : " / ";
    let cursor = 0;
    output.value = counts.map((item) => { const part = units.slice(cursor, cursor + item.count); cursor += item.count; return `${item.measure}小節目：${part.join(sep)}`; }).join("\n");
    if (units.length > total) warnings.push("歌詞の音がMIDIの音符数より多いです");
    if (total > units.length) warnings.push("MIDIの音符数が歌詞の音より多いです");
  }
  warning.hidden = warnings.length === 0;
  warning.innerHTML = warnings.join("<br>");
}

function getMidiProjectData() {
  return {
    lyricsInput: $("midiLyricsInput")?.value || "",
    outputSeparator: $("midiOutputSeparator")?.value || "slash",
    combineSmallYoon: Boolean($("midiCombineSmallYoon")?.checked),
    longVowelCombine: Boolean($("midiLongVowelMode")?.checked),
    smallTsuCount: Boolean($("midiSmallTsuMode")?.checked),
    selectedTrack: $("midiTrackSelect")?.value || "",
    allocationOutput: $("midiLyricsOutput")?.value || "",
    state: serializeMidiState(),
  };
}

function setMidiProjectData(data) {
  if (!$("midiLyricsInput")) return;
  $("midiLyricsInput").value = data?.lyricsInput || "";
  $("midiOutputSeparator").value = data?.outputSeparator || "slash";
  $("midiCombineSmallYoon").checked = data?.combineSmallYoon !== false;
  $("midiLongVowelMode").checked = Boolean(data?.longVowelCombine);
  $("midiSmallTsuMode").checked = data?.smallTsuCount !== false;
  restoreMidiState(data?.state);
  if (data?.selectedTrack !== undefined && document.querySelector(`#midiTrackSelect option[value="${data.selectedTrack}"]`)) $("midiTrackSelect").value = data.selectedTrack;
  renderMidiAnalysis(); updateMidiLyricsAllocation();
}

function clearMidiProjectData() {
  midiState = null;
  if ($("midiFile")) $("midiFile").value = "";
  if ($("midiFileName")) $("midiFileName").textContent = "未選択";
  if ($("midiLyricsInput")) $("midiLyricsInput").value = "";
  if ($("midiLyricsOutput")) $("midiLyricsOutput").value = "";
  populateMidiTrackSelect(); renderMidiAnalysis(); updateMidiLyricsAllocation();
}

function setupMidiEvents() {
  $("midiFile").addEventListener("change", (event) => {
    const file = event.target.files[0]; if (!file) return;
    if (!/\.midi?$/i.test(file.name)) { showToast(".mid または .midi を選んでください"); event.target.value = ""; return; }
    const reader = new FileReader();
    reader.onload = () => { try { midiState = { fileName: file.name, parsed: parseMidiFile(reader.result) }; $("midiFileName").textContent = file.name; populateMidiTrackSelect(); renderMidiAnalysis(); updateMidiLyricsAllocation(); saveProject(false); showToast("MIDIを解析しました"); } catch (e) { console.error(e); showToast("MIDIを解析できませんでした"); } };
    reader.readAsArrayBuffer(file);
  });
  ["midiTrackSelect", "midiLyricsInput", "midiOutputSeparator", "midiCombineSmallYoon", "midiLongVowelMode", "midiSmallTsuMode"].forEach((id) => $(id).addEventListener("input", () => { renderMidiAnalysis(); updateMidiLyricsAllocation(); scheduleAutoSave(); }));
  $("midiTrackSelect").addEventListener("change", () => { renderMidiAnalysis(); updateMidiLyricsAllocation(); scheduleAutoSave(); });
}

const $ = (id) => document.getElementById(id);
let toastTimer;
let autoSaveTimer;

function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2200);
}

function fillSelects() {
  Object.entries(selectOptions).forEach(([id, options]) => {
    const select = $(id);
    if (!select) return;

    const existingOptions = Array.from(select.options).map((option) => option.value);
    const hasAllOptions = options.every((option) => existingOptions.includes(option));
    if (!hasAllOptions || select.options.length === 0) {
      select.replaceChildren(...options.map((option) => new Option(option, option)));
    }

    if (!select.value) select.selectedIndex = id === "bpm" ? 6 : 0;
  });
}

function getDisplayValue(id, fallback = "未定") {
  const value = $(id).value.trim();
  const otherId = otherFieldMap[id];
  if (value === "その他" && otherId) return $(otherId).value.trim() || "その他";
  return value || fallback;
}

function updateOtherVisibility(id) {
  const otherId = otherFieldMap[id];
  if (!otherId) return;
  $(otherId).hidden = $(id).value !== "その他";
}

function updateLyricCounts() {
  let total = 0;
  Object.keys(lyricLabels).forEach((id) => {
    const count = $(id).value.length;
    total += count;
    $(`${id}Count`).textContent = `${count}文字`;
  });
  $("lyricsTotalCount").textContent = `${total}文字`;
}

function getProjectData() {
  const fields = Object.fromEntries(fieldIds.map((id) => [id, $(id).value]));
  const checklist = checklistItems.map((_, index) => $(`check-${index}`).checked);
  return { appName: "AI Music Helper", version: 4, savedAt: new Date().toISOString(), fields, checklist, voisona: getVoisonaProjectData(), midi: getMidiProjectData() };
}

function setProjectData(data) {
  const fields = data?.fields || {};
  fieldIds.forEach((id) => { if ($(id)) $(id).value = fields[id] || ""; });
  Object.keys(selectOptions).forEach((id) => {
    if (!$(id).value) $(id).selectedIndex = id === "bpm" ? 6 : 0;
  });
  Object.keys(otherFieldMap).forEach(updateOtherVisibility);
  const checklist = Array.isArray(data?.checklist) ? data.checklist : [];
  checklistItems.forEach((_, index) => { $(`check-${index}`).checked = Boolean(checklist[index]); });
  setVoisonaProjectData(data?.voisona);
  setMidiProjectData(data?.midi);
  updateLyricCounts();
}

function saveProject(showMessage = true) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(getProjectData()));
  if (showMessage) showToast("この端末に保存しました");
}

function scheduleAutoSave() {
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => saveProject(false), 250);
}

function loadProject() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (!saved) { updateLyricCounts(); return; }
  try { setProjectData(JSON.parse(saved)); showToast("保存データを読み込みました"); }
  catch (error) { console.error(error); showToast("保存データを読み込めませんでした"); }
}

function buildLyricBlock() {
  return Object.entries(lyricLabels).map(([id, label]) => {
    const value = $(id).value.trim();
    return value ? `【${label}】\n${value}` : "";
  }).filter(Boolean).join("\n\n");
}

function generatePrompts() {
  const title = $("title").value.trim() || "未定の曲";
  const values = {
    genre: getDisplayValue("genre", "ジャンル未定"), mood: getDisplayValue("mood", "雰囲気未定"), key: getDisplayValue("key", "キー未定"),
    bpm: getDisplayValue("bpm", "BPM未定"), timeSignature: getDisplayValue("timeSignature", "拍子未定"), vocalType: getDisplayValue("vocalType", "ボーカル未定"),
    language: getDisplayValue("language", "言語未定"), outputType: getDisplayValue("outputType", "汎用AI音楽用"), reference: $("reference").value.trim() || "参考イメージ未定",
  };
  const lyrics = buildLyricBlock() || "歌詞は後で追加する。";
  const detailLine = values.outputType === "短めプロンプト" ? "要点を短くまとめ、AIが解釈しやすい簡潔な指示にしてください。" : "構成、ボーカル、音色、展開が伝わる具体的な指示にしてください。";

  $("promptJa").value = [`曲名「${title}」のAI音楽を制作してください。`, `出力タイプは${values.outputType}。ジャンルは${values.genre}、雰囲気は${values.mood}。`, `キーは${values.key}、BPM目安は${values.bpm}、拍子は${values.timeSignature}。`, `ボーカルタイプは${values.vocalType}、使用言語は${values.language}。`, `参考イメージメモ：${values.reference}`, detailLine, "イントロ、Aメロ、Bメロ、サビ、間奏、ラスサビを意識し、歌メロが自然に盛り上がるアレンジにしてください。", "ボーカルが聴き取りやすく、DAWで編集しやすい構成にしてください。", "歌詞:", lyrics].join("\n");
  $("promptEn").value = [`Create an AI-generated song titled "${title}".`, `Output type: ${values.outputType}. Genre: ${values.genre}. Mood: ${values.mood}.`, `Key: ${values.key}. Target BPM: ${values.bpm}. Time signature: ${values.timeSignature}.`, `Vocal type: ${values.vocalType}. Language: ${values.language}.`, `Reference notes: ${values.reference}.`, "Use a clear structure with intro, verse A, verse B, chorus, interlude, and final chorus. Make the melody natural, memorable, and emotionally engaging.", "Keep the vocal clear, the arrangement easy to mix, and the song structure easy to edit later in a DAW.", "Lyrics:", lyrics].join("\n");
  saveProject(false); showToast("プロンプトを生成しました");
}

async function copyPrompt(targetId) {
  const text = $(targetId).value;
  if (!text) { showToast("コピーするプロンプトがありません"); return; }
  try { await navigator.clipboard.writeText(text); showToast("コピーしました"); }
  catch { $(targetId).select(); document.execCommand("copy"); showToast("コピーしました"); }
}

function exportJson() {
  const data = getProjectData();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const safeTitle = (data.fields.title || "ai-music-helper").replace(/[\\/:*?"<>|\s]+/g, "-");
  const link = document.createElement("a"); link.href = url; link.download = `${safeTitle}.json`; link.click(); URL.revokeObjectURL(url);
  showToast("JSONを書き出しました");
}

function importJson(event) {
  const file = event.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = () => { try { setProjectData(JSON.parse(reader.result)); saveProject(false); showToast("JSONを読み込みました"); } catch (error) { console.error(error); showToast("JSONを読み込めませんでした"); } finally { event.target.value = ""; } };
  reader.readAsText(file);
}

function resetProject() {
  if (!window.confirm("入力内容とチェック状態をリセットしますか？")) return;
  fieldIds.forEach((id) => { if ($(id)) $(id).value = ""; });
  setVoisonaProjectData(null);
  clearMidiProjectData();
  $("key").selectedIndex = 0; $("bpm").selectedIndex = 6;
  Object.keys(otherFieldMap).forEach(updateOtherVisibility);
  checklistItems.forEach((_, index) => { $(`check-${index}`).checked = false; });
  updateLyricCounts(); localStorage.removeItem(STORAGE_KEY); showToast("リセットしました");
}

function renderChecklist() {
  const checklist = $("checklist"); checklist.innerHTML = "";
  checklistItems.forEach((item, index) => {
    const label = document.createElement("label"); label.className = "check-item";
    label.innerHTML = `<input type="checkbox" id="check-${index}" /> <span>${item}</span>`; checklist.appendChild(label);
  });
}

function setupEvents() {
  fieldIds.forEach((id) => { if ($(id)) $(id).addEventListener("input", () => { updateLyricCounts(); scheduleAutoSave(); }); });
  Object.keys(selectOptions).forEach((id) => $(id).addEventListener("change", () => { updateOtherVisibility(id); scheduleAutoSave(); }));
  checklistItems.forEach((_, index) => $(`check-${index}`).addEventListener("change", scheduleAutoSave));
  document.querySelectorAll(".copy-button").forEach((button) => button.addEventListener("click", () => copyPrompt(button.dataset.copyTarget)));
  setupVoisonaEvents();
  setupMidiEvents();
  $("saveButton").addEventListener("click", () => saveProject(true)); $("exportButton").addEventListener("click", exportJson); $("importFile").addEventListener("change", importJson); $("resetButton").addEventListener("click", resetProject); $("generateButton").addEventListener("click", generatePrompts);
}

function init() { fillSelects(); $("bpm").value = "120"; renderChecklist(); loadProject(); Object.keys(otherFieldMap).forEach(updateOtherVisibility); setupEvents(); }
document.addEventListener("DOMContentLoaded", init);
