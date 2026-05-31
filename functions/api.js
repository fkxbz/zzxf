import { QUESTIONS } from './data/questions-data.js';

const ADMIN_USERNAME = 'admin';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
const LOGIN_MAX_FAILURES = 5;
const LOGIN_LOCK_SECONDS = 60 * 60;

export async function onRequest(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    const action = url.searchParams.get('action');

    if (!env.EXAM_KV) {
        return json({ error: 'KV 数据库未绑定' }, 500);
    }

    await ensureAdminUser(env);

    try {
        if (request.method === 'POST' && action === 'register') return await register(request, env);
        if (request.method === 'POST' && action === 'login') return await login(request, env);
        if (request.method === 'POST' && action === 'request-password-reset') return await requestPasswordReset(request, env);
        if (request.method === 'POST' && action === 'logout') return await logout(request, env);
        if (request.method === 'GET' && action === 'me') return await me(request, env);
        if (request.method === 'GET' && action === 'questions') return await getQuestions(request, env);
        if (request.method === 'GET' && action === 'settings') return await getSettings(request, env);
        if (request.method === 'POST' && action === 'save-settings') return await saveSettings(request, env);
        if (request.method === 'POST' && action === 'change-password') return await changePassword(request, env);
        if (request.method === 'GET' && action === 'users') return await listUsers(request, env);
        if (request.method === 'GET' && action === 'reset-requests') return await listResetRequests(request, env);
        if (request.method === 'POST' && action === 'handle-reset-request') return await handleResetRequest(request, env);
        if (request.method === 'POST' && action === 'reset-password') return await resetPassword(request, env);
        if (request.method === 'POST' && action === 'delete-user') return await deleteUser(request, env);
        if (request.method === 'GET' && action === 'records') return await listRecords(request, env);
        if (request.method === 'POST' && action === 'save-record') return await saveRecord(request, env);
        if (request.method === 'GET' && action === 'messages') return await listMessages(request, env);
        if (request.method === 'POST' && action === 'post-message') return await postMessage(request, env);
        if (request.method === 'POST' && action === 'reply-message') return await replyMessage(request, env);
    } catch (error) {
        return json({ error: error.message || '服务器处理失败' }, error.status || 500);
    }

    return json({ error: 'Not Found' }, 404);
}

async function ensureAdminUser(env) {
    const users = await getUsers(env);
    if (users[ADMIN_USERNAME]) return;
    const initialPassword = String(env.ADMIN_INITIAL_PASSWORD || '');
    if (!initialPassword) {
        throw new HttpError('ADMIN_INITIAL_PASSWORD 未配置，无法创建管理员账号', 500);
    }
    const salt = crypto.randomUUID();
    users[ADMIN_USERNAME] = {
        username: ADMIN_USERNAME,
        displayName: '系统管理员',
        role: 'admin',
        salt,
        passwordHash: await hashPassword(initialPassword, salt),
        createdAt: new Date().toISOString()
    };
    await putUsers(env, users);
}

async function register(request, env) {
    const body = await request.json();
    const username = cleanUsername(body.username);
    const password = String(body.password || '');
    const displayName = String(body.displayName || username).trim() || username;
    if (!username || !password) return json({ error: '请输入用户名和密码' }, 400);
    if (username === ADMIN_USERNAME) return json({ error: '该用户名不可注册' }, 400);

    const users = await getUsers(env);
    if (users[username]) return json({ error: '该用户名已存在' }, 409);

    const salt = crypto.randomUUID();
    users[username] = {
        username,
        displayName,
        role: 'user',
        salt,
        passwordHash: await hashPassword(password, salt),
        createdAt: new Date().toISOString()
    };
    await putUsers(env, users);
    return createSession(env, users[username]);
}

async function login(request, env) {
    const body = await request.json();
    const username = cleanUsername(body.username);
    const password = String(body.password || '');
    const clientIp = getClientIp(request);
    const lock = await getLoginLock(env, username, clientIp);
    if (lock) {
        return json({ error: '登录失败次数过多，请 60 分钟后再试' }, 429);
    }

    const users = await getUsers(env);
    const user = users[username];
    if (!user || user.deletedAt) {
        await recordFailedLogin(env, username, clientIp);
        return json({ error: '用户名或密码不正确' }, 401);
    }
    let ok = false;
    if (user.salt && user.passwordHash) {
        ok = user.passwordHash === await hashPassword(password, user.salt);
    } else if (user.passwordHash) {
        ok = user.passwordHash === await sha256(password);
    } else if (user.password) {
        ok = user.password === password;
    }

    if (!ok) {
        await recordFailedLogin(env, username, clientIp);
        return json({ error: '用户名或密码不正确' }, 401);
    }

    let changed = false;
    if (!user.salt || user.password || user.passwordHash === await sha256(password)) {
        user.salt = crypto.randomUUID();
        user.passwordHash = await hashPassword(password, user.salt);
        delete user.password;
        changed = true;
    }
    user.lastLoginAt = new Date().toISOString();
    user.loginCount = Number(user.loginCount || 0) + 1;
    users[username] = user;
    if (changed || true) await putUsers(env, users);
    await clearFailedLogin(env, username, clientIp);

    return createSession(env, user);
}

async function requestPasswordReset(request, env) {
    const body = await request.json();
    const username = cleanUsername(body.username);
    const displayName = String(body.displayName || '').trim();
    if (!username || !displayName) return json({ error: '请输入账号和昵称' }, 400);

    const users = await getUsers(env);
    const user = users[username];
    if (!user || user.deletedAt || user.role === 'admin') {
        return json({ error: '账号或昵称不匹配' }, 400);
    }
    if ((user.displayName || user.username).trim() !== displayName) {
        return json({ error: '账号或昵称不匹配' }, 400);
    }

    const requests = await getResetRequests(env);
    const pending = requests.find(item => item.username === username && item.status === 'pending');
    if (pending) return json({ success: true, message: '重置申请已提交，请等待管理员审核。' });

    requests.unshift({
        id: crypto.randomUUID(),
        username,
        displayName,
        status: 'pending',
        createdAt: new Date().toISOString(),
        handledAt: '',
        handledBy: ''
    });
    await putResetRequests(env, requests);
    return json({ success: true, message: '重置申请已提交，请等待管理员审核。' });
}

async function logout(request, env) {
    const token = getBearerToken(request);
    if (token) await env.EXAM_KV.delete(`session:${token}`);
    return json({ success: true });
}

async function me(request, env) {
    const user = await requireUser(request, env, false);
    return json({ user: user ? publicUser(user) : null });
}

async function getSettings(request, env) {
    await requireUser(request, env);
    const settings = await env.EXAM_KV.get('exam:settings', 'json');
    return json({ settings: normalizeSettings(settings) });
}

async function getQuestions(request, env) {
    await requireUser(request, env);
    return json({ questions: QUESTIONS });
}

async function saveSettings(request, env) {
    await requireAdmin(request, env);
    const body = await request.json();
    const settings = normalizeSettings(body.settings || body);
    await env.EXAM_KV.put('exam:settings', JSON.stringify(settings));
    return json({ success: true, settings });
}

async function changePassword(request, env) {
    const user = await requireUser(request, env);
    const body = await request.json();
    const oldPassword = String(body.oldPassword || '');
    const newPassword = String(body.newPassword || '');
    if (!oldPassword || !newPassword) return json({ error: '请输入原密码和新密码' }, 400);
    if (newPassword.length < 6) return json({ error: '新密码至少 6 位' }, 400);

    const users = await getUsers(env);
    const current = users[user.username];
    if (!await verifyPassword(current, oldPassword)) return json({ error: '原密码不正确' }, 400);
    current.salt = crypto.randomUUID();
    current.passwordHash = await hashPassword(newPassword, current.salt);
    current.passwordChangedAt = new Date().toISOString();
    delete current.password;
    users[user.username] = current;
    await putUsers(env, users);
    return json({ success: true });
}

async function listUsers(request, env) {
    await requireAdmin(request, env);
    const users = Object.values(await getUsers(env))
        .filter(user => !user.deletedAt)
        .sort((a, b) => a.username.localeCompare(b.username));
    const result = [];
    for (const user of users) {
        const item = publicUser(user);
        item.examSummary = user.role === 'admin'
            ? { total: 0, bestScore: 0, latestScore: 0, latestAt: '', passed: 0 }
            : await getExamSummary(env, user.username);
        result.push(item);
    }
    return json({ users: result });
}

async function listResetRequests(request, env) {
    await requireAdmin(request, env);
    const requests = await getResetRequests(env);
    return json({ requests });
}

async function handleResetRequest(request, env) {
    const admin = await requireAdmin(request, env);
    const body = await request.json();
    const id = String(body.id || '');
    const decision = String(body.decision || '');
    if (!id || !['approve', 'reject'].includes(decision)) return json({ error: '缺少审核信息' }, 400);

    const requests = await getResetRequests(env);
    const item = requests.find(requestItem => requestItem.id === id);
    if (!item) return json({ error: '申请不存在' }, 404);
    if (item.status !== 'pending') return json({ error: '该申请已处理' }, 400);

    item.status = decision === 'approve' ? 'approved' : 'rejected';
    item.handledAt = new Date().toISOString();
    item.handledBy = admin.username;

    let password = '';
    if (decision === 'approve') {
        const users = await getUsers(env);
        const user = users[item.username];
        if (!user || user.deletedAt) return json({ error: '账号不存在' }, 404);
        password = defaultPassword();
        user.salt = crypto.randomUUID();
        user.passwordHash = await hashPassword(password, user.salt);
        user.passwordResetAt = item.handledAt;
        delete user.password;
        users[item.username] = user;
        await putUsers(env, users);
    }

    await putResetRequests(env, requests);
    return json({ success: true, password, request: item });
}

async function deleteUser(request, env) {
    const admin = await requireAdmin(request, env);
    const body = await request.json();
    const username = cleanUsername(body.username);
    if (!username) return json({ error: '缺少用户名' }, 400);
    if (username === ADMIN_USERNAME) return json({ error: '内置管理员账号不能删除' }, 400);
    if (username === admin.username) return json({ error: '不能删除当前登录账号' }, 400);

    const users = await getUsers(env);
    if (!users[username]) return json({ error: '账号不存在' }, 404);
    delete users[username];
    await putUsers(env, users);
    await env.EXAM_KV.delete(`records:${username}`);
    await env.EXAM_KV.delete(`messages:${username}`);
    return json({ success: true });
}

async function resetPassword(request, env) {
    const admin = await requireAdmin(request, env);
    const body = await request.json();
    const username = cleanUsername(body.username);
    if (!username) return json({ error: '缺少用户名' }, 400);
    if (username === admin.username) return json({ error: '当前管理员请使用修改密码功能' }, 400);

    const users = await getUsers(env);
    const user = users[username];
    if (!user || user.deletedAt) return json({ error: '账号不存在' }, 404);
    const password = defaultPassword();
    user.salt = crypto.randomUUID();
    user.passwordHash = await hashPassword(password, user.salt);
    user.passwordResetAt = new Date().toISOString();
    delete user.password;
    users[username] = user;
    await putUsers(env, users);
    return json({ success: true, password });
}

async function listRecords(request, env) {
    const user = await requireUser(request, env);
    const records = await env.EXAM_KV.get(`records:${user.username}`, 'json') || [];
    return json({ records: records.map(publicRecord) });
}

async function saveRecord(request, env) {
    const user = await requireUser(request, env);
    const body = await request.json();
    const key = `records:${user.username}`;
    const records = await env.EXAM_KV.get(key, 'json') || [];
    records.unshift({
        score: Number(body.score || 0),
        totalScore: Number(body.totalScore || 0),
        passScore: Number(body.passScore || 0),
        correct: Number(body.correct || 0),
        wrong: Number(body.wrong || 0),
        answeredCount: Number(body.answeredCount || 0),
        totalQuestions: Number(body.totalQuestions || 0),
        questionIds: Array.isArray(body.questionIds) ? body.questionIds.map(String).slice(0, 500) : [],
        userAnswers: body.userAnswers && typeof body.userAnswers === 'object' ? body.userAnswers : {},
        wrongIds: Array.isArray(body.wrongIds) ? body.wrongIds.map(String).slice(0, 500) : [],
        createdAt: new Date().toISOString()
    });
    await env.EXAM_KV.put(key, JSON.stringify(records.slice(0, 20)));
    return json({ success: true });
}

async function listMessages(request, env) {
    const user = await requireUser(request, env);
    if (user.role === 'admin') {
        const username = cleanUsername(new URL(request.url).searchParams.get('username'));
        if (username) return json({ messages: await getUserMessages(env, username) });
        const users = Object.values(await getUsers(env)).filter(item => !item.deletedAt && item.role !== 'admin');
        const threads = [];
        for (const item of users) {
            const messages = await getUserMessages(env, item.username);
            if (messages.length > 0) {
                threads.push({ user: publicUser(item), messages, latestAt: messages[0]?.createdAt || '' });
            }
        }
        threads.sort((a, b) => String(b.latestAt).localeCompare(String(a.latestAt)));
        return json({ threads });
    }
    return json({ messages: await getUserMessages(env, user.username) });
}

async function postMessage(request, env) {
    const user = await requireUser(request, env);
    const body = await request.json();
    const content = String(body.content || '').trim();
    if (!content) return json({ error: '请输入留言内容' }, 400);
    if (content.length > 1000) return json({ error: '留言不能超过 1000 字' }, 400);

    const messages = await getUserMessages(env, user.username);
    messages.unshift({
        id: crypto.randomUUID(),
        content,
        reply: '',
        createdAt: new Date().toISOString(),
        repliedAt: ''
    });
    await putUserMessages(env, user.username, messages);
    return json({ success: true, messages });
}

async function replyMessage(request, env) {
    await requireAdmin(request, env);
    const body = await request.json();
    const username = cleanUsername(body.username);
    const id = String(body.id || '');
    const reply = String(body.reply || '').trim();
    if (!username || !id) return json({ error: '缺少留言信息' }, 400);
    if (!reply) return json({ error: '请输入回复内容' }, 400);
    if (reply.length > 1000) return json({ error: '回复不能超过 1000 字' }, 400);

    const messages = await getUserMessages(env, username);
    const item = messages.find(message => message.id === id);
    if (!item) return json({ error: '留言不存在' }, 404);
    item.reply = reply;
    item.repliedAt = new Date().toISOString();
    await putUserMessages(env, username, messages);
    return json({ success: true, messages });
}

async function createSession(env, user) {
    const token = crypto.randomUUID();
    await env.EXAM_KV.put(`session:${token}`, JSON.stringify({
        username: user.username,
        createdAt: new Date().toISOString()
    }), { expirationTtl: SESSION_TTL_SECONDS });
    return json({ token, user: publicUser(user) });
}

async function requireAdmin(request, env) {
    const user = await requireUser(request, env);
    if (user.role !== 'admin') throw new HttpError('需要管理员权限', 403);
    return user;
}

async function requireUser(request, env, required = true) {
    const token = getBearerToken(request);
    if (!token) {
        if (required) throw new HttpError('请先登录', 401);
        return null;
    }
    const session = await env.EXAM_KV.get(`session:${token}`, 'json');
    if (!session?.username) {
        if (required) throw new HttpError('登录已失效', 401);
        return null;
    }
    const users = await getUsers(env);
    const user = users[session.username];
    if (!user || user.deletedAt) {
        if (required) throw new HttpError('账号不存在或已被删除', 401);
        return null;
    }
    return user;
}

async function verifyPassword(user, password) {
    if (!user) return false;
    if (user.salt && user.passwordHash) return user.passwordHash === await hashPassword(password, user.salt);
    if (user.passwordHash) return user.passwordHash === await sha256(password);
    if (user.password) return user.password === password;
    return false;
}

async function getUsers(env) {
    return await env.EXAM_KV.get('users', 'json') || {};
}

async function putUsers(env, users) {
    await env.EXAM_KV.put('users', JSON.stringify(users));
}

function publicUser(user) {
    return {
        username: user.username,
        displayName: user.displayName || user.username,
        role: user.role || 'user',
        createdAt: user.createdAt || '',
        lastLoginAt: user.lastLoginAt || '',
        loginCount: Number(user.loginCount || 0),
        passwordResetAt: user.passwordResetAt || ''
    };
}

function publicRecord(record) {
    return {
        score: Number(record.score || 0),
        totalScore: Number(record.totalScore || 0),
        passScore: Number(record.passScore || 0),
        correct: Number(record.correct || 0),
        wrong: Number(record.wrong || 0),
        answeredCount: Number(record.answeredCount || 0),
        totalQuestions: Number(record.totalQuestions || 0),
        questionIds: Array.isArray(record.questionIds) ? record.questionIds : [],
        userAnswers: record.userAnswers && typeof record.userAnswers === 'object' ? record.userAnswers : {},
        wrongIds: Array.isArray(record.wrongIds) ? record.wrongIds : [],
        createdAt: record.createdAt || ''
    };
}

function normalizeSettings(settings) {
    return {
        examCount: clampNumber(settings?.examCount, 1, 500, 200),
        examMinutes: clampNumber(settings?.examMinutes, 1, 300, 90),
        totalScore: clampNumber(settings?.totalScore, 1, 1000, 100),
        passScore: clampNumber(settings?.passScore, 1, 1000, 60),
        combos: settings?.combos && typeof settings.combos === 'object' ? settings.combos : {},
        percentCombos: settings?.percentCombos && typeof settings.percentCombos === 'object' ? settings.percentCombos : {},
        typeScores: settings?.typeScores && typeof settings.typeScores === 'object'
            ? settings.typeScores
            : { '单选': 0.5, '多选': 0.5, '判断': 0.5 }
    };
}

async function getUserMessages(env, username) {
    return await env.EXAM_KV.get(`messages:${username}`, 'json') || [];
}

async function putUserMessages(env, username, messages) {
    await env.EXAM_KV.put(`messages:${username}`, JSON.stringify(messages.slice(0, 100)));
}

function defaultPassword() {
    const date = new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).format(new Date()).replace(/\D/g, '');
    return `zzxf${date}`;
}

async function getResetRequests(env) {
    return await env.EXAM_KV.get('password-reset-requests', 'json') || [];
}

async function putResetRequests(env, requests) {
    await env.EXAM_KV.put('password-reset-requests', JSON.stringify(requests.slice(0, 100)));
}

async function getExamSummary(env, username) {
    const records = await env.EXAM_KV.get(`records:${username}`, 'json') || [];
    if (records.length === 0) return { total: 0, bestScore: 0, latestScore: 0, latestAt: '', passed: 0 };
    const scores = records.map(record => Number(record.score || 0));
    return {
        total: records.length,
        bestScore: Math.max(...scores),
        latestScore: Number(records[0]?.score || 0),
        latestAt: records[0]?.createdAt || '',
        passed: records.filter(record => Number(record.score || 0) >= Number(record.passScore || 0)).length
    };
}

function clampNumber(value, min, max, fallback) {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.max(min, Math.min(max, num));
}

function cleanUsername(value) {
    return String(value || '').trim().toLowerCase();
}

function getBearerToken(request) {
    const header = request.headers.get('Authorization') || '';
    return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

function getClientIp(request) {
    return request.headers.get('CF-Connecting-IP')
        || request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim()
        || request.headers.get('X-Real-IP')
        || '';
}

async function getLoginAttemptKeys(username, clientIp) {
    const keys = [];
    if (username) keys.push(`login-fail:user:${username}`);
    if (clientIp) keys.push(`login-fail:ip:${await sha256(clientIp)}`);
    return keys;
}

async function getLoginLock(env, username, clientIp) {
    const now = Date.now();
    const keys = await getLoginAttemptKeys(username, clientIp);
    for (const key of keys) {
        const attempt = await env.EXAM_KV.get(key, 'json');
        if (attempt?.lockedUntil && Number(attempt.lockedUntil) > now) return attempt;
    }
    return null;
}

async function recordFailedLogin(env, username, clientIp) {
    const now = Date.now();
    const keys = await getLoginAttemptKeys(username, clientIp);
    for (const key of keys) {
        const current = await env.EXAM_KV.get(key, 'json') || {};
        const count = current.lockedUntil && Number(current.lockedUntil) > now
            ? LOGIN_MAX_FAILURES
            : Number(current.count || 0) + 1;
        const attempt = {
            count,
            updatedAt: new Date(now).toISOString(),
            lockedUntil: count >= LOGIN_MAX_FAILURES ? now + LOGIN_LOCK_SECONDS * 1000 : 0
        };
        await env.EXAM_KV.put(key, JSON.stringify(attempt), { expirationTtl: LOGIN_LOCK_SECONDS });
    }
}

async function clearFailedLogin(env, username, clientIp) {
    const keys = await getLoginAttemptKeys(username, clientIp);
    await Promise.all(keys.map(key => env.EXAM_KV.delete(key)));
}

async function hashPassword(password, salt) {
    return sha256(`${salt}:${password}`);
}

async function sha256(value) {
    const bytes = new TextEncoder().encode(value);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store'
        }
    });
}

class HttpError extends Error {
    constructor(message, status) {
        super(message);
        this.status = status;
    }
}
