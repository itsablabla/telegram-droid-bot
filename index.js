const { Telegraf } = require('telegraf');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// 配置
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED_USERS = process.env.ALLOWED_USERS
  ? process.env.ALLOWED_USERS.split(',').map(id => parseInt(id.trim()))
  : null;
const DEFAULT_REMINDER_USER = process.env.DEFAULT_REMINDER_USER
  ? parseInt(process.env.DEFAULT_REMINDER_USER)
  : null;
const DROID_MODEL = process.env.DROID_MODEL || 'custom:minimax-m2.7';
const DROID_PATH = process.env.DROID_PATH || '/root/.local/bin/droid';
const DROID_CWD = process.env.DROID_CWD || '/root/Peter工作空间';
let DROID_TIMEOUT = parseInt(process.env.DROID_TIMEOUT) || 120000;

function parseGroupConfigs(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    const configs = {};
    for (const [chatId, cfg] of Object.entries(parsed)) {
      if (cfg && typeof cfg.cwd === 'string' && cfg.cwd.trim()) {
        configs[String(chatId)] = {
          cwd: cfg.cwd,
          label: typeof cfg.label === 'string' && cfg.label.trim() ? cfg.label : '群聊',
        };
      }
    }
    return configs;
  } catch (e) {
    console.error('[CONFIG] Failed to parse DROID_GROUP_CONFIGS:', e.message);
    return {};
  }
}

// 群聊配置: chatId -> { cwd, label }
const GROUP_CONFIGS = parseGroupConfigs(process.env.DROID_GROUP_CONFIGS);
const PRIVATE_CWD = process.env.DROID_PRIVATE_CWD || DROID_CWD;

const SESSION_FILE = path.join(__dirname, 'sessions.json');
const REMINDER_FILE = path.join(__dirname, 'reminders.json');

// 模型列表
const CUSTOM_MODELS = {
  'minimax': 'custom:minimax-m2.7',
  'glm4': 'custom:glm-4.7',
  'glm5': 'custom:glm-5.1',
  'xfyun': 'custom:astron-code-latest',
};
const BUILTIN_MODELS = {
  'claude-opus': 'claude-opus-4-6',
  'claude-opus-fast': 'claude-opus-4-6-fast',
  'claude-sonnet': 'claude-sonnet-4-6',
  'claude-haiku': 'claude-haiku-4-5-20251001',
  'gpt54': 'gpt-5.4',
  'gpt54-fast': 'gpt-5.4-fast',
  'gpt54-mini': 'gpt-5.4-mini',
  'gpt53-codex': 'gpt-5.3-codex',
  'gpt53-codex-fast': 'gpt-5.3-codex-fast',
  'gpt52': 'gpt-5.2',
  'gpt52-codex': 'gpt-5.2-codex',
  'gemini-pro': 'gemini-3.1-pro-preview',
  'gemini-flash': 'gemini-3-flash-preview',
  'glm5-builtin': 'glm-5.1',
  'kimi': 'kimi-k2.5',
  'minimax-builtin': 'minimax-m2.7',
};
const ALL_MODELS = { ...CUSTOM_MODELS, ...BUILTIN_MODELS };

const MODEL_REASONING = {
  'claude-opus-4-6': ['off','low','medium','high','max'],
  'claude-opus-4-6-fast': ['off','low','medium','high','max'],
  'claude-sonnet-4-6': ['off','low','medium','high','max'],
  'claude-haiku-4-5-20251001': ['off','low','medium','high'],
  'gpt-5.4': ['low','medium','high','xhigh'],
  'gpt-5.4-fast': ['low','medium','high','xhigh'],
  'gpt-5.4-mini': ['low','medium','high','xhigh'],
  'gpt-5.3-codex': ['low','medium','high','xhigh'],
  'gpt-5.3-codex-fast': ['low','medium','high','xhigh'],
  'gpt-5.2': ['off','low','medium','high','xhigh'],
  'gpt-5.2-codex': ['low','medium','high','xhigh'],
  'gemini-3.1-pro-preview': ['low','medium','high'],
  'gemini-3-flash-preview': ['minimal','low','medium','high'],
  'glm-5.1': [], 'kimi-k2.5': [], 'minimax-m2.7': ['high'],
  'custom:minimax-m2.7': ['high'], 'custom:glm-5.1': [], 'custom:glm-4.7': [], 'custom:astron-code-latest': [],
};

const DROID_ENV = {
  ...process.env,
  PATH: '/root/.local/bin:/usr/local/go/bin:/root/.nvm/versions/node/v22.22.0/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  HOME: '/root',
};
const HOME = process.env.HOME || '/root';

const bot = new Telegraf(TELEGRAM_BOT_TOKEN, { handlerTimeout: 0 }); // 0=无限，由 spawn DROID_TIMEOUT 统一控制
const userSessions = new Map();

// ==================== 上下文感知 ====================

function getSessionKey(userId, chatId) {
  return `${userId}_${chatId}`;
}

function isGroupChat(chatId) {
  const cid = String(chatId);
  return GROUP_CONFIGS[cid] !== undefined;
}

function getCwdForChat(chatId) {
  const cfg = GROUP_CONFIGS[String(chatId)];
  return cfg ? cfg.cwd : PRIVATE_CWD;
}

function getLabelForChat(chatId) {
  const cfg = GROUP_CONFIGS[String(chatId)];
  return cfg ? cfg.label : '工作';
}

// ==================== 持久化 ====================

function loadSessions() {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
      for (const [key, sess] of Object.entries(data)) {
        userSessions.set(key, {
          ...sess,
          processing: false,
          processingSince: null,
          currentProc: null,
          useSpec: sess.useSpec || false,
          useMission: sess.useMission || false,
          reasoning: sess.reasoning || null,
        });
      }
      console.log(`[SESSION] Loaded ${userSessions.size} session(s)`);
    }
  } catch (e) { console.error('[SESSION] Load failed:', e.message); }
}

function saveSessions() {
  try {
    const data = {};
    for (const [key, sess] of userSessions) {
      data[key] = {
        sessionId: sess.sessionId, model: sess.model, autoLevel: sess.autoLevel,
        useSpec: sess.useSpec, useMission: sess.useMission, reasoning: sess.reasoning,
      };
    }
    fs.writeFileSync(SESSION_FILE, JSON.stringify(data, null, 2));
  } catch (e) { console.error('[SESSION] Save failed:', e.message); }
}

function getUserSession(userId, chatId) {
  const key = getSessionKey(userId, chatId);
  if (!userSessions.has(key)) {
    userSessions.set(key, {
      sessionId: null, model: DROID_MODEL, autoLevel: 'high',
      processing: false, processingSince: null, useSpec: false, useMission: false, reasoning: null,
      currentProc: null,
    });
  }
  return userSessions.get(key);
}

// 检查 processing 是否真正卡死（区分正常长任务 vs 进程已死/僵尸）
function checkProcessingStuck(s) {
  if (!s.processing) return false;

  // 检查 droid 子进程是否还活着（signal 0 不发信号，只检查进程是否存在）
  const hasAliveProc = s.currentProc && s.currentProc.pid;
  let procAlive = false;
  if (hasAliveProc) {
    try { process.kill(s.currentProc.pid, 0); procAlive = true; } catch(e) {}
  }

  if (procAlive) {
    // 进程还活着 → 可能是正常长任务
    // 兜底：如果超过 3x DROID_TIMEOUT（spawn timeout + SIGKILL 都失效的极端情况），视为僵尸
    const zombieLimit = DROID_TIMEOUT * 3;
    if (s.processingSince && Date.now() - s.processingSince > zombieLimit) {
      console.log(`[STUCK] Process ${s.currentProc.pid} alive but exceeded 3x timeout (${zombieLimit/1000}s), force killing`);
      s.currentProc.kill('SIGKILL');
      s.currentProc = null;
      s.processing = false; s.processingSince = null;
      return true;
    }
    // 进程活着且未超 3x timeout → 正常长任务，不打断
    return false;
  }

  // 进程不存在（已死或 currentProc 为 null）→ processing 应该已被 finally 清掉
  // 如果还在 processing，说明 finally 没执行（Telegraf 旧 bug），需要手动重置
  const stuckLimit = DROID_TIMEOUT + 10000; // DROID_TIMEOUT + 10s 缓冲
  if (s.processingSince && Date.now() - s.processingSince > stuckLimit) {
    console.log(`[STUCK] Process dead but processing=true for ${Math.round((Date.now()-s.processingSince)/1000)}s, auto-resetting`);
    s.currentProc = null;
    s.processing = false; s.processingSince = null;
    return true;
  }

  return false;
}

loadSessions();

// ==================== 提醒功能 ====================

let reminders = [];

function loadReminders() {
  try {
    if (fs.existsSync(REMINDER_FILE)) {
      reminders = JSON.parse(fs.readFileSync(REMINDER_FILE, 'utf8'));
      console.log(`[REMINDER] Loaded ${reminders.length} reminder(s)`);
    }
  } catch (e) { console.error('[REMINDER] Load failed:', e.message); reminders = []; }
}
function saveReminders() {
  try {
    const tmp = REMINDER_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(reminders, null, 2));
    fs.renameSync(tmp, REMINDER_FILE);  // atomic rename，防止文件损坏
  } catch (e) { console.error('[REMINDER] Save failed:', e.message); }
}
function addReminder(chatId, time, text, type='once', exec=false, day=null) {
  const r = {
    id: Date.now().toString(36)+Math.random().toString(36).slice(2,6),
    chatId, time, text, type, exec, day, createdAt: Date.now(),
    lastFiredAt: null,
  };
  reminders.push(r); saveReminders(); return r;
}
function deleteReminder(id) {
  const i = reminders.findIndex(r => r.id === id);
  if (i !== -1) { reminders.splice(i, 1); saveReminders(); return true; }
  return false;
}
function getChatReminders(chatId) { return reminders.filter(r => r.chatId === chatId); }

// 辅助：格式化本地时间为 YYYY-MM-DD HH:MM
function localDateTimeStr(d) {
  const y=d.getFullYear(), m=String(d.getMonth()+1).padStart(2,'0'),
        dd=String(d.getDate()).padStart(2,'0'), h=String(d.getHours()).padStart(2,'0'),
        mn=String(d.getMinutes()).padStart(2,'0');
  return `${y}-${m}-${dd} ${h}:${mn}`;
}
function localDateStr(d) { return localDateTimeStr(d).slice(0,10); }
function localTimeStr(d) { return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`; }

// 辅助：解析 reminder 的目标触发时间为 Date 对象（本地时间）
function parseReminderTargetTime(r, now) {
  if (r.type==='daily' || r.type==='weekly' || r.type==='monthly') {
    const [h,mn] = r.time.split(':').map(Number);
    const t = new Date(now);
    t.setHours(h, mn, 0, 0);
    return t;
  }
  if (r.type==='once') {
    // r.time 格式: "YYYY-MM-DD HH:MM"
    const [datePart, timePart] = r.time.split(' ');
    if (!datePart || !timePart) return null;
    const [y,mo,d] = datePart.split('-').map(Number);
    const [h,mn] = timePart.split(':').map(Number);
    // 明确用本地时间构造 Date（不加时区偏移，由运行时环境决定）
    return new Date(y, mo-1, d, h, mn, 0);
  }
  return null;
}

// 辅助：判断周期类型是否已在本周期触发过
function alreadyFiredThisCycle(r, now) {
  if (!r.lastFiredAt) return false;
  const last = new Date(r.lastFiredAt);
  if (r.type==='daily') return localDateStr(last) === localDateStr(now);
  if (r.type==='weekly') {
    // 正确：比较同一年的同一周+同一星期几
    const getWeekStart = d => {
      const t = new Date(d);
      t.setHours(0,0,0,0);
      // 移回到周一
      const day = t.getDay();
      const diff = (day === 0 ? -6 : 1 - day);
      t.setDate(t.getDate() + diff);
      return t;
    };
    const lastWeek = getWeekStart(last);
    const nowWeek = getWeekStart(now);
    return lastWeek.getTime() === nowWeek.getTime() && last.getDay() === now.getDay();
  }
  if (r.type==='monthly') return localDateStr(last) === localDateStr(now);
  if (r.type==='once') return true;
  return false;
}

// 辅助：判断 exec 失败是否为可重试的临时错误
function isRetryableError(errMsg) {
  const s = (errMsg||'').toLowerCase();
  return s.includes('rate_limit') || s.includes('overloaded') || s.includes('network') ||
         s.includes('timeout') || s.includes('429') || s.includes('timed out') ||
         s.includes('econnreset') || s.includes('econnrefused') || s.includes('socket hang up');
}

const WINDOW_MS = 3*60*1000;  // 3分钟窗口容差
const EXPIRE_MS = 5*60*1000;  // 5分钟后过期清理

function checkDueReminders() {
  const now = new Date();
  const due = [];
  for (const r of reminders) {
    // 已在本周期触发过则跳过
    if (alreadyFiredThisCycle(r, now)) continue;

    // ---- 周期类型必须匹配日期：weekly 必须是指定星期几，monthly 必须是指定几号 ----
    if (r.type==='weekly' && now.getDay() !== r.day) continue;
    if (r.type==='monthly' && now.getDate() !== r.day) continue;

    const target = parseReminderTargetTime(r, now);
    if (!target) continue;

    const diff = now.getTime() - target.getTime();

    if (r.type==='once') {
      // once类型：窗口内触发 OR 窗口后但在过期前（补救漏检）
      if (diff >= 0 && diff < EXPIRE_MS) due.push(r);
    } else {
      // 周期类型：必须在3分钟窗口内
      if (diff >= 0 && diff < WINDOW_MS) due.push(r);
    }
  }
  return due;
}

// exec 任务重试队列（异步，不阻塞主循环）
const retryQueue = [];
let retryProcessing = false;

function scheduleRetry(chatId, text, errMsg, attempt, maxAttempts) {
  const delays = [30000, 60000, 120000]; // 30s, 60s, 120s
  if (attempt >= maxAttempts) {
    bot.telegram.sendMessage(chatId, `❌ 任务重试${maxAttempts}次仍失败: ${text}\n${errMsg.slice(0,200)}`).catch(()=>{});
    return;
  }
  retryQueue.push({ chatId, text, attempt: attempt+1, fireAt: Date.now() + delays[attempt] });
  console.log(`[RETRY] Scheduled retry #${attempt+1} for: ${text.slice(0,50)}`);
  if (!retryProcessing) processRetryQueue();
}

function processRetryQueue() {
  if (retryQueue.length === 0) { retryProcessing = false; return; }
  retryProcessing = true;
  const item = retryQueue[0];
  const wait = item.fireAt - Date.now();
  if (wait > 0) {
    setTimeout(() => processRetryQueue(), wait);
    return;
  }
  retryQueue.shift();
  const cwd = getCwdForChat(item.chatId);
  const tempSession = { sessionId:null, model:DROID_MODEL, autoLevel:'high', useSpec:false, useMission:false, reasoning:null };
  callDroid(item.text, tempSession, cwd).then(({stdout}) => {
    const parsed = parseDroidOutput(stdout);
    const result = parsed.text.length>4000 ? parsed.text.slice(0,4000)+'...' : parsed.text;
    bot.telegram.sendMessage(item.chatId, `✅ 重试成功 (#${item.attempt}): ${item.text}\n\n${result}`).catch(()=>{});
  }).catch(err => {
    const msg = err.message || '';
    if (isRetryableError(msg)) {
      scheduleRetry(item.chatId, item.text, msg, item.attempt, 3);
    } else {
      bot.telegram.sendMessage(item.chatId, `❌ 任务失败 (不可重试): ${item.text}\n${msg.slice(0,200)}`).catch(()=>{});
    }
  }).finally(() => processRetryQueue());
}

loadReminders();

let reminderProcessing = false;

setInterval(async () => {
  if (reminderProcessing) return; // 防并发
  reminderProcessing = true;
  try {
    // 从文件重载 reminders（remind-cli 可能已直接写文件更新）
    try { reminders = JSON.parse(fs.readFileSync(REMINDER_FILE, 'utf8')); } catch(e) {}

    // 1. 清理过期 once 提醒
    const now = new Date();
    const expiredIds = [];
    for (const r of reminders) {
      if (r.type==='once' && !r.lastFiredAt) {
        const target = parseReminderTargetTime(r, now);
        if (target && now.getTime() - target.getTime() > EXPIRE_MS) {
          expiredIds.push(r);
        }
      }
    }
    for (const r of expiredIds) {
      deleteReminder(r.id);
      try {
        await bot.telegram.sendMessage(r.chatId, `⏰ 提醒已过期: ${r.text}\n(设定时间: ${r.time})`);
      } catch(e) { console.error('[REMINDER] Expire notify failed:', e.message); }
    }

    // 2. 检查并触发到期提醒
    const dueReminders = checkDueReminders();
    if (dueReminders.length > 0) console.log(`[REMINDER] ${dueReminders.length} reminder(s) due`);
    for (const r of dueReminders) {
      const chatId = r.chatId;
      if (!chatId) continue;
      try {
        if (r.exec) {
          await bot.telegram.sendMessage(chatId, `⏰ 定时任务执行中: ${r.text}`);
          const cwd = getCwdForChat(chatId);
          const tempSession = { sessionId:null, model:DROID_MODEL, autoLevel:'high', useSpec:false, useMission:false, reasoning:null };
          try {
            const {stdout} = await callDroid(r.text, tempSession, cwd);
            const parsed = parseDroidOutput(stdout);
            const result = parsed.text.length>4000 ? parsed.text.slice(0,4000)+'...' : parsed.text;
            await bot.telegram.sendMessage(chatId, `✅ 任务完成: ${r.text}\n\n${result}`);
          } catch (err) {
            const msg = err.message || '';
            if (isRetryableError(msg)) {
              await bot.telegram.sendMessage(chatId, `⚠️ 任务失败，将自动重试: ${r.text}\n${msg.slice(0,200)}`);
              scheduleRetry(chatId, r.text, msg, 0, 3);
            } else {
              await bot.telegram.sendMessage(chatId, `❌ 任务失败: ${r.text}\n${msg.slice(0,300)}`);
            }
          }
        } else {
          await bot.telegram.sendMessage(chatId, `⏰ 提醒: ${r.text}`);
        }
      } catch (e) { console.error(`[REMINDER] Send failed:`, e.message); }
      // 标记已触发
      r.lastFiredAt = Date.now();
      if (r.type==='once') deleteReminder(r.id);
      else saveReminders();
    }
  } catch (e) { console.error('[REMINDER] Check error:', e.message); }
  finally { reminderProcessing = false; }
}, 60*1000);
console.log('[REMINDER] Checker started (every 60s)');

// ==================== Droid 调用 ====================

function isAllowed(userId) {
  if (!ALLOWED_USERS) return true;
  return ALLOWED_USERS.includes(userId);
}

function execDroid(prompt, session, cwd, useFork = false) {
  return new Promise((resolve, reject) => {
    const args = ['exec', '-m', session.model, '-o', 'json'];
    if (session.useMission) args.push('--auto', 'high');
    else args.push('--auto', session.autoLevel);
    if (session.useSpec) args.push('--use-spec');
    if (session.useMission) args.push('--mission');
    if (session.reasoning) args.push('-r', session.reasoning);
    if (useFork && session.sessionId) args.push('--fork', session.sessionId);
    else if (session.sessionId && !session.useSpec) args.push('-s', session.sessionId);
    // 用 -f 传 prompt 文件，避免多行/特殊字符被误解析为 CLI 参数
    const promptFile = path.join(os.tmpdir(), `droid_prompt_${Date.now()}.txt`);
    fs.writeFileSync(promptFile, prompt);
    args.push('-f', promptFile);
    console.log(`[DROID] ${DROID_PATH} ${args.join(' ')} (cwd: ${cwd})`);
    const proc = spawn(DROID_PATH, args, { cwd, env: DROID_ENV, timeout: DROID_TIMEOUT, maxBuffer: 1024*1024*10 });
    // 将进程引用存到 session 上，方便 /stop 命令杀进程
    session.currentProc = proc;
    let stdout='', stderr='', resolved=false;
    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => { stderr += d; });
    const cleanup = () => { session.currentProc = null; try { fs.unlinkSync(promptFile); } catch(e){} };
    proc.on('close', code => { if (resolved) return; resolved=true; cleanup(); resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }); });
    proc.on('error', err => { if (resolved) return; resolved=true; cleanup(); reject(err); });
    // spawn timeout 只发 SIGTERM，5秒后还没退出则 SIGKILL 强杀
    const killTimer = setTimeout(() => {
      if (!resolved && proc.pid) {
        console.log(`[DROID] Process ${proc.pid} still alive after SIGTERM, sending SIGKILL...`);
        proc.kill('SIGKILL');
      }
    }, DROID_TIMEOUT + 5000);
    proc.on('close', () => clearTimeout(killTimer));
  });
}

function isSessionCorrupted(stdout) {
  try {
    const j = JSON.parse(stdout);
    if (j.is_error) {
      const r = (j.result||'').toLowerCase();
      if (r.includes('byok error')||r.includes('403')||r.includes('forbidden')||r.includes('upstream error')||r.includes('insufficient permission')) return true;
    }
  } catch (e) {}
  // 也检查 stderr 中的关键错误
  const lower = (stdout||'').toLowerCase();
  if (lower.includes('insufficient permission') || lower.includes('exec ended early')) return true;
  return false;
}

async function callDroid(prompt, session, cwd) {
  let result = await execDroid(prompt, session, cwd);
  // 检测 session 损坏：code !==0 且有 session 且检测到错误
  // 新增：空输出 + code 1 也视为损坏（droid exec crash 无输出）
  const combinedOutput = (result.stdout||'') + '\n' + (result.stderr||'');
  const isEmptyCrash = result.code !== 0 && !result.stdout.trim() && !result.stderr.trim();
  if (result.code!==0 && session.sessionId && (isSessionCorrupted(combinedOutput) || isEmptyCrash)) {
    const oldId = session.sessionId;
    console.log(`[DROID] Session corrupted (${oldId}), forking...`);
    result = await execDroid(prompt, session, cwd, true);
    if (result.code===0) console.log(`[DROID] Fork OK (old: ${oldId})`);
    else if (isSessionCorrupted(result.stdout + '\n' + result.stderr) || (!result.stdout.trim() && !result.stderr.trim())) {
      console.log(`[DROID] Fork also failed, fresh session...`);
      session.sessionId=null; saveSessions();
      result = await execDroid(prompt, session, cwd);
    }
  }
  if (result.code===0 && !result.stdout.trim() && !result.stderr.trim()) {
    // code=0 但 stdout 完全空 → 重试一次
    console.log('[DROID] Empty output, retrying once...');
    result = await execDroid(prompt, session, cwd);
  }
  if (result.code===0) return { stdout: result.stdout, stderr: result.stderr };
  let msg;
  if (result.code === null) {
    msg = '⏱️ 执行超时（' + (DROID_TIMEOUT/1000) + '秒），任务太复杂或模型响应太慢。\n建议:\n  /timeout 300 — 增加超时\n  /model glm5 — 换更快的模型';
  } else {
    msg = result.stderr.trim() || `Process exited with code ${result.code}`;
    try { const j=JSON.parse(result.stdout); if (j.is_error&&j.result) msg=j.result.trim().slice(0,500); } catch(e) {}
  }
  throw new Error(msg);
}

function parseDroidOutput(raw) {
  try {
    const j = JSON.parse(raw);
    const c = (j.result||'').trim().replace(/<thought>[\s\S]*?<\/thought>/gi,'').replace(/<think[\s\S]*?<\/think>/gi,'').trim();
    return { text: c||'（Droid 没有返回内容）', sessionId: j.session_id||null, isError: j.is_error||false };
  } catch(e) {
    const c = raw.replace(/<thought>[\s\S]*?<\/thought>/gi,'').replace(/<think[\s\S]*?<\/think>/gi,'').trim();
    // 优先保留原始输出（strip 后可能只剩标签），只有真的完全空白才Fallback
    return { text: c||raw.trim()||'（Droid 没有返回内容）', sessionId: null, isError: false };
  }
}

// ==================== 命令 ====================

function cid(ctx) { return String(ctx.chat.id); }

bot.command('new', async ctx => {
  const uid=ctx.from.id; if (!isAllowed(uid)) return;
  getUserSession(uid, cid(ctx)).sessionId=null; saveSessions();
  const label = getLabelForChat(cid(ctx));
  await ctx.reply(`会话已清空 (${label})，开始新对话。`);
});

bot.command('model', async ctx => {
  const uid=ctx.from.id; if (!isAllowed(uid)) return;
  const s=getUserSession(uid, cid(ctx)), args=ctx.message.text.split(' ').slice(1);
  if (!args.length) {
    const cl=Object.entries(CUSTOM_MODELS).map(([k,v])=>`  ${k} ${v===s.model?'✅':''}`).join('\n');
    const bl=Object.entries(BUILTIN_MODELS).map(([k,v])=>`  ${k} ${v===s.model?'✅':''}`).join('\n');
    await ctx.reply(`当前: ${s.model} (${getLabelForChat(cid(ctx))})\n\n自定义:\n${cl}\n\n内置:\n${bl}\n\n用法: /model <名称>`);
    return;
  }
  const m=args[0].toLowerCase();
  if (ALL_MODELS[m]) {
    s.sessionId=null; s.model=ALL_MODELS[m]; saveSessions();
    await ctx.reply(`已切换: ${m} (${s.model})\n会话已清空。`);
  } else await ctx.reply(`未知: ${m}\n可用: ${Object.keys(ALL_MODELS).join(', ')}`);
});

bot.command('auto', async ctx => {
  const uid=ctx.from.id; if (!isAllowed(uid)) return;
  const s=getUserSession(uid, cid(ctx)), args=ctx.message.text.split(' ').slice(1);
  if (!args.length) { await ctx.reply(`当前: ${s.autoLevel}\n用法: /auto <low|medium|high>`); return; }
  const l=args[0].toLowerCase();
  if (['low','medium','high'].includes(l)) { s.autoLevel=l; await ctx.reply(`权限: ${l}`); }
  else await ctx.reply(`未知: ${l}`);
});

bot.command('session', async ctx => {
  const uid=ctx.from.id; if (!isAllowed(uid)) return;
  const s=getUserSession(uid, cid(ctx));
  await ctx.reply(
    `上下文: ${getLabelForChat(cid(ctx))}\n` +
    `Session: ${s.sessionId||'无'}\n` +
    `模型: ${s.model}\n权限: ${s.autoLevel}\n` +
    `Spec: ${s.useSpec?'开':'关'}\nMission: ${s.useMission?'开':'关'}\n` +
    `Reasoning: ${s.reasoning||'默认'}`
  );
});

bot.command('timeout', async ctx => {
  const uid=ctx.from.id; if (!isAllowed(uid)) return;
  const args=ctx.message.text.split(' ').slice(1);
  if (!args.length) { await ctx.reply(`当前: ${DROID_TIMEOUT/1000}秒\n用法: /timeout <10-600>`); return; }
  const sec=parseInt(args[0]);
  if (isNaN(sec)||sec<10||sec>600) { await ctx.reply('范围: 10-600秒'); return; }
  DROID_TIMEOUT=sec*1000; await ctx.reply(`超时: ${sec}秒`);
});

bot.command('tools', async ctx => {
  const uid=ctx.from.id; if (!isAllowed(uid)) return;
  const s=getUserSession(uid, cid(ctx));
  await ctx.reply('查询中...');
  try {
    const proc=spawn(DROID_PATH, ['exec','-m',s.model,'--auto',s.autoLevel,'--list-tools','-o','json'], {cwd:getCwdForChat(cid(ctx)),env:DROID_ENV,timeout:15000});
    let out=''; proc.stdout.on('data',d=>{out+=d}); proc.stderr.on('data',d=>{out+=d});
    proc.on('close', async ()=>{
      try {
        const tools=JSON.parse(out.trim());
        const lines=tools.map(t=>`${t.currentlyAllowed?'✅':'❌'} ${t.displayName}`);
        const allowed=tools.filter(t=>t.currentlyAllowed).length;
        await ctx.reply(`工具 (${allowed}/${tools.length}, 权限: ${s.autoLevel}):\n\n${lines.join('\n')}`);
      } catch(e) { await ctx.reply(out.trim().slice(0,4000)||'无法获取'); }
    });
  } catch(e) { await ctx.reply(`失败: ${e.message}`); }
});

bot.command('version', async ctx => {
  const uid=ctx.from.id; if (!isAllowed(uid)) return;
  try {
    const proc=spawn(DROID_PATH, ['--version'], {env:DROID_ENV,timeout:5000});
    let out=''; proc.stdout.on('data',d=>{out+=d}); proc.stderr.on('data',d=>{out+=d});
    proc.on('close', async ()=>{ await ctx.reply(`Droid CLI: ${out.trim()}`); });
  } catch(e) { await ctx.reply(`失败: ${e.message}`); }
});

bot.command('stop', async ctx => {
  const uid=ctx.from.id; if (!isAllowed(uid)) return;
  const s=getUserSession(uid, cid(ctx));
  if (!s.processing) { await ctx.reply('当前无任务。'); return; }
  // 杀掉 droid 子进程
  if (s.currentProc && s.currentProc.pid) {
    console.log(`[STOP] Killing droid process ${s.currentProc.pid}`);
    s.currentProc.kill('SIGKILL');
    s.currentProc = null;
  }
  s.processing=false; s.processingSince=null; s.currentProc=null; s.sessionId=null; saveSessions();
  await ctx.reply('已停止，会话已重置。');
});

bot.command('spec', async ctx => {
  const uid=ctx.from.id; if (!isAllowed(uid)) return;
  const s=getUserSession(uid, cid(ctx)), args=ctx.message.text.split(' ').slice(1);
  if (!args.length) { await ctx.reply(`Spec: ${s.useSpec?'✅ 开':'❌ 关'}\n用法: /spec on|off`); return; }
  const v=args[0].toLowerCase();
  if (v==='on') { s.useSpec=true; s.sessionId=null; saveSessions(); await ctx.reply('✅ Spec 已开启（会话已清空，spec 仅支持新会话）'); }
  else if (v==='off') { s.useSpec=false; saveSessions(); await ctx.reply('❌ Spec 已关闭'); }
  else await ctx.reply('用法: /spec on|off');
});

bot.command('mission', async ctx => {
  const uid=ctx.from.id; if (!isAllowed(uid)) return;
  const s=getUserSession(uid, cid(ctx)), args=ctx.message.text.split(' ').slice(1);
  if (!args.length) { await ctx.reply(`Mission: ${s.useMission?'✅ 开':'❌ 关'}\n用法: /mission on|off`); return; }
  const v=args[0].toLowerCase();
  if (v==='on') { s.useMission=true; s.sessionId=null; saveSessions(); await ctx.reply('✅ Mission 已开启 (auto high)'); }
  else if (v==='off') { s.useMission=false; saveSessions(); await ctx.reply('❌ Mission 已关闭'); }
  else await ctx.reply('用法: /mission on|off');
});

bot.command('reason', async ctx => {
  const uid=ctx.from.id; if (!isAllowed(uid)) return;
  const s=getUserSession(uid, cid(ctx)), args=ctx.message.text.split(' ').slice(1);
  const supported=MODEL_REASONING[s.model]||[];
  if (!args.length) {
    let info=`思考深度: ${s.reasoning||'默认'}\n模型: ${s.model}\n`;
    info+=supported.length>0?`支持: ${supported.join(', ')}`:'该模型不支持调整';
    info+='\n\n用法: /reason <等级> | /reason default';
    await ctx.reply(info); return;
  }
  const v=args[0].toLowerCase();
  if (v==='default'||v==='reset') { s.reasoning=null; saveSessions(); await ctx.reply('已恢复默认。'); return; }
  const valid=['off','low','medium','high','max','xhigh','minimal'];
  if (!valid.includes(v)) { await ctx.reply(`未知: ${v}\n可用: ${valid.join(', ')}`); return; }
  if (supported.length===0) { await ctx.reply(`模型 ${s.model} 不支持。`); return; }
  if (!supported.includes(v)) { await ctx.reply(`${v} 不适用。\n支持: ${supported.join(', ')}`); return; }
  s.reasoning=v; saveSessions(); await ctx.reply(`思考深度: ${v}`);
});

// ==================== 提醒命令 ====================

bot.command('remind', async ctx => {
  const uid=ctx.from.id; if (!isAllowed(uid)) return;
  const chatId=cid(ctx);
  const args=ctx.message.text.split(' ').slice(1);
  if (args.length<2) {
    await ctx.reply(
      '用法:\n/remind HH:MM 内容\n/remind YYYY-MM-DD HH:MM 内容\n'+
      '/remind daily HH:MM 内容\n/remind weekly 周X HH:MM 内容\n'+
      '/remind monthly X号 HH:MM 内容\n/remind 30m 内容\n\n'+
      '定时任务(exec:前缀):\n/remind 30m exec:检查服务器状态'
    ); return;
  }
  let time, text, type='once', exec=false, day=null;
  const WEEKDAY_MAP={'日':0,'天':0,'一':1,'二':2,'三':3,'四':4,'五':5,'六':6,'sun':0,'mon':1,'tue':2,'wed':3,'thu':4,'fri':5,'sat':6};
  const rawText=args.join(' ');
  let actualArgs=[...args];
  if (rawText.match(/\bexec:/i)) {
    exec=true;
    const m=rawText.match(/\bexec:\s*(.+)/i);
    if (m) { text=m[1].trim(); actualArgs=rawText.split(/\bexec:/i)[0].trim().split(/\s+/); }
  }
  if (actualArgs[0]==='weekly'&&actualArgs.length>=3) {
    const wd=actualArgs[1].replace(/周|星期/,'');
    if (!(wd in WEEKDAY_MAP)) { await ctx.reply('星期: 日/一/二/三/四/五/六'); return; }
    if (!/^\d{1,2}:\d{2}$/.test(actualArgs[2])) { await ctx.reply('格式: HH:MM'); return; }
    day=WEEKDAY_MAP[wd]; time=actualArgs[2].padStart(5,'0'); type='weekly';
    if (!exec) text=actualArgs.slice(3).join(' ');
  } else if (actualArgs[0]==='monthly'&&actualArgs.length>=3) {
    const dayNum=parseInt(actualArgs[1].replace(/号|日/,''));
    if (isNaN(dayNum)||dayNum<1||dayNum>31) { await ctx.reply('日期: 1-31号'); return; }
    if (!/^\d{1,2}:\d{2}$/.test(actualArgs[2])) { await ctx.reply('格式: HH:MM'); return; }
    day=dayNum; time=actualArgs[2].padStart(5,'0'); type='monthly';
    if (!exec) text=actualArgs.slice(3).join(' ');
  } else if (actualArgs[0]==='daily'&&actualArgs.length>=2) {
    if (!/^\d{1,2}:\d{2}$/.test(actualArgs[1])) { await ctx.reply('格式: HH:MM'); return; }
    time=actualArgs[1].padStart(5,'0'); type='daily';
    if (!exec) text=actualArgs.slice(2).join(' ');
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(actualArgs[0])&&actualArgs.length>=2) {
    if (!/^\d{1,2}:\d{2}$/.test(actualArgs[1])) { await ctx.reply('格式: HH:MM'); return; }
    time=`${actualArgs[0]} ${actualArgs[1].padStart(5,'0')}`;
    if (!exec) text=actualArgs.slice(2).join(' ');
  } else if (/^\d{1,2}:\d{2}$/.test(actualArgs[0])) {
    // 若指定时间今天已过，自动推到明天（Bug C 修复）
    const [_h,_m]=actualArgs[0].split(':').map(Number);
    const _t=new Date(); _t.setHours(_h,_m,0,0);
    if (_t<=new Date()) _t.setDate(_t.getDate()+1);
    time=localDateTimeStr(_t);
    if (!exec) text=actualArgs.slice(1).join(' ');
  } else if (/^\d+[dhm]$/.test(actualArgs[0])) {
    const v=parseInt(actualArgs[0]),u=actualArgs[0].slice(-1);
    const ms=u==='d'?v*86400000:u==='h'?v*3600000:v*60000;
    time=localDateTimeStr(new Date(Date.now()+ms));
    if (!exec) text=actualArgs.slice(1).join(' ');
  } else { await ctx.reply('格式错误。'); return; }
  if (!text) { await ctx.reply('缺少内容。'); return; }
  addReminder(chatId, time, text, type, exec, day);
  const dn=['日','一','二','三','四','五','六'];
  const tl=type==='daily'?'每天':type==='weekly'?`每周${dn[day]}`:(type==='monthly'?`每月${day}号`:'一次性');
  await ctx.reply(`${exec?'定时任务':'提醒'}已添加 ✅\n上下文: ${getLabelForChat(chatId)}\n类型: ${tl}\n时间: ${time}\n${exec?'任务':'内容'}: ${text}`);
});

bot.command('list', async ctx => {
  const uid=ctx.from.id; if (!isAllowed(uid)) return;
  const r=getChatReminders(cid(ctx));
  if (!r.length) { await ctx.reply('暂无提醒。'); return; }
  const dn=['日','一','二','三','四','五','六'];
  const lines=r.map((x,i)=>{
    const cycle=x.type==='daily'?'每天':x.type==='weekly'?`每周${dn[x.day]}`:(x.type==='monthly'?`每月${x.day}号`:'一次');
    return `${i+1}. [${cycle}] ${x.exec?'[任务]':'[提醒]'} ${x.time} - ${x.text} (${x.id})`;
  });
  await ctx.reply(`提醒 (${getLabelForChat(cid(ctx))}):\n\n${lines.join('\n')}\n\n删除: /delete <ID或序号>`);
});

bot.command('delete', async ctx => {
  const uid=ctx.from.id; if (!isAllowed(uid)) return;
  const args=ctx.message.text.split(' ').slice(1);
  if (!args.length) { await ctx.reply('用法: /delete <ID或序号>'); return; }
  const cr=getChatReminders(cid(ctx));
  const idx=parseInt(args[0])-1;
  if (idx>=0&&idx<cr.length) { const t=cr[idx]; deleteReminder(t.id); await ctx.reply(`已删除: ${t.time} - ${t.text}`); return; }
  const t=cr.find(x=>x.id===args[0]);
  if (t) { deleteReminder(t.id); await ctx.reply(`已删除: ${t.time} - ${t.text}`); }
  else await ctx.reply('未找到。/list 查看。');
});

bot.command('status', async ctx => {
  const uid=ctx.from.id; if (!isAllowed(uid)) return;
  const s=getUserSession(uid, cid(ctx));
  const chatId=cid(ctx);
  await ctx.reply(
    `上下文: ${getLabelForChat(chatId)}\n` +
    `工作目录: ${getCwdForChat(chatId)}\n` +
    `模型: ${s.model}\n权限: ${s.autoLevel}\n` +
    `会话: ${s.sessionId?s.sessionId.slice(0,8)+'...':'新会话'}\n` +
    `Spec: ${s.useSpec?'开':'关'}\nMission: ${s.useMission?'开':'关'}\n` +
    `Reasoning: ${s.reasoning||'默认'}\n超时: ${DROID_TIMEOUT/1000}s\n` +
    `提醒数: ${getChatReminders(chatId).length}\n` +
    `处理中: ${s.processing?'是':'否'}`
  );
});

// ==================== MCP 命令 ====================

function runDroidCli(args, timeoutMs=15000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(DROID_PATH, args, { env: DROID_ENV, timeout: timeoutMs });
    let stdout='', stderr='';
    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => { stderr += d; });
    proc.on('close', code => resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }));
    proc.on('error', err => reject(err));
  });
}

bot.command('mcp', async ctx => {
  const uid=ctx.from.id; if (!isAllowed(uid)) return;
  const args=ctx.message.text.split(' ').slice(1);
  if (!args.length) {
    await ctx.reply(
      `MCP 管理:\n\n`+
      `  /mcp list - 查看已配置的 MCP\n`+
      `  /mcp add <名称> <地址> - 添加 HTTP MCP\n`+
      `  /mcp add <名称> <地址> --header "Key: Value" - 带 header\n`+
      `  /mcp remove <名称> - 删除 MCP\n\n`+
      `示例:\n`+
      `  /mcp add yaocai https://app.yaocai.cool/mcp\n`+
      `  /mcp add yaocai https://app.yaocai.cool/mcp --header "Authorization: Bearer xxx"`
    );
    return;
  }

  const sub=args[0].toLowerCase();

  if (sub==='list') {
    await ctx.reply('查询中...');
    try {
      // 读取 cwd 下的 .mcp.json 和全局 settings
      const cwd = getCwdForChat(cid(ctx));
      let mcps = [];

      // 项目级 .mcp.json
      const projectMcpPath = path.join(cwd, '.mcp.json');
      if (fs.existsSync(projectMcpPath)) {
        try {
          const data = JSON.parse(fs.readFileSync(projectMcpPath, 'utf8'));
          if (data.mcpServers) {
            for (const [name, cfg] of Object.entries(data.mcpServers)) {
              mcps.push({ name, type: cfg.type||'stdio', url: cfg.url||cfg.command||'-', scope: '项目' });
            }
          }
        } catch(e) {}
      }

      // 全局 settings.local.json
      const globalSettingsPath = path.join(process.env.HOME||'/root', '.factory', 'settings.local.json');
      if (fs.existsSync(globalSettingsPath)) {
        try {
          const data = JSON.parse(fs.readFileSync(globalSettingsPath, 'utf8'));
          if (data.mcpServers) {
            for (const [name, cfg] of Object.entries(data.mcpServers)) {
              mcps.push({ name, type: cfg.type||'stdio', url: cfg.url||cfg.command||'-', scope: '全局' });
            }
          }
        } catch(e) {}
      }

      if (!mcps.length) { await ctx.reply('暂无已配置的 MCP。'); return; }
      const lines = mcps.map(m => `${m.scope==='项目'?'📂':'🌐'} ${m.name} (${m.type}) ${m.url}`);
      await ctx.reply(`MCP 服务器 (${getLabelForChat(cid(ctx))}):\n\n${lines.join('\n')}`);
    } catch(e) { await ctx.reply(`查询失败: ${e.message}`); }
    return;
  }

  if (sub==='add') {
    if (args.length<3) { await ctx.reply('用法: /mcp add <名称> <地址> [--header "Key: Value"]'); return; }
    const name=args[1];
    const url=args[2];
    const cliArgs=['mcp','add',name,url,'--type','http'];

    // 解析 --header 参数
    const rest=args.slice(3);
    for (let i=0; i<rest.length; i++) {
      if (rest[i]==='--header' && rest[i+1]) { cliArgs.push('--header', rest[i+1]); i++; }
    }

    await ctx.reply(`正在添加 MCP: ${name}...`);
    try {
      const {code, stdout, stderr}=await runDroidCli(cliArgs, 15000);
      if (code===0) await ctx.reply(`✅ MCP "${name}" 已添加。\n\n${(stdout||stderr).slice(0,500)}`);
      else await ctx.reply(`❌ 添加失败:\n${(stderr||stdout||'未知错误').slice(0,500)}`);
    } catch(e) { await ctx.reply(`❌ 执行失败: ${e.message}`); }
    return;
  }

  if (sub==='remove'||sub==='delete'||sub==='rm') {
    if (args.length<2) { await ctx.reply('用法: /mcp remove <名称>'); return; }
    const name=args[1];
    await ctx.reply(`正在删除 MCP: ${name}...`);
    try {
      const {code, stdout, stderr}=await runDroidCli(['mcp','remove',name], 15000);
      if (code===0) await ctx.reply(`✅ MCP "${name}" 已删除。`);
      else await ctx.reply(`❌ 删除失败:\n${(stderr||stdout||'未知错误').slice(0,500)}`);
    } catch(e) { await ctx.reply(`❌ 执行失败: ${e.message}`); }
    return;
  }

  await ctx.reply('未知子命令。可用: list, add, remove');
});

// ==================== Skills 命令 ====================

bot.command('skill', async ctx => {
  const uid=ctx.from.id; if (!isAllowed(uid)) return;
  const args=ctx.message.text.split(' ').slice(1);
  if (!args.length) {
    await ctx.reply(
      `Skills 管理:\n\n`+
      `  /skill list - 查看已安装 Skills\n`+
      `  /skill info <名称> - 查看详情\n`+
      `  /skill install <名称> - 安装\n`+
      `  /skill remove <名称> - 卸载\n`+
      `  /skill marketplace list - 查看市场\n\n`+
      `示例:\n`+
      `  /skill list\n`+
      `  /skill install pencil`
    );
    return;
  }

  const sub=args[0].toLowerCase();

  if (sub==='list'||sub==='ls') {
    await ctx.reply('查询中...');
    try {
      // 读取 ~/.factory/skills/ 目录
      const skillsDir = path.join(HOME || '/root', '.factory', 'skills');
      const skills = [];
      if (fs.existsSync(skillsDir)) {
        for (const entry of fs.readdirSync(skillsDir, {withFileTypes:true})) {
          if (entry.isDirectory()) {
            const skillFile = path.join(skillsDir, entry.name, 'skill.md');
            let desc = '';
            if (fs.existsSync(skillFile)) {
              try { desc = fs.readFileSync(skillFile, 'utf8').split('\n').find(l=>l.trim())||''; } catch(e){}
            }
            skills.push(`📂 ${entry.name}${desc ? ' - '+desc.slice(0,60) : ''}`);
          }
        }
      }
      // 也检查项目级 skills
      const cwd = getCwdForChat(cid(ctx));
      const projSkillsDir = path.join(cwd, 'skills');
      if (fs.existsSync(projSkillsDir)) {
        for (const entry of fs.readdirSync(projSkillsDir, {withFileTypes:true})) {
          if (entry.isDirectory()) {
            skills.push(`📂 ${entry.name} (项目级)`);
          }
        }
      }
      // 也检查 plugin 管理的 skills
      const {code, stdout, stderr}=await runDroidCli(['plugin','list'], 15000);
      const pluginOutput=(stdout||stderr).trim();
      if (pluginOutput && pluginOutput !== 'No plugins installed.') {
        skills.push(`\n--- Plugins (含 Skills) ---\n${pluginOutput}`);
      }

      await ctx.reply(skills.length>0 ? `已安装 Skills/插件:\n\n${skills.join('\n')}` : '暂无已安装的 Skills。');
    } catch(e) { await ctx.reply(`查询失败: ${e.message}`); }
    return;
  }

  if (sub==='info') {
    if (args.length<2) { await ctx.reply('用法: /skill info <名称>'); return; }
    const name=args[1];
    // 查找 skill.md
    const locations = [
      path.join(HOME || '/root', '.factory', 'skills', name),
      path.join(getCwdForChat(cid(ctx)), 'skills', name),
    ];
    let found = false;
    for (const loc of locations) {
      const mdFile = path.join(loc, 'skill.md');
      if (fs.existsSync(mdFile)) {
        const content = fs.readFileSync(mdFile, 'utf8').slice(0, 4000);
        await ctx.reply(`📂 ${name}:\n\n${content}`);
        found = true; break;
      }
    }
    if (!found) await ctx.reply(`未找到 Skill: ${name}`);
    return;
  }

  if (sub==='install'||sub==='i') {
    if (args.length<2) { await ctx.reply('用法: /skill install <名称>'); return; }
    const skillName=args[1];
    await ctx.reply(`正在安装 Skill: ${skillName}...`);
    try {
      // 尝试 droid skill install
      const {code, stdout, stderr}=await runDroidCli(['skill','install',skillName], 60000);
      const output=(stdout||stderr).trim();
      if (code===0) await ctx.reply(`✅ Skill 已安装。\n\n${output.slice(0,1000)}`);
      else await ctx.reply(`❌ 安装失败:\n${output.slice(0,500)}`);
    } catch(e) { await ctx.reply(`❌ 执行失败: ${e.message}`); }
    return;
  }

  if (sub==='remove'||sub==='uninstall'||sub==='rm'||sub==='delete') {
    if (args.length<2) { await ctx.reply('用法: /skill remove <名称>'); return; }
    const skillName=args[1];
    // 先尝试从文件系统删除
    const locations = [
      path.join(HOME || '/root', '.factory', 'skills', skillName),
      path.join(getCwdForChat(cid(ctx)), 'skills', skillName),
    ];
    let deleted = false;
    for (const loc of locations) {
      if (fs.existsSync(loc)) {
        try {
          fs.rmSync(loc, {recursive:true, force:true});
          await ctx.reply(`✅ 已删除: ${skillName}\n路径: ${loc}`);
          deleted = true; break;
        } catch(e) { await ctx.reply(`❌ 删除失败: ${e.message}`); return; }
      }
    }
    if (!deleted) {
      // 尝试 droid skill uninstall
      try {
        const {code, stdout, stderr}=await runDroidCli(['skill','uninstall',skillName], 30000);
        if (code===0) await ctx.reply(`✅ 已卸载: ${skillName}`);
        else await ctx.reply(`❌ 未找到: ${skillName}\n可用 /skill list 查看`);
      } catch(e) { await ctx.reply(`❌ 执行失败: ${e.message}`); }
    }
    return;
  }

  if (sub==='marketplace'||sub==='market') {
    const msub=(args[1]||'').toLowerCase();
    if (msub==='list') {
      await ctx.reply('查询中...');
      try {
        const {code, stdout, stderr}=await runDroidCli(['skill','marketplace','list'], 15000);
        await ctx.reply(`Skills 市场:\n\n${(stdout||stderr).trim()||'无'}`);
      } catch(e) { await ctx.reply(`查询失败: ${e.message}`); }
      return;
    }
    await ctx.reply('用法: /skill marketplace list');
    return;
  }

  await ctx.reply('未知子命令。可用: list, info, install, remove, marketplace');
});

// ==================== 插件/技能命令 ====================

bot.command('plugin', async ctx => {
  const uid=ctx.from.id; if (!isAllowed(uid)) return;
  const args=ctx.message.text.split(' ').slice(1);
  if (!args.length) {
    await ctx.reply(
      `插件管理:\n\n`+
      `  /plugin list - 查看已安装插件\n`+
      `  /plugin install <插件@市场> - 安装插件\n`+
      `  /plugin remove <插件> - 卸载插件\n`+
      `  /plugin update [插件] - 更新插件\n`+
      `  /plugin marketplace list - 查看市场\n`+
      `  /plugin marketplace add <Git URL> - 添加市场\n`+
      `  /plugin marketplace update - 更新市场\n\n`+
      `示例:\n`+
      `  /plugin list\n`+
      `  /plugin install security-guidance@factory-plugins`
    );
    return;
  }

  const sub=args[0].toLowerCase();

  if (sub==='list') {
    await ctx.reply('查询中...');
    try {
      const {code, stdout, stderr}=await runDroidCli(['plugin','list'], 15000);
      const output=(stdout||stderr).trim();
      await ctx.reply(`已安装插件:\n\n${output||'无'}`);
    } catch(e) { await ctx.reply(`查询失败: ${e.message}`); }
    return;
  }

  if (sub==='install'||sub==='i') {
    if (args.length<2) { await ctx.reply('用法: /plugin install <插件@市场>\n示例: /plugin install security-guidance@factory-plugins'); return; }
    const plugin=args[1];
    await ctx.reply(`正在安装插件: ${plugin}...`);
    try {
      const {code, stdout, stderr}=await runDroidCli(['plugin','install',plugin], 60000);
      const output=(stdout||stderr).trim();
      if (code===0) await ctx.reply(`✅ 插件已安装。\n\n${output.slice(0,1000)}`);
      else await ctx.reply(`❌ 安装失败:\n${output.slice(0,500)}`);
    } catch(e) { await ctx.reply(`❌ 执行失败: ${e.message}`); }
    return;
  }

  if (sub==='remove'||sub==='uninstall'||sub==='rm') {
    if (args.length<2) { await ctx.reply('用法: /plugin remove <插件名>'); return; }
    const plugin=args[1];
    await ctx.reply(`正在卸载插件: ${plugin}...`);
    try {
      const {code, stdout, stderr}=await runDroidCli(['plugin','uninstall',plugin], 30000);
      const output=(stdout||stderr).trim();
      if (code===0) await ctx.reply(`✅ 插件已卸载。\n\n${output.slice(0,500)}`);
      else await ctx.reply(`❌ 卸载失败:\n${output.slice(0,500)}`);
    } catch(e) { await ctx.reply(`❌ 执行失败: ${e.message}`); }
    return;
  }

  if (sub==='update') {
    const plugin=args[1]||null;
    await ctx.reply(plugin?`正在更新插件: ${plugin}...`:'正在更新所有插件...');
    try {
      const cliArgs=['plugin','update'];
      if (plugin) cliArgs.push(plugin);
      const {code, stdout, stderr}=await runDroidCli(cliArgs, 60000);
      const output=(stdout||stderr).trim();
      if (code===0) await ctx.reply(`✅ 更新完成。\n\n${output.slice(0,1000)}`);
      else await ctx.reply(`❌ 更新失败:\n${output.slice(0,500)}`);
    } catch(e) { await ctx.reply(`❌ 执行失败: ${e.message}`); }
    return;
  }

  if (sub==='marketplace'||sub==='market') {
    const msub=(args[1]||'').toLowerCase();
    if (msub==='list') {
      await ctx.reply('查询中...');
      try {
        const {code, stdout, stderr}=await runDroidCli(['plugin','marketplace','list'], 15000);
        await ctx.reply(`插件市场:\n\n${(stdout||stderr).trim()||'无'}`);
      } catch(e) { await ctx.reply(`查询失败: ${e.message}`); }
      return;
    }
    if (msub==='add') {
      if (!args[2]) { await ctx.reply('用法: /plugin marketplace add <Git URL>'); return; }
      await ctx.reply(`正在添加市场: ${args[2]}...`);
      try {
        const {code, stdout, stderr}=await runDroidCli(['plugin','marketplace','add',args[2]], 30000);
        if (code===0) await ctx.reply(`✅ 市场已添加。\n\n${(stdout||stderr).trim().slice(0,500)}`);
        else await ctx.reply(`❌ 添加失败:\n${(stderr||stdout).trim().slice(0,500)}`);
      } catch(e) { await ctx.reply(`❌ 执行失败: ${e.message}`); }
      return;
    }
    if (msub==='update') {
      await ctx.reply('正在更新市场...');
      try {
        const {code, stdout, stderr}=await runDroidCli(['plugin','marketplace','update'], 30000);
        if (code===0) await ctx.reply(`✅ 市场已更新。\n\n${(stdout||stderr).trim().slice(0,500)}`);
        else await ctx.reply(`❌ 更新失败:\n${(stderr||stdout).trim().slice(0,500)}`);
      } catch(e) { await ctx.reply(`❌ 执行失败: ${e.message}`); }
      return;
    }
    await ctx.reply('用法: /plugin marketplace <list|add|update>');
    return;
  }

  await ctx.reply('未知子命令。可用: list, install, remove, update, marketplace');
});

bot.command('help', async ctx => {
  const label = getLabelForChat(cid(ctx));
  await ctx.reply(
    `命令 (${label}):\n\n`+
    `对话:\n  /new - 清空会话\n  /session - 会话信息\n  /stop - 停止任务\n\n`+
    `模型:\n  /model [名称] - 切换模型\n  /tools - 可用工具\n  /version - Droid版本\n\n`+
    `执行:\n  /auto [等级] - 权限(low/medium/high)\n  /timeout <秒> - 超时\n  /status - 完整状态\n\n`+
    `高级:\n  /spec [on|off] - 规格模式\n  /mission [on|off] - 多Agent模式\n  /reason [等级] - 思考深度\n\n`+
    `Skills:\n  /skill list - 查看Skills\n  /skill info <名> - 详情\n  /skill install <名> - 安装\n  /skill remove <名> - 卸载\n\n`+
    `插件:\n  /plugin list - 查看插件\n  /plugin install <名> - 安装\n  /plugin remove <名> - 卸载\n  /plugin update - 更新\n\n`+
    `MCP:\n  /mcp list - 查看MCP\n  /mcp add <名> <地址> - 添加\n  /mcp remove <名> - 删除\n\n`+
    `提醒:\n  /remind <时间> <内容>\n  /list - 查看提醒\n  /delete <ID|序号>\n\n`+
    `图片:\n  直接发图片即可处理（上传电商/分析图片）\n\n`+
    `文件:\n  直接发文件即可处理（CSV/PDF/Excel/Word/TXT等）\n  支持自动发送生成的文件`
  );
});

bot.command('start', async ctx => {
  const label = getLabelForChat(cid(ctx));
  await ctx.reply(`欢迎使用 Droid Bot!\n\n当前上下文: ${label}\n直接发消息即可对话。\n/help 查看命令。`);
});

// ==================== 图片/文件处理 ====================

async function handlePhoto(ctx) {
  const uid=ctx.from.id;
  if (!isAllowed(uid)) return;
  const chatId=cid(ctx);
  const s=getUserSession(uid, chatId);
  checkProcessingStuck(s);
  if (s.processing) { await ctx.reply('⏳ 上一个请求还在处理中...'); return; }
  const photos = ctx.message.photo;
  if (!photos || !photos.length) return;
  const photo = photos[photos.length - 1]; // 最大尺寸
  const fileId = photo.file_id;

  console.log(`[PHOTO] ${uid} sent photo, fileId: ${fileId}`);

  s.processing = true; s.processingSince = Date.now();
  let typingInterval = null;
  try {
    await ctx.sendChatAction('typing');
    typingInterval = setInterval(() => ctx.sendChatAction('typing').catch(() => {}), 5000);

    // 下载图片
    const fileLink = await ctx.telegram.getFileLink(fileId);
    const https = require('https');
    const http = require('http');
    const urlStr = fileLink.toString();
    const client = urlStr.startsWith('https') ? https : http;

    const imageBuffer = await new Promise((resolve, reject) => {
      client.get(urlStr, {timeout: 30000}, (res) => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      }).on('error', reject);
    });

    // 保存到临时文件
    const tmpPath = path.join(os.tmpdir(), `tg_photo_${Date.now()}.jpg`);
    fs.writeFileSync(tmpPath, imageBuffer);
    console.log(`[PHOTO] Saved to ${tmpPath} (${imageBuffer.length} bytes)`);

    const caption = ctx.message.caption || '';
    // 构建包含图片信息的 prompt，让 Droid 根据 AGENTS.md 规则处理
    let prompt = `[图片已保存到: ${tmpPath}]\n`;
    if (caption) {
      prompt = caption + '\n' + prompt;
    }
    // 添加图片处理指引
    prompt += `\n[图片处理规则]：
- 如果需要分析图片内容，请使用: mmx vision --file ${tmpPath}
- 如果需要上传到电商网站，请按照 AGENTS.md 中的「电商产品图片上传」规则执行
- 图片临时路径在对话结束后会自动删除，如需保留请及时处理`;


    const cwd=getCwdForChat(chatId);
    const ctxNote=`[系统: 当前会话 chatId=${chatId} (${getLabelForChat(chatId)})；调用 remind-cli 时请加 --json；提醒类型默认规则：除非用户明确说了"每天/每周/每月"等周期词，否则一律用 --type once（一次性），不要猜测]`;
    const {stdout}=await callDroid(`${ctxNote}\n${prompt}`, s, cwd);
    const p=parseDroidOutput(stdout);
    if (p.sessionId) { s.sessionId=p.sessionId; saveSessions(); }
    const r=p.text;
    if (r.length>4000) { for(let i=0;i<r.length;i+=4000) await ctx.reply(r.slice(i,i+4000)); }
    else await ctx.reply(r);

    // 清理临时文件
    try { fs.unlinkSync(tmpPath); } catch(e){}
  } catch(e) {
    console.error('[PHOTO ERROR]', e.message);
    await ctx.reply(`图片处理出错: ${e.message.slice(0,500)}`);
  } finally {
    if (typingInterval) clearInterval(typingInterval);
    s.processing = false; s.processingSince = null; s.currentProc = null;
  }
}

bot.on('photo', handlePhoto);

// ==================== 文件接收处理 ====================

// 支持的文件扩展名及其处理方式
const FILE_EXTENSIONS = {
  text: ['.csv','.tsv','.txt','.md','.json','.xml','.yaml','.yml','.toml','.ini','.conf','.log','.env','.html','.htm','.css','.js','.ts','.py','.java','.c','.cpp','.h','.go','.rs','.rb','.php','.sh','.bat','.ps1','.sql','.graphql'],
  document: ['.pdf','.doc','.docx','.xls','.xlsx','.ppt','.pptx','.odt','.ods','.odp','.rtf'],
  data: ['.xlsx','.xls','.csv','.tsv','.json','.xml'],
  image: ['.jpg','.jpeg','.png','.gif','.bmp','.webp','.svg','.ico','.tiff','.tif'],
  archive: ['.zip','.tar','.gz','.bz2','.rar','.7z'],
};

function getFileCategory(filename) {
  const ext = path.extname(filename).toLowerCase();
  for (const [cat, exts] of Object.entries(FILE_EXTENSIONS)) {
    if (exts.includes(ext)) return cat;
  }
  return 'unknown';
}

async function handleDocument(ctx) {
  const uid = ctx.from.id;
  if (!isAllowed(uid)) return;
  const chatId = cid(ctx);
  const s = getUserSession(uid, chatId);
  checkProcessingStuck(s);
  if (s.processing) { await ctx.reply('⏳ 上一个请求还在处理中...'); return; }
  const fileName = doc.file_name || 'unknown';
  const fileId = doc.file_id;
  const fileSize = doc.file_size || 0;
  const caption = ctx.message.caption || '';

  console.log(`[FILE] ${uid} sent: ${fileName} (${(fileSize/1024).toFixed(1)}KB)`);

  // 文件大小限制 50MB
  if (fileSize > 50 * 1024 * 1024) {
    await ctx.reply('❌ 文件太大，上限 50MB。');
    return;
  }

  s.processing = true; s.processingSince = Date.now();
  let typingInterval = null;
  try {
    await ctx.sendChatAction('typing');
    typingInterval = setInterval(() => ctx.sendChatAction('typing').catch(() => {}), 5000);

    // 下载文件
    const fileLink = await ctx.telegram.getFileLink(fileId);
    const https = require('https');
    const http = require('http');
    const urlStr = fileLink.toString();
    const client = urlStr.startsWith('https') ? https : http;

    const fileBuffer = await new Promise((resolve, reject) => {
      client.get(urlStr, { timeout: 60000 }, (res) => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      }).on('error', reject);
    });

    // 保存到临时目录
    const tmpDir = path.join(os.tmpdir(), 'droid-files');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    const tmpPath = path.join(tmpDir, `${Date.now()}_${fileName}`);
    fs.writeFileSync(tmpPath, fileBuffer);
    console.log(`[FILE] Saved to ${tmpPath} (${fileBuffer.length} bytes)`);

    // 根据文件类型构建 prompt
    const category = getFileCategory(fileName);
    let prompt;

    if (category === 'image') {
      // 图片文件：检查模型是否支持
      const noImageModels = Object.values(CUSTOM_MODELS);
      if (noImageModels.includes(s.model)) {
        await ctx.reply('⚠️ 当前模型不支持图片识别。\n切换模型: /model claude-sonnet 或 /model gemini-pro');
        if (typingInterval) clearInterval(typingInterval);
        s.processing = false;
        try { fs.unlinkSync(tmpPath); } catch(e){}
        return;
      }
      prompt = (caption ? caption + '\n' : '') + `请分析这张图片。图片路径: ${tmpPath}`;
    } else if (category === 'text') {
      // 文本文件：读取内容作为上下文
      let content = '';
      try { content = fs.readFileSync(tmpPath, 'utf8'); } catch(e) { content = `[无法读取文件内容: ${e.message}]`; }
      // 截取前 8000 字符避免超长
      if (content.length > 8000) {
        content = content.slice(0, 8000) + '\n... (文件过长，已截取前8000字符)';
      }
      prompt = (caption ? caption + '\n' : '') + `用户发送了文件 "${fileName}"，内容如下：\n\n${content}\n\n请根据文件内容处理用户的请求。如果用户没有明确指令，请简要总结文件内容。`;
    } else if (category === 'data') {
      // 数据文件（CSV/Excel等）：传路径让 droid 用工具处理
      prompt = (caption ? caption + '\n' : '') + `用户发送了数据文件 "${fileName}"，文件路径: ${tmpPath}\n请读取并分析这个文件。如果用户没有明确指令，请显示文件内容和简要摘要。`;
    } else if (category === 'document') {
      // 文档文件（PDF/Word等）：传路径让 droid 用工具处理
      prompt = (caption ? caption + '\n' : '') + `用户发送了文档 "${fileName}"，文件路径: ${tmpPath}\n请读取并分析这个文档。如果用户没有明确指令，请总结文档内容。`;
    } else if (category === 'archive') {
      prompt = (caption ? caption + '\n' : '') + `用户发送了压缩包 "${fileName}"，文件路径: ${tmpPath}\n请解压并查看内容。`;
    } else {
      prompt = (caption ? caption + '\n' : '') + `用户发送了文件 "${fileName}"，文件路径: ${tmpPath}\n请处理这个文件。`;
    }

    const cwd = getCwdForChat(chatId);
    const { stdout } = await callDroid(prompt, s, cwd);
    const p = parseDroidOutput(stdout);
    if (p.sessionId) { s.sessionId = p.sessionId; saveSessions(); }

    // 检查回复中是否有文件路径需要发送
    await sendReplyWithFiles(ctx, chatId, p.text, cwd);

    // 清理临时文件（非数据文件保留30分钟供后续引用）
    if (category === 'text' || category === 'image') {
      try { fs.unlinkSync(tmpPath); } catch(e){}
    } else {
      // 数据/文档文件保留供后续对话引用
      setTimeout(() => { try { fs.unlinkSync(tmpPath); } catch(e){} }, 30 * 60 * 1000);
    }

  } catch (e) {
    console.error('[FILE ERROR]', e.message);
    await ctx.reply(`文件处理出错: ${e.message.slice(0,500)}`);
  } finally {
    if (typingInterval) clearInterval(typingInterval);
    s.processing = false; s.processingSince = null; s.currentProc = null;
  }
}

bot.on('document', handleDocument);

// ==================== 文件发送辅助 ====================

// 从回复文本中检测文件路径并自动发送
async function sendReplyWithFiles(ctx, chatId, text, cwd) {
  // 匹配服务器上存在的文件路径
  const filePathPatterns = [
    // 绝对路径
    /(?:文件(?:已保存|生成|位于|在|路径)|saved to|file (?:at|is|path)|generated at)[:\s]*`?([^\s`]+\.\w{1,10})`?/gi,
    // 引号内的路径
    /["'`]((?:\/[\w.\-\u4e00-\u9fff]+)+\.\w{1,10})["'`]/g,
    // markdown 链接中的路径
    /\[([^\]]*\.\w{1,10})\]\([^)]*\)/g,
    // 独立路径行
    /^(\/[\w.\-\u4e00-\u9fff]+\/[\w.\-./\u4e00-\u9fff]+\.\w{1,10})$/gm,
  ];

  const foundFiles = new Set();

  for (const pattern of filePathPatterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const p = match[1];
      // 检查文件是否存在
      if (fs.existsSync(p)) foundFiles.add(p);
      // 也检查相对于 cwd 的路径
      const absPath = path.resolve(cwd, p);
      if (fs.existsSync(absPath)) foundFiles.add(absPath);
    }
  }

  // 发送文本回复
  if (text.length > 4000) {
    for (let i = 0; i < text.length; i += 4000) await ctx.reply(text.slice(i, i + 4000));
  } else {
    await ctx.reply(text);
  }

  // 自动发送找到的文件
  for (const filePath of foundFiles) {
    try {
      const stat = fs.statSync(filePath);
      if (stat.size > 50 * 1024 * 1024) continue; // 跳过 >50MB
      const basename = path.basename(filePath);
      const ext = path.extname(filePath).toLowerCase();

      // 图片直接作为图片发送
      if (['.jpg','.jpeg','.png','.gif','.bmp','.webp'].includes(ext)) {
        await ctx.replyWithPhoto({ source: filePath }, { caption: basename });
      } else {
        // 其他文件作为文档发送
        await ctx.replyWithDocument({ source: filePath }, { caption: basename });
      }
      console.log(`[FILE SEND] ${basename} (${(stat.size/1024).toFixed(1)}KB)`);
    } catch (e) {
      console.error(`[FILE SEND ERROR] ${filePath}:`, e.message);
    }
  }
}

// ==================== 消息处理 ====================

bot.on('text', async ctx => {
  const uid=ctx.from.id, txt=ctx.message.text;
  if (!isAllowed(uid)) return;
  const chatId=cid(ctx);
  const s=getUserSession(uid, chatId);
  checkProcessingStuck(s);
  if (s.processing) { await ctx.reply('⏳ 上一个请求还在处理中...'); return; }
  console.log(`[MSG] ${uid} (${ctx.from.username||'?'}) @ ${getLabelForChat(chatId)}: ${txt}`);

  s.processing=true; s.processingSince=Date.now();
  const cwd=getCwdForChat(chatId);
  let typingInterval=null;
  try {
    await ctx.sendChatAction('typing');
    typingInterval=setInterval(()=>ctx.sendChatAction('typing').catch(()=>{}), 5000);
    const ctxNote=`[系统: 当前会话 chatId=${chatId} (${getLabelForChat(chatId)})；调用 remind-cli 时请加 --json；提醒类型默认规则：除非用户明确说了"每天/每周/每月"等周期词，否则一律用 --type once（一次性），不要猜测]`;
    const {stdout}=await callDroid(`${ctxNote}\n${txt}`, s, cwd);
    const p=parseDroidOutput(stdout);
    if (p.sessionId) { s.sessionId=p.sessionId; saveSessions(); }
    const r=p.text;
    await sendReplyWithFiles(ctx, chatId, r, cwd);
    console.log(`[REPLY] ${uid} @ ${getLabelForChat(chatId)}: ${r.slice(0,100)}...`);
  } catch(e) {
    console.error('[ERROR]', e.message);
    await ctx.reply(`出错了: ${e.message.slice(0,500)}`);
  } finally {
    if (typingInterval) clearInterval(typingInterval);
    s.processing=false; s.processingSince=null; s.currentProc=null;
  }
});

bot.catch((err, ctx) => console.error('[BOT ERROR]', err));

console.log('='.repeat(50));
console.log('Telegram + Droid Bot (Multi-Context)');
console.log('='.repeat(50));
console.log(`Model: ${DROID_MODEL}`);
console.log(`Droid: ${DROID_PATH}`);
console.log(`Private CWD: ${PRIVATE_CWD}`);
for (const [k,v] of Object.entries(GROUP_CONFIGS)) {
  console.log(`Group ${k} -> ${v.cwd} (${v.label})`);
}
console.log(`Timeout: ${DROID_TIMEOUT/1000}s`);
console.log(`Allowed: ${ALLOWED_USERS?ALLOWED_USERS.join(', '):'All'}`);
console.log('='.repeat(50));

bot.launch().then(()=>console.log('[STARTED]')).catch(e=>{console.error('[FAILED]',e.message);process.exit(1)});
process.once('SIGINT', ()=>bot.stop('SIGINT'));
process.once('SIGTERM', ()=>bot.stop('SIGTERM'));
