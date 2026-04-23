/**
 * ═══════════════════════════════════════════════════════════════════════
 * VEDANTU BOOSTER · CLM ORCHESTRATION
 * Google Apps Script — drives the entire 3-day funnel
 * ═══════════════════════════════════════════════════════════════════════
 *
 * What this does:
 *   1. Reads the Master sheet (Metabase-fed)
 *   2. Decides which WATI template should fire (auto-selector)
 *   3. Dispatches WhatsApp messages via WATI API
 *   4. Sends Vedantu-orange performance emails via Gmail API
 *   5. Computes lead scores nightly & assigns tiers
 *   6. Writes chosen_template + dispatch log back to sheet
 *   7. Handles WATI webhook for intent capture button replies
 *
 * Deploy:
 *   1. Paste into a Google Apps Script project bound to the Master sheet
 *   2. Fill CONFIG below with your WATI token, sheet IDs, counsellor list
 *   3. Run `setupTriggers()` once to install time-driven triggers
 *   4. Deploy as Web App (execute as: me, access: anyone) for WATI webhook
 */

// ═══════════════════════════════════════════════════════════════════════
// 1. CONFIG — fill these in
// ═══════════════════════════════════════════════════════════════════════

const CONFIG = {
  // Sheet tabs inside the Master spreadsheet
  SHEETS: {
    STUDENTS:     'Students',
    EVENTS:       'Events',
    DISPATCH_LOG: 'Dispatch_Log',
    SCORES:       'Scores',
    COHORTS:      'Cohorts',
    COUNSELLORS:  'Counsellors',
  },

  // WATI live server · get token from WATI dashboard → Settings → API
  WATI: {
    BASE_URL: 'https://live-server.wati.io',
    TOKEN:    PropertiesService.getScriptProperties().getProperty('WATI_TOKEN') || 'REPLACE_ME',
  },

  // Email sender
  EMAIL: {
    FROM_NAME:    'Vedantu Booster',
    FROM_ADDRESS: 'booster@vedantu.com',
  },

  // Region → regional welcome poster URL (T01_WELCOME header_image variable)
  REGION_POSTERS: {
    TG: 'https://cdn.vedantu.com/boosters/poster_telangana.jpg',
    AP: 'https://cdn.vedantu.com/boosters/poster_andhra.jpg',
    TN: 'https://cdn.vedantu.com/boosters/poster_tamilnadu.jpg',
    MH: 'https://cdn.vedantu.com/boosters/poster_maharashtra.jpg',
    PB: 'https://cdn.vedantu.com/boosters/poster_patiala.jpg',
  },

  // Lead scoring weights (must sum to 1.0)
  WEIGHTS: {
    ATTENDANCE:  0.60,
    HOMEWORK:    0.30,
    WA_READ:     0.10,
  },

  // Tier thresholds (score → tier)
  TIERS: [
    { min: 0.85, tier: 'hot',    label: 'Hot'       },
    { min: 0.55, tier: 'warm75', label: 'Warm-75'   },
    { min: 0.30, tier: 'warm50', label: 'Warm-50'   },
    { min: 0.00, tier: 'd1ns',   label: 'D1-NoShow' },
  ],
};

// ═══════════════════════════════════════════════════════════════════════
// 2. TEMPLATE REGISTRY — 16 WATI templates + metadata
// ═══════════════════════════════════════════════════════════════════════

const TEMPLATES = {
  T01_WELCOME:            { channel: 'WA', waName: 't01_welcome_regional', regional: true  },
  T02_REMINDER_T24H:      { channel: 'WA', waName: 't02_reminder_t24h'                       },
  T03_REMINDER_T3H:       { channel: 'WA', waName: 't03_reminder_t3h'                        },
  T04_JOIN_NOW:           { channel: 'WA', waName: 't04_join_now_cta'                        },
  T05_POST_SUMMARY:       { channel: 'WA', waName: 't05_post_summary'                        },
  T06_HW_ASSIGNED:        { channel: 'WA', waName: 't06_hw_assigned'                         },
  T07_HW_REMINDER:        { channel: 'WA', waName: 't07_hw_reminder'                         },
  T08_PERF_HIGH:          { channel: 'WA', waName: 't08_perf_high'                           },
  T09_PERF_LOW:           { channel: 'WA', waName: 't09_perf_low'                            },
  T10_HYPE_VIDEO:         { channel: 'WA', waName: 't10_hype_video'                          },
  T11_CURIOSITY_HOOK:     { channel: 'WA', waName: 't11_curiosity_hook'                      },
  T12_D3_SUMMARY:         { channel: 'WA', waName: 't12_d3_summary'                          },
  T13_INTENT_CAPTURE:     { channel: 'WA', waName: 't13_intent_capture', hasButtons: true    },
  T14_COUNSELLOR_CONNECT: { channel: 'WA', waName: 't14_counsellor_connect'                  },
  T15_NURTURE_SOFT:       { channel: 'WA', waName: 't15_nurture_soft'                        },
  T16_D1_NOSHOW:          { channel: 'WA', waName: 't16_d1_noshow'                           },

  EMAIL_D1:    { channel: 'EMAIL', subject: 'Your Day 1 Booster · Scorecard inside 📊'   },
  EMAIL_D2:    { channel: 'EMAIL', subject: 'Day 2 done · You\'re 2/3 of the way there 💪' },
  EMAIL_FINAL: { channel: 'EMAIL', subject: 'Your complete Booster journey report is here' },
};

// ═══════════════════════════════════════════════════════════════════════
// 3. AUTO-SELECTOR — decide which template fires next
// Given phase + student state, returns template_id or null
// ═══════════════════════════════════════════════════════════════════════

function pickTemplate(phase, student) {
  const {
    d1_attended, d2_attended, d3_attended,
    hw_d1_submitted, hw_d2_submitted,
    intent_reply,
  } = student;

  switch (phase) {
    case 'pre_d3':         return 'T10_HYPE_VIDEO';
    case 'pre_d1':         return 'T11_CURIOSITY_HOOK';
    case 'enroll':         return 'T01_WELCOME';
    case 't24h':           return 'T02_REMINDER_T24H';
    case 't3h':            return 'T03_REMINDER_T3H';
    case 't30m':           return 'T04_JOIN_NOW';

    case 'post_class_d1':  return d1_attended ? 'T05_POST_SUMMARY' : null;
    case 'hw_assigned_d1': return d1_attended ? 'T06_HW_ASSIGNED' : null;
    case 'hw_remind_d1':   return (d1_attended && !hw_d1_submitted) ? 'T07_HW_REMINDER' : null;
    case 'eve_d1':
      if (!d1_attended) return 'T16_D1_NOSHOW';
      return (d1_attended && hw_d1_submitted) ? 'T08_PERF_HIGH' : 'T09_PERF_LOW';

    case 'post_class_d2':  return d2_attended ? 'T05_POST_SUMMARY' : null;
    case 'hw_assigned_d2': return d2_attended ? 'T06_HW_ASSIGNED' : null;
    case 'hw_remind_d2':   return (d2_attended && !hw_d2_submitted) ? 'T07_HW_REMINDER' : null;
    case 'eve_d2':
      return (d2_attended && hw_d2_submitted) ? 'T08_PERF_HIGH' : 'T09_PERF_LOW';

    case 'post_class_d3':  return d3_attended ? 'T05_POST_SUMMARY' : null;
    case 'end_d3':         return 'T12_D3_SUMMARY';

    case 'intent_d3_plus1':
      return 'T13_INTENT_CAPTURE';
    case 'after_intent':
      if (intent_reply === 'YES') return 'T14_COUNSELLOR_CONNECT';
      if (intent_reply === 'NO' || !intent_reply) return 'T15_NURTURE_SOFT';
      return null;

    // Emails
    case 'email_d1':    return d1_attended ? 'EMAIL_D1' : null;
    case 'email_d2':    return d2_attended ? 'EMAIL_D2' : null;
    case 'email_final': return 'EMAIL_FINAL';

    default: return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 4. SHEET HELPERS
// ═══════════════════════════════════════════════════════════════════════

function getSheet(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss.getSheetByName(name);
}

function getStudents(batchId) {
  const sh = getSheet(CONFIG.SHEETS.STUDENTS);
  const rows = sh.getDataRange().getValues();
  const header = rows.shift();
  const colIdx = Object.fromEntries(header.map((h, i) => [h, i]));

  return rows
    .map((r, idx) => ({
      _rowIndex:         idx + 2,  // 1-based + header row
      student_id:        r[colIdx.student_id],
      first_name:        r[colIdx.first_name],
      last_name:         r[colIdx.last_name],
      phone:             r[colIdx.phone],
      email:             r[colIdx.email],
      region:            r[colIdx.region],
      class:             r[colIdx.class],
      batch_id:          r[colIdx.batch_id],
      enrolled_at:       r[colIdx.enrolled_at],
      d1_attended:       !!r[colIdx.d1_attended],
      d2_attended:       !!r[colIdx.d2_attended],
      d3_attended:       !!r[colIdx.d3_attended],
      hw_d1_submitted:   !!r[colIdx.hw_d1_submitted],
      hw_d2_submitted:   !!r[colIdx.hw_d2_submitted],
      wa_msgs_sent:      r[colIdx.wa_msgs_sent] || 0,
      wa_msgs_read:      r[colIdx.wa_msgs_read] || 0,
      intent_reply:      r[colIdx.intent_reply] || '',
      chosen_template:   r[colIdx.chosen_template] || '',
    }))
    .filter(s => !batchId || s.batch_id === batchId);
}

function updateStudentCells(rowIndex, updates) {
  const sh = getSheet(CONFIG.SHEETS.STUDENTS);
  const header = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const colIdx = Object.fromEntries(header.map((h, i) => [h, i + 1]));

  Object.entries(updates).forEach(([k, v]) => {
    if (colIdx[k]) sh.getRange(rowIndex, colIdx[k]).setValue(v);
  });
}

function logDispatch(studentId, templateId, channel, status, extra) {
  const sh = getSheet(CONFIG.SHEETS.DISPATCH_LOG);
  sh.appendRow([
    new Date(),
    studentId,
    templateId,
    channel,
    status,
    extra?.wati_message_id || '',
    extra?.error || '',
  ]);
}

function getCohort(batchId) {
  const sh = getSheet(CONFIG.SHEETS.COHORTS);
  const rows = sh.getDataRange().getValues();
  const header = rows.shift();
  const colIdx = Object.fromEntries(header.map((h, i) => [h, i]));
  const row = rows.find(r => r[colIdx.cohort_id] === batchId);
  if (!row) return null;
  return {
    cohort_id:  row[colIdx.cohort_id],
    start_date: row[colIdx.start_date],
    d1_time:    row[colIdx.d1_time],
    d2_time:    row[colIdx.d2_time],
    d3_time:    row[colIdx.d3_time],
    d1_topic:   row[colIdx.d1_topic],
    d2_topic:   row[colIdx.d2_topic],
    d3_topic:   row[colIdx.d3_topic],
    teacher:    row[colIdx.teacher_name],
  };
}

function getCounsellorForRegion(region) {
  const sh = getSheet(CONFIG.SHEETS.COUNSELLORS);
  const rows = sh.getDataRange().getValues();
  const header = rows.shift();
  const colIdx = Object.fromEntries(header.map((h, i) => [h, i]));
  const match = rows.find(r => r[colIdx.region] === region && r[colIdx.active]);
  if (!match) return null;
  return {
    name:  match[colIdx.name],
    phone: match[colIdx.phone],
  };
}

// ═══════════════════════════════════════════════════════════════════════
// 5. WATI DISPATCH
// ═══════════════════════════════════════════════════════════════════════

function dispatchWati(student, templateId, varsMap) {
  const t = TEMPLATES[templateId];
  if (!t || t.channel !== 'WA') throw new Error(`Invalid WA template: ${templateId}`);

  const parameters = Object.entries(varsMap).map(([name, value]) => ({
    name:  String(name),
    value: String(value),
  }));

  const payload = {
    whatsappNumber: String(student.phone).replace(/[^0-9]/g, ''),
    template_name:  t.waName,
    broadcast_name: `${student.batch_id.toLowerCase()}_${templateId.toLowerCase()}`,
    parameters,
  };

  const url = `${CONFIG.WATI.BASE_URL}/api/v1/sendTemplateMessage?whatsappNumber=${payload.whatsappNumber}`;
  const response = UrlFetchApp.fetch(url, {
    method:             'post',
    contentType:        'application/json',
    headers:            { Authorization: `Bearer ${CONFIG.WATI.TOKEN}` },
    payload:            JSON.stringify(payload),
    muteHttpExceptions: true,
  });

  const code = response.getResponseCode();
  const body = JSON.parse(response.getContentText() || '{}');

  if (code >= 200 && code < 300 && body.result !== false) {
    logDispatch(student.student_id, templateId, 'WA', 'SENT', {
      wati_message_id: body?.messageInfo?.id || '',
    });
    updateStudentCells(student._rowIndex, {
      chosen_template:   templateId,
      last_dispatch_at:  new Date(),
      wa_msgs_sent:      (student.wa_msgs_sent || 0) + 1,
    });
    return { ok: true, id: body?.messageInfo?.id };
  } else {
    logDispatch(student.student_id, templateId, 'WA', 'FAILED', {
      error: `HTTP ${code}: ${response.getContentText()}`,
    });
    return { ok: false, error: response.getContentText() };
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 6. VARIABLE BUILDERS — per template, resolve variables from student+cohort
// ═══════════════════════════════════════════════════════════════════════

function buildVariables(templateId, student, cohort) {
  const firstName = student.first_name || 'there';
  const base = { first_name: firstName };

  switch (templateId) {
    case 'T01_WELCOME':
      return {
        ...base,
        batch_id:     student.batch_id,
        day1_date:    Utilities.formatDate(cohort.start_date, Session.getScriptTimeZone(), 'MMM d'),
        day1_time:    cohort.d1_time,
        day1_topic:   cohort.d1_topic,
        day2_date:    Utilities.formatDate(new Date(cohort.start_date.getTime() + 86400000), Session.getScriptTimeZone(), 'MMM d'),
        day2_time:    cohort.d2_time,
        day2_topic:   cohort.d2_topic,
        day3_date:    Utilities.formatDate(new Date(cohort.start_date.getTime() + 2*86400000), Session.getScriptTimeZone(), 'MMM d'),
        day3_time:    cohort.d3_time,
        day3_topic:   cohort.d3_topic,
        teacher_name: cohort.teacher,
        phone:        student.phone,
        email:        student.email,
        header_image: CONFIG.REGION_POSTERS[student.region] || CONFIG.REGION_POSTERS.TG,
      };

    case 'T02_REMINDER_T24H':
      return { ...base, day_label: 'Day 1', class_time: cohort.d1_time, teacher_name: cohort.teacher, topic: cohort.d1_topic, n_days_topic_preview: '1-line teaser' };

    case 'T04_JOIN_NOW':
      return { ...base, class_time: cohort.d1_time, join_link: `ved.app/j/${student.batch_id}D1`, teacher_name: cohort.teacher };

    case 'T05_POST_SUMMARY':
      return { ...base, day_label: 'Day 1', topic: cohort.d1_topic, key_takeaway_1: '…', key_takeaway_2: '…', key_takeaway_3: '…', feedback_link: `ved.app/fb/${student.batch_id}D1` };

    case 'T08_PERF_HIGH': {
      const attn = [student.d1_attended, student.d2_attended, student.d3_attended].filter(Boolean).length;
      const hw   = [student.hw_d1_submitted, student.hw_d2_submitted].filter(Boolean).length;
      return { ...base, attn_score: Math.round(attn/3*100), hw_score: Math.round(hw/2*100), day_num: '1', rank_in_batch: '8' };
    }

    case 'T09_PERF_LOW':
      return { ...base, missed: !student.d1_attended ? 'missed class' : 'skipped homework', day_num: '1', confirm_link: 'ved.app/confirm' };

    case 'T12_D3_SUMMARY': {
      const attn = [student.d1_attended, student.d2_attended, student.d3_attended].filter(Boolean).length;
      const hw   = [student.hw_d1_submitted, student.hw_d2_submitted].filter(Boolean).length;
      const read = student.wa_msgs_sent ? student.wa_msgs_read / student.wa_msgs_sent : 0;
      const score = Math.round((CONFIG.WEIGHTS.ATTENDANCE*(attn/3) + CONFIG.WEIGHTS.HOMEWORK*(hw/2) + CONFIG.WEIGHTS.WA_READ*read) * 100);
      return { ...base, attn_total: attn, hw_total: hw, overall_score: score,
               learning_outcome: 'Full Physics foundation — Rotational Mechanics, Gravitation, Oscillations',
               performance_report_link: `ved.app/report/${student.batch_id}/${student.student_id}` };
    }

    case 'T14_COUNSELLOR_CONNECT': {
      const c = getCounsellorForRegion(student.region) || { name: 'Ankita Sharma', phone: '+91 8X-XXXX-XXXX' };
      return { ...base, counsellor_name: c.name, counsellor_phone: c.phone, call_window: '4 PM – 7 PM today' };
    }

    default:
      return base;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 7. FIRE A TEMPLATE — top-level dispatch (reads, picks, sends, logs)
// ═══════════════════════════════════════════════════════════════════════

function fireForCohort(batchId, phase) {
  const cohort = getCohort(batchId);
  if (!cohort) { console.log(`No cohort: ${batchId}`); return; }

  const students = getStudents(batchId);
  console.log(`Phase: ${phase} · ${students.length} students`);

  let sent = 0, skipped = 0, failed = 0;

  students.forEach(s => {
    const templateId = pickTemplate(phase, s);
    if (!templateId) { skipped++; return; }

    const t = TEMPLATES[templateId];

    if (t.channel === 'WA') {
      const vars = buildVariables(templateId, s, cohort);
      const result = dispatchWati(s, templateId, vars);
      result.ok ? sent++ : failed++;
    } else if (t.channel === 'EMAIL') {
      const result = dispatchEmail(s, templateId, cohort);
      result.ok ? sent++ : failed++;
    }

    Utilities.sleep(150);  // throttle
  });

  console.log(`${phase} · sent=${sent}, skipped=${skipped}, failed=${failed}`);
  return { sent, skipped, failed };
}

// ═══════════════════════════════════════════════════════════════════════
// 8. EMAIL DISPATCH (Vedantu orange theme)
// ═══════════════════════════════════════════════════════════════════════

function dispatchEmail(student, templateId, cohort) {
  const t = TEMPLATES[templateId];
  if (!t || t.channel !== 'EMAIL') throw new Error(`Invalid email template: ${templateId}`);

  try {
    const html = renderEmailHtml(templateId, student, cohort);
    const subject = t.subject;

    GmailApp.sendEmail(student.email, subject, '', {
      name:        CONFIG.EMAIL.FROM_NAME,
      from:        CONFIG.EMAIL.FROM_ADDRESS,
      htmlBody:    html,
      attachments: [],
    });

    logDispatch(student.student_id, templateId, 'EMAIL', 'SENT');
    updateStudentCells(student._rowIndex, {
      chosen_template:   templateId,
      last_dispatch_at:  new Date(),
    });
    return { ok: true };
  } catch (err) {
    logDispatch(student.student_id, templateId, 'EMAIL', 'FAILED', { error: err.toString() });
    return { ok: false, error: err.toString() };
  }
}

function renderEmailHtml(templateId, student, cohort) {
  const attnN = [student.d1_attended, student.d2_attended, student.d3_attended].filter(Boolean).length;
  const hwN   = [student.hw_d1_submitted, student.hw_d2_submitted].filter(Boolean).length;
  const readPct = student.wa_msgs_sent ? Math.round((student.wa_msgs_read / student.wa_msgs_sent) * 100) : 0;

  if (templateId === 'EMAIL_D1') return emailDailyHtml(student, 1, cohort);
  if (templateId === 'EMAIL_D2') return emailDailyHtml(student, 2, cohort);
  if (templateId === 'EMAIL_FINAL') return emailFinalHtml(student, cohort, attnN, hwN, readPct);

  return `<p>Template ${templateId} not found.</p>`;
}

function emailDailyHtml(student, day, cohort) {
  // Same structure as email-preview.html (Vedantu orange).
  // In production: store the full template as an HTML file in the Apps Script
  // project and load it with HtmlService, injecting vars via <?= ?>
  const topic = day === 1 ? cohort.d1_topic : cohort.d2_topic;
  const attn = day === 1 ? (student.d1_attended ? 100 : 0) : Math.round(([student.d1_attended,student.d2_attended].filter(Boolean).length/2)*100);
  const hw   = day === 1 ? (student.hw_d1_submitted ? 100 : 0) : Math.round(([student.hw_d1_submitted,student.hw_d2_submitted].filter(Boolean).length/2)*100);

  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f6f8fc;font-family:-apple-system,Roboto,Arial,sans-serif">
    <div style="max-width:600px;margin:20px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 14px rgba(0,0,0,.08)">
      <div style="background:linear-gradient(135deg,#FF6B1A,#FFB547);padding:34px;color:#fff">
        <div style="font-size:11px;letter-spacing:.25em;font-weight:700;margin-bottom:18px">VEDANTU · BOOSTER</div>
        <div style="font-size:26px;font-weight:700;line-height:1.2">Day ${day} Scorecard · ${student.first_name} 🎯</div>
        <div style="font-size:14px;margin-top:6px;opacity:.95">Attendance · Homework · What you learned</div>
      </div>
      <div style="padding:30px">
        <p style="font-size:15px;color:#495066;line-height:1.65">Hi <strong>${student.first_name}</strong>,</p>
        <p style="font-size:14.5px;color:#495066;line-height:1.65">Day ${day} of your Booster trial — <strong>${topic}</strong> — is done. Here's how it went.</p>
        <div style="margin:20px 0;background:#FFF4EB;border:1px solid #FFD9BC;border-radius:12px;padding:22px">
          <div style="font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#FF6B1A;margin-bottom:14px">📊 Day ${day} Scorecard</div>
          <table width="100%" cellpadding="0" cellspacing="10"><tr>
            <td style="text-align:center;background:#fff;padding:14px;border-radius:10px;border:1px solid #FFD9BC;width:33%">
              <div style="font-size:24px;font-weight:700;color:#FF6B1A">${attn}%</div>
              <div style="font-size:10px;color:#7a7e91;text-transform:uppercase;letter-spacing:.04em;margin-top:4px">Attendance</div>
            </td>
            <td style="text-align:center;background:#fff;padding:14px;border-radius:10px;border:1px solid #FFD9BC;width:33%">
              <div style="font-size:24px;font-weight:700;color:#FF6B1A">${hw}%</div>
              <div style="font-size:10px;color:#7a7e91;text-transform:uppercase;letter-spacing:.04em;margin-top:4px">Homework</div>
            </td>
            <td style="text-align:center;background:#fff;padding:14px;border-radius:10px;border:1px solid #FFD9BC;width:33%">
              <div style="font-size:15px;font-weight:700;color:#FF6B1A">Day ${day+1}</div>
              <div style="font-size:10px;color:#7a7e91;text-transform:uppercase;letter-spacing:.04em;margin-top:4px">Next up</div>
            </td>
          </tr></table>
        </div>
        <div style="text-align:center;margin:28px 0 14px">
          <a href="ved.app/j/${student.batch_id}D${day+1}" style="display:inline-block;padding:14px 30px;background:#FF6B1A;color:#fff;text-decoration:none;font-weight:700;border-radius:8px;font-size:14px">Set reminder for Day ${day+1} →</a>
        </div>
      </div>
      <div style="background:#fafbfd;padding:22px;text-align:center;color:#7a7e91;font-size:11.5px;border-top:1px solid #eef0f5">
        <div style="font-weight:700;letter-spacing:.2em;color:#FF6B1A;font-size:10px;margin-bottom:9px">VEDANTU</div>
        <a href="#" style="color:#FF6B1A">View on web</a> · <a href="#" style="color:#FF6B1A">Preferences</a> · <a href="#" style="color:#FF6B1A">Unsubscribe</a>
      </div>
    </div></body></html>`;
}

function emailFinalHtml(student, cohort, attnN, hwN, readPct) {
  const score = Math.round((CONFIG.WEIGHTS.ATTENDANCE*(attnN/3) + CONFIG.WEIGHTS.HOMEWORK*(hwN/2) + CONFIG.WEIGHTS.WA_READ*(readPct/100)) * 100);
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f6f8fc;font-family:-apple-system,Roboto,Arial,sans-serif">
    <div style="max-width:600px;margin:20px auto;background:#fff;border-radius:12px;overflow:hidden">
      <div style="background:linear-gradient(135deg,#FF6B1A,#FFB547);padding:36px;color:#fff;text-align:center">
        <div style="font-size:11px;letter-spacing:.25em;font-weight:700">VEDANTU · BOOSTER · FINAL REPORT</div>
        <div style="font-size:26px;font-weight:700;line-height:1.2;margin-top:14px">Your 3-day journey, ${student.first_name} ✨</div>
      </div>
      <div style="padding:30px;text-align:center">
        <div style="font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#FF6B1A;margin-bottom:8px">Overall Booster Score</div>
        <div style="font-size:56px;font-weight:800;color:#FF6B1A;line-height:1">${score}<span style="font-size:22px;color:#7a7e91">%</span></div>
        <div style="margin-top:18px;padding:22px;background:#fafbfd;border-radius:10px;text-align:left">
          <div style="font-size:13px;margin-bottom:10px"><strong>Day 1 · ${cohort.d1_topic}</strong> — ${student.d1_attended?'✓ Attended':'✗ Missed'} · HW ${student.hw_d1_submitted?'✓':'✗'}</div>
          <div style="font-size:13px;margin-bottom:10px"><strong>Day 2 · ${cohort.d2_topic}</strong> — ${student.d2_attended?'✓ Attended':'✗ Missed'} · HW ${student.hw_d2_submitted?'✓':'✗'}</div>
          <div style="font-size:13px"><strong>Day 3 · ${cohort.d3_topic}</strong> — ${student.d3_attended?'✓ Attended':'✗ Missed'}</div>
        </div>
        <a href="ved.app/report/${student.batch_id}/${student.student_id}" style="display:inline-block;margin-top:24px;padding:14px 30px;background:#FF6B1A;color:#fff;text-decoration:none;font-weight:700;border-radius:8px;font-size:14px">See full course →</a>
      </div>
      <div style="background:#fafbfd;padding:22px;text-align:center;color:#7a7e91;font-size:11.5px;border-top:1px solid #eef0f5">
        <div style="font-weight:700;letter-spacing:.2em;color:#FF6B1A;font-size:10px;margin-bottom:9px">VEDANTU</div>
        Thank you for spending 3 days with us.
      </div>
    </div></body></html>`;
}

// ═══════════════════════════════════════════════════════════════════════
// 9. NIGHTLY SCORING JOB
// ═══════════════════════════════════════════════════════════════════════

function runScoring() {
  const students = getStudents();
  const scoresSheet = getSheet(CONFIG.SHEETS.SCORES);

  // Clear previous scores (keep header)
  if (scoresSheet.getLastRow() > 1) {
    scoresSheet.getRange(2, 1, scoresSheet.getLastRow() - 1, scoresSheet.getLastColumn()).clearContent();
  }

  const scoreRows = students.map(s => {
    const attn = [s.d1_attended, s.d2_attended, s.d3_attended].filter(Boolean).length;
    const hw   = [s.hw_d1_submitted, s.hw_d2_submitted].filter(Boolean).length;
    const readRate = s.wa_msgs_sent ? s.wa_msgs_read / s.wa_msgs_sent : 0;

    const score = +(
      CONFIG.WEIGHTS.ATTENDANCE * (attn/3) +
      CONFIG.WEIGHTS.HOMEWORK   * (hw/2) +
      CONFIG.WEIGHTS.WA_READ    * readRate
    ).toFixed(4);

    const tier = CONFIG.TIERS.find(t => score >= t.min)?.tier || 'd1ns';

    const reason =
      tier === 'hot'    ? `${attn}/3 attn · ${hw}/2 HW · ${Math.round(readRate*100)}% read — FULL COHORT` :
      tier === 'warm75' ? `${attn}/3 attn (dropped D3) · ${hw}/2 HW · ${Math.round(readRate*100)}% read` :
      tier === 'warm50' ? `${attn}/3 attn (dropped D2) · ${hw}/2 HW · ${Math.round(readRate*100)}% read` :
                          `Did not attend any class · ${Math.round(readRate*100)}% read only`;

    return [
      s.student_id, s.batch_id,
      Math.round(attn/3*100),
      Math.round(hw/2*100),
      Math.round(readRate*100),
      score, tier, reason,
      new Date(),
    ];
  });

  if (scoreRows.length) {
    scoresSheet.getRange(2, 1, scoreRows.length, scoreRows[0].length).setValues(scoreRows);
  }
  console.log(`Scored ${scoreRows.length} students.`);
}

// ═══════════════════════════════════════════════════════════════════════
// 10. WATI WEBHOOK — intent capture button replies
// Deploy this script as Web App and register URL in WATI dashboard
// ═══════════════════════════════════════════════════════════════════════

function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);
    // WATI webhook payload typically contains: waId (phone), text, buttonText, eventType
    const phone = (payload.waId || '').replace(/[^0-9]/g, '');
    const button = payload.buttonText || payload.text || '';

    if (!phone) return okResponse();

    const students = getStudents();
    const s = students.find(x => String(x.phone).replace(/[^0-9]/g, '').endsWith(phone.slice(-10)));
    if (!s) return okResponse();

    // Determine intent
    let intent = '';
    if (/yes|interested/i.test(button))      intent = 'YES';
    else if (/not right now|no/i.test(button)) intent = 'NO';

    if (intent) {
      updateStudentCells(s._rowIndex, { intent_reply: intent, intent_reply_at: new Date() });

      // Immediate handoff if YES
      if (intent === 'YES') {
        const cohort = getCohort(s.batch_id);
        const vars = buildVariables('T14_COUNSELLOR_CONNECT', s, cohort);
        dispatchWati(s, 'T14_COUNSELLOR_CONNECT', vars);
      }
    }

    return okResponse();
  } catch (err) {
    console.error('Webhook error:', err);
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function okResponse() {
  return ContentService.createTextOutput(JSON.stringify({ ok: true }))
    .setMimeType(ContentService.MimeType.JSON);
}

// ═══════════════════════════════════════════════════════════════════════
// 11. TIME-DRIVEN TRIGGER SETUP
// Run once manually: setupTriggers()
// ═══════════════════════════════════════════════════════════════════════

function setupTriggers() {
  // Clear existing
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));

  // Hourly sweep — checks what's due for any active cohort
  ScriptApp.newTrigger('hourlySweep')
    .timeBased()
    .everyHours(1)
    .create();

  // Nightly scoring — 2 AM IST
  ScriptApp.newTrigger('runScoring')
    .timeBased()
    .atHour(2)
    .everyDays(1)
    .create();

  console.log('Triggers installed: hourlySweep (every hour), runScoring (daily 2 AM)');
}

function hourlySweep() {
  // Find all active cohorts (where any day 1/2/3 is within next 48h or past 48h)
  const cohortSheet = getSheet(CONFIG.SHEETS.COHORTS);
  const rows = cohortSheet.getDataRange().getValues();
  const header = rows.shift();
  const col = Object.fromEntries(header.map((h, i) => [h, i]));
  const now = new Date();

  rows.forEach(r => {
    const cohortId = r[col.cohort_id];
    const start = new Date(r[col.start_date]);
    const hoursFromStart = (now - start) / 3600000;

    // Determine which phase(s) to run based on time since cohort started
    const phase = detectPhase(hoursFromStart);
    if (phase) {
      try { fireForCohort(cohortId, phase); }
      catch (err) { console.error(`${cohortId} · ${phase} failed: ${err}`); }
    }
  });
}

/**
 * Maps elapsed hours since cohort D1 09:00 start → which phase should fire.
 * Phases are idempotent — each student row should track last_phase_fired
 * so a phase doesn't fire twice. (Extend the Students schema with that column.)
 */
function detectPhase(hoursFromStart) {
  // Pre-cohort (negative hours)
  if (hoursFromStart < -72 && hoursFromStart > -73) return 'pre_d3';
  if (hoursFromStart < -24 && hoursFromStart > -25) return 'pre_d1';

  // Day 0 evening (T-24h for Day 1)
  if (hoursFromStart > 9 && hoursFromStart < 10) return 't24h';  // welcome day + 9h

  // Day 1
  if (between(hoursFromStart, 30.5, 31.5)) return 't3h';           // T-3h before 6:30 PM D1
  if (between(hoursFromStart, 33,   33.5)) return 't30m';          // T-30m D1
  if (between(hoursFromStart, 35,   36))   return 'post_class_d1';
  if (between(hoursFromStart, 35.5, 36.5)) return 'hw_assigned_d1';
  if (between(hoursFromStart, 36,   37))   return 'eve_d1';
  if (between(hoursFromStart, 36.5, 37.5)) return 'email_d1';

  // Day 2 (+24h)
  if (between(hoursFromStart, 54, 55))     return 'hw_remind_d1';
  if (between(hoursFromStart, 54.5,55.5))  return 't3h';
  if (between(hoursFromStart, 57,  57.5))  return 't30m';
  if (between(hoursFromStart, 59,  60))    return 'post_class_d2';
  if (between(hoursFromStart, 59.5,60.5))  return 'hw_assigned_d2';
  if (between(hoursFromStart, 60,  61))    return 'eve_d2';
  if (between(hoursFromStart, 60.5,61.5))  return 'email_d2';

  // Day 3 (+48h)
  if (between(hoursFromStart, 78.5, 79.5)) return 't3h';
  if (between(hoursFromStart, 81,   81.5)) return 't30m';
  if (between(hoursFromStart, 83,   84))   return 'post_class_d3';
  if (between(hoursFromStart, 84,   85))   return 'end_d3';
  if (between(hoursFromStart, 84.5, 85.5)) return 'email_final';

  // D3 + 1 day (conversion)
  if (between(hoursFromStart, 105, 106))   return 'intent_d3_plus1';
  if (between(hoursFromStart, 108, 109))   return 'after_intent';

  return null;
}

function between(v, lo, hi) { return v >= lo && v < hi; }

// ═══════════════════════════════════════════════════════════════════════
// 12. MANUAL TRIGGER HELPERS (for testing from Apps Script editor)
// ═══════════════════════════════════════════════════════════════════════

function test_fireWelcome()     { fireForCohort('BOOSTER-APR-C17', 'enroll');     }
function test_fireJoinNow_D1()  { fireForCohort('BOOSTER-APR-C17', 't30m');       }
function test_firePerf_D1()     { fireForCohort('BOOSTER-APR-C17', 'eve_d1');     }
function test_fireD3Summary()   { fireForCohort('BOOSTER-APR-C17', 'end_d3');     }
function test_fireEmail_D1()    { fireForCohort('BOOSTER-APR-C17', 'email_d1');   }
function test_fireEmail_Final() { fireForCohort('BOOSTER-APR-C17', 'email_final');}
function test_runScoring()      { runScoring(); }

// ═══════════════════════════════════════════════════════════════════════
// 13. FIRST-TIME SETUP CHECKLIST (run these once, in order)
// ═══════════════════════════════════════════════════════════════════════
/*
  Step 1 — Store your WATI token securely:
    In Apps Script: Project Settings → Script Properties → add
      key: WATI_TOKEN · value: <your_wati_api_token>

  Step 2 — Create these sheet tabs in the Master spreadsheet:

    Students:
      student_id | first_name | last_name | phone | email | region | class |
      batch_id | enrolled_at | d1_attended | d2_attended | d3_attended |
      hw_d1_submitted | hw_d2_submitted | wa_msgs_sent | wa_msgs_read |
      intent_reply | intent_reply_at | chosen_template | last_dispatch_at |
      last_phase_fired

    Events:
      ts | student_id | event_type | day | value

    Dispatch_Log:
      ts | student_id | template_id | channel | status | wati_message_id | error

    Scores:
      student_id | batch_id | attn_pct | hw_pct | read_pct | score | tier |
      handoff_reason | scored_at

    Cohorts:
      cohort_id | start_date | d1_time | d1_topic | d2_time | d2_topic |
      d3_time | d3_topic | teacher_name | active

    Counsellors:
      region | name | phone | active | max_load

  Step 3 — Seed Cohorts sheet with your first batch (BOOSTER-APR-C17).

  Step 4 — Seed Counsellors sheet (at least one counsellor per region).

  Step 5 — Run setupTriggers() once from the Apps Script editor.

  Step 6 — Deploy as Web App (Execute as: me, Who has access: anyone)
           and register the /exec URL as webhook in WATI dashboard.

  Step 7 — Verify with test_fireWelcome() on a test phone number.
*/
