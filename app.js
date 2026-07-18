/* ============================================
   🚗 Drowsy Driver Detection - Main Application
   Teachable Machine + TensorFlow.js
   ============================================ */

// ===== โมเดล Teachable Machine =====
const MODEL_URL = "https://teachablemachine.withgoogle.com/models/1bwg8H3sN/";

// ===== ค่า Threshold =====
const DROWSY_THRESHOLD = 0.80;   // 80% ขึ้นไป = หลับใน
const AWAKE_THRESHOLD = 0.80;    // 80% ขึ้นไป = ตื่นปกติ

// ===== ตัวแปรหลัก =====
let model, webcam, maxPredictions;
let isRunning = false;
let alertActive = false;
let startTime = null;
let totalAlerts = 0;
let safeFrames = 0;
let totalFrames = 0;
let lastState = null;       // สถานะที่แสดงผลอยู่ตอนนี้
let lastLoggedState = null; // สถานะที่ log ล่าสุด (ไม่นับ neutral)

// ===== Debounce — ป้องกันสถานะกระพริบ =====
const DEBOUNCE_FRAMES = 15; // ต้องตรวจพบต่อเนื่อง ~15 เฟรม ก่อนเปลี่ยนสถานะ
let pendingState = null;    // สถานะที่รอยืนยัน
let pendingCount = 0;       // นับจำนวนเฟรมที่ตรวจพบต่อเนื่อง
let confirmedState = null;  // สถานะที่ยืนยันแล้ว

// ===== Audio Context สำหรับเสียงเตือน =====
let audioCtx = null;
let alarmOscillator = null;
let alarmGain = null;
let isAlarmPlaying = false;

// ===== DOM Elements =====
const statusCard = document.getElementById("status-card");
const statusRing = document.getElementById("status-ring");
const statusEmoji = document.getElementById("status-emoji");
const statusText = document.getElementById("status-text");
const statusSub = document.getElementById("status-sub");
const progressRing = document.getElementById("progress-ring");
const awakeBar = document.getElementById("awake-bar");
const drowsyBar = document.getElementById("drowsy-bar");
const awakeValue = document.getElementById("awake-value");
const drowsyValue = document.getElementById("drowsy-value");
const alertOverlay = document.getElementById("alert-overlay");
const recIndicator = document.getElementById("rec-indicator");
const historyList = document.getElementById("history-list");
const totalAlertsEl = document.getElementById("total-alerts");
const uptimeEl = document.getElementById("uptime");
const safePercentEl = document.getElementById("safe-percent");
const startBtn = document.getElementById("start-btn");
const clockEl = document.getElementById("clock");
const fpsEl = document.getElementById("fps-counter");

// ===== FPS Counter =====
let frameCount = 0;
let lastFpsTime = performance.now();

// ===== สร้าง Particles พื้นหลัง =====
function createParticles() {
    const container = document.getElementById("particles");
    for (let i = 0; i < 40; i++) {
        const p = document.createElement("div");
        p.className = "particle";
        p.style.left = Math.random() * 100 + "%";
        p.style.animationDelay = Math.random() * 6 + "s";
        p.style.animationDuration = (4 + Math.random() * 4) + "s";
        p.style.width = (1 + Math.random() * 3) + "px";
        p.style.height = p.style.width;
        container.appendChild(p);
    }
}

// ===== นาฬิกา =====
function updateClock() {
    const now = new Date();
    clockEl.textContent = now.toLocaleTimeString("th-TH", { hour12: false });
}

// ===== อัพเดท Uptime =====
function updateUptime() {
    if (!startTime) return;
    const diff = Math.floor((Date.now() - startTime) / 1000);
    const mins = String(Math.floor(diff / 60)).padStart(2, "0");
    const secs = String(diff % 60).padStart(2, "0");
    uptimeEl.textContent = `${mins}:${secs}`;
}

// ===== ระบบเสียงเตือน (Web Audio API - ไม่ต้องใช้ไฟล์) =====
function initAudio() {
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
}

function startAlarm() {
    if (isAlarmPlaying) return;
    initAudio();
    isAlarmPlaying = true;

    // สร้าง Gain node
    alarmGain = audioCtx.createGain();
    alarmGain.gain.setValueAtTime(0.35, audioCtx.currentTime);
    alarmGain.connect(audioCtx.destination);

    // สร้าง Oscillator หลัก (เสียงไซเรน)
    alarmOscillator = audioCtx.createOscillator();
    alarmOscillator.type = "sawtooth";
    alarmOscillator.frequency.setValueAtTime(440, audioCtx.currentTime);
    alarmOscillator.connect(alarmGain);
    alarmOscillator.start();

    // สร้างเอฟเฟกต์ไซเรนวนขึ้นลง
    function sirenLoop() {
        if (!isAlarmPlaying) return;
        const now = audioCtx.currentTime;
        alarmOscillator.frequency.linearRampToValueAtTime(880, now + 0.4);
        alarmOscillator.frequency.linearRampToValueAtTime(440, now + 0.8);
        // วนเสียง
        setTimeout(sirenLoop, 800);
    }
    sirenLoop();

    // Pulse volume เพื่อเพิ่มความด่วน
    function volumePulse() {
        if (!isAlarmPlaying) return;
        const now = audioCtx.currentTime;
        alarmGain.gain.linearRampToValueAtTime(0.45, now + 0.15);
        alarmGain.gain.linearRampToValueAtTime(0.15, now + 0.3);
        setTimeout(volumePulse, 300);
    }
    volumePulse();
}

function stopAlarm() {
    if (!isAlarmPlaying) return;
    isAlarmPlaying = false;
    if (alarmOscillator) {
        try {
            alarmOscillator.stop();
            alarmOscillator.disconnect();
        } catch (e) { /* ignore */ }
        alarmOscillator = null;
    }
    if (alarmGain) {
        try { alarmGain.disconnect(); } catch (e) { /* ignore */ }
        alarmGain = null;
    }
}

// ===== เพิ่ม Log ใน History =====
function addHistoryLog(state, confidence) {
    // log เฉพาะตอนที่สถานะเปลี่ยนจริงๆ (ไม่นับ neutral)
    if (state === lastLoggedState) return;
    lastLoggedState = state;

    // ลบข้อความ empty
    const emptyMsg = historyList.querySelector(".history-empty");
    if (emptyMsg) emptyMsg.remove();

    const time = new Date().toLocaleTimeString("th-TH", { hour12: false });
    const entry = document.createElement("div");
    entry.className = `history-entry ${state === "safe" ? "safe-entry" : "danger-entry"}`;

    const icon = state === "safe" ? "✅" : "🚨";
    const msg = state === "safe"
        ? `ตื่นตัวปกติ (${confidence}%)`
        : `ตรวจพบหลับใน! (${confidence}%)`;

    entry.innerHTML = `
        <span class="history-time">${time}</span>
        <span>${icon}</span>
        <span class="history-msg">${msg}</span>
    `;

    // ใส่บนสุด
    historyList.prepend(entry);

    // จำกัดจำนวน
    while (historyList.children.length > 30) {
        historyList.removeChild(historyList.lastChild);
    }
}

// ===== อัพเดท Progress Ring =====
function updateProgressRing(value) {
    const circumference = 2 * Math.PI * 54; // r=54
    const offset = circumference - (value / 100) * circumference;
    progressRing.style.strokeDashoffset = offset;
}

// ===== ตั้งสถานะ Safe =====
function setSafeState(confidence) {
    document.body.className = "state-safe";
    statusCard.className = "status-card safe";
    statusRing.className = "status-ring safe";
    statusEmoji.textContent = "😊";
    statusText.textContent = "STATUS: SAFE";
    statusText.className = "status-main safe";
    statusSub.textContent = "ขับขี่ปลอดภัย — ผู้ขับตื่นตัวดี";
    alertOverlay.classList.remove("active");

    updateProgressRing(confidence);
    stopAlarm();

    if (lastState !== "safe") {
        addHistoryLog("safe", confidence);
    }
    lastState = "safe";
}

// ===== ตั้งสถานะ Danger =====
function setDangerState(confidence) {
    document.body.className = "state-danger";
    statusCard.className = "status-card danger";
    statusRing.className = "status-ring danger";
    statusEmoji.textContent = "😴";
    statusText.textContent = "⚠️ ตรวจพบหลับใน!";
    statusText.className = "status-main danger";
    statusSub.textContent = "กรุณาจอดรถพัก — อันตราย!";
    alertOverlay.classList.add("active");

    updateProgressRing(confidence);
    startAlarm();

    if (lastState !== "danger") {
        totalAlerts++;
        totalAlertsEl.textContent = totalAlerts;
        addHistoryLog("danger", confidence);
    }
    lastState = "danger";
}

// ===== ตั้งสถานะ Neutral =====
function setNeutralState() {
    document.body.className = "state-idle";
    statusCard.className = "status-card";
    statusRing.className = "status-ring";
    statusEmoji.textContent = "🔍";
    statusText.textContent = "กำลังวิเคราะห์...";
    statusText.className = "status-main";
    statusSub.textContent = "AI กำลังประมวลผลภาพจากกล้อง";
    alertOverlay.classList.remove("active");
    stopAlarm();
    lastState = "neutral";
}

// ===== Initialize — โหลดโมเดลและเปิดกล้อง =====
async function init() {
    startBtn.disabled = true;
    startBtn.querySelector(".btn-text").textContent = "กำลังโหลดโมเดล AI...";

    try {
        const modelURL = MODEL_URL + "model.json";
        const metadataURL = MODEL_URL + "metadata.json";

        // โหลดโมเดล
        model = await tmImage.load(modelURL, metadataURL);
        maxPredictions = model.getTotalClasses();

        // เปิดกล้อง — ปรับขนาดตามหน้าจอ + ใช้กล้องหน้าบนมือถือ
        const isMobile = window.innerWidth <= 600;
        const camWidth = isMobile ? Math.min(window.innerWidth - 32, 320) : 400;
        const camHeight = Math.round(camWidth * 0.75); // อัตราส่วน 4:3
        const flip = true; // กลับซ้าย-ขวา (กระจกเงา)
        webcam = new tmImage.Webcam(camWidth, camHeight, flip);
        await webcam.setup({ facingMode: "user" }); // กล้องหน้าเสมอ
        await webcam.play();

        // แสดงกล้องบนหน้าจอ
        const container = document.getElementById("webcam-container");
        container.innerHTML = "";
        container.appendChild(webcam.canvas);

        // เริ่มการทำงาน
        isRunning = true;
        startTime = Date.now();
        recIndicator.classList.add("active");
        startBtn.querySelector(".btn-text").textContent = "🟢 ระบบทำงานอยู่";

        setNeutralState();
        window.requestAnimationFrame(loop);

    } catch (err) {
        console.error("Error initializing:", err);
        startBtn.disabled = false;
        startBtn.querySelector(".btn-text").textContent = "เกิดข้อผิดพลาด — ลองใหม่";
        statusText.textContent = "❌ โหลดโมเดลไม่สำเร็จ";
        statusSub.textContent = "ตรวจสอบการเชื่อมต่ออินเทอร์เน็ตและลองใหม่";
    }
}

// ===== Main Loop =====
async function loop() {
    if (!isRunning) return;

    webcam.update();
    await predict();

    // FPS counter
    frameCount++;
    const now = performance.now();
    if (now - lastFpsTime >= 1000) {
        fpsEl.textContent = frameCount;
        frameCount = 0;
        lastFpsTime = now;
    }

    // อัพเดท uptime & safe %
    updateUptime();
    totalFrames++;
    if (lastState === "safe") safeFrames++;
    if (totalFrames > 0) {
        safePercentEl.textContent = Math.round((safeFrames / totalFrames) * 100) + "%";
    }

    window.requestAnimationFrame(loop);
}

// ===== Prediction =====
async function predict() {
    const prediction = await model.predict(webcam.canvas);

    let awakeProb = 0;
    let drowsyProb = 0;

    for (let i = 0; i < maxPredictions; i++) {
        const className = prediction[i].className.toLowerCase();
        const prob = prediction[i].probability;

        if (className.includes("awake")) {
            awakeProb = prob;
        } else if (className.includes("sleep") || className.includes("drowsy")) {
            drowsyProb = prob;
        }
    }

    // อัพเดท UI bars
    const awakePercent = Math.round(awakeProb * 100);
    const drowsyPercent = Math.round(drowsyProb * 100);

    awakeBar.style.width = awakePercent + "%";
    drowsyBar.style.width = drowsyPercent + "%";
    awakeValue.textContent = awakePercent + "%";
    drowsyValue.textContent = drowsyPercent + "%";

    // ===== ระบบ Debounce — ป้องกันสถานะกระพริบ =====
    let rawState, rawConfidence;
    if (drowsyProb >= DROWSY_THRESHOLD) {
        rawState = "danger";
        rawConfidence = drowsyPercent;
    } else if (awakeProb >= AWAKE_THRESHOLD) {
        rawState = "safe";
        rawConfidence = awakePercent;
    } else {
        rawState = "neutral";
        rawConfidence = 0;
    }

    // นับเฟรมต่อเนื่องของสถานะเดียวกัน
    if (rawState === pendingState) {
        pendingCount++;
    } else {
        pendingState = rawState;
        pendingCount = 1;
    }

    // เปลี่ยนสถานะจริงเมื่อตรวจพบต่อเนื่องครบ
    if (pendingCount >= DEBOUNCE_FRAMES && rawState !== confirmedState) {
        confirmedState = rawState;
        if (rawState === "danger") {
            setDangerState(rawConfidence);
        } else if (rawState === "safe") {
            setSafeState(rawConfidence);
        } else {
            setNeutralState();
        }
    }
    // ถ้ายังไม่ครบ debounce ให้อัพเดทเฉพาะ confidence ของสถานะปัจจุบัน
    else if (confirmedState === "danger") {
        updateProgressRing(drowsyPercent);
    } else if (confirmedState === "safe") {
        updateProgressRing(awakePercent);
    }
}

// ===== เริ่มต้นเมื่อหน้าเว็บโหลดเสร็จ =====
document.addEventListener("DOMContentLoaded", () => {
    createParticles();
    updateClock();
    setInterval(updateClock, 1000);

    // ตั้งค่าเริ่มต้น
    document.body.className = "state-idle";
});
