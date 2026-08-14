(() => {
  let tritonApiKey = '';

// === CẤU HÌNH TRITON ===
const TRITON_HOST = 'http://triton-api:8003';
const WS_HOST = 'ws://triton-api:8003';
const FIRE_CALL_ENDPOINT = 'https://vovinamctut.id.vn/call12';
const FIRE_CALL_STATUS_ENDPOINT = 'https://vovinamctut.id.vn/call-status';
const FIRE_ALERT_BRIDGE_ORIGIN = window.FIRE_ALERT_BRIDGE_ORIGIN || (
  window.location.protocol.startsWith('http') ? window.location.origin : 'http://127.0.0.1:8765'
);
const FIRE_ALERT_STATE_ENDPOINT = `${FIRE_ALERT_BRIDGE_ORIGIN}/alert-state`;
const FIRE_ALERT_SETTINGS_ENDPOINT = `${FIRE_ALERT_BRIDGE_ORIGIN}/settings`;
const ADMIN_USERS_ENDPOINT = `${FIRE_ALERT_BRIDGE_ORIGIN}/admin/users`;
const LOCAL_MODEL_HEALTH_ENDPOINT = `${FIRE_ALERT_BRIDGE_ORIGIN}/local-model/health`;
const LOCAL_INFER_ENDPOINT = `${FIRE_ALERT_BRIDGE_ORIGIN}/local-infer`;
const LOCAL_RTSP_PREVIEW_ENDPOINT = `${FIRE_ALERT_BRIDGE_ORIGIN}/local-rtsp/preview`;
const FIRE_DEFAULT_SMS_DELAY_SECONDS = 300;
const FIRE_DEFAULT_CALL_INITIAL_DELAY_SECONDS = 0;
const FIRE_DEFAULT_CALL_DELAY_SECONDS = 300;
const FIRE_CALL_RETRY_DELAY_MS = 20000;
const FIRE_CALL_STATUS_POLL_MS = 3000;
const FIRE_CALL_STATUS_POLL_MAX_MS = 45000;

// === TRẠNG THÁI TOÀN CỤC ===
let isHealthy = false;
let modelsList = [];
let inferenceMode = localStorage.getItem('fireAlertInferenceMode') || 'server';
let localModelAvailable = false;
let localModelError = '';
let serverHealthKnown = false;
let authMode = 'login';
let currentUser = null;
let authToken = localStorage.getItem('fireAlertAuthToken') || '';
const streams = new Map();
const eventsLog = [];
let streamIdCounter = 0;
let activeSingleStreamId = null;
let adminUsers = [];

// === NGƯỠNG CẢNH BÁO ===
const FIRE_LABELS = ['fire', 'flame', 'smoke', 'lửa', 'khói'];
const FIRE_CONF_THRESHOLD = 0.60;
const STREAM_FIRE_CONFIRM = 5; // Số khung hình liên tiếp có cháy để xác nhận cảnh báo
const FIRE_LEVEL_THRESHOLDS = { LEVEL3: 0.50, LEVEL2: 0.04 };

// === ÂM THANH CẢNH BÁO ===
let audioCtx = null;
let synthInterval = null;
let isMuted = false;
let dismissedUntil = 0;
let alertCallState = { status: 'idle', text: '', logId: null, callId: null };
let alertSmsState = { status: 'idle', text: '', logId: null, messageId: null };
const alertCallLoops = new Map();
function getStoredDelaySeconds(key, defaultValue, legacyValues = []) {
  const rawValue = localStorage.getItem(key);
  if (rawValue === null || legacyValues.includes(rawValue)) return defaultValue;
  const value = Number(rawValue);
  return Number.isFinite(value) ? value : defaultValue;
}

function getDefaultAlertSettings() {
  return {
    smsEnabled: true,
    callEnabled: true,
    smsDelaySeconds: FIRE_DEFAULT_SMS_DELAY_SECONDS,
    callInitialDelaySeconds: FIRE_DEFAULT_CALL_INITIAL_DELAY_SECONDS,
    callDelaySeconds: FIRE_DEFAULT_CALL_DELAY_SECONDS,
  };
}

function getLegacyAlertSettings() {
  return {
    smsEnabled: localStorage.getItem('fireAlertSmsEnabled') !== 'false',
    callEnabled: localStorage.getItem('fireAlertCallEnabled') !== 'false',
    smsDelaySeconds: getStoredDelaySeconds('fireAlertSmsDelaySeconds', FIRE_DEFAULT_SMS_DELAY_SECONDS, ['0']),
    callInitialDelaySeconds: Number(localStorage.getItem('fireAlertCallInitialDelaySeconds')) || FIRE_DEFAULT_CALL_INITIAL_DELAY_SECONDS,
    callDelaySeconds: getStoredDelaySeconds('fireAlertCallDelaySeconds', FIRE_DEFAULT_CALL_DELAY_SECONDS, ['60']),
  };
}

let fireAlertSettings = getLegacyAlertSettings();
let alertSettingsSaveTimer = null;

function setAuthMessage(text, type = 'error') {
  const msg = document.getElementById('auth-message');
  if (!msg) return;
  msg.classList.remove('hidden', 'bg-green-500/10', 'text-green-600', 'bg-red-500/10', 'text-red-600');
  if (!text) {
    msg.classList.add('hidden');
    return;
  }
  msg.classList.remove('hidden');
  msg.classList.add(type === 'success' ? 'bg-green-500/10' : 'bg-red-500/10');
  msg.classList.add(type === 'success' ? 'text-green-600' : 'text-red-600');
  msg.innerText = text;
}

function toggleAuthScreen(show) {
  const screen = document.getElementById('auth-screen');
  const sidebar = document.getElementById('app-sidebar');
  const logoutBtn = document.getElementById('btn-logout');
  if (!screen) return;
  screen.classList.toggle('hidden', !show);
  if (sidebar) sidebar.classList.toggle('opacity-50', show);
  if (logoutBtn) logoutBtn.classList.toggle('hidden', !currentUser);
}

function updateAuthUI() {
  const title = document.getElementById('auth-title');
  const subtitle = document.getElementById('auth-subtitle');
  const submitBtn = document.getElementById('auth-submit');
  const logoutBtn = document.getElementById('btn-logout');
  const registerFields = document.getElementById('register-fields');
  const modeButtons = document.querySelectorAll('[data-auth-mode]');

  if (authMode === 'register') {
    if (title) title.innerText = 'Đăng ký';
    if (subtitle) subtitle.innerText = 'Tạo tài khoản mới để sử dụng hệ thống';
    if (registerFields) registerFields.classList.remove('hidden');
    if (submitBtn) submitBtn.innerText = 'Đăng ký';
  } else {
    if (title) title.innerText = 'Đăng nhập';
    if (subtitle) subtitle.innerText = 'Truy cập hệ thống giám sát cháy';
    if (registerFields) registerFields.classList.add('hidden');
    if (submitBtn) submitBtn.innerText = 'Đăng nhập';
  }

  modeButtons.forEach(btn => {
    const active = btn.dataset.authMode === authMode;
    btn.classList.toggle('bg-selected', active);
    btn.classList.toggle('text-white', active);
    btn.classList.toggle('text-primary-variant', !active);
  });

  if (logoutBtn) logoutBtn.classList.toggle('hidden', !currentUser);
  syncAdminNavigation();
}

function isAdminUser() {
  return currentUser?.role === 'admin';
}

function syncAdminNavigation() {
  const adminNav = document.getElementById('admin-nav-wrap');
  const adminMode = isAdminUser();
  if (adminNav) adminNav.classList.toggle('hidden', !adminMode);
  [
    document.getElementById('tab-live')?.closest('.w-full'),
    document.querySelector('[onclick="openAddStream()"]')?.closest('.w-full'),
    document.querySelector('[onclick="openWebcam()"]')?.closest('.w-full'),
    document.querySelector('[onclick="openVideoDialog()"]')?.closest('.w-full'),
    document.querySelector('[onclick="openAlertSettings()"]')?.closest('.w-full'),
    document.getElementById('tab-system')?.closest('.w-full'),
  ].filter(Boolean).forEach(element => element.classList.toggle('hidden', adminMode));
  if (adminMode) {
    closeAddStream();
    closeVideoDialog();
    closeAlertSettings();
    // Tai lai ngay khi nhan vai tro admin, ke ca khi giao dien da o tab admin.
    setTimeout(() => loadAdminUsers(), 0);
  }
  if (!isAdminUser() && document.getElementById('view-admin')?.style.display === 'flex') switchTab('live');
}

async function openWorkspaceForCurrentUser() {
  if (isAdminUser()) {
    switchTab('admin');
    return;
  }
  restoreSavedRtspCameras(currentUser);
  await restoreSavedSimulationVideos(currentUser);
}

function setAccountStatus(text, type = 'success') {
  const statusEl = document.getElementById('settings-account-status');
  if (!statusEl) return;
  statusEl.classList.remove('hidden', 'bg-green-500/10', 'text-green-600', 'bg-red-500/10', 'text-red-600');
  if (!text) {
    statusEl.classList.add('hidden');
    return;
  }
  statusEl.innerText = text;
  statusEl.classList.add(type === 'success' ? 'bg-green-500/10' : 'bg-red-500/10');
  statusEl.classList.add(type === 'success' ? 'text-green-600' : 'text-red-600');
}

function populateAccountSettings() {
  const fullNameInput = document.getElementById('settings-account-full-name');
  const emailInput = document.getElementById('settings-account-email');
  const phoneInput = document.getElementById('settings-account-phone');
  if (fullNameInput) fullNameInput.value = currentUser?.full_name || '';
  if (emailInput) emailInput.value = currentUser?.email || '';
  if (phoneInput) phoneInput.value = currentUser?.phone || '';
}

async function submitAccountSettings(event) {
  event.preventDefault();
  const submitBtn = document.getElementById('settings-account-submit');
  const fullName = document.getElementById('settings-account-full-name')?.value.trim() || '';
  const email = document.getElementById('settings-account-email')?.value.trim() || '';
  const phone = document.getElementById('settings-account-phone')?.value.trim() || '';

  if (!fullName || !email || !phone) {
    setAccountStatus('Vui lòng nhập đầy đủ họ tên, Gmail và số điện thoại', 'error');
    return;
  }

  try {
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.innerText = 'Đang lưu...';
    }
    const data = await fetchAuth('/auth/profile', { full_name: fullName, email, phone });
    currentUser = data.user || currentUser;
    populateAccountSettings();
    updateAuthUI();
    setAccountStatus('Đã cập nhật thông tin tài khoản', 'success');
  } catch (err) {
    setAccountStatus(err.message || 'Không thể cập nhật tài khoản', 'error');
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerText = 'Lưu thay đổi';
    }
  }
}

async function fetchAuth(endpoint, payload) {
  const res = await fetch(`${FIRE_ALERT_BRIDGE_ORIGIN}${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
    },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Yêu cầu thất bại');
  return data;
}

function getUserCameraStorageKey(user = currentUser) {
  const email = String(user?.email || '').trim().toLowerCase();
  return email ? `fireAlertRtspCameras:${email}` : '';
}

// Video duoc chon tu may tinh khong the khoi phuc bang blob: URL sau khi dang
// xuat. Luu Blob trong IndexedDB de moi tai khoan co danh sach mo phong rieng.
const SIMULATION_VIDEO_DB = 'fireAlertSimulationVideos';
const SIMULATION_VIDEO_STORE = 'videos';

function getSimulationVideoUserKey(user = currentUser) {
  return String(user?.email || '').trim().toLowerCase();
}

function openSimulationVideoDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(SIMULATION_VIDEO_DB, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(SIMULATION_VIDEO_STORE)) {
        request.result.createObjectStore(SIMULATION_VIDEO_STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Khong the mo kho video mo phong'));
  });
}

function createSimulationVideoId() {
  return typeof window.crypto?.randomUUID === 'function'
    ? window.crypto.randomUUID()
    : `simulation-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function saveSimulationVideo(file, location, user = currentUser) {
  const userKey = getSimulationVideoUserKey(user);
  if (!userKey) throw new Error('Can dang nhap truoc khi luu video mo phong');
  const record = {
    id: `${userKey}:${createSimulationVideoId()}`,
    userKey,
    location,
    fileName: file.name,
    blob: file,
    createdAt: Date.now(),
  };
  const db = await openSimulationVideoDb();
  try {
    await new Promise((resolve, reject) => {
      const request = db.transaction(SIMULATION_VIDEO_STORE, 'readwrite')
        .objectStore(SIMULATION_VIDEO_STORE).put(record);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error || new Error('Khong the luu video mo phong'));
    });
    return record;
  } finally {
    db.close();
  }
}

async function getSavedSimulationVideos(user = currentUser) {
  const userKey = getSimulationVideoUserKey(user);
  if (!userKey) return [];
  const db = await openSimulationVideoDb();
  try {
    const records = await new Promise((resolve, reject) => {
      const request = db.transaction(SIMULATION_VIDEO_STORE, 'readonly')
        .objectStore(SIMULATION_VIDEO_STORE).getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error || new Error('Khong the doc video mo phong'));
    });
    return records.filter(record => record.userKey === userKey).sort((a, b) => a.createdAt - b.createdAt);
  } finally {
    db.close();
  }
}

async function deleteSimulationVideo(id) {
  if (!id) return;
  const db = await openSimulationVideoDb();
  try {
    await new Promise((resolve, reject) => {
      const request = db.transaction(SIMULATION_VIDEO_STORE, 'readwrite')
        .objectStore(SIMULATION_VIDEO_STORE).delete(id);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error || new Error('Khong the xoa video mo phong'));
    });
  } finally {
    db.close();
  }
}

function getUserAlertSettingsStorageKey(user = currentUser) {
  const email = String(user?.email || '').trim().toLowerCase();
  return email ? `fireAlertSettings:${email}` : '';
}

function loadAlertSettingsForUser(user = currentUser) {
  const key = getUserAlertSettingsStorageKey(user);
  if (!key) {
    fireAlertSettings = getLegacyAlertSettings();
    return;
  }

  try {
    const savedSettings = JSON.parse(localStorage.getItem(key) || 'null');
    fireAlertSettings = { ...getDefaultAlertSettings(), ...(savedSettings || {}) };
  } catch (err) {
    console.warn('Khong doc duoc cau hinh canh bao cua tai khoan:', err);
    fireAlertSettings = getDefaultAlertSettings();
  }
}

function saveAlertSettingsForUser(user = currentUser) {
  const key = getUserAlertSettingsStorageKey(user);
  if (!key) return;
  localStorage.setItem(key, JSON.stringify(fireAlertSettings));
}

function applyAlertSettingsInputs() {
  const smsDelayInput = document.getElementById('input-sms-delay');
  const delayInput = document.getElementById('input-call-delay');
  if (smsDelayInput) smsDelayInput.value = String(fireAlertSettings.smsDelaySeconds);
  if (delayInput) delayInput.value = String(fireAlertSettings.callDelaySeconds);
}

function getSavedRtspCameras(user = currentUser) {
  const key = getUserCameraStorageKey(user);
  if (!key) return [];
  try {
    const cameras = JSON.parse(localStorage.getItem(key) || '[]');
    if (!Array.isArray(cameras)) return [];
    return cameras.filter(camera => camera && camera.name && camera.url);
  } catch (err) {
    console.warn('Khong doc duoc danh sach camera da luu:', err);
    return [];
  }
}

function saveRtspCameras(user = currentUser) {
  const key = getUserCameraStorageKey(user);
  if (!key) return;
  const cameras = Array.from(streams.values())
    .filter(stream => stream.type === 'server_rtsp' || stream.type === 'local_rtsp')
    .map(stream => ({ name: stream.name, url: stream.src }));
  localStorage.setItem(key, JSON.stringify(cameras));
}

function restoreSavedRtspCameras(user = currentUser) {
  const savedCameras = getSavedRtspCameras(user);
  savedCameras.forEach(camera => {
    addStreamLogic('server_rtsp', camera.name, camera.url, null, { persist: false });
  });
}

async function restoreSavedSimulationVideos(user = currentUser) {
  try {
    const videos = await getSavedSimulationVideos(user);
    for (const video of videos) {
      const url = URL.createObjectURL(video.blob);
      await addStreamLogic('file', video.location, url, null, {
        persist: false,
        simulationId: video.id,
        simulationFileName: video.fileName,
      });
    }
  } catch (err) {
    console.warn('Khong the khoi phuc video mo phong:', err);
  }
}

function clearAllStreams({ forgetSaved = false } = {}) {
  Array.from(streams.values()).forEach(stream => stream.remove({ forgetSaved }));
  streams.clear();
  updateGridEmptyState();
  alertCallLoops.forEach(loop => {
    loop.stopped = true;
    if (loop.timerId) clearTimeout(loop.timerId);
  });
  alertCallLoops.clear();
  alertCallState = { status: 'idle', text: '', logId: null, callId: null };
  alertSmsState = { status: 'idle', text: '', logId: null, messageId: null };
  updateBannerCallStatus();
}

async function submitAuthForm(event) {
  event.preventDefault();
  const email = document.getElementById('auth-email')?.value || '';
  const password = document.getElementById('auth-password')?.value || '';
  const fullName = document.getElementById('auth-full-name')?.value || '';
  const phone = document.getElementById('auth-phone')?.value || '';

  try {
    const payload = { email, password, ...(authMode === 'register' ? { full_name: fullName, phone } : {}) };
    const data = await fetchAuth(authMode === 'register' ? '/auth/register' : '/auth/login', payload);
    authToken = data.token || '';
    currentUser = data.user || null;
    localStorage.setItem('fireAlertAuthToken', authToken);
    updateAuthUI();
    loadAlertSettingsForUser(currentUser);
    applyAlertSettingsInputs();
    syncAlertSettingControls();
    syncAlertSettings();
    setAuthMessage(authMode === 'register' ? 'Đăng ký thành công' : 'Đăng nhập thành công', 'success');
    toggleAuthScreen(false);
    await openWorkspaceForCurrentUser();
  } catch (err) {
    setAuthMessage(err.message || 'Không thể thực hiện thao tác', 'error');
  }
}

async function restoreAuthSession() {
  if (!authToken) {
    toggleAuthScreen(true);
    return;
  }

  try {
    const res = await fetch(`${FIRE_ALERT_BRIDGE_ORIGIN}/auth/me`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || 'Session invalid');
    currentUser = data.user || null;
    updateAuthUI();
    loadAlertSettingsForUser(currentUser);
    applyAlertSettingsInputs();
    syncAlertSettingControls();
    syncAlertSettings();
    toggleAuthScreen(false);
    await openWorkspaceForCurrentUser();
  } catch (err) {
    authToken = '';
    currentUser = null;
    localStorage.removeItem('fireAlertAuthToken');
    updateAuthUI();
    toggleAuthScreen(true);
  }
}

async function logout() {
  const loggedOutUser = currentUser;
  if (loggedOutUser) saveAlertSettingsForUser(loggedOutUser);
  if (loggedOutUser) saveRtspCameras(loggedOutUser);
  clearAllStreams({ forgetSaved: false });
  try {
    await fetch(`${FIRE_ALERT_BRIDGE_ORIGIN}/auth/logout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${authToken}` },
    });
  } catch (err) {
    console.warn(err);
  }
  authToken = '';
  currentUser = null;
  localStorage.removeItem('fireAlertAuthToken');
  updateAuthUI();
  toggleAuthScreen(true);
}

function openLogoutConfirm() {
  const dialog = document.getElementById('logout-confirm-dialog');
  if (!dialog) return;
  dialog.classList.remove('hidden');
  dialog.classList.add('flex');
}

function closeLogoutConfirm() {
  const dialog = document.getElementById('logout-confirm-dialog');
  if (!dialog) return;
  dialog.classList.add('hidden');
  dialog.classList.remove('flex');
}

async function confirmLogout() {
  closeLogoutConfirm();
  await logout();
}

// === KHỞI TẠO & VÒNG LẶP ===
function setInferenceMode(mode) {
  inferenceMode = mode === 'local' ? 'local' : 'server';
  localStorage.setItem('fireAlertInferenceMode', inferenceMode);
  streams.forEach(stream => {
    if (!stream.active) return;
    if ((stream.type === 'local_rtsp' && inferenceMode === 'server') || (stream.type === 'server_rtsp' && inferenceMode === 'local')) {
      stream.pause();
      stream.type = inferenceMode === 'server' ? 'server_rtsp' : 'local_rtsp';
      stream.resume();
      return;
    }
    stream.inferWsList.forEach(ws => ws.close());
    stream.inferWsList = [];
    stream.localInferAwaiting = false;
    stream.localInferErrorNotified = false;
    if (inferenceMode === 'server') stream._connectInfer();
  });
  updateInferenceStatusText();
}

function updateInferenceStatusText() {
  const serverText = isHealthy ? `${modelsList.length} Server Models` : 'Server Offline';
  const localText = localModelAvailable ? 'Local Model Ready' : (localModelError || 'Local Model');
  const text = inferenceMode === 'local' ? localText : serverText;
  updateTextByIds(['stat-models', 'settings-stat-models'], text);
}

async function checkLocalModelHealth() {
  try {
    const res = await fetch(LOCAL_MODEL_HEALTH_ENDPOINT);
    const data = await res.json();
    localModelAvailable = !!data.model?.available;
    localModelError = data.model?.error || '';
  } catch (e) {
    localModelAvailable = false;
    localModelError = 'Local model offline';
  }
  updateInferenceStatusText();
  return localModelAvailable;
}

async function askUseLocalModel() {
  if (inferenceMode === 'local') return true;
  const available = localModelAvailable || await checkLocalModelHealth();
  if (!available) return false;
  if (confirm('Bạn có muốn chạy model ngay trên máy mình?')) {
    setInferenceMode('local');
    return true;
  }
  return false;
}

function askUseServerModel() {
  if (inferenceMode === 'server') return true;
  if (confirm('Bạn có muốn dùng model server?')) {
    setInferenceMode('server');
    return true;
  }
  return false;
}

async function checkHealth() {
  const wasHealthy = isHealthy;
  try {
    const headers = {};
    if (tritonApiKey) {
      headers['X-API-Key'] = tritonApiKey;
    }
    const res = await fetch(`${TRITON_HOST}/health`, { headers });
    const data = await res.json();
    isHealthy = !!data.triton_ready;
    const mRes = await fetch(`${TRITON_HOST}/models`, { headers });
    const mData = await mRes.json();
    modelsList = mData.models || mData.single_models || [];
    document.getElementById('api-status-dot').className = `w-2 h-2 rounded-full ${isHealthy ? 'bg-green-500' : 'bg-red-500'}`;
    if (serverHealthKnown && !wasHealthy && isHealthy && inferenceMode === 'local') askUseServerModel();
  } catch(e) {
    isHealthy = false;
    document.getElementById('api-status-dot').className = `w-2 h-2 rounded-full bg-red-500`;
    if ((serverHealthKnown && wasHealthy && inferenceMode === 'server') || (!serverHealthKnown && inferenceMode === 'server')) {
      askUseLocalModel();
    }
  }
  serverHealthKnown = true;
  updateInferenceStatusText();
}

setInterval(checkHealth, 10000);
checkLocalModelHealth();
checkHealth();

function updateTextByIds(ids, text) {
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerText = text;
  });
}

function syncThemeControls() {
  const isDark = document.documentElement.classList.contains('dark');
  document.querySelectorAll('[data-theme-icon="moon"]').forEach(icon => icon.classList.toggle('hidden', isDark));
  document.querySelectorAll('[data-theme-icon="sun"]').forEach(icon => icon.classList.toggle('hidden', !isDark));
  updateTextByIds(['theme-toggle-label'], isDark ? 'Chế độ sáng' : 'Chế độ tối');
}

function syncAlertSettingControls() {
  const toggleConfigs = [
    { key: 'callEnabled', enabledLabel: 'Đang bật', disabledLabel: 'Đang tắt' },
    { key: 'smsEnabled', enabledLabel: 'Đang bật', disabledLabel: 'Đang tắt' },
  ];
  toggleConfigs.forEach(({ key, enabledLabel, disabledLabel }) => {
    const enabled = !!fireAlertSettings[key];
    document.querySelectorAll(`[data-alert-toggle="${key}"]`).forEach(btn => {
      btn.setAttribute('aria-pressed', String(enabled));
      btn.classList.toggle('bg-[#0068ff]', enabled);
      btn.classList.toggle('text-white', enabled);
      btn.classList.toggle('bg-[#dce3ef]', !enabled);
      btn.classList.toggle('text-[#24344f]', !enabled);
      btn.classList.toggle('dark:bg-selected/20', !enabled);
      btn.classList.toggle('dark:text-primary', !enabled);
      const knob = btn.querySelector('[data-toggle-knob]');
      if (knob) knob.classList.toggle('translate-x-5', enabled);
      const label = btn.querySelector('[data-toggle-label]');
      if (label) {
        label.classList.add('whitespace-nowrap');
        label.innerText = enabled ? enabledLabel : disabledLabel;
      }
    });
  });
}

function toggleAlertSetting(key) {
  if (!(key in fireAlertSettings)) return;
  fireAlertSettings[key] = !fireAlertSettings[key];
  syncAlertSettingControls();
  scheduleAlertSettingsSave();
}

function getApiKeyInput() {
  return document.getElementById('settings-input-api-key') || document.getElementById('input-api-key');
}

function getApiKeyStatusEl() {
  return document.getElementById('settings-api-key-status') || document.getElementById('api-key-status');
}

function getApiKeyEyeIcon() {
  return document.getElementById('settings-eye-icon') || document.getElementById('eye-icon');
}

// === AUTH EVENT BINDINGS ===
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('auth-form')?.addEventListener('submit', submitAuthForm);
  document.getElementById('settings-account-form')?.addEventListener('submit', submitAccountSettings);
  ['input-call-delay', 'input-sms-delay'].forEach(id => {
    const input = document.getElementById(id);
    input?.addEventListener('input', scheduleAlertSettingsSave);
    input?.addEventListener('change', persistAlertSettings);
  });
  document.querySelectorAll('[data-auth-mode]').forEach(btn => {
    btn.addEventListener('click', () => {
      authMode = btn.dataset.authMode;
      updateAuthUI();
      setAuthMessage('');
    });
  });
  document.getElementById('btn-logout')?.addEventListener('click', openLogoutConfirm);
  document.getElementById('logout-confirm-dialog')?.addEventListener('click', event => {
    if (event.target?.id === 'logout-confirm-dialog') closeLogoutConfirm();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeLogoutConfirm();
  });
  syncThemeControls();
  syncAlertSettingControls();
  updateAuthUI();
  restoreAuthSession();
});

// === GIAO DIỆN SÁNG TỐI (THEME) ===
function toggleTheme() {
  const html = document.documentElement;
  const isDark = html.classList.contains('dark');
  if (isDark) {
    html.classList.remove('dark');
  } else {
    html.classList.add('dark');
  }
  syncThemeControls();
}

// === XỬ LÝ CHUYỂN TAB CƠ BẢN ===
function openAlertSettings(section = 'general') {
  if (isAdminUser()) return;
  const dialog = document.getElementById('alert-settings-dialog');
  const smsDelayInput = document.getElementById('input-sms-delay');
  const delayInput = document.getElementById('input-call-delay');
  if (smsDelayInput) smsDelayInput.value = String(fireAlertSettings.smsDelaySeconds);
  if (delayInput) delayInput.value = String(fireAlertSettings.callDelaySeconds);
  syncAlertSettingControls();
  switchAlertSettingsSection(section);
  if (dialog) dialog.classList.remove('hidden');
}

function closeAlertSettings() {
  persistAlertSettings();
  const dialog = document.getElementById('alert-settings-dialog');
  if (dialog) dialog.classList.add('hidden');
}

function switchAlertSettingsSection(section) {
  persistAlertSettings();
  document.querySelectorAll('[data-settings-section]').forEach(el => {
    el.classList.toggle('hidden', el.dataset.settingsSection !== section);
  });

  document.querySelectorAll('[data-settings-tab]').forEach(tab => {
    const isActive = tab.dataset.settingsTab === section;
    tab.classList.toggle('bg-[#e7f1ff]', isActive);
    tab.classList.toggle('text-[#17345f]', isActive);
    tab.classList.toggle('dark:bg-selected', isActive);
    tab.classList.toggle('dark:text-white', isActive);
    tab.classList.toggle('dark:hover:opacity-90', isActive);
    tab.classList.toggle('text-[#24344f]', !isActive);
    tab.classList.toggle('dark:text-primary-variant', !isActive);
    tab.classList.toggle('dark:hover:bg-secondary', !isActive);
  });

  if (section === 'system') renderEventLogs();
  if (section === 'account') {
    populateAccountSettings();
    setAccountStatus('');
  }
  if (section === 'apikey') {
    const input = getApiKeyInput();
    if (input) input.value = tritonApiKey;
  }
  if (section === 'appearance') syncThemeControls();
}

function isSystemStatusVisible() {
  const oldSystemView = document.getElementById('view-system');
  return oldSystemView && oldSystemView.style.display === 'flex';
}

function readAlertSettingsInputs() {
  const smsDelayInput = document.getElementById('input-sms-delay');
  const delayInput = document.getElementById('input-call-delay');
  const smsDelayValue = smsDelayInput?.value;
  const callDelayValue = delayInput?.value;
  const smsDelay = Math.max(0, Number(smsDelayValue ? smsDelayValue : fireAlertSettings.smsDelaySeconds));
  const callInitialDelay = FIRE_DEFAULT_CALL_INITIAL_DELAY_SECONDS;
  const delay = Math.max(5, Number(callDelayValue ? callDelayValue : fireAlertSettings.callDelaySeconds));
  fireAlertSettings.smsDelaySeconds = smsDelay;
  fireAlertSettings.callInitialDelaySeconds = callInitialDelay;
  fireAlertSettings.callDelaySeconds = delay;
  saveAlertSettingsForUser();
  return { smsDelay, callInitialDelay, delay };
}

async function persistAlertSettings() {
  if (alertSettingsSaveTimer) {
    clearTimeout(alertSettingsSaveTimer);
    alertSettingsSaveTimer = null;
  }
  const { smsDelay, callInitialDelay, delay } = readAlertSettingsInputs();

  try {
    await fetch(FIRE_ALERT_SETTINGS_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      },
      body: JSON.stringify({
        smsEnabled: fireAlertSettings.smsEnabled,
        callEnabled: fireAlertSettings.callEnabled,
        smsDelaySeconds: smsDelay,
        callInitialDelaySeconds: callInitialDelay,
        callDelaySeconds: delay,
      }),
    });
  } catch (err) {
    console.warn('Khong dong bo duoc cau hinh Automate:', err);
  }
}

function scheduleAlertSettingsSave() {
  if (alertSettingsSaveTimer) clearTimeout(alertSettingsSaveTimer);
  alertSettingsSaveTimer = setTimeout(() => {
    persistAlertSettings();
  }, 350);
}

async function saveAlertSettings() {
  await persistAlertSettings();
}

async function syncAlertSettings() {
  try {
    await fetch(FIRE_ALERT_SETTINGS_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      },
      body: JSON.stringify({
        smsEnabled: fireAlertSettings.smsEnabled,
        callEnabled: fireAlertSettings.callEnabled,
        smsDelaySeconds: fireAlertSettings.smsDelaySeconds,
        callInitialDelaySeconds: fireAlertSettings.callInitialDelaySeconds,
        callDelaySeconds: fireAlertSettings.callDelaySeconds,
      }),
    });
  } catch (err) {
    console.warn('Khong dong bo duoc cau hinh Automate:', err);
  }
}

if (authToken) syncAlertSettings();

function switchTab(tab) {
  if (tab === 'admin' && !isAdminUser()) {
    tab = 'live';
  }
  if (isAdminUser() && tab !== 'admin') {
    tab = 'admin';
  }
  persistAlertSettings();
  if(activeSingleStreamId) closeSingleView();
  
  document.getElementById('view-live').style.display = tab === 'live' ? 'flex' : 'none';
  const systemView = document.getElementById('view-system');
  const apiKeyView = document.getElementById('view-apikey');
  const adminView = document.getElementById('view-admin');
  if (systemView) systemView.style.display = tab === 'system' ? 'flex' : 'none';
  if (apiKeyView) apiKeyView.style.display = tab === 'apikey' ? 'flex' : 'none';
  if (adminView) adminView.style.display = tab === 'admin' ? 'flex' : 'none';
  document.getElementById('view-single').style.display = 'none';
  window.location.hash = '';

  const activeCls = 'mx-[10px] mb-4 flex flex-col items-center justify-center rounded-lg bg-selected cursor-pointer p-2 transition text-white';
  const inactiveCls = 'mx-[10px] mb-4 flex flex-col items-center justify-center rounded-lg text-primary-variant hover:bg-secondary cursor-pointer p-2 transition';
  const activeBottomCls = 'mx-[10px] flex flex-col items-center justify-center rounded-lg bg-selected cursor-pointer p-2 transition text-white';
  const inactiveBottomCls = 'mx-[10px] flex flex-col items-center justify-center rounded-lg text-primary-variant hover:bg-secondary cursor-pointer p-2 transition';
  
  document.getElementById('tab-live').className = tab === 'live' ? activeCls : inactiveCls;
  const systemTab = document.getElementById('tab-system');
  const apiKeyTab = document.getElementById('tab-apikey');
  const adminTab = document.getElementById('tab-admin');
  if (systemTab) systemTab.className = tab === 'system' ? activeBottomCls : inactiveBottomCls;
  if (apiKeyTab) apiKeyTab.className = 'hidden';
  if (adminTab) adminTab.className = tab === 'admin' ? activeBottomCls : inactiveBottomCls;
  
  if(tab === 'system') renderEventLogs();
  if(tab === 'apikey') {
    const input = getApiKeyInput();
    if (input) input.value = tritonApiKey;
  }
}

// === XỬ LÝ SINGLE CAMERA VIEW ===
function openSingleView(id) {
  const s = streams.get(id);
  if(!s) return;
  activeSingleStreamId = id;
  
  window.location.hash = `#${s.name.replace(/\s+/g, '_').toLowerCase()}`;
  
  document.getElementById('view-live').style.display = 'none';
  const systemView = document.getElementById('view-system');
  if (systemView) systemView.style.display = 'none';
  document.getElementById('view-single').style.display = 'flex';
  
  const canvas = document.getElementById(`canvas-${id}`);
  const wrapper = document.getElementById('single-video-wrapper');
  
  document.getElementById('single-placeholder').style.display = 'none';
  wrapper.appendChild(canvas);
  
  updateSingleViewControls();
}

function closeSingleView() {
  if(!activeSingleStreamId) return;
  const id = activeSingleStreamId;
  const tile = document.getElementById(`tile-${id}`);
  const canvas = document.getElementById(`canvas-${id}`);
  
  if(tile && canvas) {
    tile.insertBefore(canvas, tile.lastElementChild);
  }
  
  activeSingleStreamId = null;
  window.location.hash = '';
  document.getElementById('view-single').style.display = 'none';
  document.getElementById('view-live').style.display = 'flex';
}

function updateSingleViewControls() {
  const s = streams.get(activeSingleStreamId);
  if(!s) return;
  
  const btnPower = document.getElementById('btn-single-power');
  const btnDetect = document.getElementById('btn-single-detect');
  
  btnPower.className = `flex items-center justify-center p-2 rounded-lg transition ${s.active ? 'bg-selected text-white hover:opacity-90' : 'bg-secondary text-primary-variant hover:bg-secondary-highlight'}`;
  btnDetect.className = `flex items-center justify-center p-2 rounded-lg transition ${s.detectEnabled ? 'bg-selected text-white hover:opacity-90' : 'bg-secondary text-primary-variant hover:bg-secondary-highlight'}`;
}

function toggleSinglePower() {
  const s = streams.get(activeSingleStreamId);
  if(!s) return;
  s.active ? s.pause() : s.resume();
  updateSingleViewControls();
}

function toggleSingleDetection() {
  const s = streams.get(activeSingleStreamId);
  if(!s) return;
  s.detectEnabled = !s.detectEnabled;
  if(!s.detectEnabled) s._clearAlerts();
  updateSingleViewControls();
}

function toggleSingleFullscreen() {
  const wrapper = document.getElementById('single-video-wrapper');
  if(!document.fullscreenElement) {
    wrapper.requestFullscreen().catch(err => alert("Không thể phóng to."));
  } else {
    document.exitFullscreen();
  }
}

window.addEventListener('hashchange', () => {
  if(window.location.hash === '' && activeSingleStreamId) {
    closeSingleView();
  }
});

// === CÁC PHƯƠNG THỨC THÊM CAMERA ===
function openAddStream() { if (!isAdminUser()) document.getElementById('add-dialog').style.display = 'flex'; }
function closeAddStream() { document.getElementById('add-dialog').style.display = 'none'; }

async function submitAddStream() {
  const name = document.getElementById('input-cam-name').value || `Camera ${streams.size + 1}`;
  const url = document.getElementById('input-cam-url').value;
  if (!url) return alert("Vui lòng nhập RTSP URL!");
  if (await addStreamLogic('server_rtsp', name, url)) closeAddStream();
}

async function openWebcam() {
  if (isAdminUser()) return;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const videoDevs = devices.filter(d => d.kind === 'videoinput');
    if (videoDevs.length === 0) return alert("Không tìm thấy Webcam!");
    await addStreamLogic('webcam', `Webcam ${streams.size + 1}`, null, videoDevs[0].deviceId);
  } catch(e) { alert("Lỗi truy cập Webcam: " + e.message); }
}

function openVideoDialog() { if (!isAdminUser()) document.getElementById('video-dialog').style.display = 'flex'; }
function closeVideoDialog() { document.getElementById('video-dialog').style.display = 'none'; }

async function submitVideoFile() {
  const fileInput = document.getElementById('input-video-file');
  const file = fileInput.files[0];
  const location = document.getElementById('input-video-location').value.trim();
  if (!location) return alert('Vui lòng nhập vị trí!');
  if (!file) return alert('Vui lòng chọn video!');
  try {
    const savedVideo = await saveSimulationVideo(file, location);
    const url = URL.createObjectURL(file);
    const added = await addStreamLogic('file', location, url, null, {
      simulationId: savedVideo.id,
      simulationFileName: savedVideo.fileName,
    });
    if (!added) {
      URL.revokeObjectURL(url);
      await deleteSimulationVideo(savedVideo.id);
      return;
    }
    fileInput.value = '';
    document.getElementById('input-video-location').value = '';
    closeVideoDialog();
  } catch (err) {
    alert(`Khong the luu video mo phong: ${err.message || err}`);
  }
  if (tab === 'admin') loadAdminUsers();
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

async function adminRequest(url = ADMIN_USERS_ENDPOINT, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      Authorization: `Bearer ${authToken}`,
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.success) throw new Error(data.error || 'Không thể xử lý yêu cầu quản trị');
  return data;
}

async function loadAdminUsers() {
  if (!isAdminUser()) return;
  const table = document.getElementById('admin-users-table');
  if (table) table.innerHTML = '<tr><td colspan="5" class="px-4 py-8 text-center text-primary-variant">Đang tải danh sách...</td></tr>';
  try {
    const data = await adminRequest();
    adminUsers = data.users || [];
    document.getElementById('admin-stat-total').innerText = data.summary?.total ?? adminUsers.length;
    document.getElementById('admin-stat-active').innerText = data.summary?.active ?? adminUsers.filter(user => user.status === 'active').length;
    document.getElementById('admin-stat-disabled').innerText = data.summary?.disabled ?? adminUsers.filter(user => user.status === 'disabled').length;
    document.getElementById('admin-stat-alerts').innerText = data.summary?.active_alerts ?? 0;
    renderAdminUsers();
  } catch (err) {
    if (table) table.innerHTML = `<tr><td colspan="5" class="px-4 py-8 text-center text-red-500">${escapeHtml(err.message)}</td></tr>`;
  }
}

function renderAdminUsers() {
  const table = document.getElementById('admin-users-table');
  if (!table) return;
  const query = (document.getElementById('admin-user-search')?.value || '').trim().toLowerCase();
  const visibleUsers = adminUsers.filter(user => [user.full_name, user.email, user.phone].some(value => String(value || '').toLowerCase().includes(query)));
  if (!visibleUsers.length) {
    table.innerHTML = '<tr><td colspan="5" class="px-4 py-8 text-center text-primary-variant">Không tìm thấy tài khoản phù hợp.</td></tr>';
    return;
  }
  table.innerHTML = visibleUsers.map(user => {
    const isActive = user.status === 'active';
    const roleText = user.role === 'admin' ? 'Admin' : 'Khách hàng';
    return `<tr class="text-primary"><td class="px-4 py-3"><div class="font-semibold">${escapeHtml(user.full_name)}</div></td><td class="px-4 py-3"><div>${escapeHtml(user.email)}</div><div class="mt-0.5 text-xs text-primary-variant">${escapeHtml(user.phone)}</div></td><td class="px-4 py-3"><span class="rounded-full px-2 py-1 text-xs ${user.role === 'admin' ? 'bg-blue-500/15 text-blue-500' : 'bg-secondary text-primary-variant'}">${roleText}</span></td><td class="px-4 py-3"><span class="rounded-full px-2 py-1 text-xs ${isActive ? 'bg-green-500/15 text-green-500' : 'bg-red-500/15 text-red-500'}">${isActive ? 'Hoạt động' : 'Đã khóa'}</span></td><td class="px-4 py-3 text-right"><button type="button" onclick="openAdminUserForm('${encodeURIComponent(user.email)}')" class="rounded-lg bg-secondary px-3 py-1.5 text-xs font-semibold text-primary hover:bg-secondary-highlight">Xem / sửa</button></td></tr>`;
  }).join('');
}

function openAdminUserForm(encodedEmail = '') {
  const dialog = document.getElementById('admin-user-dialog');
  const originalEmail = decodeURIComponent(encodedEmail || '');
  const user = adminUsers.find(item => item.email === originalEmail);
  document.getElementById('admin-user-form').reset();
  document.getElementById('admin-user-original-email').value = user?.email || '';
  document.getElementById('admin-user-dialog-title').innerText = user ? 'Cập nhật tài khoản' : 'Thêm khách hàng';
  document.getElementById('admin-user-name').value = user?.full_name || '';
  document.getElementById('admin-user-email').value = user?.email || '';
  document.getElementById('admin-user-email').readOnly = !!user;
  document.getElementById('admin-user-phone').value = user?.phone || '';
  document.getElementById('admin-user-role').value = user?.role || 'customer';
  document.getElementById('admin-user-status').value = user?.status || 'active';
  document.getElementById('admin-user-password').required = !user;
  document.getElementById('admin-password-hint').innerText = user ? '(để trống nếu không đổi)' : '(tối thiểu 6 ký tự)';
  document.getElementById('admin-user-error').classList.add('hidden');
  dialog.classList.remove('hidden'); dialog.classList.add('flex');
}

function openCurrentAdminProfile() {
  if (!isAdminUser()) return;
  openAdminUserForm(encodeURIComponent(currentUser.email));
}

function closeAdminUserForm() {
  const dialog = document.getElementById('admin-user-dialog');
  dialog.classList.add('hidden'); dialog.classList.remove('flex');
}

async function submitAdminUser(event) {
  event.preventDefault();
  const originalEmail = document.getElementById('admin-user-original-email').value;
  const payload = {
    full_name: document.getElementById('admin-user-name').value.trim(),
    email: document.getElementById('admin-user-email').value.trim(),
    phone: document.getElementById('admin-user-phone').value.trim(),
    password: document.getElementById('admin-user-password').value,
    role: document.getElementById('admin-user-role').value,
    status: document.getElementById('admin-user-status').value,
  };
  const errorEl = document.getElementById('admin-user-error');
  try {
    if (originalEmail) {
      await adminRequest(`${ADMIN_USERS_ENDPOINT}/${encodeURIComponent(originalEmail)}`, { method: 'POST', body: JSON.stringify(payload) });
    } else {
      await adminRequest(ADMIN_USERS_ENDPOINT, { method: 'POST', body: JSON.stringify(payload) });
    }
    closeAdminUserForm();
    await loadAdminUsers();
  } catch (err) {
    errorEl.innerText = err.message;
    errorEl.classList.remove('hidden');
  }
}

async function addStreamLogic(type, name, url, deviceId = null, options = {}) {
  if (isAdminUser()) return false;
  const shouldPersist = options.persist !== false;
  const fireModel = modelsList.find(m => /fire|flame/i.test(m.name))?.name || (modelsList[0]?.name || '');
  if (type === 'server_rtsp' && (!isHealthy || inferenceMode === 'local')) {
    const useLocal = inferenceMode === 'local' || await askUseLocalModel();
    if (!useLocal) return false;
    type = 'local_rtsp';
  }
  if (type !== 'server_rtsp' && type !== 'local_rtsp' && (!isHealthy || !fireModel) && inferenceMode !== 'local') {
    await askUseLocalModel();
  }
  if ((type !== 'server_rtsp' && inferenceMode === 'local') || type === 'local_rtsp') {
    const available = localModelAvailable || await checkLocalModelHealth();
    if (!available) { alert("Khong the chay model local. Hay kiem tra file y8ndfire.pt va thu vien ultralytics."); return false; }
  }
  if (type === 'server_rtsp' && !isHealthy) { alert("RTSP can server Triton API de xu ly stream."); return false; }
  if(!fireModel && type !== 'server_rtsp' && inferenceMode !== 'local') { alert("Chưa có Model trên Triton API để chạy file/webcam!"); return false; }

  const id = `stream_${++streamIdCounter}`;
  const inst = new StreamInstance({
    id, name, type, src: url, deviceId, 
    models: fireModel ? [fireModel] : [],
    fps: 15, previewFps: 12, conf: 0.5, imgsz: 640,
    simulationId: options.simulationId || null,
    simulationFileName: options.simulationFileName || null,
  });
  
  streams.set(id, inst);
  inst.start();
  if (shouldPersist && (type === 'server_rtsp' || type === 'local_rtsp')) saveRtspCameras();
  updateGridEmptyState();
  switchTab('live');
  return true;
}

function updateGridEmptyState() {
  const noStreams = document.getElementById('no-streams');
  if(streams.size === 0) noStreams.style.display = 'flex';
  else noStreams.style.display = 'none';
  updateTextByIds(['stat-cameras', 'settings-stat-cameras'], streams.size);
}

// ==========================================
// LỚP STREAM INSTANCE
// ==========================================
class StreamInstance {
  constructor(cfg) {
    this.id = cfg.id; this.name = cfg.name; this.type = cfg.type; 
    this.src = cfg.src; this.deviceId = cfg.deviceId;
    this.models = cfg.models; this.fps = cfg.fps; this.previewFps = cfg.previewFps || 12; this.conf = cfg.conf; this.imgsz = cfg.imgsz;
    this.simulationId = cfg.simulationId || null;
    this.simulationFileName = cfg.simulationFileName || null;
    
    this.active = false; this.generation = 0; this.detectEnabled = true;
    this.videoEl = null; this.canvas = null; this.mediaStream = null;
    this.rtspImg = null;
    this.inferWsList = []; this.previewWs = null; this.eventWs = null;
    this.managedStreamId = null; this.loopId = null;
    this.localInferAwaiting = false; this.localInferErrorNotified = false;
    this.localRtspLoopStarted = false;
    
    this.lastAnns = []; this.lastShape = null;
    this.fireFrames = 0; this.fireLastTs = 0;
    this.alertState = null;
  }

  _renderTile() {
    const grid = document.getElementById('streams-grid');
    const col = document.createElement('div');
    col.id = `tile-${this.id}`;
    col.className = 'relative size-full rounded-2xl bg-black aspect-video flex items-center justify-center border border-background group overflow-hidden cursor-pointer';
    
    col.innerHTML = `
      <div id="fire-icon-${this.id}" class="absolute top-2 left-2 z-10 hidden">
        <svg viewBox="0 0 384 512" class="size-8 fill-red-500 animate-pulse drop-shadow-md">
          <path d="M153.6 29.9l16-21.3C173.6 3.2 180 0 186.7 0C198.4 0 208 9.6 208 21.3V43.5c0 13.1 5.4 25.7 14.9 34.7L250.7 106c38.1 35.8 59.8 86.8 58.6 139.6C307 334.8 235.8 406.4 146.4 406.4C55 406.4 -15.8 333.1 -11.9 241.6c1.6-38.1 16.2-73.7 41.2-101.4c6.3-6.9 16.9-8.4 25-3.6c8 4.7 11.5 14.7 8.1 23.3l-11 28.1c-12 30.6-11.3 64.6 2 94.6c13.7 30.8 39.5 54 72 65.2c32.5 11.2 68.3 8.3 98.7-8c30.4-16.3 53.3-43.1 63.8-74.6c1.5-4.5-1.5-9.3-6.2-10.4l-14.7-3.4c-9.5-2.2-17.6-8.5-22.3-17.4l-11.4-21.6c-4.8-9.1-14.3-14.7-24.5-14.7H192c-17.7 0-32-14.3-32-32V115.1c0-14.2-8.7-26.7-21.8-31.1c-13.1-4.4-27.6-1-35.9 8.6L87 108.4c-6.8 7.9-18.8 9.6-27.6 3.8C50.6 106.3 48.9 94 55 86.1l98.6-126.2z"/>
        </svg>
      </div>
      <div id="badge-${this.id}" class="absolute top-2 right-2 z-10 bg-red-600/90 text-white px-2 py-1 rounded text-xs font-bold animate-pulse hidden"></div>
      <canvas id="canvas-${this.id}" class="w-full h-full object-contain pointer-events-none"></canvas>
      <div class="absolute bottom-2 right-2 z-10 flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
        <button onclick="event.stopPropagation(); streams.get('${this.id}').remove()" class="bg-red-600/80 hover:bg-red-700 text-white px-3 py-1 rounded text-xs font-bold pointer-events-auto">✕ Delete</button>
      </div>
    `;
    
    col.onclick = () => openSingleView(this.id);
    
    grid.appendChild(col);
    this.canvas = document.getElementById(`canvas-${this.id}`);
  }

  async start() {
    this._renderTile();
    await this.resume();
  }

  async resume() {
    this.active = true; this.generation++;
    
    if (this.canvas) {
        const ctx = this.canvas.getContext('2d');
        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }

    if (this.type === 'webcam') {
      try {
        const constraint = this.deviceId ? { deviceId: { exact: this.deviceId } } : true;
        this.mediaStream = await navigator.mediaDevices.getUserMedia({ video: constraint, audio: false });
        this.videoEl = document.createElement('video'); this.videoEl.srcObject = this.mediaStream;
        this.videoEl.autoplay = true; this.videoEl.playsInline = true;
        this.videoEl.onloadedmetadata = () => { this._connectInfer(); this._startVideoLoop(); };
      } catch (e) { alert('Webcam Error: ' + e.message); this.remove(); }
    } else if (this.type === 'file') {
      this.videoEl = document.createElement('video'); this.videoEl.src = this.src; this.videoEl.loop = true;
      this.videoEl.muted = true;
      this.videoEl.onloadeddata = () => { this.videoEl.play(); this._connectInfer(); this._startVideoLoop(); };
    } else if (this.type === 'local_rtsp') {
      this.rtspImg = new Image();
      this.rtspImg.crossOrigin = 'anonymous';
      this.rtspImg.onload = () => this._startLocalRtspLoop();
      this.rtspImg.onerror = () => {
        if (this.active) alert("Khong the doc RTSP tren may nay. Hay kiem tra URL camera va OpenCV.");
        this.remove();
      };
      this.rtspImg.src = `${LOCAL_RTSP_PREVIEW_ENDPOINT}?url=${encodeURIComponent(this.src)}&fps=${encodeURIComponent(this.previewFps)}&quality=75&max_height=720`;
    } else if (this.type === 'server_rtsp') {
      try {
        const headers = {'Content-Type':'application/json'};
        if (tritonApiKey) {
          headers['X-API-Key'] = tritonApiKey;
        }
        const resp = await fetch(`${TRITON_HOST}/streams`, {
          method: 'POST', headers,
          body: JSON.stringify({
            name: this.name,
            url: this.src,
            models: this.models,
            imgsz: String(this.imgsz),
            conf: this.conf,
            fps: this.fps,
            preview_fps: 10,
            annotated_preview: false
          })
        });
        if(!resp.ok) throw new Error("API Error");
        const data = await resp.json();
        this.managedStreamId = data.id;
        this._connectManagedPreview(); this._connectManagedEvents();
      } catch(e) { alert("Failed to add RTSP: " + e.message); this.remove(); }
    }
  }

  pause() {
    this.active = false; this.generation++;
    this.localRtspLoopStarted = false;
    if (this.loopId) cancelAnimationFrame(this.loopId);
    if (this.previewWs) this.previewWs.close();
    if (this.eventWs) this.eventWs.close();
    this.inferWsList.forEach(w => w.close());
    
    if (this.managedStreamId) {
        const headers = {};
        if (tritonApiKey) {
          headers['X-API-Key'] = tritonApiKey;
        }
        fetch(`${TRITON_HOST}/streams/${this.managedStreamId}`, {method:'DELETE', headers}).catch(()=>{});
        this.managedStreamId = null;
    }
    
    if (this.mediaStream) this.mediaStream.getTracks().forEach(t => t.stop());
    if (this.videoEl) { this.videoEl.pause(); this.videoEl.removeAttribute('src'); this.videoEl.load(); }
    if (this.rtspImg) { this.rtspImg.onload = null; this.rtspImg.onerror = null; this.rtspImg.src = ''; this.rtspImg = null; }
    
    this._clearAlerts();

    if (this.canvas) {
        const ctx = this.canvas.getContext('2d');
        ctx.fillStyle = 'rgba(0,0,0,0.8)';
        ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        ctx.fillStyle = '#fff';
        ctx.font = '20px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('CAMERA OFF', this.canvas.width/2, this.canvas.height/2);
    }
  }

  _clearAlerts() {
    this.fireFrames = 0; this.fireLastTs = 0;
    if (this.alertState && this.alertState.active) {
       const endingLogId = this.alertState.logId;
       this.alertState.active = false; 
       this.alertState.endTime = Date.now(); 
       
       const logIdx = eventsLog.findIndex(l => l.logId === this.alertState.logId);
       if(logIdx !== -1) eventsLog[logIdx] = { ...this.alertState, streamName: this.name };
       
       syncFireAlertState({ ...this.alertState, streamName: this.name }, 'ended');
       stopFireAlertCallLoop(endingLogId, 'stopped', 'Cảnh báo đã ngừng, dừng gọi cảnh báo.');
       checkGlobalAlerts();
       
       if (isSystemStatusVisible()) renderEventLogs();
    }
    const badge = document.getElementById(`badge-${this.id}`);
    if (badge) badge.style.display = 'none';
    
    const fireIcon = document.getElementById(`fire-icon-${this.id}`);
    if (fireIcon) fireIcon.classList.add('hidden');
    
    const tile = document.getElementById(`tile-${this.id}`);
    if (tile) tile.className = 'relative size-full rounded-2xl bg-black aspect-video flex items-center justify-center border border-background group overflow-hidden cursor-pointer';
  }

  remove(options = {}) {
    const forgetSaved = options.forgetSaved !== false;
    if(activeSingleStreamId === this.id) closeSingleView();
    this.pause();
    document.getElementById(`tile-${this.id}`)?.remove();
    streams.delete(this.id);
    if (forgetSaved && (this.type === 'server_rtsp' || this.type === 'local_rtsp')) saveRtspCameras();
    if (forgetSaved && this.type === 'file' && this.simulationId) {
      deleteSimulationVideo(this.simulationId).catch(err => console.warn('Khong the xoa video mo phong:', err));
    }
    if (this.type === 'file' && typeof this.src === 'string' && this.src.startsWith('blob:')) {
      URL.revokeObjectURL(this.src);
    }
    updateGridEmptyState();
  }

  _connectManagedPreview() {
    let wsUrl = `${WS_HOST}/streams/${this.managedStreamId}/preview`;
    if (tritonApiKey) {
      wsUrl += `?api_key=${encodeURIComponent(tritonApiKey)}`;
    }
    const ws = new WebSocket(wsUrl);
    this.previewWs = ws; ws.binaryType = 'arraybuffer';
    ws.onmessage = async (e) => {
      if (!this.active) return;
      const blob = new Blob([e.data], {type:'image/jpeg'});
      if(typeof createImageBitmap === 'function') {
        try {
          const bmp = await createImageBitmap(blob);
          if(this.canvas.width !== bmp.width) this.canvas.width = bmp.width;
          if(this.canvas.height !== bmp.height) this.canvas.height = bmp.height;
          const ctx = this.canvas.getContext('2d');
          ctx.drawImage(bmp, 0, 0);
          if(this.detectEnabled && this.lastAnns.length && this.lastShape) drawAnnotations(ctx, this.canvas.width, this.canvas.height, this.lastAnns, this.lastShape);
          bmp.close();
        } catch(ex){}
      }
    };
  }

  _connectManagedEvents() {
    let wsUrl = `${WS_HOST}/streams/${this.managedStreamId}/events`;
    if (tritonApiKey) {
      wsUrl += `?api_key=${encodeURIComponent(tritonApiKey)}`;
    }
    const ws = new WebSocket(wsUrl);
    this.eventWs = ws;
    ws.onmessage = (e) => {
      if (!this.active || !this.detectEnabled) return;
      try {
        const data = JSON.parse(e.data);
        if (data.type === 'detections') {
          // Lọc bỏ nhãn 'other' ngay khi nhận dữ liệu
          this.lastAnns = (data.annotations || []).filter(a => !(a.category_name || '').toLowerCase().includes('other'));
          this.lastShape = data.image_shape;
          handleDetections(this.id, this.lastAnns, this.lastShape);
        }
      } catch {}
    };
  }

  _connectInfer() {
    if (inferenceMode === 'local') {
      this.inferWsList = [];
      return;
    }
    this.inferWsList = this.models.map(model => {
      let wsUrl = `${WS_HOST}/ws/stream?model=${encodeURIComponent(model)}&fps=${this.fps}&imgsz=${this.imgsz}&conf=${this.conf}`;
      if (tritonApiKey) {
        wsUrl += `&api_key=${encodeURIComponent(tritonApiKey)}`;
      }
      const ws = new WebSocket(wsUrl);
      ws._awaiting = false; ws.binaryType = 'arraybuffer';
      ws.onmessage = (e) => {
        ws._awaiting = false; if (!this.active || !this.detectEnabled) return;
        try {
          const data = JSON.parse(e.data); if (data.dropped) return;
          // Lọc bỏ nhãn 'other' ngay khi nhận dữ liệu
          this.lastAnns = (data.annotations || []).filter(a => !(a.category_name || '').toLowerCase().includes('other'));
          this.lastShape = data.image_shape;
          handleDetections(this.id, this.lastAnns, this.lastShape);
        } catch {}
      };
      return ws;
    });
  }

  _sendLocalFrame(blob) {
    if (this.localInferAwaiting || !this.active || !this.detectEnabled) return;
    this.localInferAwaiting = true;
    fetch(`${LOCAL_INFER_ENDPOINT}?imgsz=${encodeURIComponent(this.imgsz)}&conf=${encodeURIComponent(this.conf)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/jpeg' },
      body: blob,
    })
      .then(res => res.json().then(data => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        if (!ok || !data.success) throw new Error(data.error || 'Local inference failed');
        if (!this.active || !this.detectEnabled) return;
        this.lastAnns = (data.annotations || []).filter(a => !(a.category_name || '').toLowerCase().includes('other'));
        this.lastShape = data.image_shape;
        handleDetections(this.id, this.lastAnns, this.lastShape);
      })
      .catch(err => {
        if (!this.localInferErrorNotified) {
          this.localInferErrorNotified = true;
          alert("Khong the nhan dien bang model local: " + err.message);
        }
      })
      .finally(() => {
        this.localInferAwaiting = false;
      });
  }

  _startLocalRtspLoop() {
    if (this.localRtspLoopStarted) return;
    this.localRtspLoopStarted = true;
    let lastSend = 0; let lastDraw = 0; const gen = this.generation;
    const loop = ts => {
      if (!this.active || gen !== this.generation) return;
      this.loopId = requestAnimationFrame(loop);
      if (!this.rtspImg || !this.rtspImg.complete || !this.rtspImg.naturalWidth) return;
      const drawInterval = 1000 / Math.max(1, this.previewFps || 12);
      if (ts - lastDraw < drawInterval) return;
      lastDraw = ts;

      const w = this.rtspImg.naturalWidth || 640;
      const h = this.rtspImg.naturalHeight || 480;
      if (this.canvas.width !== w) this.canvas.width = w;
      if (this.canvas.height !== h) this.canvas.height = h;

      const ctx = this.canvas.getContext('2d');
      ctx.drawImage(this.rtspImg, 0, 0, w, h);
      if (this.detectEnabled && this.lastAnns.length && this.lastShape) drawAnnotations(ctx, w, h, this.lastAnns, this.lastShape);

      if (this.detectEnabled && ts - lastSend >= (1000 / this.fps) && !this.localInferAwaiting) {
        lastSend = ts;
        this.canvas.toBlob(blob => {
          if (!blob || !this.active || !this.detectEnabled) return;
          this._sendLocalFrame(blob);
        }, 'image/jpeg', 0.8);
      }
    };
    this.loopId = requestAnimationFrame(loop);
  }

  _startVideoLoop() {
    let lastSend = 0; const gen = this.generation;
    const loop = ts => {
      if (!this.active || gen !== this.generation) return;
      this.loopId = requestAnimationFrame(loop);
      if (!this.videoEl || this.videoEl.readyState < 2) return;
      
      const w = this.videoEl.videoWidth || 640, h = this.videoEl.videoHeight || 480;
      if (this.canvas.width !== w) this.canvas.width = w;
      if (this.canvas.height !== h) this.canvas.height = h;
      
      const ctx = this.canvas.getContext('2d'); ctx.drawImage(this.videoEl, 0, 0, w, h);
      if (this.detectEnabled && this.lastAnns.length && this.lastShape) drawAnnotations(ctx, w, h, this.lastAnns, this.lastShape);

      if (this.detectEnabled && (ts - lastSend >= (1000 / this.fps))) {
        lastSend = ts;
        const useLocalInference = inferenceMode === 'local';
        if (!useLocalInference && !this.inferWsList.some(w => w.readyState === 1 && !w._awaiting)) return;
        if (useLocalInference && this.localInferAwaiting) return;
        const cap = document.createElement('canvas'); cap.width = w; cap.height = h;
        cap.getContext('2d').drawImage(this.videoEl, 0, 0, w, h);
        cap.toBlob(blob => {
          if (!blob || !this.active || !this.detectEnabled) return;
          if (useLocalInference) {
            this._sendLocalFrame(blob);
          } else {
            blob.arrayBuffer().then(ab => { this.inferWsList.forEach(ws => { if (ws.readyState === 1 && !ws._awaiting) { ws._awaiting = true; ws.send(ab); } }); });
          }
        }, 'image/jpeg', 0.8);
      }
    };
    this.loopId = requestAnimationFrame(loop);
  }
}

// === VẼ CẢNH BÁO ===
function drawAnnotations(ctx, w, h, anns, shape) {
  const [imgH, imgW] = shape;
  const sx = w / imgW;
  const sy = h / imgH;

  anns.forEach(a => {
    const name = (a.category_name || '').toLowerCase();
    let color = null;
    if(name.includes('smoke') || name.includes('khói')) color = '#fbbf24'; 
    else if(name.includes('fire') || name.includes('flame') || name.includes('l?a')) color = '#ef4444'; 
    if(!color) return;

    const [x, y, bw, bh] = a.bbox;
    const px = x*sx, py = y*sy, pw = bw*sx, ph = bh*sy;

    ctx.strokeStyle = 'rgba(0,0,0,0.8)'; ctx.lineWidth = 4; ctx.strokeRect(px, py, pw, ph);
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.strokeRect(px, py, pw, ph);
    
    ctx.fillStyle = color;
    const label = `${a.category_name} ${(a.score*100).toFixed(0)}%`;
    const tW = ctx.measureText(label).width;
    ctx.fillRect(px, py - 20, tW + 10, 20);
    ctx.fillStyle = '#fff'; ctx.font = 'bold 12px Arial'; ctx.fillText(label, px + 5, py - 5);
  });
}

// === LOGIC XỬ LÝ BÁO CHÁY ===
function handleDetections(id, anns, shape) {
  const s = streams.get(id);
  if(!s || !s.detectEnabled) return;
  const now = Date.now();
  const fireAnns = anns.filter(a => FIRE_LABELS.some(l => a.category_name?.toLowerCase().includes(l)) && (a.score || 0) >= FIRE_CONF_THRESHOLD);

  const container = document.getElementById(`tile-${id}`);
  const badge = document.getElementById(`badge-${id}`);

  if (fireAnns.length === 0) {
    if (s.fireLastTs && now - s.fireLastTs <= 5000 && s.fireFrames > 0) return; 
    s.fireFrames = 0; s.fireLastTs = 0;
    container.className = 'relative size-full rounded-2xl bg-black aspect-video flex items-center justify-center border border-background group overflow-hidden cursor-pointer';
    badge.style.display = 'none';
    
    if (s.alertState && s.alertState.active) {
      const endingLogId = s.alertState.logId;
      s.alertState.active = false;
      s.alertState.endTime = now;
      
      const logIdx = eventsLog.findIndex(l => l.logId === s.alertState.logId);
      if(logIdx !== -1) eventsLog[logIdx] = { ...s.alertState, streamName: s.name };
      
      syncFireAlertState({ ...s.alertState, streamName: s.name }, 'ended');
      stopFireAlertCallLoop(endingLogId, 'stopped', 'Cảnh báo đã ngừng, dừng gọi cảnh báo.');
      checkGlobalAlerts();
      
      if (isSystemStatusVisible()) renderEventLogs();
    }
    return;
  }

  s.fireFrames++;
  s.fireLastTs = now;

  

  if (s.fireFrames < STREAM_FIRE_CONFIRM) return;

  const frameArea = shape[1] * shape[0];
  const maxRatio = Math.max(...fireAnns.map(a => { const [, , w, h] = a.bbox; return (w * h) / frameArea; }));
  let level = 1;
  if (maxRatio >= FIRE_LEVEL_THRESHOLDS.LEVEL3) level = 3;
  else if (maxRatio >= FIRE_LEVEL_THRESHOLDS.LEVEL2) level = 2;

  badge.innerHTML = `🔥 CẤP ${level}`;
  badge.className = 'absolute top-2 right-2 z-10 bg-red-600/90 text-white px-2 py-1 rounded text-xs font-bold animate-pulse';
  container.className = `relative size-full rounded-2xl bg-black aspect-video flex items-center justify-center border-alert-level-${level} group overflow-hidden cursor-pointer`;

  const topScore = Math.max(...fireAnns.map(a => a.score || 0));
  const topAnn = fireAnns.reduce((p, c) => p.score > c.score ? p : c);
  const typeStr = (topAnn.category_name.toLowerCase().includes('smoke') || topAnn.category_name.toLowerCase().includes('khói')) ? 'Khói' : 'Lửa';

  if (!s.alertState || !s.alertState.active) {
    s.alertState = { active: true, logId: `log-${id}-${now}`, startTime: now, maxLevel: level, maxScore: topScore, type: typeStr };
    const alertInfo = { ...s.alertState, streamName: s.name };
    eventsLog.unshift(alertInfo);
    if(eventsLog.length > 50) eventsLog.pop();
    syncFireAlertState(alertInfo, 'new', buildNewFireSmsMessage(alertInfo));
  } else {
    let st = s.alertState;
    const previousLevel = st.maxLevel;
    if (level > st.maxLevel) st.maxLevel = level;
    if (topScore > st.maxScore) st.maxScore = topScore;
    if (st.type === 'Khói' && typeStr === 'Lửa') st.type = 'Lửa';

    if (level > previousLevel) {
      syncFireAlertState({ ...st, streamName: s.name }, 'level_increase', buildLevelIncreaseSmsMessage({ ...st, streamName: s.name }));
    }
    
    const logIdx = eventsLog.findIndex(l => l.logId === st.logId);
    if(logIdx !== -1) eventsLog[logIdx] = { ...st, streamName: s.name };
  }
  
  checkGlobalAlerts();
}

// === CẢNH BÁO TOÀN CỤC (BANNER + ÂM THANH) ===
document.getElementById('btn-mute').onclick = () => {
  isMuted = !isMuted;
  document.getElementById('btn-mute').innerText = isMuted ? '🔇 BẬT ÂM' : '🔊 TẮT ÂM';
};
document.getElementById('btn-dismiss').onclick = () => {
  dismissedUntil = Date.now() + 60000;
  checkGlobalAlerts();
};

function playSynthSiren() {
  if (isMuted || Date.now() < dismissedUntil) return;
  try {
    if(!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const master = audioCtx.createGain(); 
    master.gain.value = 0.3; 
    master.connect(audioCtx.destination);
    const osc = audioCtx.createOscillator(); 
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(500, audioCtx.currentTime);
    osc.frequency.linearRampToValueAtTime(1200, audioCtx.currentTime + 0.3);
    osc.frequency.linearRampToValueAtTime(500, audioCtx.currentTime + 0.6);
    osc.connect(master); 
    osc.start(); 
    osc.stop(audioCtx.currentTime + 0.6);
  } catch(e) {}
}

function ensureBannerCallStatus() {
  let el = document.getElementById('banner-call-status');
  if (el) return el;

  const camEl = document.getElementById('banner-cam');
  if (!camEl || !camEl.parentElement) return null;

  el = document.createElement('div');
  el.id = 'banner-call-status';
  el.className = 'text-[10px] font-mono text-white/90';
  camEl.insertAdjacentElement('afterend', el);
  return el;
}

function updateBannerCallStatus() {
  const el = ensureBannerCallStatus();
  if (!el) return;

  const textParts = [alertSmsState.text, alertCallState.text].filter(Boolean);
  if (textParts.length === 0) {
    el.style.display = 'none';
    el.innerText = '';
    return;
  }

  el.style.display = 'block';
  el.innerText = textParts.join('\n');
}

function setAlertCallStatus(status, text, extra = {}) {
  alertCallState = {
    status,
    text,
    logId: extra.logId ?? alertCallState.logId,
    callId: extra.callId ?? alertCallState.callId,
  };
  updateBannerCallStatus();
}

function setAlertSmsStatus(status, text, extra = {}) {
  alertSmsState = {
    status,
    text,
    logId: extra.logId ?? alertSmsState.logId,
    messageId: extra.messageId ?? alertSmsState.messageId,
  };
  updateBannerCallStatus();
}

function buildFireCallMessage(alertInfo) {
  return `Cảnh báo cháy mức độ ${alertInfo.maxLevel} tại camera ${alertInfo.streamName}.`;
}

function buildNewFireSmsMessage(alertInfo) {
  return `Cảnh báo cháy cấp độ ${alertInfo.maxLevel} tại camera ${alertInfo.streamName}.`;
}

function buildLevelIncreaseSmsMessage(alertInfo) {
  return `Cảnh báo cháy: Cấp độ cháy tăng lên cấp độ ${alertInfo.maxLevel} tại camera ${alertInfo.streamName}.`;
}

async function syncFireAlertState(alertInfo, eventType, message = '') {
  const isEnded = eventType === 'ended';
  setAlertSmsStatus('sending', isEnded ? 'Dang cap nhat canh bao ket thuc...' : 'Dang cap nhat canh bao realtime...', { logId: alertInfo.logId });
  checkGlobalAlerts();

  try {
    const res = await fetch(FIRE_ALERT_STATE_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      },
      body: JSON.stringify({
        logId: alertInfo.logId,
        accountEmail: currentUser?.email || '',
        streamName: alertInfo.streamName,
        maxLevel: alertInfo.maxLevel,
        maxScore: alertInfo.maxScore,
        type: alertInfo.type,
        startTime: alertInfo.startTime,
        active: !isEnded,
        eventType,
        message,
        smsEnabled: fireAlertSettings.smsEnabled,
        callEnabled: fireAlertSettings.callEnabled,
        smsDelaySeconds: fireAlertSettings.smsDelaySeconds,
        callInitialDelaySeconds: fireAlertSettings.callInitialDelaySeconds,
        callDelaySeconds: fireAlertSettings.callDelaySeconds,
      }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.success === false) {
      throw new Error(data.error || data.message || `HTTP ${res.status}`);
    }

    if (isEnded) {
      setAlertSmsStatus('ended', 'Da cap nhat canh bao ket thuc cho Automate', { logId: alertInfo.logId });
      setAlertCallStatus('stopped', 'Canh bao da ket thuc, Automate se dung goi lap lai', { logId: alertInfo.logId });
    } else {
      setAlertSmsStatus('synced', 'Da cap nhat canh bao realtime cho Automate', { logId: alertInfo.logId });
      setAlertCallStatus('synced', `Automate se goi lai sau ${fireAlertSettings.callDelaySeconds}s neu canh bao con active`, { logId: alertInfo.logId });
    }
  } catch (err) {
    setAlertSmsStatus('error', `Cap nhat canh bao realtime loi: ${err.message}`, { logId: alertInfo.logId });
    console.warn('Khong cap nhat duoc canh bao realtime:', err);
  }
}

function isAlertStillActive(logId) {
  return Array.from(streams.values()).some(s => s.alertState && s.alertState.active && s.alertState.logId === logId);
}

function stopFireAlertCallLoop(logId, status = 'stopped', text = '') {
  const loop = alertCallLoops.get(logId);
  if (!loop) return;

  loop.stopped = true;
  if (loop.timerId) clearTimeout(loop.timerId);
  if (loop.statusTimerId) clearTimeout(loop.statusTimerId);
  alertCallLoops.delete(logId);

  if (text) {
    setAlertCallStatus(status, text, { logId, callId: loop.callId || null });
  }
}

function getCallResultStatus(data) {
  const result = data?.result || data || {};
  const callStatus = String(data?.call_status || result.call_status || '').toLowerCase();
  const endCause = String(data?.endCallCause || result.endCallCause || data?.end_call_cause || result.end_call_cause || '').toLowerCase();
  const answerDuration = Number(data?.answerDuration ?? result.answerDuration ?? data?.answer_duration ?? result.answer_duration ?? 0);
  const message = String(data?.message || result.message || '').toLowerCase();

  if (callStatus === 'answered' || answerDuration > 0) return 'answered';
  if (callStatus === 'agentended') return 'rejected';
  if (callStatus === 'ended') {
    if (answerDuration > 0) return 'answered';
    return 'rejected';
  }
  if (
    endCause.includes('busy') ||
    endCause.includes('decline') ||
    endCause.includes('reject') ||
    endCause.includes('486') ||
    endCause.includes('603') ||
    message.includes('busy') ||
    message.includes('reject') ||
    message.includes('decline')
  ) {
    return 'rejected';
  }

  return 'pending';
}

function scheduleNextFireAlertCall(alertInfo, loop) {
  if (loop.stopped || !isAlertStillActive(alertInfo.logId)) {
    stopFireAlertCallLoop(alertInfo.logId, 'stopped', 'Cảnh báo đã ngừng, dừng gọi cảnh báo.');
    return;
  }

  loop.timerId = setTimeout(() => runFireAlertCallAttempt(alertInfo, loop), FIRE_CALL_RETRY_DELAY_MS);
}

async function pollCallStatusUntilDone(alertInfo, loop, callId) {
  if (!callId) return 'pending';

  const startedAt = Date.now();
  while (!loop.stopped && isAlertStillActive(alertInfo.logId) && Date.now() - startedAt < FIRE_CALL_STATUS_POLL_MAX_MS) {
    await new Promise(resolve => {
      loop.statusTimerId = setTimeout(resolve, FIRE_CALL_STATUS_POLL_MS);
    });
    loop.statusTimerId = null;

    if (loop.stopped || !isAlertStillActive(alertInfo.logId)) {
      return 'stopped';
    }

    try {
      const res = await fetch(`${FIRE_CALL_STATUS_ENDPOINT}?call_id=${encodeURIComponent(callId)}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.success === false) continue;

      const status = getCallResultStatus(data.status || data);
      if (status === 'answered' || status === 'rejected') {
        return status;
      }
    } catch (err) {
      console.warn('Khong doc duoc trang thai cuoc goi:', err);
    }
  }

  return 'pending';
}
async function runFireAlertCallAttempt(alertInfo, loop) {
  if (loop.stopped || !isAlertStillActive(alertInfo.logId)) {
    stopFireAlertCallLoop(alertInfo.logId, 'stopped', 'Cảnh báo đã ngừng, dừng gọi cảnh báo.');
    return;
  }

  loop.attempt += 1;
  setAlertCallStatus('calling', `Đang gọi cảnh báo lần ${loop.attempt}...`, {
    logId: alertInfo.logId,
    callId: loop.callId || null,
  });
  checkGlobalAlerts();

  try {
    const res = await fetch(FIRE_CALL_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        logId: alertInfo.logId,
        streamName: alertInfo.streamName,
        maxLevel: alertInfo.maxLevel,
        maxScore: alertInfo.maxScore,
        type: alertInfo.type,
        startTime: alertInfo.startTime,
        attempt: loop.attempt,
        message: buildFireCallMessage(alertInfo),
      }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.success === false) {
      throw new Error(data.message || data.error || `HTTP ${res.status}`);
    }

    const callId = data.call_id || data.result?.call_id || loop.callId || null;
    loop.callId = callId;

    const callResultStatus = getCallResultStatus(data);
    if (callResultStatus === 'answered') {
      stopFireAlertCallLoop(alertInfo.logId, 'answered', callId ? `Người nhận đã bắt máy (${callId})` : 'Người nhận đã bắt máy');
      return;
    }

    if (callResultStatus === 'rejected') {
      stopFireAlertCallLoop(alertInfo.logId, 'rejected', callId ? `Người nhận đã từ chối/kết thúc (${callId})` : 'Người nhận đã từ chối/kết thúc');
      return;
    }

    setAlertCallStatus(
      'sent',
      callId ? `Đã gửi cuộc gọi lần ${loop.attempt} (${callId}), đang chờ trạng thái` : `Đã gửi cuộc gọi lần ${loop.attempt}, đang chờ trạng thái`,
      { logId: alertInfo.logId, callId }
    );

    const finalStatus = await pollCallStatusUntilDone(alertInfo, loop, callId);
    if (finalStatus === 'answered') {
      stopFireAlertCallLoop(alertInfo.logId, 'answered', callId ? `Người nhận đã bắt máy (${callId})` : 'Người nhận đã bắt máy');
      return;
    }

    if (finalStatus === 'rejected') {
      stopFireAlertCallLoop(alertInfo.logId, 'rejected', callId ? `Người nhận đã từ chối/kết thúc (${callId})` : 'Người nhận đã từ chối/kết thúc');
      return;
    }

    if (finalStatus === 'stopped') {
      stopFireAlertCallLoop(alertInfo.logId, 'stopped', 'Cảnh báo đã ngừng, dừng gọi cảnh báo.');
      return;
    }

    scheduleNextFireAlertCall(alertInfo, loop);
  } catch (err) {
    if (loop.stopped || !isAlertStillActive(alertInfo.logId)) {
      stopFireAlertCallLoop(alertInfo.logId, 'stopped', 'Cảnh báo đã ngừng, dừng gọi cảnh báo.');
      return;
    }

    setAlertCallStatus('error', `Gọi cảnh báo lỗi lần ${loop.attempt}: ${err.message}. Sẽ thử lại.`, {
      logId: alertInfo.logId,
      callId: loop.callId || null,
    });
    scheduleNextFireAlertCall(alertInfo, loop);
  }
}

function triggerFireAlertCall(alertInfo) {
  if (alertCallLoops.has(alertInfo.logId)) return;

  const loop = {
    attempt: 0,
    callId: null,
    timerId: null,
    statusTimerId: null,
    stopped: false,
  };
  alertCallLoops.set(alertInfo.logId, loop);
  runFireAlertCallAttempt(alertInfo, loop);
}

function checkGlobalAlerts() {
  const activeAlerts = Array.from(streams.values())
                            .filter(s => s.alertState && s.alertState.active)
                            .map(s => ({ ...s.alertState, streamName: s.name }));

  const banner = document.getElementById('fire-banner');
  if (activeAlerts.length === 0 || Date.now() < dismissedUntil) {
    banner.style.display = 'none';
    if (synthInterval) { clearInterval(synthInterval); synthInterval = null; }
    return;
  }

  const topAlert = activeAlerts.sort((a,b) => b.maxLevel - a.maxLevel)[0];
  banner.style.display = 'flex';
  document.getElementById('banner-level').innerText = `LVL ${topAlert.maxLevel}`;
  document.getElementById('banner-desc').innerText = `Độ tin cậy: ${(topAlert.maxScore * 100).toFixed(0)}% - Phát hiện: ${topAlert.type}`;
  document.getElementById('banner-cam').innerText = `Nguồn: ${topAlert.streamName}`;
  updateBannerCallStatus();

  if (topAlert.maxLevel === 3) {
    banner.className = 'fixed bottom-4 right-4 w-72 z-50 flex flex-col gap-2 p-3 text-white shadow-2xl backdrop-blur-sm rounded-xl bg-red-600/95';
    document.getElementById('banner-title').innerText = 'LỬA LỚN - KHẨN CẤP!';
  } else if (topAlert.maxLevel === 2) {
    banner.className = 'fixed bottom-4 right-4 w-72 z-50 flex flex-col gap-2 p-3 text-white shadow-2xl backdrop-blur-sm rounded-xl bg-orange-600/95';
    document.getElementById('banner-title').innerText = 'PHÁT HIỆN CHÁY';
  } else {
    banner.className = 'fixed bottom-4 right-4 w-72 z-50 flex flex-col gap-2 p-3 text-white shadow-2xl backdrop-blur-sm rounded-xl bg-amber-600/95';
    document.getElementById('banner-title').innerText = 'CÓ KHÓI / LỬA NHỎ';
  }

  if (!synthInterval) {
    playSynthSiren();
    synthInterval = setInterval(playSynthSiren, 1200);
  }
}

function renderEventLogs() {
  const containers = ['event-logs', 'settings-event-logs']
    .map(id => document.getElementById(id))
    .filter(Boolean);
  containers.forEach(container => {
    renderEventLogContainer(container);
  });
}

function renderEventLogContainer(container) {
  if(eventsLog.length === 0) {
    container.innerHTML = '<div class="text-primary-variant text-center py-8">System secure. No events.</div>';
    return;
  }
  container.innerHTML = '';
  eventsLog.forEach(log => {
    const el = document.createElement('div');
    const color = log.type === 'Khói' ? 'border-yellow-500' : 'border-red-500';
    const textColor = log.type === 'Khói' ? 'text-yellow-500' : 'text-red-500';
    el.className = `p-3 border-l-4 rounded bg-background shadow-sm ${color}`;
    
    let timeStr = `<b>Start:</b> ${new Date(log.startTime).toLocaleTimeString('vi-VN')}`;
    let statusStr = log.active 
        ? `<div class="text-orange-500 font-bold animate-pulse mt-1">Cảnh báo...</div>`
        : `<div class="text-green-500 font-bold mt-1"><b>End:</b> ${new Date(log.endTime).toLocaleTimeString('vi-VN')}</div>`;

    el.innerHTML = `
      <div class="font-bold ${textColor}">Detection: ${log.type}</div>
      <div class="text-sm mt-2 text-primary-variant">
        <div><b>CAM:</b> ${log.streamName}</div>
        <div>${timeStr}</div>
        <div><b>Level:</b> ${log.maxLevel} (Conf: ${(log.maxScore*100).toFixed(0)}%)</div>
        ${statusStr}
      </div>
    `;
    container.appendChild(el);
  });
}

// === CÀI ĐẶT API KEY (UI LOGIC) ===
function toggleApiKeyVisibility() {
  const input = getApiKeyInput();
  const eyeIcon = getApiKeyEyeIcon();
  if (!input || !eyeIcon) return;
  if (input.type === 'password') {
    input.type = 'text';
    eyeIcon.innerHTML = `
      <path stroke-linecap="round" stroke-linejoin="round" d="M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.242 4.242L9.88 9.88" />
    `;
  } else {
    input.type = 'password';
    eyeIcon.innerHTML = `
      <path stroke-linecap="round" stroke-linejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" />
      <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    `;
  }
}

async function saveApiKey() {
  const input = getApiKeyInput();
  if (!input) return;
  const key = input.value.trim();
  const statusEl = getApiKeyStatusEl();
  if (!statusEl) return;
  
  try {
    const res = await fetch(`${FIRE_ALERT_BRIDGE_ORIGIN}/api/key`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: key }),
    });
    const data = await res.json();
    if (data.success) {
      tritonApiKey = key;
      statusEl.innerText = "✓ API Key đã được lưu thành công trên máy chủ!";
      statusEl.className = "text-xs px-3 py-2 rounded-lg bg-green-500/10 text-green-500 font-medium mt-2";
      statusEl.classList.remove('hidden');
      
      checkHealth();
      setTimeout(() => statusEl.classList.add('hidden'), 3000);
    } else {
      throw new Error(data.message || "Failed to save key");
    }
  } catch (err) {
    statusEl.innerText = "✗ Không thể lưu API Key: " + err.message;
    statusEl.className = "text-xs px-3 py-2 rounded-lg bg-red-500/10 text-red-500 font-medium mt-2";
    statusEl.classList.remove('hidden');
  }
}

// Tự động tải API Key khi load trang
async function initApiKey() {
  try {
    const res = await fetch(`${FIRE_ALERT_BRIDGE_ORIGIN}/api/key`);
    const data = await res.json();
    if (data.success && data.api_key) {
      tritonApiKey = data.api_key;
      const input = getApiKeyInput();
      if (input) input.value = tritonApiKey;
      checkHealth();
    }
  } catch (e) {
    console.warn("Lỗi tải API Key từ server:", e);
  }
}
initApiKey();

// Expose variables & methods to window for inline HTML events
window.streams = streams;
window.eventsLog = eventsLog;
window.switchTab = switchTab;
window.openAddStream = openAddStream;
window.closeAddStream = closeAddStream;
window.submitAddStream = submitAddStream;
window.openWebcam = openWebcam;
window.openVideoDialog = openVideoDialog;
window.closeVideoDialog = closeVideoDialog;
window.submitVideoFile = submitVideoFile;
window.openAdminUserForm = openAdminUserForm;
window.openCurrentAdminProfile = openCurrentAdminProfile;
window.closeAdminUserForm = closeAdminUserForm;
window.submitAdminUser = submitAdminUser;
window.renderAdminUsers = renderAdminUsers;
window.toggleTheme = toggleTheme;
window.toggleAlertSetting = toggleAlertSetting;
window.closeLogoutConfirm = closeLogoutConfirm;
window.confirmLogout = confirmLogout;
window.openAlertSettings = openAlertSettings;
window.closeAlertSettings = closeAlertSettings;
window.switchAlertSettingsSection = switchAlertSettingsSection;
window.saveAlertSettings = saveAlertSettings;
window.closeSingleView = closeSingleView;
window.toggleSingleFullscreen = toggleSingleFullscreen;
window.toggleSinglePower = toggleSinglePower;
window.toggleSingleDetection = toggleSingleDetection;
window.toggleApiKeyVisibility = toggleApiKeyVisibility;
window.saveApiKey = saveApiKey;
window.dismissedUntil = dismissedUntil;

})();

