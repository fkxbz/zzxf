import { QUESTIONS } from './data/questions-data.js';

const ADMIN_USERNAME = 'admin';
const ADMIN_PASSWORD = 'Admin@123456';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

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
        if (request.method === 'POST' && action === 'logout') return await logout(request, env);
        if (request.method === 'GET' && action === 'me') return await me(request, env);
        if (request.method === 'GET' && action === 'questions') return await getQuestions(request, env);
        if (request.method === 'GET' && action === 'settings') return await getSettings(request, env);
        if (request.method === 'POST' && action === 'save-settings') return await saveSettings(request, env);
        if (request.method === 'GET' && action === 'users') return await listUsers(request, env);
        if (request.method === 'POST' && action === 'delete-user') return await deleteUser(request, env);
        if (request.method === 'POST' && action === 'save-record') return await saveRecord(request, env);
    } catch (error) {
        return json({ error: error.message || '服务器处理失败' }, error.status || 500);
    }

    return json({ error: 'Not Found' }, 404);
}

async function ensureAdminUser(env) {
    const users = await getUsers(env);
    if (users[ADMIN_USERNAME]) return;
    const salt = crypto.randomUUID();
    users[ADMIN_USERNAME] = {
        username: ADMIN_USERNAME,
        displayName: '系统管理员',
        role: 'admin',
        salt,
        passwordHash: await hashPassword(ADMIN_PASSWORD, salt),
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
    const users = await getUsers(env);
    const user = users[username];
    if (!user || user.deletedAt) return json({ error: '用户名或密码不正确' }, 401);

    let ok = false;
    if (user.salt && user.passwordHash) {
        ok = user.passwordHash === await hashPassword(password, user.salt);
    } else if (user.passwordHash) {
        ok = user.passwordHash === await sha256(password);
    } else if (user.password) {
        ok = user.password === password;
    }

    if (!ok) return json({ error: '用户名或密码不正确' }, 401);

    if (!user.salt || user.password || user.passwordHash === await sha256(password)) {
        user.salt = crypto.randomUUID();
        user.passwordHash = await hashPassword(password, user.salt);
        delete user.password;
        users[username] = user;
        await putUsers(env, users);
    }

    return createSession(env, user);
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

async function listUsers(request, env) {
    await requireAdmin(request, env);
    const users = Object.values(await getUsers(env))
        .filter(user => !user.deletedAt)
        .map(publicUser)
        .sort((a, b) => a.username.localeCompare(b.username));
    return json({ users });
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
    return json({ success: true });
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
        createdAt: new Date().toISOString()
    });
    await env.EXAM_KV.put(key, JSON.stringify(records.slice(0, 20)));
    return json({ success: true });
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
        createdAt: user.createdAt || ''
    };
}

function normalizeSettings(settings) {
    return {
        examCount: clampNumber(settings?.examCount, 1, 500, 200),
        examMinutes: clampNumber(settings?.examMinutes, 1, 300, 90),
        totalScore: clampNumber(settings?.totalScore, 1, 1000, 100),
        passScore: clampNumber(settings?.passScore, 1, 1000, 60),
        combos: settings?.combos && typeof settings.combos === 'object' ? settings.combos : {},
        typeScores: settings?.typeScores && typeof settings.typeScores === 'object'
            ? settings.typeScores
            : { '单选': 0.5, '多选': 0.5, '判断': 0.5 }
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
