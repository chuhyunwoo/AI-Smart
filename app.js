const MODEL_URL = "https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@master/weights";
const STORAGE_PREFIX = "mood-note:day:";
const SAMPLE_INTERVAL_MS = 3000;

const EXPRESSIONS = {
  happy: { label: "행복", emoji: "😊", color: "#f0bf67" },
  sad: { label: "슬픔", emoji: "😢", color: "#8eabe8" },
  angry: { label: "화남", emoji: "😠", color: "#e88e91" },
  surprised: { label: "놀람", emoji: "😮", color: "#bd9ce9" },
  fearful: { label: "두려움", emoji: "😟", color: "#8ec7b0" },
  disgusted: { label: "불쾌", emoji: "😣", color: "#88b97e" },
  neutral: { label: "차분함", emoji: "😐", color: "#aaa6b5" },
};

const camera = document.querySelector("#camera");
const cameraButton = document.querySelector("#camera-button");
const checkInButton = document.querySelector("#check-in-button");
const retryModelsButton = document.querySelector("#retry-models-button");
const cameraPlaceholder = document.querySelector("#camera-placeholder");
const cameraIndicator = document.querySelector("#camera-indicator");
const cameraState = document.querySelector("#camera-state");
const statusMessage = document.querySelector("#status-message");
const expressionBadge = document.querySelector("#expression-badge");
const expressionEmoji = document.querySelector("#expression-emoji");
const expressionLabel = document.querySelector("#expression-label");
const expressionConfidence = document.querySelector("#expression-confidence");
const recordCount = document.querySelector("#record-count");
const dominantEmotion = document.querySelector("#dominant-emotion");
const summaryEmoji = document.querySelector("#summary-emoji");
const summaryTitle = document.querySelector("#summary-title");
const summaryDescription = document.querySelector("#summary-description");
const emotionList = document.querySelector("#emotion-list");
const chartCaption = document.querySelector("#chart-caption");
const timelineList = document.querySelector("#timeline-list");
const clearButton = document.querySelector("#clear-button");
const todayDate = document.querySelector("#today-date");

let modelsReady = false;
let cameraStream = null;
let samplingTimer = null;
let isAnalyzing = false;
let activeDay = "";

function getLocalDayKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getStorageKey() {
  return `${STORAGE_PREFIX}${getLocalDayKey()}`;
}

function readRecords() {
  const stored = localStorage.getItem(getStorageKey());
  if (stored === null) {
    return [];
  }

  const records = JSON.parse(stored);
  if (!Array.isArray(records) || records.some((record) =>
    !record || !Number.isFinite(record.t) || !EXPRESSIONS[record.e] ||
    !Number.isFinite(record.p) || record.p < 0 || record.p > 100
  )) {
    throw new Error("오늘 기록의 저장 형식이 올바르지 않습니다.");
  }
  return records;
}

function setStatus(message, isError = false) {
  statusMessage.textContent = message;
  statusMessage.classList.toggle("is-error", isError);
}

function setCameraActive(isActive) {
  cameraIndicator.classList.toggle("is-live", isActive);
  cameraState.textContent = isActive ? "기록 중" : "카메라 꺼짐";
  cameraButton.textContent = isActive ? "기록 멈추기" : "카메라 시작하기";
  cameraButton.classList.toggle("is-stop", isActive);
  checkInButton.disabled = !isActive;
  cameraPlaceholder.hidden = isActive;
  camera.hidden = !isActive;
}

async function loadModels() {
  cameraButton.disabled = true;
  retryModelsButton.hidden = true;
  setStatus("AI 모델을 준비하고 있어요. 처음에는 조금 걸릴 수 있어요.");

  try {
    if (!window.faceapi) {
      throw new Error("표정 분석 라이브러리를 불러오지 못했습니다. 인터넷 연결을 확인해 주세요.");
    }

    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
      faceapi.nets.faceExpressionNet.loadFromUri(MODEL_URL),
    ]);
    modelsReady = true;
    cameraButton.disabled = false;
    setStatus("준비됐어요. 카메라를 켜면 3초마다 오늘의 표정을 기록해요.");
  } catch (error) {
    modelsReady = false;
    cameraButton.disabled = true;
    retryModelsButton.hidden = false;
    setStatus(`모델을 불러오지 못했어요: ${error.message}`, true);
  }
}

async function startCamera() {
  if (!modelsReady || cameraStream) {
    return;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setStatus("이 브라우저에서는 카메라를 사용할 수 없어요. HTTPS 또는 localhost에서 열어 주세요.", true);
    return;
  }

  cameraButton.disabled = true;
  setStatus("카메라 권한을 기다리고 있어요.");

  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: "user" },
    });
    camera.srcObject = cameraStream;
    await camera.play();
    setCameraActive(true);
    cameraButton.disabled = false;
    setStatus("카메라가 켜졌어요. 표정은 이 기기에서만 분석돼요.");
    await sampleExpression();
    samplingTimer = window.setInterval(sampleExpression, SAMPLE_INTERVAL_MS);
  } catch (error) {
    stopCamera();
    const message = error.name === "NotAllowedError"
      ? "카메라 권한이 필요해요. 브라우저 설정에서 권한을 허용해 주세요."
      : error.name === "NotFoundError"
        ? "사용할 수 있는 카메라를 찾지 못했어요."
        : `카메라를 시작하지 못했어요: ${error.message}`;
    setStatus(message, true);
  }
}

function stopCamera() {
  if (samplingTimer !== null) {
    window.clearInterval(samplingTimer);
    samplingTimer = null;
  }
  if (cameraStream) {
    cameraStream.getTracks().forEach((track) => track.stop());
    cameraStream = null;
  }
  camera.srcObject = null;
  setCameraActive(false);
  cameraButton.disabled = !modelsReady;
}

async function sampleExpression() {
  if (!cameraStream || isAnalyzing || camera.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    return;
  }

  isAnalyzing = true;
  try {
    const result = await faceapi
      .detectSingleFace(camera, new faceapi.TinyFaceDetectorOptions({
        inputSize: 224,
        scoreThreshold: 0.5,
      }))
      .withFaceExpressions();

    if (!result) {
      setStatus("얼굴을 찾지 못했어요. 카메라를 정면으로 바라봐 주세요.");
      return;
    }

    const [expression, score] = Object.entries(result.expressions)
      .sort((first, second) => second[1] - first[1])[0];
    const details = EXPRESSIONS[expression];
    const confidence = Math.round(score * 100);
    expressionEmoji.textContent = details.emoji;
    expressionLabel.textContent = details.label;
    expressionConfidence.textContent = `${confidence}%`;
    expressionBadge.hidden = false;

    const saved = saveRecord({ t: Date.now(), e: expression, p: confidence });
    if (saved) {
      setStatus(`${details.label} 표정으로 기록했어요. 분석 결과는 참고용 추정치예요.`);
    }
  } catch (error) {
    setStatus(`표정을 분석하지 못했어요: ${error.message}`, true);
  } finally {
    isAnalyzing = false;
  }
}

function saveRecord(record) {
  try {
    const records = readRecords();
    records.push(record);
    localStorage.setItem(getStorageKey(), JSON.stringify(records));
    renderDashboard(records);
    return true;
  } catch (error) {
    setStatus(`기록을 저장하지 못했어요: ${error.message}`, true);
    return false;
  }
}

function renderDashboard(records) {
  recordCount.textContent = String(records.length);
  clearButton.disabled = records.length === 0;
  const totals = new Map();
  for (const record of records) {
    totals.set(record.e, (totals.get(record.e) || 0) + 1);
  }

  const sortedEmotions = [...totals.entries()].sort((first, second) => second[1] - first[1]);
  if (sortedEmotions.length === 0) {
    dominantEmotion.textContent = "—";
    summaryEmoji.textContent = "☁️";
    summaryTitle.textContent = "아직 기록이 없어요";
    summaryDescription.textContent = "카메라를 켜거나 지금 표정을 기록해 보세요.";
    chartCaption.textContent = "기록이 쌓이면 여기에 보여요";
    emotionList.innerHTML = '<p class="empty-chart">아직 표시할 기록이 없어요.</p>';
    timelineList.innerHTML = '<p class="empty-timeline">표정을 기록하면 시간대별 흐름이 여기에 쌓여요.</p>';
    return;
  }

  const [mostCommonExpression, mostCommonCount] = sortedEmotions[0];
  const details = EXPRESSIONS[mostCommonExpression];
  const percent = Math.round((mostCommonCount / records.length) * 100);
  dominantEmotion.textContent = details.label;
  summaryEmoji.textContent = details.emoji;
  summaryTitle.textContent = `오늘은 ${details.label} 표정이 가장 많았어요`;
  summaryDescription.textContent = `전체 기록 중 ${percent}%에서 관찰됐어요. 표정은 실제 기분과 다를 수 있어요.`;
  chartCaption.textContent = `총 ${records.length}회 기록`;

  emotionList.innerHTML = sortedEmotions.map(([expression, count]) => {
    const emotion = EXPRESSIONS[expression];
    const share = Math.round((count / records.length) * 100);
    return `
      <div class="emotion-row">
        <span class="emotion-name">${emotion.emoji} ${emotion.label}</span>
        <div class="emotion-track" aria-hidden="true">
          <div class="emotion-fill" style="width: ${share}%; --emotion-color: ${emotion.color}"></div>
        </div>
        <span class="emotion-percent">${share}%</span>
      </div>
    `;
  }).join("");

  renderTimeline(records);
}

function renderTimeline(records) {
  const hours = new Map();
  for (const record of records) {
    const hour = new Date(record.t).getHours();
    if (!hours.has(hour)) {
      hours.set(hour, new Map());
    }
    const counts = hours.get(hour);
    counts.set(record.e, (counts.get(record.e) || 0) + 1);
  }

  const entries = [...hours.entries()].sort((first, second) => first[0] - second[0]);
  const maxCount = Math.max(...[...hours.values()].map((counts) =>
    [...counts.values()].reduce((total, count) => total + count, 0)
  ));

  timelineList.innerHTML = entries.map(([hour, counts]) => {
    const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
    const [expression] = [...counts.entries()].sort((first, second) => second[1] - first[1])[0];
    const emotion = EXPRESSIONS[expression];
    const width = Math.max(5, Math.round((total / maxCount) * 100));
    return `
      <div class="timeline-item">
        <span class="timeline-hour">${String(hour).padStart(2, "0")}:00</span>
        <div class="timeline-detail">
          <span class="timeline-emoji" aria-hidden="true">${emotion.emoji}</span>
          <span class="timeline-emotion">${emotion.label} 표정이 가장 많이 관찰됐어요</span>
          <div class="timeline-track" aria-hidden="true">
            <div class="timeline-fill" style="width: ${width}%; --emotion-color: ${emotion.color}"></div>
          </div>
        </div>
        <span class="timeline-count">${total}회</span>
      </div>
    `;
  }).join("");
}

function refreshDateAndRecords() {
  const currentDay = getLocalDayKey();
  todayDate.textContent = new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
  }).format(new Date());

  if (currentDay !== activeDay) {
    activeDay = currentDay;
    try {
      renderDashboard(readRecords());
    } catch (error) {
      setStatus(`오늘의 기록을 읽지 못했어요: ${error.message}`, true);
    }
  }
}

cameraButton.addEventListener("click", () => {
  if (cameraStream) {
    stopCamera();
    setStatus("기록을 멈췄어요. 오늘의 요약은 그대로 남아 있어요.");
  } else {
    startCamera();
  }
});

checkInButton.addEventListener("click", sampleExpression);
retryModelsButton.addEventListener("click", loadModels);

clearButton.addEventListener("click", () => {
  if (!window.confirm("오늘 기록을 모두 지울까요? 이 작업은 되돌릴 수 없어요.")) {
    return;
  }

  try {
    localStorage.removeItem(getStorageKey());
    renderDashboard([]);
    setStatus("오늘의 기록을 모두 지웠어요.");
  } catch (error) {
    setStatus(`기록을 지우지 못했어요: ${error.message}`, true);
  }
});

window.addEventListener("beforeunload", stopCamera);

refreshDateAndRecords();
window.setInterval(refreshDateAndRecords, 60_000);
loadModels();
