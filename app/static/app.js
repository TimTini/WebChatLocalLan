const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const E2EE_STORAGE_KEY = "webchat_e2ee_identity_v1";
const DEVICE_PROFILE_KEY = "webchat_device_profile_v1";

const state = {
  socket: null,
  myClientId: "",
  myNetworkIp: "",
  users: [],
  messages: [],
  knownMessageIds: new Set(),
  activeRecipient: null,
  reconnectTimer: null,
  typingTimer: null,
  typingSent: false,
  typingPeer: null,
  identity: null,
  e2eeReady: false,
  peerPublicKeyCache: new Map(),
  sharedKeyCache: new Map(),
  textDecryptCache: new Map(),
  fileDecryptCache: new Map(),
  deviceProfile: null,
  sidebarOpen: false,
};

const elements = {
  myIp: document.getElementById("my-ip"),
  myFingerprint: document.getElementById("my-fingerprint"),
  wsStatus: document.getElementById("ws-status"),
  onlineCount: document.getElementById("online-count"),
  users: document.getElementById("users"),
  roomTitle: document.getElementById("room-title"),
  roomSubtitle: document.getElementById("room-subtitle"),
  roomSecurity: document.getElementById("room-security"),
  typingHint: document.getElementById("typing-hint"),
  messages: document.getElementById("messages"),
  messageInput: document.getElementById("message-input"),
  composerForm: document.getElementById("composer-form"),
  fileInput: document.getElementById("file-input"),
  filePreview: document.getElementById("file-preview"),
  filePreviewName: document.getElementById("file-preview-name"),
  attachBtn: document.getElementById("attach-btn"),
  removeFileBtn: document.getElementById("remove-file-btn"),
  sendBtn: document.getElementById("send-btn"),
  openSidebarBtn: document.getElementById("open-sidebar"),
  closeSidebarBtn: document.getElementById("close-sidebar"),
  sidebarBackdrop: document.getElementById("sidebar-backdrop"),
  publicBtn: document.querySelector('[data-room="public"]'),
};

const MOBILE_LAYOUT_QUERY = "(max-width: 900px)";

function socketUrl() {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const url = new URL(`${protocol}://${window.location.host}/ws`);
  if (state.deviceProfile?.deviceId) {
    url.searchParams.set("device_id", state.deviceProfile.deviceId);
  }
  if (state.deviceProfile?.deviceName) {
    url.searchParams.set("device_name", state.deviceProfile.deviceName);
  }
  return url.toString();
}

function setStatus(text) {
  elements.wsStatus.textContent = text;
  const normalized = String(text || "").toLowerCase();
  if (normalized.includes("da ket noi")) {
    elements.wsStatus.dataset.state = "online";
  } else if (normalized.includes("loi")) {
    elements.wsStatus.dataset.state = "error";
  } else {
    elements.wsStatus.dataset.state = "connecting";
  }
}

function isMobileLayout() {
  return window.matchMedia(MOBILE_LAYOUT_QUERY).matches;
}

function setSidebarOpen(isOpen) {
  state.sidebarOpen = Boolean(isOpen);
  document.body.classList.toggle("sidebar-open", state.sidebarOpen);
}

function closeSidebarIfNeeded() {
  if (isMobileLayout()) {
    setSidebarOpen(false);
  }
}

function toSlug(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
}

function randomHex(bytes = 6) {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return Array.from(buffer, (value) => value.toString(16).padStart(2, "0")).join("");
}

function defaultDeviceName() {
  const ua = navigator.userAgent || "browser";
  if (/iphone/i.test(ua)) {
    return "iPhone";
  }
  if (/ipad/i.test(ua)) {
    return "iPad";
  }
  if (/android/i.test(ua)) {
    return "Android";
  }
  if (/windows/i.test(ua)) {
    return "Windows";
  }
  if (/macintosh|mac os x/i.test(ua)) {
    return "Mac";
  }
  if (/linux/i.test(ua)) {
    return "Linux";
  }
  return "Browser";
}

function loadOrCreateDeviceProfile() {
  const raw = localStorage.getItem(DEVICE_PROFILE_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (
        parsed &&
        typeof parsed.deviceId === "string" &&
        /^[a-z0-9:._-]{3,80}$/.test(parsed.deviceId) &&
        typeof parsed.deviceName === "string" &&
        parsed.deviceName.trim()
      ) {
        return {
          deviceId: parsed.deviceId,
          deviceName: parsed.deviceName.trim().slice(0, 64),
        };
      }
    } catch (_) {
      // Ignore invalid profile and regenerate.
    }
  }

  const baseName = defaultDeviceName();
  const shortName = toSlug(baseName) || "device";
  const deviceId = `dev:${shortName}-${randomHex(5)}`;
  const profile = {
    deviceId,
    deviceName: baseName,
  };
  localStorage.setItem(DEVICE_PROFILE_KEY, JSON.stringify(profile));
  return profile;
}

function shortClientId(clientId) {
  if (!clientId) {
    return "unknown";
  }
  if (clientId.length <= 18) {
    return clientId;
  }
  return `${clientId.slice(0, 12)}...${clientId.slice(-4)}`;
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  const parts = keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
  return `{${parts.join(",")}}`;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64Value) {
  const binary = atob(base64Value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function utf8ToBase64(text) {
  return arrayBufferToBase64(textEncoder.encode(text).buffer);
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(text));
  const bytes = Array.from(new Uint8Array(digest));
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
}

function shortFingerprint(fullHex) {
  const prefix = fullHex.slice(0, 32);
  const groups = prefix.match(/.{1,4}/g) || [prefix];
  return groups.join(":");
}

function isValidPublicJwk(value) {
  return (
    value &&
    typeof value === "object" &&
    value.kty === "EC" &&
    value.crv === "P-256" &&
    typeof value.x === "string" &&
    typeof value.y === "string"
  );
}

async function createIdentity() {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveKey"]
  );

  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const fingerprintHex = await sha256Hex(stableStringify(publicJwk));
  const fingerprint = shortFingerprint(fingerprintHex);

  localStorage.setItem(
    E2EE_STORAGE_KEY,
    JSON.stringify({
      version: 1,
      createdAt: new Date().toISOString(),
      fingerprint,
      publicJwk,
      privateJwk,
    })
  );

  return {
    fingerprint,
    publicJwk,
    privateJwk,
    publicKey: pair.publicKey,
    privateKey: pair.privateKey,
  };
}

async function loadIdentityFromStorage() {
  const raw = localStorage.getItem(E2EE_STORAGE_KEY);
  if (!raw) {
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    return null;
  }

  if (
    !parsed ||
    parsed.version !== 1 ||
    typeof parsed.fingerprint !== "string" ||
    !isValidPublicJwk(parsed.publicJwk) ||
    !isValidPublicJwk(parsed.privateJwk)
  ) {
    return null;
  }

  const publicKey = await crypto.subtle.importKey(
    "jwk",
    parsed.publicJwk,
    { name: "ECDH", namedCurve: "P-256" },
    true,
    []
  );
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    parsed.privateJwk,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveKey"]
  );

  return {
    fingerprint: parsed.fingerprint,
    publicJwk: parsed.publicJwk,
    privateJwk: parsed.privateJwk,
    publicKey,
    privateKey,
  };
}

async function initializeE2EEIdentity() {
  if (!window.crypto || !window.crypto.subtle) {
    state.e2eeReady = false;
    elements.myFingerprint.textContent = "khong ho tro";
    return;
  }

  let identity = null;
  try {
    identity = await loadIdentityFromStorage();
  } catch (_) {
    identity = null;
  }
  if (!identity) {
    identity = await createIdentity();
  }

  state.identity = identity;
  state.e2eeReady = true;
  elements.myFingerprint.textContent = identity.fingerprint;
}

function addMessage(message) {
  if (!message || !message.message_id) {
    return;
  }
  if (state.knownMessageIds.has(message.message_id)) {
    return;
  }
  state.knownMessageIds.add(message.message_id);
  state.messages.push(message);
}

function getUserById(clientId) {
  return state.users.find((user) => user.ip === clientId) || null;
}

function getRecipientIdentity(clientId) {
  const user = getUserById(clientId);
  if (!user || !isValidPublicJwk(user.public_key) || typeof user.key_fingerprint !== "string") {
    return null;
  }
  return { publicJwk: user.public_key, fingerprint: user.key_fingerprint };
}

function formatUserLabel(clientId) {
  if (!clientId) {
    return "unknown";
  }
  if (clientId === state.myClientId) {
    return "Ban";
  }
  const user = getUserById(clientId);
  if (!user) {
    return shortClientId(clientId);
  }
  const name = (user.device_name || "").trim() || shortClientId(clientId);
  const ipSuffix = user.network_ip ? ` @${user.network_ip}` : "";
  return `${name}${ipSuffix}`;
}

function updateRoomButtons() {
  elements.publicBtn.classList.toggle("active", state.activeRecipient === null);
  const roomButtons = elements.users.querySelectorAll(".room-btn");
  roomButtons.forEach((button) => {
    const isCurrent = button.dataset.id === state.activeRecipient;
    button.classList.toggle("active", isCurrent);
  });
}

function updateTypingHint(text) {
  elements.typingHint.textContent = text || "";
}

function roomModeForRecipient(recipientId) {
  if (recipientId === null) {
    return {
      title: "Phong cong khai",
      subtitle: "Tin nhan cho toan bo thiet bi trong LAN",
      security: "Public",
      mode: "public",
      inputPlaceholder: "Nhap tin nhan cong khai hoac them ghi chu file...",
    };
  }

  const peerLabel = formatUserLabel(recipientId);
  const peerIdentity = getRecipientIdentity(recipientId);
  if (peerIdentity && state.e2eeReady && state.identity) {
    return {
      title: `Chat rieng voi ${peerLabel}`,
      subtitle: "Che do rieng tu E2EE dang bat",
      security: "Private E2EE",
      mode: "secure",
      inputPlaceholder: "Nhap tin nhan rieng da ma hoa hoac ghi chu file...",
    };
  }
  if (peerIdentity) {
    return {
      title: `Chat rieng voi ${peerLabel}`,
      subtitle: "Peer co key, thiet bi nay se gui private thuong",
      security: "Private",
      mode: "private",
      inputPlaceholder: "Nhap tin nhan rieng hoac ghi chu file...",
    };
  }
  return {
    title: `Chat rieng voi ${peerLabel}`,
    subtitle: "Peer chua co key, se gui private thuong",
    security: "Private",
    mode: "private",
    inputPlaceholder: "Nhap tin nhan rieng hoac ghi chu file...",
  };
}

function canSendEncryptedTo(recipientId) {
  return Boolean(recipientId && state.e2eeReady && state.identity && getRecipientIdentity(recipientId));
}

function updateRoomUi() {
  const mode = roomModeForRecipient(state.activeRecipient);
  elements.roomTitle.textContent = mode.title;
  if (elements.roomSubtitle) {
    elements.roomSubtitle.textContent = mode.subtitle;
  }
  if (elements.roomSecurity) {
    elements.roomSecurity.textContent = mode.security;
    elements.roomSecurity.dataset.mode = mode.mode;
  }
  elements.messageInput.placeholder = mode.inputPlaceholder;
  updateRoomButtons();
  updateTypingHint("");
}

function renderUsers() {
  const previousRecipient = state.activeRecipient;
  elements.users.innerHTML = "";
  if (elements.onlineCount) {
    elements.onlineCount.textContent = `${state.users.length} online`;
  }

  const visibleUsers = state.users
    .filter((user) => user.ip !== state.myClientId)
    .sort((a, b) => {
      const an = (a.device_name || a.ip || "").toLowerCase();
      const bn = (b.device_name || b.ip || "").toLowerCase();
      if (an < bn) return -1;
      if (an > bn) return 1;
      return String(a.ip || "").localeCompare(String(b.ip || ""));
    });

  if (state.activeRecipient && !visibleUsers.some((user) => user.ip === state.activeRecipient)) {
    state.activeRecipient = null;
  }

  if (visibleUsers.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-users";
    empty.textContent = "Hien chua co nguoi khac online";
    elements.users.appendChild(empty);
  }

  visibleUsers.forEach((user) => {
    const button = document.createElement("button");
    button.className = "room-btn";
    button.type = "button";
    button.dataset.id = user.ip;
    const e2eeReady = Boolean(user.key_fingerprint);
    const shortId = shortClientId(user.ip);
    const networkIp = user.network_ip || "unknown";
    const deviceName = user.device_name || "Device";
    const connectionsLabel = user.connections > 1 ? `${user.connections} ket noi` : "online";

    const title = document.createElement("span");
    title.className = "room-title";
    title.textContent = `${deviceName} @${networkIp}`;
    button.appendChild(title);

    const detail = document.createElement("span");
    detail.className = "room-detail";
    detail.classList.add(e2eeReady ? "e2ee-ready" : "e2ee-missing");
    detail.textContent = `${shortId} | ${connectionsLabel} | ${e2eeReady ? "E2EE san sang" : "Private thuong"}`;
    button.appendChild(detail);

    if (state.activeRecipient === user.ip) {
      button.classList.add("active");
    }
    button.addEventListener("click", () => {
      state.activeRecipient = user.ip;
      updateRoomUi();
      renderMessages();
      closeSidebarIfNeeded();
    });
    elements.users.appendChild(button);
  });

  if (previousRecipient !== state.activeRecipient) {
    updateRoomUi();
  } else {
    updateRoomButtons();
  }
}

function formatTime(isoString) {
  try {
    return new Date(isoString).toLocaleTimeString();
  } catch (_) {
    return "";
  }
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

function pendingFile() {
  return elements.fileInput?.files?.[0] || null;
}

function autoResizeComposer() {
  if (!elements.messageInput) {
    return;
  }
  elements.messageInput.style.height = "auto";
  const maxHeight = 150;
  const nextHeight = Math.min(elements.messageInput.scrollHeight, maxHeight);
  elements.messageInput.style.height = `${nextHeight}px`;
  elements.messageInput.style.overflowY = elements.messageInput.scrollHeight > maxHeight ? "auto" : "hidden";
}

function updateComposerState() {
  if (!elements.sendBtn) {
    return;
  }
  const hasText = elements.messageInput.value.trim().length > 0;
  const hasFile = Boolean(pendingFile());
  elements.sendBtn.disabled = !hasText && !hasFile;
}

function updateFilePreview() {
  if (!elements.filePreview || !elements.filePreviewName) {
    return;
  }
  const file = pendingFile();
  if (!file) {
    elements.filePreview.hidden = true;
    elements.filePreviewName.textContent = "";
    updateComposerState();
    return;
  }
  elements.filePreview.hidden = false;
  elements.filePreviewName.textContent = `${file.name} (${formatBytes(file.size)})`;
  updateComposerState();
}

function clearComposerFile() {
  if (!elements.fileInput) {
    return;
  }
  elements.fileInput.value = "";
  updateFilePreview();
}

function isVisibleInCurrentRoom(message) {
  if (!state.myClientId) {
    return false;
  }
  if (state.activeRecipient === null) {
    return message.recipient_ip === null;
  }
  if (!message.recipient_ip) {
    return false;
  }
  return (
    (message.sender_ip === state.myClientId && message.recipient_ip === state.activeRecipient) ||
    (message.sender_ip === state.activeRecipient && message.recipient_ip === state.myClientId)
  );
}

function makeMetaLine(message) {
  const sender = formatUserLabel(message.sender_ip);
  const target = message.recipient_ip ? ` -> ${formatUserLabel(message.recipient_ip)}` : " -> public";
  const e2eeTag = message.message_type.startsWith("e2ee_") ? " | E2EE" : "";
  return `${sender}${target} | ${formatTime(message.timestamp)}${e2eeTag}`;
}

function mediaKindFromMime(mimeType) {
  if (mimeType.startsWith("image/")) {
    return "image";
  }
  if (mimeType.startsWith("video/")) {
    return "video";
  }
  if (mimeType.startsWith("audio/")) {
    return "audio";
  }
  return "file";
}

async function importPeerPublicKey(peerJwk, peerFingerprint) {
  const cacheKey = `pub:${peerFingerprint}`;
  if (state.peerPublicKeyCache.has(cacheKey)) {
    return state.peerPublicKeyCache.get(cacheKey);
  }
  const imported = await crypto.subtle.importKey(
    "jwk",
    peerJwk,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );
  state.peerPublicKeyCache.set(cacheKey, imported);
  return imported;
}

async function deriveSharedKey(peerJwk, peerFingerprint) {
  if (!state.e2eeReady || !state.identity) {
    throw new Error("E2EE is not ready");
  }
  const cacheKey = `shared:${state.identity.fingerprint}:${peerFingerprint}`;
  if (state.sharedKeyCache.has(cacheKey)) {
    return state.sharedKeyCache.get(cacheKey);
  }
  const peerPublic = await importPeerPublicKey(peerJwk, peerFingerprint);
  const sharedKey = await crypto.subtle.deriveKey(
    { name: "ECDH", public: peerPublic },
    state.identity.privateKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
  state.sharedKeyCache.set(cacheKey, sharedKey);
  return sharedKey;
}

function buildEnvelopeBase(peer) {
  return {
    version: 1,
    alg: "AES-GCM",
    curve: "P-256",
    sender_fingerprint: state.identity.fingerprint,
    recipient_fingerprint: peer.fingerprint,
    sender_public_jwk: state.identity.publicJwk,
    recipient_public_jwk: peer.publicJwk,
  };
}

function randomIv() {
  return crypto.getRandomValues(new Uint8Array(12));
}

async function encryptPrivateText(text, recipientId) {
  const peer = getRecipientIdentity(recipientId);
  if (!peer) {
    throw new Error("Nguoi nhan chua cong bo key E2EE.");
  }

  const sharedKey = await deriveSharedKey(peer.publicJwk, peer.fingerprint);
  const iv = randomIv();
  const aad = textEncoder.encode(`webchat:e2ee:text:v1:${state.myClientId}->${recipientId}`);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad },
    sharedKey,
    textEncoder.encode(text)
  );

  return {
    ...buildEnvelopeBase(peer),
    iv: arrayBufferToBase64(iv.buffer),
    aad: arrayBufferToBase64(aad.buffer),
    ciphertext: arrayBufferToBase64(ciphertext),
  };
}

function getPeerFromEncryptedMessage(message) {
  const encrypted = message.encrypted || {};
  if (message.sender_ip === state.myClientId) {
    return {
      publicJwk: encrypted.recipient_public_jwk,
      fingerprint: encrypted.recipient_fingerprint,
    };
  }
  return {
    publicJwk: encrypted.sender_public_jwk,
    fingerprint: encrypted.sender_fingerprint,
  };
}

async function decryptPrivateText(message) {
  if (!message.encrypted) {
    throw new Error("Missing encrypted payload");
  }
  const encrypted = message.encrypted;
  const peer = getPeerFromEncryptedMessage(message);
  if (!isValidPublicJwk(peer.publicJwk) || typeof peer.fingerprint !== "string") {
    throw new Error("Peer key not found");
  }
  const sharedKey = await deriveSharedKey(peer.publicJwk, peer.fingerprint);
  const iv = new Uint8Array(base64ToArrayBuffer(encrypted.iv));
  const aad = new Uint8Array(base64ToArrayBuffer(encrypted.aad));
  const ciphertext = base64ToArrayBuffer(encrypted.ciphertext);
  const plainBuffer = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv, additionalData: aad },
    sharedKey,
    ciphertext
  );
  return textDecoder.decode(plainBuffer);
}

function ensureTextDecryption(message) {
  if (state.textDecryptCache.has(message.message_id)) {
    return;
  }
  state.textDecryptCache.set(message.message_id, { status: "loading" });
  decryptPrivateText(message)
    .then((text) => {
      state.textDecryptCache.set(message.message_id, { status: "ok", text });
      renderMessages();
    })
    .catch((error) => {
      state.textDecryptCache.set(message.message_id, {
        status: "error",
        error: String(error?.message || error || "decrypt failed"),
      });
      renderMessages();
    });
}

function renderPlainAttachment(message) {
  if (!message.attachment) {
    return null;
  }
  const attachment = message.attachment;
  const wrapper = document.createElement("div");
  wrapper.className = "attachment";

  if (attachment.kind === "image") {
    const img = document.createElement("img");
    img.src = attachment.url;
    img.alt = attachment.original_name;
    img.loading = "lazy";
    wrapper.appendChild(img);
  } else if (attachment.kind === "video") {
    const video = document.createElement("video");
    video.controls = true;
    video.src = attachment.url;
    wrapper.appendChild(video);
  } else if (attachment.kind === "audio") {
    const audio = document.createElement("audio");
    audio.controls = true;
    audio.src = attachment.url;
    wrapper.appendChild(audio);
  }

  const fileLink = document.createElement("a");
  fileLink.href = attachment.url;
  fileLink.target = "_blank";
  fileLink.rel = "noopener noreferrer";
  fileLink.textContent = `${attachment.original_name} (${formatBytes(attachment.size)})`;
  wrapper.appendChild(fileLink);

  return wrapper;
}

async function encryptPrivateFile(file, recipientId, caption) {
  const peer = getRecipientIdentity(recipientId);
  if (!peer) {
    throw new Error("Nguoi nhan chua cong bo key E2EE.");
  }

  const sharedKey = await deriveSharedKey(peer.publicJwk, peer.fingerprint);
  const fileBytes = await file.arrayBuffer();
  const fileIv = randomIv();
  const fileAad = textEncoder.encode(`webchat:e2ee:file:v1:${state.myClientId}->${recipientId}`);
  const encryptedFile = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: fileIv, additionalData: fileAad },
    sharedKey,
    fileBytes
  );

  const metadata = {
    original_name: file.name || "file",
    mime_type: file.type || "application/octet-stream",
    size: file.size,
    caption: caption || null,
  };
  const metadataIv = randomIv();
  const metadataAad = textEncoder.encode(`webchat:e2ee:file-meta:v1:${state.myClientId}->${recipientId}`);
  const metadataCiphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: metadataIv, additionalData: metadataAad },
    sharedKey,
    textEncoder.encode(JSON.stringify(metadata))
  );

  return {
    encryptedBlob: new Blob([encryptedFile], { type: "application/octet-stream" }),
    encryptedPayload: {
      ...buildEnvelopeBase(peer),
      file_iv: arrayBufferToBase64(fileIv.buffer),
      file_aad: arrayBufferToBase64(fileAad.buffer),
      metadata_iv: arrayBufferToBase64(metadataIv.buffer),
      metadata_aad: arrayBufferToBase64(metadataAad.buffer),
      metadata_ciphertext: arrayBufferToBase64(metadataCiphertext),
    },
  };
}

async function decryptPrivateFile(message) {
  const encrypted = message.encrypted || {};
  const peer = getPeerFromEncryptedMessage(message);
  if (!isValidPublicJwk(peer.publicJwk) || typeof peer.fingerprint !== "string") {
    throw new Error("Peer key not found");
  }
  const sharedKey = await deriveSharedKey(peer.publicJwk, peer.fingerprint);

  const response = await fetch(message.attachment.url);
  if (!response.ok) {
    throw new Error(`Cannot fetch encrypted file (${response.status})`);
  }
  const encryptedFileBuffer = await response.arrayBuffer();
  const fileIv = new Uint8Array(base64ToArrayBuffer(encrypted.file_iv));
  const fileAad = new Uint8Array(base64ToArrayBuffer(encrypted.file_aad));
  const plainFileBuffer = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fileIv, additionalData: fileAad },
    sharedKey,
    encryptedFileBuffer
  );

  const metadataIv = new Uint8Array(base64ToArrayBuffer(encrypted.metadata_iv));
  const metadataAad = new Uint8Array(base64ToArrayBuffer(encrypted.metadata_aad));
  const metadataCipher = base64ToArrayBuffer(encrypted.metadata_ciphertext);
  const plainMetaBuffer = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: metadataIv, additionalData: metadataAad },
    sharedKey,
    metadataCipher
  );

  const metadataText = textDecoder.decode(plainMetaBuffer);
  const metadata = JSON.parse(metadataText);
  const mimeType =
    typeof metadata.mime_type === "string" && metadata.mime_type
      ? metadata.mime_type
      : "application/octet-stream";
  const blob = new Blob([plainFileBuffer], { type: mimeType });
  const objectUrl = URL.createObjectURL(blob);

  return {
    url: objectUrl,
    name: typeof metadata.original_name === "string" ? metadata.original_name : "file",
    size: Number.isFinite(metadata.size) ? metadata.size : blob.size,
    mimeType,
    kind: mediaKindFromMime(mimeType),
    caption: typeof metadata.caption === "string" ? metadata.caption : null,
  };
}

function ensureFileDecryption(message) {
  const cached = state.fileDecryptCache.get(message.message_id);
  if (cached) {
    return;
  }
  state.fileDecryptCache.set(message.message_id, { status: "loading" });
  decryptPrivateFile(message)
    .then((data) => {
      state.fileDecryptCache.set(message.message_id, { status: "ok", data });
      renderMessages();
    })
    .catch((error) => {
      state.fileDecryptCache.set(message.message_id, {
        status: "error",
        error: String(error?.message || error || "decrypt failed"),
      });
      renderMessages();
    });
}

function renderEncryptedFileNode(message) {
  const wrapper = document.createElement("div");
  wrapper.className = "attachment";
  const cached = state.fileDecryptCache.get(message.message_id);

  if (!cached) {
    ensureFileDecryption(message);
    const loading = document.createElement("p");
    loading.className = "message-body";
    loading.textContent = "[E2EE file] Dang giai ma...";
    wrapper.appendChild(loading);
    return wrapper;
  }

  if (cached.status === "loading") {
    const loading = document.createElement("p");
    loading.className = "message-body";
    loading.textContent = "[E2EE file] Dang giai ma...";
    wrapper.appendChild(loading);
    return wrapper;
  }

  if (cached.status === "error") {
    const error = document.createElement("p");
    error.className = "message-body";
    error.textContent = `[E2EE file] Khong giai ma duoc (${cached.error})`;
    wrapper.appendChild(error);
    return wrapper;
  }

  const data = cached.data;
  if (data.kind === "image") {
    const img = document.createElement("img");
    img.src = data.url;
    img.alt = data.name;
    img.loading = "lazy";
    wrapper.appendChild(img);
  } else if (data.kind === "video") {
    const video = document.createElement("video");
    video.controls = true;
    video.src = data.url;
    wrapper.appendChild(video);
  } else if (data.kind === "audio") {
    const audio = document.createElement("audio");
    audio.controls = true;
    audio.src = data.url;
    wrapper.appendChild(audio);
  }

  if (data.caption) {
    const cap = document.createElement("p");
    cap.className = "message-body";
    cap.textContent = data.caption;
    wrapper.appendChild(cap);
  }

  const link = document.createElement("a");
  link.href = data.url;
  link.download = data.name;
  link.textContent = `${data.name} (${formatBytes(data.size)})`;
  wrapper.appendChild(link);

  return wrapper;
}

function renderMessages() {
  const frag = document.createDocumentFragment();
  const visibleMessages = state.messages.filter(isVisibleInCurrentRoom);

  if (visibleMessages.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-messages";
    empty.textContent =
      state.activeRecipient === null
        ? "Chua co tin nhan cong khai. Hay bat dau cuoc tro chuyen."
        : "Chua co tin nhan rieng trong phong nay.";
    frag.appendChild(empty);
  }

  visibleMessages.forEach((message) => {
    const item = document.createElement("article");
    item.className = "message";
    if (message.sender_ip === state.myClientId) {
      item.classList.add("mine");
    } else {
      item.classList.add("other");
    }

    const meta = document.createElement("p");
    meta.className = "message-meta";
    meta.textContent = makeMetaLine(message);
    item.appendChild(meta);

    if (message.message_type === "text") {
      if (message.text) {
        const body = document.createElement("p");
        body.className = "message-body";
        body.textContent = message.text;
        item.appendChild(body);
      }
    } else if (message.message_type === "e2ee_text") {
      const cache = state.textDecryptCache.get(message.message_id);
      const body = document.createElement("p");
      body.className = "message-body";
      if (!cache) {
        ensureTextDecryption(message);
        body.textContent = "[E2EE] Dang giai ma...";
      } else if (cache.status === "loading") {
        body.textContent = "[E2EE] Dang giai ma...";
      } else if (cache.status === "error") {
        body.textContent = `[E2EE] Khong giai ma duoc (${cache.error})`;
      } else {
        body.textContent = cache.text;
      }
      item.appendChild(body);
    } else if (message.text) {
      const body = document.createElement("p");
      body.className = "message-body";
      body.textContent = message.text;
      item.appendChild(body);
    }

    if (message.message_type === "file") {
      const attachmentNode = renderPlainAttachment(message);
      if (attachmentNode) {
        item.appendChild(attachmentNode);
      }
    } else if (message.message_type === "e2ee_file") {
      const encryptedNode = renderEncryptedFileNode(message);
      item.appendChild(encryptedNode);
    }

    frag.appendChild(item);
  });

  elements.messages.innerHTML = "";
  elements.messages.appendChild(frag);
  elements.messages.scrollTop = elements.messages.scrollHeight;
}

function isTypingEventRelevant(payload) {
  if (!payload || payload.sender_ip === state.myClientId) {
    return false;
  }
  if (state.activeRecipient === null) {
    return payload.recipient_ip === null;
  }
  return payload.sender_ip === state.activeRecipient && payload.recipient_ip === state.myClientId;
}

function sendSocketJson(payload) {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
    setStatus("Chua ket noi server");
    return false;
  }
  state.socket.send(JSON.stringify(payload));
  return true;
}

function announceIdentityIfPossible() {
  if (!state.e2eeReady || !state.identity) {
    return;
  }
  sendSocketJson({
    type: "announce_key",
    public_key: state.identity.publicJwk,
    key_fingerprint: state.identity.fingerprint,
  });
}

function handleSocketEvent(payload) {
  if (!payload || typeof payload !== "object") {
    return;
  }

  if (payload.type === "hello") {
    state.myClientId = payload.me?.id || payload.me?.ip || "";
    state.myNetworkIp = payload.me?.ip || "";
    const displayName =
      payload.me?.device_name || state.deviceProfile?.deviceName || shortClientId(state.myClientId);
    const idShort = shortClientId(state.myClientId);
    const ipPart = state.myNetworkIp ? ` @${state.myNetworkIp}` : "";
    elements.myIp.textContent = `${displayName} | ${idShort}${ipPart}`;
    state.users = Array.isArray(payload.users) ? payload.users : [];
    state.messages = [];
    state.knownMessageIds = new Set();
    state.textDecryptCache = new Map();
    state.fileDecryptCache.forEach((entry) => {
      if (entry && entry.status === "ok" && entry.data && entry.data.url) {
        URL.revokeObjectURL(entry.data.url);
      }
    });
    state.fileDecryptCache = new Map();
    (payload.messages || []).forEach(addMessage);
    updateRoomUi();
    renderUsers();
    renderMessages();
    announceIdentityIfPossible();
    return;
  }

  if (payload.type === "presence") {
    state.users = Array.isArray(payload.users) ? payload.users : [];
    renderUsers();
    return;
  }

  if (payload.type === "message") {
    addMessage(payload.message);
    renderMessages();
    return;
  }

  if (payload.type === "typing") {
    if (!isTypingEventRelevant(payload)) {
      return;
    }
    if (payload.is_typing) {
      state.typingPeer = payload.sender_ip;
      updateTypingHint(`${formatUserLabel(payload.sender_ip)} dang nhap...`);
    } else if (state.typingPeer === payload.sender_ip) {
      state.typingPeer = null;
      updateTypingHint("");
    }
    return;
  }
}

function connectSocket() {
  if (
    state.socket &&
    (state.socket.readyState === WebSocket.OPEN || state.socket.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }

  setStatus("Dang ket noi...");
  const socket = new WebSocket(socketUrl());
  state.socket = socket;

  socket.addEventListener("open", () => {
    setStatus("Da ket noi");
    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
    announceIdentityIfPossible();
  });

  socket.addEventListener("message", (event) => {
    try {
      const payload = JSON.parse(event.data);
      handleSocketEvent(payload);
    } catch (_) {
      // Ignore invalid payloads.
    }
  });

  socket.addEventListener("close", () => {
    setStatus("Mat ket noi, dang thu lai...");
    if (!state.reconnectTimer) {
      state.reconnectTimer = setTimeout(() => {
        state.reconnectTimer = null;
        connectSocket();
      }, 2000);
    }
  });

  socket.addEventListener("error", () => {
    setStatus("Loi ket noi");
  });
}

function sendTypingState(isTyping) {
  if (state.typingSent === isTyping) {
    return;
  }
  state.typingSent = isTyping;
  sendSocketJson({
    type: "typing",
    recipient_id: state.activeRecipient,
    is_typing: isTyping,
  });
}

elements.publicBtn.addEventListener("click", () => {
  state.activeRecipient = null;
  updateRoomUi();
  renderMessages();
  closeSidebarIfNeeded();
});

if (elements.openSidebarBtn) {
  elements.openSidebarBtn.addEventListener("click", () => {
    setSidebarOpen(true);
  });
}

if (elements.closeSidebarBtn) {
  elements.closeSidebarBtn.addEventListener("click", () => {
    setSidebarOpen(false);
  });
}

if (elements.sidebarBackdrop) {
  elements.sidebarBackdrop.addEventListener("click", () => {
    setSidebarOpen(false);
  });
}

async function sendTextMessage(text) {
  let sent = false;
  if (state.activeRecipient) {
    if (canSendEncryptedTo(state.activeRecipient)) {
      try {
        const encrypted = await encryptPrivateText(text, state.activeRecipient);
        sent = sendSocketJson({
          type: "send_encrypted_message",
          recipient_id: state.activeRecipient,
          encrypted,
        });
      } catch (error) {
        setStatus(String(error?.message || error || "E2EE send failed"));
        return false;
      }
    } else {
      sent = sendSocketJson({
        type: "send_message",
        text,
        recipient_id: state.activeRecipient,
      });
    }
  } else {
    sent = sendSocketJson({
      type: "send_message",
      text,
      recipient_id: null,
    });
  }
  return sent;
}

async function sendFileMessage(file, caption) {
  const formData = new FormData();
  if (state.deviceProfile?.deviceId) {
    formData.append("device_id", state.deviceProfile.deviceId);
  }

  if (state.activeRecipient) {
    if (canSendEncryptedTo(state.activeRecipient)) {
      try {
        const encrypted = await encryptPrivateFile(file, state.activeRecipient, caption);
        formData.append("file", encrypted.encryptedBlob, "encrypted.bin");
        formData.append("recipient_id", state.activeRecipient);
        formData.append("encrypted_payload", JSON.stringify(encrypted.encryptedPayload));
      } catch (error) {
        setStatus(String(error?.message || error || "E2EE file encrypt failed"));
        return false;
      }
    } else {
      formData.append("file", file);
      formData.append("recipient_id", state.activeRecipient);
      if (caption) {
        formData.append("caption", caption);
      }
    }
  } else {
    formData.append("file", file);
    if (caption) {
      formData.append("caption", caption);
    }
  }

  try {
    const response = await fetch("/api/upload", {
      method: "POST",
      headers: state.deviceProfile?.deviceId ? { "x-device-id": state.deviceProfile.deviceId } : {},
      body: formData,
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      const detail = payload?.detail || "Khong the upload file.";
      setStatus(String(detail));
      return false;
    }
    addMessage(payload.message);
    renderMessages();
    return true;
  } catch (_) {
    setStatus("Upload loi, kiem tra lai ket noi.");
    return false;
  }
}

if (elements.composerForm) {
  elements.composerForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = elements.messageInput.value.trim();
    const file = pendingFile();

    if (!text && !file) {
      return;
    }

    let sent = false;
    if (file) {
      sent = await sendFileMessage(file, text);
    } else if (text) {
      sent = await sendTextMessage(text);
    }

    if (!sent) {
      return;
    }

    elements.messageInput.value = "";
    autoResizeComposer();
    if (file) {
      clearComposerFile();
    }
    updateComposerState();
    sendTypingState(false);
  });
}

elements.messageInput.addEventListener("input", () => {
  const hasText = elements.messageInput.value.trim().length > 0;
  sendTypingState(hasText);
  autoResizeComposer();
  updateComposerState();

  if (state.typingTimer) {
    clearTimeout(state.typingTimer);
    state.typingTimer = null;
  }

  if (hasText) {
    state.typingTimer = setTimeout(() => {
      sendTypingState(false);
      state.typingTimer = null;
    }, 900);
  }
});

elements.messageInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    elements.composerForm?.requestSubmit();
  }
});

if (elements.attachBtn) {
  elements.attachBtn.addEventListener("click", () => {
    elements.fileInput?.click();
  });
}

if (elements.fileInput) {
  elements.fileInput.addEventListener("change", () => {
    updateFilePreview();
    updateComposerState();
  });
}

if (elements.removeFileBtn) {
  elements.removeFileBtn.addEventListener("click", () => {
    clearComposerFile();
  });
}

function initializeDeviceProfile() {
  const profile = loadOrCreateDeviceProfile();
  state.deviceProfile = profile;
}

window.addEventListener("resize", () => {
  if (!isMobileLayout() && state.sidebarOpen) {
    setSidebarOpen(false);
  }
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.sidebarOpen) {
    setSidebarOpen(false);
  }
});

window.setInterval(() => {
  sendSocketJson({ type: "ping" });
}, 30000);

window.addEventListener("beforeunload", () => {
  state.fileDecryptCache.forEach((entry) => {
    if (entry && entry.status === "ok" && entry.data && entry.data.url) {
      URL.revokeObjectURL(entry.data.url);
    }
  });
});

async function bootstrap() {
  setSidebarOpen(false);
  initializeDeviceProfile();
  autoResizeComposer();
  updateFilePreview();
  updateComposerState();
  try {
    await initializeE2EEIdentity();
  } catch (_) {
    state.e2eeReady = false;
    elements.myFingerprint.textContent = "loi key";
  }
  connectSocket();
}

bootstrap();
