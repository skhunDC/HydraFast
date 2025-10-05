var PROPERTY_KEYS = {
  fastStart: 'fastStart',
  lastDrink: 'lastDrink',
  reminderInterval: 'reminderInterval',
  lastReminder: 'lastReminder'
};

var DEFAULT_REMINDER_MINUTES = 120;
var MIN_REMINDER_MINUTES = 30;
var PROGRESS_TARGET_HOURS = 72;
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

function startFast() {
  var props = PropertiesService.getUserProperties();
  var now = new Date().getTime();
  props.setProperty(PROPERTY_KEYS.fastStart, now.toString());
  props.setProperty(PROPERTY_KEYS.lastDrink, now.toString());
  props.deleteProperty(PROPERTY_KEYS.lastReminder);
  ensureReminderTrigger();
  return getStatus();
}

function stopFast() {
  var props = PropertiesService.getUserProperties();
  props.deleteProperty(PROPERTY_KEYS.fastStart);
  props.deleteProperty(PROPERTY_KEYS.lastDrink);
  props.deleteProperty(PROPERTY_KEYS.lastReminder);
  ensureReminderTrigger();
  return getStatus();
}

function recordHydration() {
  var props = PropertiesService.getUserProperties();
  var now = new Date().getTime();
  props.setProperty(PROPERTY_KEYS.lastDrink, now.toString());
  props.deleteProperty(PROPERTY_KEYS.lastReminder);
  return getStatus();
}

function setReminderInterval(intervalMinutes) {
  var interval = parseInt(intervalMinutes, 10);
  if (isNaN(interval) || interval < MIN_REMINDER_MINUTES) {
    interval = DEFAULT_REMINDER_MINUTES;
  }
  var props = PropertiesService.getUserProperties();
  props.setProperty(PROPERTY_KEYS.reminderInterval, interval.toString());
  ensureReminderTrigger();
  return getStatus();
}

function getStatus() {
  var props = PropertiesService.getUserProperties();
  var now = new Date().getTime();
  var startValue = props.getProperty(PROPERTY_KEYS.fastStart);
  var startTimestamp = startValue ? parseInt(startValue, 10) : null;
  var elapsedMinutes = startTimestamp ? Math.max(0, Math.floor((now - startTimestamp) / 60000)) : 0;
  var elapsedHours = elapsedMinutes / 60;
  var timeline = getFastingTimeline();
  var phaseDetails = getPhaseDetailsFromHours(elapsedHours, timeline);
  var hydration = buildHydrationStatus(props, now, startTimestamp);
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
      key: 'long-term',
      title: 'Long-Term Benefits',
      range: '48h+',
      startHours: 48,
      endHours: null,
      description: 'Hormonal balance, immune support, and mental resilience continue to build.',
      focus: 'Assess how you feel each hour and hydrate with purpose.'
    }
  ];
}

function buildHydrationStatus(props, now, startTimestamp) {
  var lastDrinkValue = props.getProperty(PROPERTY_KEYS.lastDrink);
  var lastDrink = lastDrinkValue ? parseInt(lastDrinkValue, 10) : null;
  var intervalValue = props.getProperty(PROPERTY_KEYS.reminderInterval);
  var interval = intervalValue ? parseInt(intervalValue, 10) : DEFAULT_REMINDER_MINUTES;
  var lastReminderValue = props.getProperty(PROPERTY_KEYS.lastReminder);
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
  var intervalValue = props.getProperty(PROPERTY_KEYS.reminderInterval);
  var interval = intervalValue ? parseInt(intervalValue, 10) : DEFAULT_REMINDER_MINUTES;
  var fastActive = !!props.getProperty(PROPERTY_KEYS.fastStart);
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'sendReminder') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  if (!fastActive || !interval || interval <= 0) {
    return;
  }
  var builder = ScriptApp.newTrigger('sendReminder').timeBased();
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
  var startValue = props.getProperty(PROPERTY_KEYS.fastStart);
  if (!startValue) {
    return 'No active fast.';
  }
  var intervalValue = props.getProperty(PROPERTY_KEYS.reminderInterval);
  var interval = intervalValue ? parseInt(intervalValue, 10) : DEFAULT_REMINDER_MINUTES;
  if (!interval || interval <= 0) {
    return 'Reminders disabled.';
  }
  var now = new Date().getTime();
  var lastDrinkValue = props.getProperty(PROPERTY_KEYS.lastDrink);
  var lastDrink = lastDrinkValue ? parseInt(lastDrinkValue, 10) : parseInt(startValue, 10);
  var lastReminderValue = props.getProperty(PROPERTY_KEYS.lastReminder);
  var lastReminder = lastReminderValue ? parseInt(lastReminderValue, 10) : 0;
  var intervalMillis = interval * 60000;
  if (now - lastDrink < intervalMillis && now - lastReminder < intervalMillis) {
    return 'Hydration up to date.';
  }
  var email = '';
  if (typeof Session !== 'undefined' && Session.getActiveUser) {
    email = Session.getActiveUser().getEmail();
  }
  if (email) {
    var fastingMinutes = Math.floor((now - parseInt(startValue, 10)) / 60000);
    var emailBody = 'Time to drink water with electrolytes! You\'ve been fasting for ' +
      formatDuration(fastingMinutes) + '. Keep going—you are doing great.';
    MailApp.sendEmail({
      to: email,
      subject: 'HydraFast Hydration Reminder',
      body: emailBody
    });
  }
  props.setProperty(PROPERTY_KEYS.lastReminder, now.toString());
  return 'Reminder sent.';
}
