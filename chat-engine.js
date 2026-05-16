'use strict';

const MAX_HISTORY = 50;
const SESSION_TTL_MS = 45000;
const DEFAULT_ROOM = 'General';

function normalizeRoomName(room) {
    if (!room || typeof room !== 'string') {
        return DEFAULT_ROOM;
    }
    const t = room.trim();
    return t || DEFAULT_ROOM;
}

function initialState() {
    return {
        nextMessageId: 1,
        nextEventId: 1,
        rooms: {},
        sessions: {},
        typing: {}
    };
}

function ensureRoom(state, roomName) {
    if (!state.rooms[roomName]) {
        state.rooms[roomName] = { messages: [], events: [] };
    }
    return state.rooms[roomName];
}

function maxId(items, idKey = 'id') {
    if (!items.length) return 0;
    return items[items.length - 1][idKey];
}

function pruneTyping(state, now) {
    if (!state.typing) return;
    for (const sid of Object.keys(state.typing)) {
        const meta = state.typing[sid];
        if (!meta || meta.until <= now) {
            delete state.typing[sid];
        }
    }
}

function purgeStaleSessions(state, now) {
    for (const sid of Object.keys(state.sessions)) {
        const sess = state.sessions[sid];
        if (!sess) continue;
        if (now - sess.lastSeen <= SESSION_TTL_MS) continue;

        delete state.sessions[sid];
        if (state.typing[sid]) delete state.typing[sid];

        const roomName = sess.room;
        const username = sess.username;
        if (username && roomName) {
            const roomObj = ensureRoom(state, roomName);
            roomObj.events.push({
                id: state.nextEventId++,
                kind: 'status',
                text: `${username} left ${roomName}`
            });
        }
    }
}

function roomUsernames(state, roomName, now = Date.now()) {
    const set = new Set();
    for (const sess of Object.values(state.sessions)) {
        if (!sess || sess.room !== roomName) continue;
        if (now - sess.lastSeen > SESSION_TTL_MS) continue;
        set.add(sess.username);
    }
    return [...set].sort();
}

function typingUsernames(state, roomName, now) {
    const names = new Set();
    pruneTyping(state, now);
    for (const meta of Object.values(state.typing || {})) {
        if (!meta || meta.room !== roomName) continue;
        if (meta.until <= now) continue;
        if (meta.username) names.add(meta.username);
    }
    return [...names];
}

function uniqueActiveUsernames(prev, now) {
    const set = new Set();
    for (const sess of Object.values(prev.sessions)) {
        if (!sess || now - sess.lastSeen > SESSION_TTL_MS) continue;
        set.add(sess.username);
    }
    return set.size;
}

function activeUsersInRoom(prev, roomName, now) {
    const set = new Set();
    for (const sess of Object.values(prev.sessions)) {
        if (!sess || sess.room !== roomName) continue;
        if (now - sess.lastSeen > SESSION_TTL_MS) continue;
        set.add(sess.username);
    }
    return set.size;
}

function activeUsernameList(prev, now) {
    const set = new Set();
    for (const sess of Object.values(prev.sessions)) {
        if (!sess || now - sess.lastSeen > SESSION_TTL_MS) continue;
        set.add(sess.username);
    }
    return [...set].sort();
}

function join(prev, body) {
    const cleaned = ((body && body.username) || '').trim();
    const sid = String((body && body.sessionId) || '').trim();
    const roomName = normalizeRoomName(body && body.room);

    if (!cleaned || !sid) {
        return {
            state: prev,
            response: { ok: false, error: 'username and sessionId are required' },
            statusCode: 400
        };
    }

    const state = structuredClone(prev);
    const now = Date.now();
    pruneTyping(state, now);
    purgeStaleSessions(state, now);

    state.sessions[sid] = { username: cleaned, room: roomName, lastSeen: now };

    const roomObj = ensureRoom(state, roomName);
    const joinEvent = {
        id: state.nextEventId++,
        kind: 'status',
        text: `${cleaned} joined ${roomName}`
    };
    roomObj.events.push(joinEvent);

    const history = roomObj.messages.slice(-MAX_HISTORY);

    return {
        state,
        response: {
            ok: true,
            room: roomName,
            username: cleaned,
            messages: history,
            users: roomUsernames(state, roomName, now),
            events: [joinEvent],
            lastMessageId: maxId(roomObj.messages),
            lastEventId: maxId(roomObj.events)
        },
        statusCode: 200
    };
}

function poll(prev, query) {
    const roomName = normalizeRoomName(query.room);
    const sid = String(query.sessionId || '').trim();
    const sinceMsg = parseInt(query.sinceMessageId || '0', 10) || 0;
    const sinceEvt = parseInt(query.sinceEventId || '0', 10) || 0;

    const state = structuredClone(prev);
    const now = Date.now();
    pruneTyping(state, now);
    purgeStaleSessions(state, now);

    if (sid && state.sessions[sid]) {
        state.sessions[sid].lastSeen = now;
        state.sessions[sid].room = roomName;
    }

    const roomObj = ensureRoom(state, roomName);
    const newMessages = roomObj.messages.filter((m) => m.id > sinceMsg);
    const newEvents = roomObj.events.filter((e) => e.id > sinceEvt);

    return {
        state,
        response: {
            messages: newMessages,
            events: newEvents,
            users: roomUsernames(state, roomName, now),
            typing: typingUsernames(state, roomName, now),
            lastMessageId: maxId(roomObj.messages),
            lastEventId: maxId(roomObj.events)
        },
        statusCode: 200
    };
}

function sendMessage(prev, body) {
    const sid = String((body && body.sessionId) || '').trim();
    const textRaw = body && body.text;

    const state = structuredClone(prev);
    const now = Date.now();
    pruneTyping(state, now);
    purgeStaleSessions(state, now);

    const sess = state.sessions[sid];
    if (!sess) {
        return {
            state: prev,
            response: { ok: false, error: 'Unknown session — refresh and join again' },
            statusCode: 401
        };
    }

    const text = typeof textRaw === 'string' ? textRaw : '';
    const roomName = sess.room;
    const roomObj = ensureRoom(state, roomName);

    const messageData = {
        id: state.nextMessageId++,
        user: sess.username,
        text,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        room: roomName
    };

    roomObj.messages.push(messageData);
    if (roomObj.messages.length > MAX_HISTORY) {
        roomObj.messages = roomObj.messages.slice(-MAX_HISTORY);
    }

    if (state.typing[sid]) {
        delete state.typing[sid];
    }

    return {
        state,
        response: { ok: true, message: messageData },
        statusCode: 200
    };
}

function typing(prev, body) {
    const sid = String((body && body.sessionId) || '').trim();
    const isTyping = Boolean(body && body.isTyping);

    const state = structuredClone(prev);
    const now = Date.now();
    pruneTyping(state, now);
    purgeStaleSessions(state, now);

    const sess = state.sessions[sid];
    if (!sess) {
        return {
            state: prev,
            response: { ok: false, error: 'Unknown session' },
            statusCode: 401
        };
    }

    if (isTyping) {
        state.typing[sid] = {
            username: sess.username,
            room: sess.room,
            until: now + 4000
        };
    } else if (state.typing[sid]) {
        delete state.typing[sid];
    }

    return { state, response: { ok: true }, statusCode: 200 };
}

function buildStats(prev, roomQuery) {
    const roomName = normalizeRoomName(roomQuery);
    const roomObj = prev.rooms[roomName] || { messages: [], events: [] };
    const now = Date.now();
    const msgs = roomObj.messages || [];
    return {
        status: 'success',
        room: roomName,
        total_active_users: uniqueActiveUsernames(prev, now),
        room_active_users: activeUsersInRoom(prev, roomName, now),
        total_messages_stored: msgs.length,
        last_message: msgs.length ? msgs[msgs.length - 1] : null
    };
}

function buildData(prev, storageLabel) {
    const room_message_history = {};
    for (const [name, ro] of Object.entries(prev.rooms)) {
        room_message_history[name] = ro.messages || [];
    }
    const now = Date.now();
    return {
        status: 'success',
        storage_type: storageLabel || 'Unknown',
        active_users: activeUsernameList(prev, now),
        room_message_history
    };
}

function clearMessages(prev, roomQuery) {
    const state = structuredClone(prev);
    const room = roomQuery ? normalizeRoomName(roomQuery) : null;

    if (room) {
        const roomObj = ensureRoom(state, room);
        roomObj.messages = [];
        roomObj.events.push({
            id: state.nextEventId++,
            kind: 'status',
            text: `Chat history in ${room} was cleared by admin action`
        });
        return {
            state,
            response: {
                status: 'success',
                message: `Message history for ${room} cleared`
            },
            statusCode: 200
        };
    }

    for (const name of Object.keys(state.rooms)) {
        const roomObj = state.rooms[name];
        roomObj.messages = [];
        roomObj.events.push({
            id: state.nextEventId++,
            kind: 'status',
            text: 'Chat history in all rooms was cleared by admin action'
        });
    }

    return {
        state,
        response: {
            status: 'success',
            message: 'Message history for all rooms cleared'
        },
        statusCode: 200
    };
}

module.exports = {
    MAX_HISTORY,
    normalizeRoomName,
    initialState,
    join,
    poll,
    sendMessage,
    typing,
    buildStats,
    buildData,
    clearMessages
};
