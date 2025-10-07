var PROPERTY_KEYS = {
  fastStart: 'fastStart',
  lastDrink: 'lastDrink',
  reminderInterval: 'reminderInterval',
  lastReminder: 'lastReminder'
};
var SESSION_INDEX_KEY = 'sessions:index';
var SESSION_PREFIX = 'session:';
var SESSION_ACTIVE_KEY = 'active';

var AUTH_PROPERTY_KEY = 'auth:users';
var PASSWORD_MIN_LENGTH = 8;
var RESET_TOKEN_EXPIRATION_MINUTES = 30;
var AUTH_REQUIRED_ERROR = 'Authentication required. Please sign in again.';

var DEFAULT_REMINDER_MINUTES = 120;
var MIN_REMINDER_MINUTES = 30;
var PROGRESS_TARGET_HOURS = 168;
var MANIFEST_FALLBACK = JSON.stringify({
  name: 'HydraFast',
  short_name: 'HydraFast',
  start_url: '.',
  display: 'standalone',
  background_color: '#f0f9ff',
  theme_color: '#00b4d8',
  description: 'Track fasting phases, hydration reminders, and motivation in a calming experience.',
  icons: []
});
var SERVICE_WORKER_FALLBACK = [
  "const CACHE_NAME = 'hydrafast-v1';",
  'const ASSETS = [',
  "  './',",
  "  './?resource=manifest'",
  '];',
  '',
  'self.addEventListener(\'install\', event => {',
  '  event.waitUntil(',
  '    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS)).catch(() => null)',
  '  );',
  '});',
  '',
  'self.addEventListener(\'activate\', event => {',
  '  event.waitUntil(',
  '    caches.keys().then(keys => {',
  '      return Promise.all(',
  '        keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))',
  '      );',
  '    })',
  '  );',
  '});',
  '',
  'self.addEventListener(\'fetch\', event => {',
  '  event.respondWith(',
  '    caches.match(event.request).then(cached => {',
  '      return cached || fetch(event.request).catch(() => cached);',
  '    })',
  '  );',
  '});'
].join('\n');

function registerUser(payload) {
  var email = normalizeEmail(payload && payload.email);
  var password = payload ? payload.password : null;
  if (!email || !password) {
    throw new Error('Email and password are required.');
  }
  if (password.length < PASSWORD_MIN_LENGTH) {
    throw new Error('Password must be at least ' + PASSWORD_MIN_LENGTH + ' characters.');
  }
  if (!isValidEmail(email)) {
    throw new Error('Please provide a valid email address.');
  }
  var store = loadUserStore();
  if (store.users[email]) {
    throw new Error('An account with this email already exists.');
  }
  var salt = generateSalt();
  var hash = hashPassword(password, salt);
  store.users[email] = {
    email: payload.email,
    normalizedEmail: email,
    salt: salt,
    hash: hash,
    createdAt: Date.now(),
    devices: {}
  };
  saveUserStore(store);
  return {
    success: true
  };
}

function loginUser(payload) {
  var email = normalizeEmail(payload && payload.email);
  var password = payload ? payload.password : null;
  var deviceId = sanitizeDeviceId(payload && payload.deviceId);
  if (!email || !password || !deviceId) {
    throw new Error('Email, password, and device are required.');
  }
  var store = loadUserStore();
  var user = store.users[email];
  if (!user || !validatePassword(password, user)) {
    throw new Error('Invalid email or password.');
  }
  var device = user.devices[deviceId] || {};
  var token = generateToken();
  var sessionKey = buildDeviceSessionKey(email, deviceId);
  var now = Date.now();
  device.token = token;
  device.sessionKey = sessionKey;
  device.lastLogin = now;
  if (!device.createdAt) {
    device.createdAt = now;
  }
  user.devices[deviceId] = device;
  if (!store.sessionOwners) {
    store.sessionOwners = {};
  }
  store.sessionOwners[sessionKey] = email;
  saveUserStore(store);
  return {
    success: true,
    email: user.email,
    token: token,
    deviceId: deviceId,
    sessionId: sessionKey
  };
}

function resumeSession(payload) {
  var context = resolveAuthorizedSession(payload);
  return {
    success: true,
    email: context.email,
    token: context.token,
    deviceId: context.deviceId,
    sessionId: context.sessionId
  };
}

function logoutUser(payload) {
  var email = normalizeEmail(payload && payload.email);
  var deviceId = sanitizeDeviceId(payload && payload.deviceId);
  if (!email || !deviceId) {
    return {
      success: true
    };
  }
  var store = loadUserStore();
  var user = store.users[email];
  if (user && user.devices && user.devices[deviceId]) {
    var sessionKey = user.devices[deviceId].sessionKey;
    delete user.devices[deviceId];
    if (store.sessionOwners && sessionKey) {
      delete store.sessionOwners[sessionKey];
    }
    saveUserStore(store);
  }
  return {
    success: true
  };
}

function initiatePasswordReset(payload) {
  var email = normalizeEmail(payload && payload.email ? payload.email : payload);
  if (!email) {
    throw new Error('Email is required.');
  }
  var store = loadUserStore();
  var user = store.users[email];
  if (!user) {
    return {
      success: true
    };
  }
  var token = generateToken();
  var expiresAt = Date.now() + RESET_TOKEN_EXPIRATION_MINUTES * 60000;
  user.reset = {
    token: token,
    expiresAt: expiresAt
  };
  saveUserStore(store);
  try {
    MailApp.sendEmail({
      to: user.email,
      subject: 'HydraFast Password Reset',
      body: 'Use this code to reset your HydraFast password: ' + token + '\n\nThe code expires in ' + RESET_TOKEN_EXPIRATION_MINUTES + ' minutes.'
    });
  } catch (err) {
    // Ignore send failures so request still succeeds.
  }
  return {
    success: true
  };
}

function completePasswordReset(payload) {
  var email = normalizeEmail(payload && payload.email);
  var token = payload ? payload.token : null;
  var newPassword = payload ? payload.newPassword : null;
  if (!email || !token || !newPassword) {
    throw new Error('Email, reset code, and new password are required.');
  }
  if (newPassword.length < PASSWORD_MIN_LENGTH) {
    throw new Error('Password must be at least ' + PASSWORD_MIN_LENGTH + ' characters.');
  }
  var store = loadUserStore();
  var user = store.users[email];
  if (!user || !user.reset || user.reset.token !== token) {
    throw new Error('Invalid reset code.');
  }
  if (Date.now() > user.reset.expiresAt) {
    delete user.reset;
    saveUserStore(store);
    throw new Error('Reset code has expired.');
  }
  var salt = generateSalt();
  var hash = hashPassword(newPassword, salt);
  user.salt = salt;
  user.hash = hash;
  user.devices = {};
  delete user.reset;
  saveUserStore(store);
  return {
    success: true
  };
}

function resolveAuthorizedSession(sessionInput) {
  if (!sessionInput || typeof sessionInput !== 'object') {
    throw new Error(AUTH_REQUIRED_ERROR);
  }
  var email = normalizeEmail(sessionInput.email || sessionInput.userEmail);
  var token = sessionInput.token || sessionInput.sessionToken;
  var deviceId = sanitizeDeviceId(sessionInput.deviceId || sessionInput.sessionId || sessionInput.id);
  if (!email || !token || !deviceId) {
    throw new Error(AUTH_REQUIRED_ERROR);
  }
  var store = loadUserStore();
  var user = store.users[email];
  if (!user || !user.devices) {
    throw new Error(AUTH_REQUIRED_ERROR);
  }
  var device = user.devices[deviceId];
  if (!device || device.token !== token) {
    throw new Error(AUTH_REQUIRED_ERROR);
  }
  if (!store.sessionOwners) {
    store.sessionOwners = {};
  }
  var mutated = false;
  if (!device.sessionKey) {
    device.sessionKey = buildDeviceSessionKey(email, deviceId);
    mutated = true;
  }
  if (store.sessionOwners[device.sessionKey] !== email) {
    store.sessionOwners[device.sessionKey] = email;
    mutated = true;
  }
  if (mutated) {
    saveUserStore(store);
  }
  return {
    email: user.email,
    normalizedEmail: email,
    token: device.token,
    deviceId: deviceId,
    sessionId: device.sessionKey
  };
}

function normalizeEmail(email) {
  if (!email && email !== '') {
    return null;
  }
  var str = String(email).trim();
  if (!str) {
    return null;
  }
  return str.toLowerCase();
}

function sanitizeDeviceId(deviceId) {
  if (!deviceId && deviceId !== '') {
    return null;
  }
  var str = String(deviceId);
  if (!str) {
    return null;
  }
  return str.replace(/[^a-zA-Z0-9_-]/g, '').substring(0, 100);
}

function generateSalt() {
  return Utilities.getUuid().replace(/-/g, '');
}

function generateToken() {
  return Utilities.getUuid().replace(/-/g, '');
}

function hashPassword(password, salt) {
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + '|' + password);
  return bytesToHex(digest);
}

function validatePassword(password, user) {
  if (!user || !user.salt || !user.hash) {
    return false;
  }
  var computed = hashPassword(password, user.salt);
  return computed === user.hash;
}

function bytesToHex(bytes) {
  return bytes
    .map(function (byte) {
      var value = byte;
      if (value < 0) {
        value += 256;
      }
      var hex = value.toString(16);
      return hex.length === 1 ? '0' + hex : hex;
    })
    .join('');
}

function buildDeviceSessionKey(email, deviceId) {
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, email + '::' + deviceId);
  return 'sess_' + bytesToHex(digest).substring(0, 32);
}

function loadUserStore() {
  var props = PropertiesService.getScriptProperties();
  var raw = props.getProperty(AUTH_PROPERTY_KEY);
  if (!raw) {
    return {
      users: {},
      sessionOwners: {}
    };
  }
  try {
    var parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return {
        users: {},
        sessionOwners: {}
      };
    }
    parsed.users = parsed.users || {};
    parsed.sessionOwners = parsed.sessionOwners || {};
    return parsed;
  } catch (err) {
    return {
      users: {},
      sessionOwners: {}
    };
  }
}

function saveUserStore(store) {
  if (!store) {
    return;
  }
  store.users = store.users || {};
  store.sessionOwners = store.sessionOwners || {};
  var props = PropertiesService.getScriptProperties();
  props.setProperty(AUTH_PROPERTY_KEY, JSON.stringify(store));
}

function lookupSessionOwner(store, sessionId) {
  if (!store) {
    return null;
  }
  var ownerMap = store.sessionOwners || {};
  if (ownerMap[sessionId]) {
    return ownerMap[sessionId];
  }
  var users = store.users || {};
  for (var key in users) {
    if (!Object.prototype.hasOwnProperty.call(users, key)) {
      continue;
    }
    var user = users[key];
    if (!user.devices) {
      continue;
    }
    var devices = user.devices;
    for (var deviceId in devices) {
      if (!Object.prototype.hasOwnProperty.call(devices, deviceId)) {
        continue;
      }
      if (devices[deviceId] && devices[deviceId].sessionKey === sessionId) {
        return key;
      }
    }
  }
  return null;
}

function findDeviceBySession(user, sessionId) {
  if (!user || !user.devices) {
    return null;
  }
  for (var deviceId in user.devices) {
    if (!Object.prototype.hasOwnProperty.call(user.devices, deviceId)) {
      continue;
    }
    var device = user.devices[deviceId];
    if (device && device.sessionKey === sessionId) {
      return device;
    }
  }
  return null;
}

function isValidEmail(email) {
  if (!email) {
    return false;
  }
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function doGet(e) {
  var resource = e && e.parameter ? e.parameter.resource : null;
  if (resource === 'manifest') {
    return ContentService.createTextOutput(getManifestContent())
      .setMimeType(ContentService.MimeType.JSON);
  }
  if (resource === 'service-worker') {
    return ContentService.createTextOutput(getServiceWorkerContent())
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('HydraFast')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function startFast(sessionId, customTimestamp) {
  if (arguments.length === 1 && (typeof sessionId === 'number' || sessionId instanceof Date || typeof sessionId === 'string')) {
    throw new Error(AUTH_REQUIRED_ERROR);
  }
  return applyFastStart(sessionId, customTimestamp);
}

function setFastStart(sessionId, customTimestamp) {
  if (arguments.length === 1 && (typeof sessionId === 'number' || sessionId instanceof Date || typeof sessionId === 'string')) {
    throw new Error(AUTH_REQUIRED_ERROR);
  }
  return applyFastStart(sessionId, customTimestamp);
}

function applyFastStart(sessionId, customTimestamp) {
  var context = resolveSessionContext(sessionId);
  var props = PropertiesService.getUserProperties();
  var now = new Date().getTime();
  var startTime = resolveStartTimestamp(customTimestamp, now);
  var resolvedSession = context.sessionId;
  persistFastStart(props, resolvedSession, startTime);
  ensureReminderTrigger();
  return getStatus(context);
}

function resolveStartTimestamp(customTimestamp, now) {
  var parsed = null;
  if (customTimestamp !== undefined && customTimestamp !== null && customTimestamp !== '') {
    if (typeof customTimestamp === 'number') {
      parsed = customTimestamp;
    } else if (typeof customTimestamp === 'string') {
      parsed = parseInt(customTimestamp, 10);
      if (isNaN(parsed)) {
        var fromString = new Date(customTimestamp);
        if (!isNaN(fromString.getTime())) {
          parsed = fromString.getTime();
        }
      }
    } else if (customTimestamp instanceof Date) {
      parsed = customTimestamp.getTime();
    }
  }
  if (!parsed || isNaN(parsed)) {
    parsed = now;
  }
  if (parsed > now) {
    parsed = now;
  }
  return parsed;
}

function resolveSessionId(sessionId) {
  if (sessionId && typeof sessionId === 'object') {
    return resolveAuthorizedSession(sessionId).sessionId;
  }
  if (sessionId === undefined || sessionId === null || sessionId === '') {
    return 'default';
  }
  if (typeof sessionId !== 'string') {
    sessionId = String(sessionId);
  }
  var sanitized = sessionId.replace(/[^a-zA-Z0-9_-]/g, '').substring(0, 80);
  if (!sanitized) {
    return 'default';
  }
  return sanitized;
}

function resolveSessionContext(sessionInput) {
  if (sessionInput && typeof sessionInput === 'object') {
    if (sessionInput.__context === true && sessionInput.sessionId) {
      return sessionInput;
    }
    var context = resolveAuthorizedSession(sessionInput);
    context.__context = true;
    return context;
  }
  throw new Error(AUTH_REQUIRED_ERROR);
}

function buildSessionKey(sessionId, key) {
  return SESSION_PREFIX + sessionId + ':' + key;
}

function getSessionProperty(props, sessionId, key) {
  var propertyKey = buildSessionKey(sessionId, key);
  var value = props.getProperty(propertyKey);
  if (value !== null && value !== undefined) {
    return value;
  }
  if (sessionId === 'default') {
    return props.getProperty(PROPERTY_KEYS[key] ? PROPERTY_KEYS[key] : key);
  }
  return null;
}

function setSessionProperty(props, sessionId, key, value) {
  props.setProperty(buildSessionKey(sessionId, key), value);
  if (sessionId === 'default' && PROPERTY_KEYS[key]) {
    props.setProperty(PROPERTY_KEYS[key], value);
  }
  recordSessionId(props, sessionId);
}

function deleteSessionProperty(props, sessionId, key) {
  props.deleteProperty(buildSessionKey(sessionId, key));
  if (sessionId === 'default' && PROPERTY_KEYS[key]) {
    props.deleteProperty(PROPERTY_KEYS[key]);
  }
  cleanupSessionIfInactive(props, sessionId);
}

function recordSessionId(props, sessionId) {
  if (!sessionId) {
    return;
  }
  var list = listSessionIds(props);
  if (list.indexOf(sessionId) === -1) {
    list.push(sessionId);
    props.setProperty(SESSION_INDEX_KEY, JSON.stringify(list));
  }
}

function listSessionIds(props) {
  var raw = props.getProperty(SESSION_INDEX_KEY);
  var list = [];
  if (raw) {
    try {
      var parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        list = parsed.filter(function (item) {
          return typeof item === 'string' && item;
        });
      }
    } catch (err) {
      list = [];
    }
  }
  if (list.indexOf('default') === -1) {
    if (props.getProperty(PROPERTY_KEYS.fastStart) || props.getProperty(PROPERTY_KEYS.lastDrink) || props.getProperty(PROPERTY_KEYS.lastReminder)) {
      list.push('default');
    }
  }
  return list;
}

function removeSessionId(props, sessionId) {
  var raw = props.getProperty(SESSION_INDEX_KEY);
  if (!raw) {
    return;
  }
  try {
    var parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      var filtered = parsed.filter(function (item) {
        return item !== sessionId;
      });
      props.setProperty(SESSION_INDEX_KEY, JSON.stringify(filtered));
    }
  } catch (err) {
    props.deleteProperty(SESSION_INDEX_KEY);
  }
}

function cleanupSessionIfInactive(props, sessionId) {
  if (!sessionId) {
    return;
  }
  var hasActiveMarker = props.getProperty(buildSessionKey(sessionId, SESSION_ACTIVE_KEY));
  var hasFastStart = getSessionProperty(props, sessionId, PROPERTY_KEYS.fastStart);
  var hasLastDrink = getSessionProperty(props, sessionId, PROPERTY_KEYS.lastDrink);
  var hasLastReminder = getSessionProperty(props, sessionId, PROPERTY_KEYS.lastReminder);
  var hasInterval = getSessionProperty(props, sessionId, PROPERTY_KEYS.reminderInterval);
  if (!hasActiveMarker && !hasFastStart && !hasLastDrink && !hasLastReminder && !hasInterval) {
    removeSessionId(props, sessionId);
  }
}

function markSessionActive(props, sessionId) {
  setSessionProperty(props, sessionId, SESSION_ACTIVE_KEY, 'true');
}

function markSessionInactive(props, sessionId) {
  deleteSessionProperty(props, sessionId, SESSION_ACTIVE_KEY);
}

function getAggregateReminderInterval(props) {
  var sessionIds = listSessionIds(props);
  var minInterval = null;
  var fastActive = false;
  for (var i = 0; i < sessionIds.length; i++) {
    var sessionId = sessionIds[i];
    var startValue = getSessionProperty(props, sessionId, PROPERTY_KEYS.fastStart);
    if (!startValue) {
      continue;
    }
    fastActive = true;
    var intervalValue = getSessionProperty(props, sessionId, PROPERTY_KEYS.reminderInterval);
    var interval = intervalValue ? parseInt(intervalValue, 10) : DEFAULT_REMINDER_MINUTES;
    if (!interval || interval <= 0) {
      continue;
    }
    if (minInterval === null || interval < minInterval) {
      minInterval = interval;
    }
  }
  return {
    fastActive: fastActive,
    interval: minInterval
  };
}

function persistFastStart(props, sessionId, startTime) {
  var previousStartValue = getSessionProperty(props, sessionId, PROPERTY_KEYS.fastStart);
  var previousStart = previousStartValue ? parseInt(previousStartValue, 10) : null;
  var startValue = startTime.toString();
  setSessionProperty(props, sessionId, PROPERTY_KEYS.fastStart, startValue);
  var lastDrinkValue = getSessionProperty(props, sessionId, PROPERTY_KEYS.lastDrink);
  var lastDrink = lastDrinkValue ? parseInt(lastDrinkValue, 10) : null;
  if (!lastDrink || lastDrink < startTime || (previousStart && lastDrink === previousStart)) {
    setSessionProperty(props, sessionId, PROPERTY_KEYS.lastDrink, startValue);
  }
  deleteSessionProperty(props, sessionId, PROPERTY_KEYS.lastReminder);
  markSessionActive(props, sessionId);
}

function stopFast(sessionId) {
  if (arguments.length === 0) {
    throw new Error(AUTH_REQUIRED_ERROR);
  }
  var context = resolveSessionContext(sessionId);
  var props = PropertiesService.getUserProperties();
  var resolvedSession = context.sessionId;
  deleteSessionProperty(props, resolvedSession, PROPERTY_KEYS.fastStart);
  deleteSessionProperty(props, resolvedSession, PROPERTY_KEYS.lastDrink);
  deleteSessionProperty(props, resolvedSession, PROPERTY_KEYS.lastReminder);
  markSessionInactive(props, resolvedSession);
  ensureReminderTrigger();
  return getStatus(context);
}

function recordHydration(sessionId) {
  if (arguments.length === 0) {
    throw new Error(AUTH_REQUIRED_ERROR);
  }
  var context = resolveSessionContext(sessionId);
  var props = PropertiesService.getUserProperties();
  var now = new Date().getTime();
  var resolvedSession = context.sessionId;
  setSessionProperty(props, resolvedSession, PROPERTY_KEYS.lastDrink, now.toString());
  deleteSessionProperty(props, resolvedSession, PROPERTY_KEYS.lastReminder);
  return getStatus(context);
}

function setReminderInterval(sessionId, intervalMinutes) {
  if (arguments.length === 1) {
    intervalMinutes = sessionId;
    throw new Error(AUTH_REQUIRED_ERROR);
  }
  var interval = parseInt(intervalMinutes, 10);
  if (isNaN(interval) || interval < MIN_REMINDER_MINUTES) {
    interval = DEFAULT_REMINDER_MINUTES;
  }
  var context = resolveSessionContext(sessionId);
  var props = PropertiesService.getUserProperties();
  var resolvedSession = context.sessionId;
  setSessionProperty(props, resolvedSession, PROPERTY_KEYS.reminderInterval, interval.toString());
  ensureReminderTrigger();
  return getStatus(context);
}

function getStatus(sessionId) {
  var context = resolveSessionContext(sessionId);
  var props = PropertiesService.getUserProperties();
  var resolvedSession = context.sessionId;
  var now = new Date().getTime();
  var startValue = getSessionProperty(props, resolvedSession, PROPERTY_KEYS.fastStart);
  var startTimestamp = startValue ? parseInt(startValue, 10) : null;
  var elapsedMinutes = startTimestamp ? Math.max(0, Math.floor((now - startTimestamp) / 60000)) : 0;
  var elapsedHours = elapsedMinutes / 60;
  var timeline = getFastingTimeline();
  var phaseDetails = getPhaseDetailsFromHours(elapsedHours, timeline);
  var hydration = buildHydrationStatus(props, now, startTimestamp, resolvedSession);
  var progressTarget = getProgressTargetHours(timeline);
  var progressPercent = startTimestamp ? Math.min(100, Math.round((elapsedHours / progressTarget) * 100)) : 0;
  var response = {
    status: startTimestamp ? 'fasting' : 'not_fasting',
    startTimestamp: startTimestamp,
    elapsedMinutes: elapsedMinutes,
    elapsedHours: elapsedHours,
    elapsedLabel: formatDuration(elapsedMinutes),
    phase: phaseDetails ? phaseDetails.title : null,
    phaseDetails: phaseDetails,
    activePhaseIndex: phaseDetails ? phaseDetails.index : -1,
    progressPercent: progressPercent,
    timeline: timeline,
    motivationalMessage: getMotivationalMessage(now, elapsedHours, phaseDetails),
    hydration: hydration,
    accountEmail: context.email
  };
  return response;
}

function getFastingPhase(hours) {
  var timeline = getFastingTimeline();
  var details = getPhaseDetailsFromHours(hours, timeline);
  return details ? details.title + ' (' + details.range + ')' : timeline[0].title + ' (' + timeline[0].range + ')';
}

function getFastingTimeline() {
  return [
    {
      key: 'fed',
      title: 'Fed State',
      range: '0-4h',
      startHours: 0,
      endHours: 4,
      description: 'Your body is digesting and absorbing nutrients. Use this time to set intentions for your fast.',
      focus: 'Sip water mindfully and plan your hydration schedule.'
    },
    {
      key: 'early-post',
      title: 'Early Post-Absorptive',
      range: '4-8h',
      startHours: 4,
      endHours: 8,
      description: 'Insulin begins to drop and your body starts tapping into glycogen stores for energy.',
      focus: 'Stay busy and keep water nearby to ease the transition.'
    },
    {
      key: 'glycogen',
      title: 'Glycogen Utilization',
      range: '8-12h',
      startHours: 8,
      endHours: 12,
      description: 'Glycogen reserves fuel your body as it prepares to switch to fat burning.',
      focus: 'Add electrolytes to your water to stay balanced.'
    },
    {
      key: 'fat-burning',
      title: 'Fat Burning Begins',
      range: '12-16h',
      startHours: 12,
      endHours: 16,
      description: 'Lipolysis ramps up and your body begins using stored fat for energy.',
      focus: 'Notice your energy—gentle movement can feel great right now.'
    },
    {
      key: 'ketosis',
      title: 'Ketosis Starts',
      range: '16-24h',
      startHours: 16,
      endHours: 24,
      description: 'Ketone levels rise and mental clarity often improves as your body adapts.',
      focus: 'Keep electrolytes handy and celebrate your discipline.'
    },
    {
      key: 'adaptation',
      title: 'Deep Fat Adaptation',
      range: '24-36h',
      startHours: 24,
      endHours: 36,
      description: 'Cells increasingly rely on fat for fuel, easing hunger and stabilizing energy.',
      focus: 'Rest when needed, hydrate consistently, and listen to your body.'
    },
    {
      key: 'autophagy',
      title: 'Peak Autophagy',
      range: '36-48h',
      startHours: 36,
      endHours: 48,
      description: 'Cellular clean-up accelerates as autophagy removes damaged components.',
      focus: 'Focus on calm breathing and light stretching to support recovery.'
    },
    {
      key: 'deep-ketosis',
      title: 'Deep Ketosis & Regeneration',
      range: '48-72h',
      startHours: 48,
      endHours: 72,
      description: 'Ketones dominate energy use, inflammation drops, and stem cell activity starts to rise.',
      focus: 'Keep electrolytes steady and prioritize deep rest.'
    },
    {
      key: 'immune-reset',
      title: 'Immune System Renewal',
      range: '72-96h',
      startHours: 72,
      endHours: 96,
      description: 'Old immune cells clear out as new white blood cells and a calmer gut microbiome emerge.',
      focus: 'Stay hydrated, stay warm, and welcome the regeneration.'
    },
    {
      key: 'stem-cell',
      title: 'Stem Cell Activation',
      range: '96-120h',
      startHours: 96,
      endHours: 120,
      description: 'Stem cells and mitochondria repair tissues while calm alertness settles in.',
      focus: 'Breathe slowly, rest often, and listen for subtle body cues.'
    },
    {
      key: 'metabolic-reset',
      title: 'Hormonal & Metabolic Reset',
      range: '120-144h',
      startHours: 120,
      endHours: 144,
      description: 'Insulin sensitivity and leptin balance reset as fat-burning efficiency peaks.',
      focus: 'Hydrate with minerals and move intentionally but gently.'
    },
    {
      key: 'deep-regeneration',
      title: 'Deep Regeneration',
      range: '144-168h',
      startHours: 144,
      endHours: 168,
      description: 'DNA repair and cellular longevity signals stay elevated with bright mental clarity.',
      focus: 'Journal insights, rest frequently, and keep stress low.'
    },
    {
      key: 'extended-healing',
      title: 'Extended Healing',
      range: '168h+',
      startHours: 168,
      endHours: null,
      description: 'The body sustains on stored fat and ketones—continue only with professional guidance and mindful refeeding.',
      focus: 'Partner with your care team and map out a gentle refeed plan.'
    }
  ];
}

function buildHydrationStatus(props, now, startTimestamp, sessionId) {
  var lastDrinkValue = getSessionProperty(props, sessionId, PROPERTY_KEYS.lastDrink);
  var lastDrink = lastDrinkValue ? parseInt(lastDrinkValue, 10) : null;
  var intervalValue = getSessionProperty(props, sessionId, PROPERTY_KEYS.reminderInterval);
  var interval = intervalValue ? parseInt(intervalValue, 10) : DEFAULT_REMINDER_MINUTES;
  var lastReminderValue = getSessionProperty(props, sessionId, PROPERTY_KEYS.lastReminder);
  var lastReminder = lastReminderValue ? parseInt(lastReminderValue, 10) : null;
  var nextReminderMinutes = null;
  if (startTimestamp && interval > 0) {
    var reference = lastDrink || startTimestamp;
    var dueAt = reference + interval * 60000;
    var deltaMinutes = Math.ceil((dueAt - now) / 60000);
    nextReminderMinutes = deltaMinutes > 0 ? deltaMinutes : 0;
  }
  var minutesSinceDrink = lastDrink ? Math.floor((now - lastDrink) / 60000) : null;
  return {
    intervalMinutes: interval,
    lastDrinkTimestamp: lastDrink,
    lastDrinkMinutesAgo: minutesSinceDrink,
    lastReminderTimestamp: lastReminder,
    nextReminderMinutes: nextReminderMinutes
  };
}

function getPhaseDetailsFromHours(hours, timeline) {
  if (!timeline || timeline.length === 0) {
    return null;
  }
  for (var i = 0; i < timeline.length; i++) {
    var phase = timeline[i];
    if (phase.endHours === null) {
      if (hours >= phase.startHours) {
        return buildPhaseResponse(phase, i);
      }
    } else if (hours >= phase.startHours && hours < phase.endHours) {
      return buildPhaseResponse(phase, i);
    }
  }
  return buildPhaseResponse(timeline[timeline.length - 1], timeline.length - 1);
}

function buildPhaseResponse(phase, index) {
  return {
    key: phase.key,
    title: phase.title,
    range: phase.range,
    description: phase.description,
    focus: phase.focus,
    index: index
  };
}

function getMotivationalMessage(now, hours, phaseDetails) {
  var baseMessages = [
    'Hydrate with intention—every sip fuels your focus.',
    'Visualize the clarity you are creating with this fast.',
    'Progress is the product of the small choices you repeat.',
    'Breathe deeply, stand tall, and remember why you started.',
    'Consistency beats intensity—stay steady and hydrated.',
    'Kindness toward yourself makes every fast more sustainable.',
    'Celebrate each hour—you are building powerful habits.'
  ];
  var index = new Date(now).getDate() + new Date(now).getDay();
  var message = baseMessages[index % baseMessages.length];
  if (phaseDetails) {
    message = phaseDetails.focus + ' ' + message;
  }
  if (!phaseDetails || hours === 0) {
    message = 'Welcome to HydraFast—set your intention and tap “Start Fast” when you are ready.';
  }
  return message;
}

function formatDuration(totalMinutes) {
  var minutes = Math.max(0, totalMinutes);
  var hours = Math.floor(minutes / 60);
  var remainingMinutes = minutes % 60;
  var parts = [];
  if (hours > 0) {
    parts.push(hours + 'h');
  }
  parts.push(remainingMinutes + 'm');
  return parts.join(' ');
}

function ensureReminderTrigger() {
  if (typeof ScriptApp === 'undefined') {
    return;
  }
  var props = PropertiesService.getUserProperties();
  var intervalData = getAggregateReminderInterval(props);
  var fastActive = intervalData.fastActive;
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'sendReminder') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  if (!fastActive || !intervalData.interval || intervalData.interval <= 0) {
    return;
  }
  var builder = ScriptApp.newTrigger('sendReminder').timeBased();
  var interval = intervalData.interval;
  if (interval <= 60) {
    builder.everyMinutes(Math.max(1, interval));
  } else {
    builder.everyHours(Math.max(1, Math.round(interval / 60)));
  }
  builder.create();
}

function getProgressTargetHours(timeline) {
  if (!timeline || timeline.length === 0) {
    return PROGRESS_TARGET_HOURS;
  }
  var max = 0;
  for (var i = 0; i < timeline.length; i++) {
    var phase = timeline[i];
    if (phase.endHours !== null && phase.endHours > max) {
      max = phase.endHours;
    }
  }
  if (max === 0) {
    max = PROGRESS_TARGET_HOURS;
  }
  return max;
}

function getManifestContent() {
  try {
    return HtmlService.createTemplateFromFile('manifest').getRawContent();
  } catch (error) {
    return MANIFEST_FALLBACK;
  }
}

function getServiceWorkerContent() {
  try {
    return HtmlService.createTemplateFromFile('service-worker').getRawContent();
  } catch (error) {
    return SERVICE_WORKER_FALLBACK;
  }
}

function sendReminder() {
  var props = PropertiesService.getUserProperties();
  var sessionIds = listSessionIds(props);
  if (!sessionIds.length) {
    return 'No sessions registered.';
  }
  var store = loadUserStore();
  var now = new Date();
  var nowMs = now.getTime();
  var hour = now.getHours();
  var wakingHours = hour >= 5 && hour < 21;
  var sentCount = 0;
  for (var i = 0; i < sessionIds.length; i++) {
    var sessionId = sessionIds[i];
    var normalizedEmail = lookupSessionOwner(store, sessionId);
    if (!normalizedEmail) {
      continue;
    }
    var user = store.users[normalizedEmail];
    if (!user) {
      continue;
    }
    var deviceInfo = findDeviceBySession(user, sessionId);
    if (!deviceInfo) {
      continue;
    }
    var startValue = getSessionProperty(props, sessionId, PROPERTY_KEYS.fastStart);
    if (!startValue) {
      continue;
    }
    var intervalValue = getSessionProperty(props, sessionId, PROPERTY_KEYS.reminderInterval);
    var interval = intervalValue ? parseInt(intervalValue, 10) : DEFAULT_REMINDER_MINUTES;
    if (!interval || interval <= 0) {
      continue;
    }
    var lastDrinkValue = getSessionProperty(props, sessionId, PROPERTY_KEYS.lastDrink);
    var lastDrink = lastDrinkValue ? parseInt(lastDrinkValue, 10) : parseInt(startValue, 10);
    var lastReminderValue = getSessionProperty(props, sessionId, PROPERTY_KEYS.lastReminder);
    var lastReminder = lastReminderValue ? parseInt(lastReminderValue, 10) : 0;
    var intervalMillis = interval * 60000;
    if (nowMs - lastDrink < intervalMillis && nowMs - lastReminder < intervalMillis) {
      continue;
    }
    if (!wakingHours) {
      continue;
    }
    var targetEmail = user.email || normalizedEmail;
    if (targetEmail) {
      var fastingMinutes = Math.floor((nowMs - parseInt(startValue, 10)) / 60000);
      var emailBody = 'Time to drink water with electrolytes! You\'ve been fasting for ' +
        formatDuration(fastingMinutes) + '. Keep going—you are doing great.';
      try {
        MailApp.sendEmail({
          to: targetEmail,
          subject: 'HydraFast Hydration Reminder',
          body: emailBody
        });
      } catch (err) {
        // Ignore email failures to prevent trigger errors.
      }
    }
    setSessionProperty(props, sessionId, PROPERTY_KEYS.lastReminder, nowMs.toString());
    sentCount++;
  }
  if (sentCount === 0) {
    return wakingHours ? 'Hydration up to date.' : 'Outside waking hours.';
  }
  return 'Reminders sent: ' + sentCount;
}
