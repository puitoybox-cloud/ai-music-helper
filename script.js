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
const voisonaBrackets = /[「」『』（）]/g;
const voisonaPunctuation = /[、。]/g;
const voisonaSymbols = /[!！?？…・♪♡☆★\-—〜~]/g;
let midiState = null;
let midiEditorData = [];
let midiEditorOverflow = [];
let midiSelectedCell = { measureIndex: 0, noteIndex: 0 };

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
  const combineYoon = $("midiCombineSmallYoon")?.checked ?? true;
  const combineLong = $("midiLongVowelMode")?.checked ?? false;
  const countSmallTsu = $("midiSmallTsuMode")?.checked ?? true;
  const units = [];
  Array.from(text.normalize("NFKC")).forEach((ch) => {
    if (/\s/.test(ch)) return;
    if (combineYoon && "ゃゅょぁぃぅぇぉゎ".includes(ch) && units.length) units[units.length - 1] += ch;
    else if (ch === "ー" && combineLong && units.length) units[units.length - 1] += ch;
    else if (ch === "っ" && !countSmallTsu && units.length) units[units.length - 1] += ch;
    else units.push(ch);
  });
  return units;
}

const voisonaSimpleDictionary = new Map(Object.entries({
  "私": "わたし", "僕": "ぼく", "俺": "おれ", "君": "きみ", "あなた": "あなた",
  "未来": "みらい", "過去": "かこ", "今日": "きょう", "明日": "あした", "昨日": "きのう",
  "世界": "せかい", "光": "ひかり", "夜": "よる", "朝": "あさ", "空": "そら", "星": "ほし", "月": "つき", "太陽": "たいよう",
  "声": "こえ", "歌": "うた", "夢": "ゆめ", "心": "こころ", "愛": "あい", "涙": "なみだ", "笑顔": "えがお",
  "走る": "はしる", "行く": "いく", "来る": "くる", "見る": "みる", "聞く": "きく", "想い": "おもい", "思い": "おもい",
  "風": "かぜ", "雨": "あめ", "雪": "ゆき", "花": "はな", "道": "みち", "街": "まち", "時": "とき", "時間": "じかん",
}));

function setHiraganaStatus(message, state = "ready") {
  const status = $("hiraganaStatus");
  if (!status) return;
  status.textContent = message;
  status.classList.toggle("is-loading", state === "loading");
  status.classList.toggle("is-error", state === "error");
  status.classList.toggle("is-ready", state === "ready");
}

function convertKatakanaToHiragana(text) {
  return text.replace(/[ァ-ン]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60));
}

function simpleDictionaryConvert(input, options = {}) {
  let converted = convertKatakanaToHiragana(input.normalize("NFKC"));
  const entries = [...voisonaSimpleDictionary.entries()].sort((a, b) => b[0].length - a[0].length);
  entries.forEach(([kanji, reading]) => {
    converted = converted.replaceAll(kanji, reading);
  });
  return applyVoisonaCleanup(converted, options);
}

function buildVoisonaChatGptPrompt(lyrics) {
  return `次の歌詞を、VoiSonaで歌わせやすいように、ひらがなに変換してください。

条件：
- 漢字は自然な読みでひらがなにする
- カタカナもできればひらがなにする
- 英語は発音に近いカタカナまたはひらがなにする
- 鍵かっこ、句読点、記号は省く
- 改行は元の歌詞に合わせて残す
- 歌として自然な読みを優先する
- 読みが複数ある言葉は、文脈に合う自然な読みを選ぶ
- 出力はひらがなの歌詞だけにする

歌詞：
${lyrics}`;
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
    chatGptPrompt: $("voisonaChatGptPrompt")?.value || "",
    cleanedLyrics: applyVoisonaCleanup(getVoisonaEditableText(), { brackets: true, punctuation: true, symbols: true, newlinesToSpaces: $("voisonaNewlineMode")?.value === "space" }),
    outputFormat: $("voisonaOutputFormat")?.value || "slash",
    newlineMode: $("voisonaNewlineMode")?.value || "keep",
    cleanupOnConvert: $("voisonaCleanupOnConvert")?.checked !== false,
    separatedOutput: $("voisonaSeparatedOutput")?.value || "",
  };
}

function setVoisonaProjectData(data) {
  if (!$("voisonaKanjiLyrics")) return;
  $("voisonaKanjiLyrics").value = data?.kanjiLyrics || "";
  $("voisonaHiraganaLyrics").value = data?.hiraganaLyrics || data?.cleanedLyrics || "";
  if ($("voisonaChatGptPrompt")) $("voisonaChatGptPrompt").value = data?.chatGptPrompt || "";
  $("voisonaOutputFormat").value = data?.outputFormat || "slash";
  $("voisonaNewlineMode").value = data?.newlineMode || "keep";
  if ($("voisonaCleanupOnConvert")) $("voisonaCleanupOnConvert").checked = data?.cleanupOnConvert !== false;
  updateVoisonaOutput();
}

function setupVoisonaEvents() {
  if (!$("voisonaKanjiLyrics")) return;
  $("voisonaConvertButton").addEventListener("click", async () => {
    const shouldCleanup = $("voisonaCleanupOnConvert")?.checked !== false;
    const converted = simpleDictionaryConvert($("voisonaKanjiLyrics").value, { brackets: shouldCleanup, punctuation: shouldCleanup, symbols: shouldCleanup, newlinesToSpaces: $("voisonaNewlineMode").value === "space" });
    $("voisonaHiraganaLyrics").value = converted;
    setHiraganaStatus("簡易変換しました。未変換の漢字は残しているので、必要に応じて手直ししてください。", "ready");
    updateVoisonaOutput();
    scheduleAutoSave();
    showToast("簡易ひらがな変換しました");
  });
  $("voisonaBuildChatGptPromptButton").addEventListener("click", () => {
    $("voisonaChatGptPrompt").value = buildVoisonaChatGptPrompt($("voisonaKanjiLyrics").value);
    scheduleAutoSave();
    showToast("ChatGPT用プロンプトを作りました");
  });
  $("voisonaRemoveSymbolsButton").addEventListener("click", () => { $("voisonaHiraganaLyrics").value = applyVoisonaCleanup(getVoisonaEditableText(), { brackets: true, punctuation: true, symbols: true, newlinesToSpaces: $("voisonaNewlineMode").value === "space" }); updateVoisonaOutput(); scheduleAutoSave(); showToast("記号を整理しました"); });
  $("voisonaRemoveBracketsButton").addEventListener("click", () => { $("voisonaHiraganaLyrics").value = applyVoisonaCleanup(getVoisonaEditableText(), { brackets: true }); updateVoisonaOutput(); scheduleAutoSave(); showToast("鍵かっこを省きました"); });
  $("voisonaRemovePunctuationButton").addEventListener("click", () => { $("voisonaHiraganaLyrics").value = applyVoisonaCleanup(getVoisonaEditableText(), { punctuation: true }); updateVoisonaOutput(); scheduleAutoSave(); showToast("句読点を省きました"); });
  $("voisonaNormalizeLinesButton").addEventListener("click", () => { $("voisonaHiraganaLyrics").value = applyVoisonaCleanup(getVoisonaEditableText(), { newlinesToSpaces: $("voisonaNewlineMode").value === "space" }); updateVoisonaOutput(); scheduleAutoSave(); showToast("改行を整理しました"); });
  $("voisonaNormalizeSpacesButton").addEventListener("click", () => { $("voisonaHiraganaLyrics").value = normalizeVoisonaSpaces(getVoisonaEditableText()); updateVoisonaOutput(); scheduleAutoSave(); showToast("空白を整理しました"); });
  $("voisonaSendToMidiButton").addEventListener("click", () => { $("midiLyricsInput").value = applyVoisonaCleanup(getVoisonaEditableText(), { brackets: true, punctuation: true, symbols: true, newlinesToSpaces: true }); updateMidiLyricsAllocation(); scheduleAutoSave(); showToast("MIDI歌詞割り当て補助へ送りました"); });
  ["voisonaKanjiLyrics", "voisonaHiraganaLyrics", "voisonaChatGptPrompt", "voisonaOutputFormat", "voisonaNewlineMode", "voisonaCleanupOnConvert"].forEach((id) => $(id).addEventListener("input", () => { updateVoisonaOutput(); scheduleAutoSave(); }));
}

function updateMidiLyricsAllocation(resetEditor = true) {
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
  if (resetEditor) rebuildMidiEditorFromAuto();
  else { ensureMidiEditorShape(); renderMidiNoteEditor(); }
}

function getMidiAutoEditorData() {
  if (!midiState) return [];
  const units = splitJapaneseLyrics($("midiLyricsInput")?.value || "");
  const counts = getTrackMeasureCounts(midiState.parsed, getSelectedMidiTrackIndex());
  let cursor = 0;
  return counts.map((item) => {
    const lyrics = Array.from({ length: item.count }, () => units[cursor++] || "");
    return { measure: item.measure, lyrics };
  });
}

function getMidiEditorSignature(data = midiEditorData) {
  return data.map((measure) => `${measure.measure}:${measure.lyrics.length}`).join("|");
}

function flattenMidiEditorData() {
  return midiEditorData.flatMap((measure) => measure.lyrics);
}

function setMidiEditorFromFlat(flat, overflow = []) {
  let cursor = 0;
  midiEditorData = midiEditorData.map((measure) => {
    const lyrics = measure.lyrics.map(() => flat[cursor++] || "");
    return { ...measure, lyrics };
  });
  midiEditorOverflow = overflow;
}

function getFlatIndex(measureIndex, noteIndex) {
  return midiEditorData.slice(0, measureIndex).reduce((sum, measure) => sum + measure.lyrics.length, 0) + noteIndex;
}

function updateMidiOverflowDisplay() {
  const box = $("midiOverflowLyrics");
  if (!box) return;
  const sep = $("midiOutputSeparator")?.value === "space" ? " " : " / ";
  box.hidden = midiEditorOverflow.length === 0;
  box.innerHTML = midiEditorOverflow.length ? `<strong>あふれた歌詞：</strong><span>${midiEditorOverflow.join(sep) || "（空欄）"}</span>` : "";
}

function fillMidiEditorCapacity(combined, capacity) {
  while (combined.length < capacity) combined.push("");
  setMidiEditorFromFlat(combined.slice(0, capacity), combined.slice(capacity).filter((value) => value !== ""));
}

function compactMidiEditorBlanks(showMessage = true) {
  const capacity = flattenMidiEditorData().length;
  const combined = [...flattenMidiEditorData(), ...midiEditorOverflow].filter((value) => value.trim() !== "");
  fillMidiEditorCapacity(combined, capacity);
  renderMidiNoteEditor();
  buildMidiOutputFromEditor(false);
  if (showMessage) showToast("編集表全体の空欄を前に詰めました");
}

function applyMidiEditorShift(flatIndex, newValue, oldValue = "") {
  const flat = flattenMidiEditorData();
  const capacity = flat.length;
  const combined = [...flat, ...midiEditorOverflow];
  const normalizedNewValue = newValue.trim();
  const normalizedOldValue = oldValue.trim();
  if (normalizedOldValue && !normalizedNewValue) {
    combined.splice(flatIndex, 1);
  } else if (!normalizedOldValue && normalizedNewValue) {
    if ((combined[flatIndex] || "").trim() === "") combined[flatIndex] = normalizedNewValue;
    else combined.splice(flatIndex, 0, normalizedNewValue);
  } else if (normalizedOldValue && normalizedNewValue.startsWith(normalizedOldValue) && Array.from(normalizedNewValue).length > Array.from(normalizedOldValue).length) {
    combined[flatIndex] = normalizedOldValue;
    combined.splice(flatIndex + 1, 0, normalizedNewValue.slice(normalizedOldValue.length));
  } else {
    combined[flatIndex] = normalizedNewValue;
  }
  fillMidiEditorCapacity(combined, capacity);
}

function updateMidiSelectedCellClasses() {
  document.querySelectorAll(".midi-note-cell").forEach((cell) => {
    const input = cell.querySelector("input[data-measure-index][data-note-index]");
    const isSelected = input && Number(input.dataset.measureIndex) === midiSelectedCell.measureIndex && Number(input.dataset.noteIndex) === midiSelectedCell.noteIndex;
    cell.classList.toggle("is-selected", Boolean(isSelected));
  });
}

function insertMidiEditorNoteAfter(measureIndex, noteIndex) {
  const flatIndex = getFlatIndex(measureIndex, noteIndex) + 1;
  const combined = [...flattenMidiEditorData(), ...midiEditorOverflow];
  const capacity = flattenMidiEditorData().length;
  combined.splice(flatIndex, 0, "");
  fillMidiEditorCapacity(combined, capacity);
  const targetIndex = Math.min(flatIndex, capacity - 1);
  let nextMeasureIndex = 0;
  let remaining = targetIndex;
  for (const [index, measure] of midiEditorData.entries()) {
    if (remaining < measure.lyrics.length) { nextMeasureIndex = index; break; }
    remaining -= measure.lyrics.length;
  }
  midiSelectedCell = { measureIndex: nextMeasureIndex, noteIndex: remaining };
  renderMidiNoteEditor();
  buildMidiOutputFromEditor(false);
}

function deleteMidiEditorNote(measureIndex, noteIndex) {
  applyMidiEditorShift(getFlatIndex(measureIndex, noteIndex), "", midiEditorData[measureIndex]?.lyrics?.[noteIndex] || "");
  midiSelectedCell = { measureIndex, noteIndex: Math.min(noteIndex, (midiEditorData[measureIndex]?.lyrics?.length || 1) - 1) };
  renderMidiNoteEditor();
  buildMidiOutputFromEditor(false);
}

function mergeMidiEditorNoteRight(measureIndex, noteIndex) {
  const flatIndex = getFlatIndex(measureIndex, noteIndex);
  const combined = [...flattenMidiEditorData(), ...midiEditorOverflow];
  if (flatIndex >= combined.length - 1) return;
  combined[flatIndex] = `${combined[flatIndex] || ""}${combined[flatIndex + 1] || ""}`;
  combined.splice(flatIndex + 1, 1);
  const capacity = flattenMidiEditorData().length;
  while (combined.length < capacity) combined.push("");
  setMidiEditorFromFlat(combined.slice(0, capacity), combined.slice(capacity).filter((value) => value !== ""));
  renderMidiNoteEditor();
  buildMidiOutputFromEditor(false);
}

function splitMidiEditorNote(measureIndex, noteIndex) {
  const value = midiEditorData[measureIndex]?.lyrics?.[noteIndex] || "";
  const chars = Array.from(value);
  if (chars.length < 2) return;
  const flatIndex = getFlatIndex(measureIndex, noteIndex);
  const combined = [...flattenMidiEditorData(), ...midiEditorOverflow];
  combined.splice(flatIndex, 1, chars[0], chars.slice(1).join(""));
  const capacity = flattenMidiEditorData().length;
  setMidiEditorFromFlat(combined.slice(0, capacity), combined.slice(capacity).filter((item) => item !== ""));
  renderMidiNoteEditor();
  buildMidiOutputFromEditor(false);
}

function rebuildMidiEditorFromAuto() {
  midiEditorData = getMidiAutoEditorData();
  midiEditorOverflow = [];
  renderMidiNoteEditor();
}

function ensureMidiEditorShape() {
  const autoData = getMidiAutoEditorData();
  if (getMidiEditorSignature(autoData) !== getMidiEditorSignature(midiEditorData)) {
    midiEditorData = autoData;
    midiEditorOverflow = [];
  }
}

function renderMidiNoteEditor() {
  const editor = $("midiNoteEditor");
  if (!editor) return;
  editor.innerHTML = "";
  if (!midiState) {
    editor.innerHTML = `<p class="empty-editor-message">MIDIを読み込むと、音符ごとの編集表が表示されます。</p>`;
    return;
  }
  if (!midiEditorData.length) {
    editor.innerHTML = `<p class="empty-editor-message">選択中のトラックに音符がありません。</p>`;
    return;
  }
  midiEditorData.forEach((measure, measureIndex) => {
    const card = document.createElement("section");
    card.className = "midi-measure-card measure-card";
    const title = document.createElement("h5");
    title.textContent = `小節 ${measure.measure}`;
    card.appendChild(title);
    const notes = document.createElement("div");
    notes.className = "midi-note-inputs note-edit-table";
    measure.lyrics.forEach((lyric, noteIndex) => {
      const label = document.createElement("label");
      const isSelected = midiSelectedCell.measureIndex === measureIndex && midiSelectedCell.noteIndex === noteIndex;
      label.className = `midi-note-cell note-cell${isSelected ? " is-selected" : ""}`;
      label.innerHTML = `<span>音符${noteIndex + 1}</span><input class="note-input" type="text" value="" data-measure-index="${measureIndex}" data-note-index="${noteIndex}" data-old-value="" autocomplete="off" /><div class="note-cell-actions"><button type="button" data-note-action="insert" data-measure-index="${measureIndex}" data-note-index="${noteIndex}">この位置で1音追加</button><button type="button" data-note-action="delete" data-measure-index="${measureIndex}" data-note-index="${noteIndex}">この音を削除して前に詰める</button><button type="button" data-note-action="merge" data-measure-index="${measureIndex}" data-note-index="${noteIndex}">右と結合</button><button type="button" data-note-action="split" data-measure-index="${measureIndex}" data-note-index="${noteIndex}">ここで分割</button></div>`;
      const input = label.querySelector("input");
      input.value = lyric;
      input.dataset.oldValue = lyric;
      notes.appendChild(label);
    });
    card.appendChild(notes);
    editor.appendChild(card);
  });
  updateMidiOverflowDisplay();
}

function formatMidiEditorOutput() {
  const sep = $("midiOutputSeparator").value === "space" ? " " : " / ";
  const lines = midiEditorData.map((item) => `${item.measure}小節目：${item.lyrics.join(sep)}`);
  if (midiEditorOverflow.length) lines.push(`あふれた歌詞：${midiEditorOverflow.join(sep)}`);
  return lines.join("\n");
}

function buildMidiOutputFromEditor(showMessage = true) {
  ensureMidiEditorShape();
  $("midiLyricsOutput").value = formatMidiEditorOutput();
  updateMidiOverflowDisplay();
  scheduleAutoSave();
  if (showMessage) showToast("編集表からVoiSona出力を作りました");
}

async function copyMidiEditorContent() {
  ensureMidiEditorShape();
  const text = formatMidiEditorOutput();
  if (!text) { showToast("コピーする編集表がありません"); return; }
  try { await navigator.clipboard.writeText(text); showToast("編集表の内容をコピーしました"); }
  catch { $("midiLyricsOutput").value = text; $("midiLyricsOutput").select(); document.execCommand("copy"); showToast("編集表の内容をコピーしました"); }
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
    editorData: midiEditorData,
    editorOverflow: midiEditorOverflow,
    autoShiftMode: Boolean($("midiAutoShiftMode")?.checked),
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
  midiEditorData = Array.isArray(data?.editorData) ? data.editorData : [];
  midiEditorOverflow = Array.isArray(data?.editorOverflow) ? data.editorOverflow : [];
  if ($("midiAutoShiftMode")) $("midiAutoShiftMode").checked = Boolean(data?.autoShiftMode);
  renderMidiAnalysis(); updateMidiLyricsAllocation();
  if (Array.isArray(data?.editorData)) {
    midiEditorData = data.editorData;
    midiEditorOverflow = Array.isArray(data?.editorOverflow) ? data.editorOverflow : [];
    ensureMidiEditorShape();
    renderMidiNoteEditor();
    if (data?.allocationOutput) $("midiLyricsOutput").value = data.allocationOutput;
  }
}

function clearMidiProjectData() {
  midiState = null;
  if ($("midiFile")) $("midiFile").value = "";
  if ($("midiFileName")) $("midiFileName").textContent = "未選択";
  if ($("midiLyricsInput")) $("midiLyricsInput").value = "";
  if ($("midiLyricsOutput")) $("midiLyricsOutput").value = "";
  midiEditorData = [];
  midiEditorOverflow = [];
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
  ["midiTrackSelect", "midiLyricsInput", "midiCombineSmallYoon", "midiLongVowelMode", "midiSmallTsuMode"].forEach((id) => $(id).addEventListener("input", () => { renderMidiAnalysis(); updateMidiLyricsAllocation(true); scheduleAutoSave(); }));
  $("midiOutputSeparator").addEventListener("input", () => { renderMidiAnalysis(); updateMidiLyricsAllocation(false); $("midiLyricsOutput").value = formatMidiEditorOutput(); scheduleAutoSave(); });
  $("midiTrackSelect").addEventListener("change", () => { renderMidiAnalysis(); updateMidiLyricsAllocation(); scheduleAutoSave(); });
  $("midiNoteEditor").addEventListener("input", (event) => {
    const input = event.target.closest("input[data-measure-index][data-note-index]");
    if (!input) return;
    const measureIndex = Number(input.dataset.measureIndex);
    const noteIndex = Number(input.dataset.noteIndex);
    midiSelectedCell = { measureIndex, noteIndex };
    const oldValue = input.dataset.oldValue || "";
    if ($("midiAutoShiftMode")?.checked) {
      applyMidiEditorShift(getFlatIndex(measureIndex, noteIndex), input.value, oldValue);
      renderMidiNoteEditor();
      buildMidiOutputFromEditor(false);
    } else if (midiEditorData[measureIndex]?.lyrics) {
      midiEditorData[measureIndex].lyrics[noteIndex] = input.value;
      input.dataset.oldValue = input.value;
      scheduleAutoSave();
    }
  });
  $("midiNoteEditor").addEventListener("focusin", (event) => {
    const input = event.target.closest("input[data-measure-index][data-note-index]");
    if (!input) return;
    midiSelectedCell = { measureIndex: Number(input.dataset.measureIndex), noteIndex: Number(input.dataset.noteIndex) };
    updateMidiSelectedCellClasses();
  });
  $("midiNoteEditor").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-note-action]");
    if (!button) return;
    const measureIndex = Number(button.dataset.measureIndex);
    const noteIndex = Number(button.dataset.noteIndex);
    midiSelectedCell = { measureIndex, noteIndex };
    const action = button.dataset.noteAction;
    if (action === "insert") insertMidiEditorNoteAfter(measureIndex, noteIndex);
    if (action === "delete") deleteMidiEditorNote(measureIndex, noteIndex);
    if (action === "merge") mergeMidiEditorNoteRight(measureIndex, noteIndex);
    if (action === "split") splitMidiEditorNote(measureIndex, noteIndex);
    scheduleAutoSave();
  });
  $("midiAutoShiftMode").addEventListener("change", scheduleAutoSave);
  $("midiCompactBlanksButton").addEventListener("click", () => compactMidiEditorBlanks(true));
  $("midiBuildFromEditorButton").addEventListener("click", () => buildMidiOutputFromEditor(true));
  $("midiResetEditorButton").addEventListener("click", () => { rebuildMidiEditorFromAuto(); buildMidiOutputFromEditor(); showToast("編集表を自動分割の内容に戻しました"); });
  $("midiCopyEditorButton").addEventListener("click", copyMidiEditorContent);
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

function init() { fillSelects(); $("bpm").value = "120"; renderChecklist(); loadProject(); Object.keys(otherFieldMap).forEach(updateOtherVisibility); setupEvents(); setHiraganaStatus("外部ライブラリなしの簡易変換です。漢字は削除せず残すので、必要に応じて手直ししてください。", "ready"); }
document.addEventListener("DOMContentLoaded", init);
