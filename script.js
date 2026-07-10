const STORAGE_KEY = "aiMusicHelperProject";

const checklistItems = [
  "AIで曲を作る",
  "ステム分離する",
  "Logic Proで編集する",
  "MIDIを作る",
  "VoiSonaで歌わせる",
  "RVCまたはApplioで自分の声に変える",
  "ミックスする",
  "書き出す",
];

const fieldIds = [
  "title",
  "genre",
  "bpm",
  "key",
  "mood",
  "reference",
  "lyricsIntro",
  "lyricsVerseA",
  "lyricsVerseB",
  "lyricsChorus",
  "lyricsInterlude",
  "lyricsFinalChorus",
  "promptJa",
  "promptEn",
];

const lyricLabels = {
  lyricsIntro: "イントロ",
  lyricsVerseA: "Aメロ",
  lyricsVerseB: "Bメロ",
  lyricsChorus: "サビ",
  lyricsInterlude: "間奏",
  lyricsFinalChorus: "ラスサビ",
};

const $ = (id) => document.getElementById(id);
let toastTimer;

function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2200);
}

function getProjectData() {
  const fields = Object.fromEntries(fieldIds.map((id) => [id, $(id).value.trim()]));
  const checklist = checklistItems.map((_, index) => $(`check-${index}`).checked);
  return {
    appName: "AI Music Helper",
    savedAt: new Date().toISOString(),
    fields,
    checklist,
  };
}

function setProjectData(data) {
  const fields = data?.fields || {};
  fieldIds.forEach((id) => {
    $(id).value = fields[id] || "";
  });

  const checklist = Array.isArray(data?.checklist) ? data.checklist : [];
  checklistItems.forEach((_, index) => {
    $(`check-${index}`).checked = Boolean(checklist[index]);
  });
}

function saveProject(showMessage = true) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(getProjectData()));
  if (showMessage) showToast("この端末に保存しました");
}

function loadProject() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (!saved) return;

  try {
    setProjectData(JSON.parse(saved));
    showToast("保存データを読み込みました");
  } catch (error) {
    console.error(error);
    showToast("保存データを読み込めませんでした");
  }
}

function buildLyricBlock() {
  return Object.entries(lyricLabels)
    .map(([id, label]) => {
      const value = $(id).value.trim();
      return value ? `【${label}】\n${value}` : "";
    })
    .filter(Boolean)
    .join("\n\n");
}

function generatePrompts() {
  const title = $("title").value.trim() || "未定の曲";
  const genre = $("genre").value.trim() || "ジャンル未定";
  const bpm = $("bpm").value.trim() || "BPM未定";
  const key = $("key").value.trim() || "キー未定";
  const mood = $("mood").value.trim() || "雰囲気未定";
  const reference = $("reference").value.trim() || "参考イメージ未定";
  const lyrics = buildLyricBlock() || "歌詞は後で追加する。";

  $("promptJa").value = [
    `曲名「${title}」のAI音楽を制作してください。`,
    `ジャンルは${genre}、テンポは${bpm}、キーは${key}。`,
    `曲の雰囲気は「${mood}」。`,
    `参考イメージは「${reference}」。`,
    "構成はイントロ、Aメロ、Bメロ、サビ、間奏、ラスサビを意識し、歌メロが自然に盛り上がるアレンジにしてください。",
    "ボーカルが聴き取りやすく、ミックスしやすい音数で、完成後にDAWで編集しやすい構成にしてください。",
    "歌詞:",
    lyrics,
  ].join("\n");

  $("promptEn").value = [
    `Create an AI-generated song titled "${title}".`,
    `Genre: ${genre}. Tempo: ${bpm}. Key: ${key}.`,
    `Mood and atmosphere: ${mood}.`,
    `Reference image and production notes: ${reference}.`,
    "Use a clear structure with intro, verse A, verse B, chorus, interlude, and final chorus. Make the melody feel natural and emotionally engaging.",
    "Keep the vocal clear, the arrangement easy to mix, and the song structure easy to edit later in a DAW.",
    "Lyrics:",
    lyrics,
  ].join("\n");

  saveProject(false);
  showToast("プロンプトを生成しました");
}

function exportJson() {
  const data = getProjectData();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const safeTitle = (data.fields.title || "ai-music-helper").replace(/[\\/:*?"<>|\s]+/g, "-");
  const link = document.createElement("a");
  link.href = url;
  link.download = `${safeTitle}.json`;
  link.click();
  URL.revokeObjectURL(url);
  showToast("JSONを書き出しました");
}

function importJson(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      setProjectData(data);
      saveProject(false);
      showToast("JSONを読み込みました");
    } catch (error) {
      console.error(error);
      showToast("JSONを読み込めませんでした");
    } finally {
      event.target.value = "";
    }
  };
  reader.readAsText(file);
}

function resetProject() {
  const ok = window.confirm("入力内容とチェック状態をリセットしますか？");
  if (!ok) return;

  fieldIds.forEach((id) => {
    $(id).value = "";
  });
  checklistItems.forEach((_, index) => {
    $(`check-${index}`).checked = false;
  });
  localStorage.removeItem(STORAGE_KEY);
  showToast("リセットしました");
}

function renderChecklist() {
  const checklist = $("checklist");
  checklist.innerHTML = "";
  checklistItems.forEach((item, index) => {
    const label = document.createElement("label");
    label.className = "check-item";
    label.innerHTML = `<input type="checkbox" id="check-${index}" /> <span>${item}</span>`;
    checklist.appendChild(label);
  });
}

function setupAutoSave() {
  fieldIds.forEach((id) => $(id).addEventListener("input", () => saveProject(false)));
  checklistItems.forEach((_, index) => $(`check-${index}`).addEventListener("change", () => saveProject(false)));
}

function init() {
  renderChecklist();
  loadProject();
  setupAutoSave();
  $("saveButton").addEventListener("click", () => saveProject(true));
  $("exportButton").addEventListener("click", exportJson);
  $("importFile").addEventListener("change", importJson);
  $("resetButton").addEventListener("click", resetProject);
  $("generateButton").addEventListener("click", generatePrompts);
}

document.addEventListener("DOMContentLoaded", init);
