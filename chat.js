function getMetaContent(name) {
    const el = document.querySelector(`meta[name="${name}"]`);
    return el && el.content ? el.content.trim() : '';
}

function apiUrl(path) {
    const base = getMetaContent('viberoom-api-base').replace(/\/$/, '');
    return base ? `${base}${path}` : path;
}

const SESSION_STORAGE_KEY = 'viberoom-session-id';

function getOrCreateSessionId() {
    let id = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!id) {
        id =
            (typeof crypto !== 'undefined' && crypto.randomUUID && crypto.randomUUID()) ||
            `sess-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
        localStorage.setItem(SESSION_STORAGE_KEY, id);
    }
    return id;
}

let sessionId = '';
let pollTimer = null;
let lastMessageId = 0;
let lastEventId = 0;
let isDemoMode = false;

function stopPolling() {
    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
    }
}

async function pollOnce() {
    if (isDemoMode || !sessionId || !currentUsername) return;
    try {
        const params = new URLSearchParams({
            room: currentRoom,
            sessionId,
            sinceMessageId: String(lastMessageId),
            sinceEventId: String(lastEventId)
        });
        const res = await fetch(apiUrl(`/api/poll?${params}`));
        const data = await res.json();
        if (!res.ok) return;

        (data.messages || []).forEach(handleChatMessage);
        (data.events || []).forEach((ev) => {
            if (ev.kind === 'status') handleStatusMessage(ev.text);
        });
        handleUserList(data.users || []);

        typingUsers.clear();
        (data.typing || []).forEach((u) => {
            if (u && u !== currentUsername) typingUsers.add(u);
        });
        updateTypingIndicator();

        if (typeof data.lastMessageId === 'number') {
            lastMessageId = data.lastMessageId;
        }
        if (typeof data.lastEventId === 'number') {
            lastEventId = data.lastEventId;
        }
    } catch {
        /* ignore transient poll errors */
    }
}

function startPolling() {
    stopPolling();
    pollTimer = setInterval(pollOnce, 1600);
}

function enableDemoMode() {
    if (isDemoMode) return;
    isDemoMode = true;
    stopPolling();
    initDemoContent();
}

async function postTyping(isTyping) {
    if (isDemoMode || !sessionId) return;
    try {
        await fetch(apiUrl('/api/typing'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId, isTyping })
        });
    } catch {
        /* ignore */
    }
}

async function sendLiveMessage(text) {
    const res = await fetch(apiUrl('/api/send'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, text })
    });
    let data = {};
    try {
        data = await res.json();
    } catch {
        /* ignore */
    }
    if (!res.ok || !data.ok) {
        alert(data.error || 'Could not send message');
        return false;
    }
    return true;
}

function handleDemoEmit(event, data) {
    console.log(`[DEMO] Emitting ${event}:`, data);

    if (event === 'join') {
        const username = typeof data === 'string' ? data : data.username;
        const room = typeof data === 'string' ? 'General' : (data.room || 'General');
        setTimeout(() => {
            handleStatusMessage(`${username} joined ${room} (Demo)`);
        }, 500);
    }

    if (event === 'chat message') {
        setTimeout(() => {
            handleChatMessage({
                user: currentUsername,
                text: data,
                time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            });
        }, 100);
    }
}

function handleStatusMessage(msg) {
    if (!messagesContainer) return;
    const div = document.createElement('div');
    div.classList.add('status-msg');
    div.textContent = msg;
    messagesContainer.appendChild(div);
    scrollToBottom();
}

function handleChatMessage(data) {
    if (!messagesContainer) return;
    const div = document.createElement('div');
    div.classList.add('message');

    if (data.user === currentUsername) {
        div.classList.add('sent');
    } else {
        div.classList.add('received');
    }

    div.innerHTML = `
        <span class="user">${data.user}</span>
        <span class="text">${data.text}</span>
        <span class="time">${data.time}</span>
    `;

    messagesContainer.appendChild(div);
    scrollToBottom();
}

function handleUserList(users) {
    if (!userList) return;
    userList.innerHTML = '';
    users.forEach((user) => {
        const li = document.createElement('li');
        li.textContent = user;
        userList.appendChild(li);
    });
}

let joinScreen, chatScreen, usernameInput, joinBtn, messageForm, messageInput, messagesContainer, userList, leaveBtn;
let roomTitleEl = null;
let refreshStatsBtn, clearHistoryBtn, healthStatus, statsText;
let searchInput, typingIndicator;
let typingTimeout;
const typingUsers = new Set();
let roomSelect;

async function tryLiveJoin(username, room) {
    const res = await fetch(apiUrl('/api/join'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, room, sessionId })
    });
    let data = {};
    try {
        data = await res.json();
    } catch {
        /* ignore */
    }
    if (!res.ok || !data.ok) {
        throw new Error(data.error || 'Could not join room');
    }

    if (!messagesContainer) return;

    messagesContainer.innerHTML = '';
    typingUsers.clear();
    updateTypingIndicator();

    (data.messages || []).forEach(handleChatMessage);
    (data.events || []).forEach((ev) => {
        if (ev.kind === 'status') handleStatusMessage(ev.text);
    });
    handleUserList(data.users || []);

    lastMessageId = typeof data.lastMessageId === 'number' ? data.lastMessageId : 0;
    lastEventId = typeof data.lastEventId === 'number' ? data.lastEventId : 0;

    joinScreen.classList.remove('active');
    chatScreen.classList.add('active');
    if (roomTitleEl) {
        roomTitleEl.textContent = `${currentRoom} Lounge`;
    }

    startPolling();
    refreshServerStats();
}

function initUI() {
    sessionId = getOrCreateSessionId();
    roomTitleEl = document.getElementById('room-name');

    joinScreen = document.getElementById('join-screen');
    chatScreen = document.getElementById('chat-screen');
    usernameInput = document.getElementById('username-input');
    joinBtn = document.getElementById('join-btn');
    roomSelect = document.getElementById('room-select');
    messageForm = document.getElementById('chat-form');
    messageInput = document.getElementById('message-input');
    messagesContainer = document.getElementById('message-container');
    userList = document.getElementById('user-list');
    leaveBtn = document.getElementById('leave-btn');
    refreshStatsBtn = document.getElementById('refresh-stats-btn');
    clearHistoryBtn = document.getElementById('clear-history-btn');
    healthStatus = document.getElementById('health-status');
    statsText = document.getElementById('stats-text');
    searchInput = document.getElementById('search-input');
    typingIndicator = document.getElementById('typing-indicator');

    joinBtn.addEventListener('click', async () => {
        const username = usernameInput.value.trim();
        const room = roomSelect.value;
        if (!username) {
            alert('Please enter a username');
            return;
        }

        currentUsername = username;
        currentRoom = room;

        if (isDemoMode) {
            handleDemoEmit('join', { username, room });
            joinScreen.classList.remove('active');
            chatScreen.classList.add('active');
            if (roomTitleEl) {
                roomTitleEl.textContent = `${currentRoom} Lounge`;
            }
            refreshServerStats();
            return;
        }

        try {
            await tryLiveJoin(username, room);
        } catch (err) {
            alert(err.message || 'Join failed');
        }
    });

    messageForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const message = messageInput.value.trim();

        if (!message) return;

        if (isDemoMode) {
            handleDemoEmit('chat message', message);
            messageInput.value = '';
            messageInput.focus();
            return;
        }

        const ok = await sendLiveMessage(message);
        if (ok) {
            await postTyping(false);
            messageInput.value = '';
            messageInput.focus();
            pollOnce();
            refreshServerStats();
        }
    });

    leaveBtn.addEventListener('click', () => {
        stopPolling();
        window.location.reload();
    });

    refreshStatsBtn.addEventListener('click', refreshServerStats);
    clearHistoryBtn.addEventListener('click', clearChatHistory);

    usernameInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') joinBtn.click();
    });

    messageInput.addEventListener('input', handleTypingInput);
    searchInput.addEventListener('input', applyMessageFilter);

    fetch(apiUrl('/api/health'))
        .then((r) => {
            if (!r.ok) enableDemoMode();
        })
        .catch(() => enableDemoMode());

    checkServerHealth();
}

let currentUsername = '';
let currentRoom = 'General';

function scrollToBottom() {
    if (messagesContainer) {
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }
}

function handleTypingInput() {
    if (!currentUsername) return;
    const hasText = messageInput.value.trim().length > 0;
    postTyping(hasText);
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
        postTyping(false);
    }, 1200);
}

function updateTypingIndicator() {
    if (!typingIndicator) return;
    const users = Array.from(typingUsers);
    if (users.length === 0) {
        typingIndicator.textContent = '';
        return;
    }
    if (users.length === 1) {
        typingIndicator.textContent = `${users[0]} is typing...`;
        return;
    }
    typingIndicator.textContent = `${users.join(', ')} are typing...`;
}

function applyMessageFilter() {
    if (!messagesContainer || !searchInput) return;
    const query = searchInput.value.trim().toLowerCase();
    const allMessages = messagesContainer.querySelectorAll('.message');
    allMessages.forEach((msg) => {
        const text = msg.innerText.toLowerCase();
        msg.style.display = text.includes(query) ? '' : 'none';
    });
}

async function checkServerHealth() {
    if (!healthStatus) return;
    try {
        const response = await fetch(apiUrl('/api/health'));
        if (!response.ok) {
            throw new Error('Health check failed');
        }
        const data = await response.json();
        healthStatus.textContent = `Server: Online (${data.uptime_seconds}s uptime)`;
    } catch (error) {
        healthStatus.textContent = 'Server: Offline or demo mode';
    }
}

async function refreshServerStats() {
    if (!statsText) return;
    await checkServerHealth();
    try {
        const response = await fetch(apiUrl(`/api/stats?room=${encodeURIComponent(currentRoom)}`));
        if (!response.ok) {
            throw new Error('Stats fetch failed');
        }
        const data = await response.json();
        statsText.textContent = `Stats: ${data.room_active_users} users, ${data.total_messages_stored} messages in ${data.room}`;
    } catch (error) {
        statsText.textContent = 'Stats: unavailable in demo mode';
    }
}

async function clearChatHistory() {
    if (!confirm('Clear all chat messages from server memory?')) {
        return;
    }
    if (isDemoMode) {
        if (!messagesContainer) return;
        messagesContainer.innerHTML = '';
        handleStatusMessage('Demo chat cleared (no server — messages are only on this page)');
        if (statsText) {
            statsText.textContent = `Stats: demo, 0 messages in ${currentRoom}`;
        }
        return;
    }
    try {
        const response = await fetch(apiUrl(`/api/messages?room=${encodeURIComponent(currentRoom)}`), {
            method: 'DELETE'
        });
        if (!response.ok) {
            throw new Error('Failed to clear history');
        }
        messagesContainer.innerHTML = '';
        lastMessageId = 0;
        lastEventId = 0;
        handleStatusMessage('Chat history cleared successfully');
        pollOnce();
        refreshServerStats();
    } catch (error) {
        alert('Could not clear history. Run npm start so the Node server is up, or fix viberoom-api-base.');
    }
}

function initDemoContent() {
    if (!messagesContainer || !userList) return;

    const demoMessages = [
        { user: 'Luna_Love', text: 'Hiiii! Welcome to our chat room! 🎀☁️✨', time: '09:00 AM' },
        { user: 'Chat_Kitty', text: ' So happy you are here 🐾 Hope you like the new bubbly theme! ', time: '09:01 AM' },
        { user: 'Star_Gazer', text: 'It looks so pretty! The baby blue is perfect ☁️💙', time: '09:05 AM' }
    ];

    const demoUsers = ['alice-123', 'Star_Gazer', 'bob_120'];

    messagesContainer.innerHTML = '';
    demoMessages.forEach((data) => {
        const div = document.createElement('div');
        div.classList.add('message', 'received');
        div.innerHTML = `
            <span class="user">${data.user}</span>
            <span class="text">${data.text}</span>
            <span class="time">${data.time}</span>
        `;
        messagesContainer.appendChild(div);
    });

    userList.innerHTML = '';
    demoUsers.forEach((user) => {
        const li = document.createElement('li');
        li.textContent = user;
        userList.appendChild(li);
    });

    if (healthStatus) {
        healthStatus.textContent = 'Server: Demo mode';
    }
    if (statsText) {
        statsText.textContent = `Stats: ${demoUsers.length} users, ${demoMessages.length} demo messages in ${currentRoom}`;
    }
    if (typingIndicator) {
        typingIndicator.textContent = '';
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initUI);
} else {
    initUI();
}
