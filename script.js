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
  return { appName: "AI Music Helper", version: 2, savedAt: new Date().toISOString(), fields, checklist };
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
  $("saveButton").addEventListener("click", () => saveProject(true)); $("exportButton").addEventListener("click", exportJson); $("importFile").addEventListener("change", importJson); $("resetButton").addEventListener("click", resetProject); $("generateButton").addEventListener("click", generatePrompts);
}

function init() { fillSelects(); $("bpm").value = "120"; renderChecklist(); loadProject(); Object.keys(otherFieldMap).forEach(updateOtherVisibility); setupEvents(); }
document.addEventListener("DOMContentLoaded", init);
