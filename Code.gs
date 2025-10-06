var PROPERTY_KEYS = {
  fastStart: 'fastStart',
  lastDrink: 'lastDrink',
  reminderInterval: 'reminderInterval',
  lastReminder: 'lastReminder'
};
var SESSION_INDEX_KEY = 'sessions:index';
var SESSION_PREFIX = 'session:';
var SESSION_ACTIVE_KEY = 'active';

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
  if (arguments.length === 1) {
    customTimestamp = sessionId;
    sessionId = null;
  }
  return applyFastStart(sessionId, customTimestamp);
}

function setFastStart(sessionId, customTimestamp) {
  if (arguments.length === 1) {
    customTimestamp = sessionId;
    sessionId = null;
  }
  return applyFastStart(sessionId, customTimestamp);
}

function applyFastStart(sessionId, customTimestamp) {
  var props = PropertiesService.getUserProperties();
  var now = new Date().getTime();
  var startTime = resolveStartTimestamp(customTimestamp, now);
  var resolvedSession = resolveSessionId(sessionId);
  persistFastStart(props, resolvedSession, startTime);
  ensureReminderTrigger();
  return getStatus(resolvedSession);
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
    sessionId = null;
  }
  var props = PropertiesService.getUserProperties();
  var resolvedSession = resolveSessionId(sessionId);
  deleteSessionProperty(props, resolvedSession, PROPERTY_KEYS.fastStart);
  deleteSessionProperty(props, resolvedSession, PROPERTY_KEYS.lastDrink);
  deleteSessionProperty(props, resolvedSession, PROPERTY_KEYS.lastReminder);
  markSessionInactive(props, resolvedSession);
  ensureReminderTrigger();
  return getStatus(resolvedSession);
}

function recordHydration(sessionId) {
  if (arguments.length === 0) {
    sessionId = null;
  }
  var props = PropertiesService.getUserProperties();
  var now = new Date().getTime();
  var resolvedSession = resolveSessionId(sessionId);
  setSessionProperty(props, resolvedSession, PROPERTY_KEYS.lastDrink, now.toString());
  deleteSessionProperty(props, resolvedSession, PROPERTY_KEYS.lastReminder);
  return getStatus(resolvedSession);
}

function setReminderInterval(sessionId, intervalMinutes) {
  if (arguments.length === 1) {
    intervalMinutes = sessionId;
    sessionId = null;
  }
  var interval = parseInt(intervalMinutes, 10);
  if (isNaN(interval) || interval < MIN_REMINDER_MINUTES) {
    interval = DEFAULT_REMINDER_MINUTES;
  }
  var props = PropertiesService.getUserProperties();
  var resolvedSession = resolveSessionId(sessionId);
  setSessionProperty(props, resolvedSession, PROPERTY_KEYS.reminderInterval, interval.toString());
  ensureReminderTrigger();
  return getStatus(resolvedSession);
}

function getStatus(sessionId) {
  if (arguments.length === 0) {
    sessionId = null;
  }
  var props = PropertiesService.getUserProperties();
  var resolvedSession = resolveSessionId(sessionId);
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
    hydration: hydration
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
  var now = new Date();
  var nowMs = now.getTime();
  var hour = now.getHours();
  var wakingHours = hour >= 5 && hour < 21;
  var email = '';
  if (typeof Session !== 'undefined' && Session.getActiveUser) {
    email = Session.getActiveUser().getEmail();
  }
  var sentCount = 0;
  for (var i = 0; i < sessionIds.length; i++) {
    var sessionId = sessionIds[i];
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
    if (email) {
      var fastingMinutes = Math.floor((nowMs - parseInt(startValue, 10)) / 60000);
      var emailBody = 'Time to drink water with electrolytes! You\'ve been fasting for ' +
        formatDuration(fastingMinutes) + '. Keep going—you are doing great.';
      MailApp.sendEmail({
        to: email,
        subject: 'HydraFast Hydration Reminder',
        body: emailBody
      });
    }
    setSessionProperty(props, sessionId, PROPERTY_KEYS.lastReminder, nowMs.toString());
    sentCount++;
  }
  if (sentCount === 0) {
    return wakingHours ? 'Hydration up to date.' : 'Outside waking hours.';
  }
  return 'Reminders sent: ' + sentCount;
}
