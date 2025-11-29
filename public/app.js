const API_URL = 'http://localhost:3000/api';

// User Management
let currentUser = JSON.parse(localStorage.getItem('currentUser'));
const accessToken = localStorage.getItem('accessToken');

function checkAuth() {
    // Handle Google Redirect
    const params = new URLSearchParams(window.location.search);
    if (params.has('accessToken')) {
        const user = {
            id: params.get('id'),
            username: params.get('username'),
            avatar_url: params.get('avatar_url'),
            type: 'actual'
        };
        localStorage.setItem('currentUser', JSON.stringify(user));
        localStorage.setItem('accessToken', params.get('accessToken'));
        localStorage.setItem('refreshToken', params.get('refreshToken'));
        window.location.href = '/index.html';
        return;
    }

    if (params.has('error')) {
        const errDiv = document.getElementById('login-error');
        if (errDiv) errDiv.textContent = "Authentication failed. Ensure you use a @pratishthanventures.com email.";
    }

    if (!currentUser && !window.location.pathname.includes('login.html')) {
        window.location.replace('/login.html'); // Use replace to prevent back button history
        return;
    }

    // If on login page but logged in, go to index
    if (currentUser && window.location.pathname.includes('login.html')) {
        window.location.replace('/index.html');
        return;
    }

    if (currentUser) {
        const userDisplay = document.getElementById('user-display');
        if (userDisplay) {
            // Calculate reputation class
            let repClass = '';
            const rep = currentUser.reputation || 0;
            if (rep >= 500) repClass = 'rep-diamond'; // Diamond for 500+
            else if (rep >= 100) repClass = 'rep-gold';
            else if (rep > 0) repClass = 'rep-bronze';

            userDisplay.innerHTML = `
                <img src="${currentUser.avatar_url || 'https://ui-avatars.com/api/?name=' + encodeURIComponent(currentUser.username)}" class="user-avatar ${repClass}" alt="Avatar">
                <span>${currentUser.username}</span>
            `;

            // Load Notifications
            loadNotifications();
        }
    }

    // Show content
    document.body.classList.add('loaded');

    // Load Top Users if on index
    if (document.getElementById('top-users-list')) {
        loadTopUsers();
    }
}

// Login (Anonymous removed)
// Google login is handled via href in login.html

// Authenticated Fetch Wrapper
async function authFetch(url, options = {}) {
    const token = localStorage.getItem('accessToken');
    const headers = { ...options.headers };

    if (token) {
        headers['Authorization'] = `Bearer ${token}`;
    }

    const res = await fetch(url, { ...options, headers });

    if (res.status === 401 || res.status === 403) {
        // Try refresh
        const refreshToken = localStorage.getItem('refreshToken');
        if (refreshToken) {
            const refreshRes = await fetch(`${API_URL}/refresh`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token: refreshToken })
            });

            if (refreshRes.ok) {
                const tokens = await refreshRes.json();
                localStorage.setItem('accessToken', tokens.accessToken);
                localStorage.setItem('refreshToken', tokens.refreshToken);
                // Retry original request
                headers['Authorization'] = `Bearer ${tokens.accessToken}`;
                return fetch(url, { ...options, headers });
            }
        }
        // Logout if refresh fails
        localStorage.clear();
        window.location.href = '/login.html';
    }
    return res;
}

// Fetch Questions
async function loadQuestions() {
    const container = document.getElementById('questions-container');
    if (!container) return;

    const res = await authFetch(`${API_URL}/questions`);
    const questions = await res.json();

    container.innerHTML = questions.map(q => `
        <div class="question-item">
            <div class="stats">
                <div class="stat-box votes">${q.score} votes</div>
                <div class="stat-box">${q.answer_count} answers</div>
            </div>
            <div class="question-content">
                <h3><a href="/question.html?id=${q.id}">${q.title}</a></h3>
                <p>${q.summary}</p>
                <div class="tags">
                    ${q.tags ? q.tags.split(',').map(t => `<span class="tag">${t.trim()}</span>`).join('') : ''}
                </div>
                <div class="meta-info">
                    <span>Asked by ${q.author_name}</span>
                    <span>${new Date(q.created_at).toLocaleDateString()}</span>
                </div>
            </div>
        </div>
    `).join('');
}

// Post Question
async function postQuestion(e) {
    e.preventDefault();
    const formData = new FormData(e.target);
    const data = Object.fromEntries(formData.entries());
    data.author_id = currentUser.id;

    const res = await authFetch(`${API_URL}/questions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    });

    if (res.ok) {
        window.location.href = '/index.html';
    }
}

// Load Question Detail
async function loadQuestionDetail() {
    const params = new URLSearchParams(window.location.search);
    const id = params.get('id');
    if (!id) return;

    const res = await authFetch(`${API_URL}/questions/${id}`);
    const q = await res.json();

    document.getElementById('question-title').textContent = q.title;
    document.getElementById('question-meta').innerHTML = `
        Asked by <strong>${q.author_name}</strong> on ${new Date(q.created_at).toLocaleDateString()}
        | Module: ${q.module} | Env: ${q.environment}
    `;

    // Render Question Body
    const bodyHtml = `
        <div class="md-content">
            <p><strong>Error Summary:</strong> ${q.summary}</p>
            <p><strong>Error Type:</strong> ${q.error_type}</p>
            <pre><code>${q.snippet}</code></pre>
            <p><strong>Steps to Reproduce:</strong><br>${q.steps}</p>
            <p><strong>Expected:</strong> ${q.expected}</p>
            <p><strong>Observed:</strong> ${q.observed}</p>
        </div>
    `;
    document.getElementById('question-body').innerHTML = bodyHtml;
    document.getElementById('question-score').textContent = q.score;

    // Render Answers
    const answersContainer = document.getElementById('answers-container');
    answersContainer.innerHTML = q.answers.map(a => `
        <div class="card answer">
            <div class="flex" style="display:flex;">
                <div class="vote-controls">
                    <button class="vote-btn" onclick="vote('answer', ${a.id}, 1)">▲</button>
                    <span>${a.score}</span>
                    <button class="vote-btn" onclick="vote('answer', ${a.id}, -1)">▼</button>
                </div>
                <div style="flex:1;">
                    <div class="md-content">
                        <p><strong>Root Cause:</strong> ${a.root_cause}</p>
                        <p><strong>Fix:</strong> ${a.fix_summary}</p>
                        <pre><code>${a.config_changes || 'No code changes'}</code></pre>
                        <p><strong>Validation:</strong> ${a.validation_steps}</p>
                    </div>
                    <div class="meta-info">
                        <span>Answered by ${a.author_name}</span>
                    </div>
                    
                    <!-- Comments -->
                    <div class="comments-section">
                        ${a.comments.map(c => `<div class="comment">${c.content} - <small>${c.author_name}</small></div>`).join('')}
                        <form onsubmit="postComment(event, 'answer', ${a.id})" style="margin-top:1rem; display:flex; gap:0.5rem;">
                            <input type="text" name="content" placeholder="Add a comment..." required>
                            <button type="submit" class="btn btn-secondary" style="padding:0.5rem;">Post</button>
                        </form>
                    </div>
                </div>
            </div>
        </div>
    `).join('');

    // Question Comments
    const qComments = document.getElementById('question-comments');
    qComments.innerHTML = q.comments.map(c => `<div class="comment">${c.content} - <small>${c.author_name}</small></div>`).join('');

    // Setup Answer Form
    document.getElementById('answer-form').onsubmit = (e) => postAnswer(e, id);

    // Setup Vote Buttons for Question
    document.getElementById('q-upvote').onclick = () => vote('question', id, 1);
    document.getElementById('q-downvote').onclick = () => vote('question', id, -1);
}

// Post Answer
async function postAnswer(e, questionId) {
    e.preventDefault();
    const formData = new FormData(e.target);
    const data = Object.fromEntries(formData.entries());
    data.author_id = currentUser.id;

    const res = await authFetch(`${API_URL}/questions/${questionId}/answers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    });

    if (res.ok) {
        window.location.reload();
    }
}

// Post Comment
async function postComment(e, type, id) {
    e.preventDefault();
    const input = e.target.querySelector('input');
    const content = input.value;

    const res = await authFetch(`${API_URL}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            parent_type: type,
            parent_id: id,
            content,
            author_id: currentUser.id
        })
    });

    if (res.ok) {
        window.location.reload();
    }
}

// Vote
async function vote(type, id, value) {
    const res = await authFetch(`${API_URL}/vote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            user_id: currentUser.id,
            target_type: type,
            target_id: id,
            value
        })
    });

    if (res.ok) {
        window.location.reload();
    }
}

// Init
document.addEventListener('DOMContentLoaded', () => {
    checkAuth();

    if (document.getElementById('questions-container')) loadQuestions();
    if (document.getElementById('question-detail')) loadQuestionDetail();

    const askForm = document.getElementById('ask-form');
    if (askForm) askForm.addEventListener('submit', postQuestion);

    // Search Logic
    const searchInput = document.getElementById('global-search');
    const searchResults = document.getElementById('search-results');
    let debounceTimer;

    if (searchInput && searchResults) {
        // Redirect on Enter
        searchInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                const query = e.target.value.trim();
                if (query.length > 0) {
                    window.location.href = `/search.html?q=${encodeURIComponent(query)}`;
                }
            }
        });

        searchInput.addEventListener('input', (e) => {
            clearTimeout(debounceTimer);
            const query = e.target.value.trim();

            if (query.length < 2) {
                searchResults.classList.remove('active');
                return;
            }

            debounceTimer = setTimeout(async () => {
                try {
                    const res = await authFetch(`${API_URL}/search?q=${encodeURIComponent(query)}`);
                    const results = await res.json();

                    if (results.length > 0) {
                        // Show top 5 preview results
                        searchResults.innerHTML = results.slice(0, 5).map(q => `
                            <a href="/question.html?id=${q.id}" class="search-result-item">
                                <div class="search-result-title">${q.title}</div>
                                <div class="search-result-meta">
                                    ${q.sql_score || 0} votes • ${q.answer_count} answers • Match: ${q.relevance_score.toFixed(0)}
                                </div>
                            </a>
                        `).join('') + `
                            <a href="/search.html?q=${encodeURIComponent(query)}" class="search-result-item view-all">
                                View all results for "${query}"
                            </a>
                        `;
                        searchResults.classList.add('active');
                    } else {
                        searchResults.innerHTML = '<div class="search-result-item" style="cursor:default;">No results found</div>';
                        searchResults.classList.add('active');
                    }
                } catch (err) {
                    console.error('Search error:', err);
                }
            }, 300);
        });

        // Close search when clicking outside
        document.addEventListener('click', (e) => {
            if (!searchInput.contains(e.target) && !searchResults.contains(e.target)) {
                searchResults.classList.remove('active');
            }
        });
    }
});

// Load Notifications
async function loadNotifications() {
    const btn = document.getElementById('notif-btn');
    const badge = document.getElementById('notif-badge');
    const dropdown = document.getElementById('notif-dropdown');

    if (!btn) return;

    const res = await authFetch(`${API_URL}/notifications`);
    const notifs = await res.json();

    const unreadCount = notifs.filter(n => !n.is_read).length;
    if (unreadCount > 0) {
        badge.textContent = unreadCount;
        badge.style.display = 'block';
    } else {
        badge.style.display = 'none';
    }

    btn.onclick = async () => {
        dropdown.classList.toggle('active');
        if (dropdown.classList.contains('active') && unreadCount > 0) {
            await authFetch(`${API_URL}/notifications/read`, { method: 'POST' });
            badge.style.display = 'none';
        }
    };

    if (notifs.length === 0) {
        dropdown.innerHTML = '<div style="padding: 1rem; text-align: center; color: var(--text-secondary);">No new notifications</div>';
    } else {
        dropdown.innerHTML = notifs.map(n => `
            <a href="/question.html?id=${n.target_id}" class="search-result-item">
                <div style="display:flex; gap:0.5rem; align-items:center;">
                    <img src="${n.actor_avatar || 'https://ui-avatars.com/api/?name=' + encodeURIComponent(n.actor_name)}" class="user-avatar" style="width:24px; height:24px;">
                    <div>
                        <div style="font-size:0.9rem;"><strong>${n.actor_name}</strong> ${n.type === 'answer' ? 'answered your question' : 'commented on your post'}</div>
                        <div style="font-size:0.7rem; color:var(--text-secondary);">${new Date(n.created_at).toLocaleDateString()}</div>
                    </div>
                </div>
            </a>
        `).join('');
    }
}

// Load Top Users
async function loadTopUsers() {
    const container = document.getElementById('top-users-list');
    if (!container) return;

    const res = await authFetch(`${API_URL}/users/top`);
    const users = await res.json();

    container.innerHTML = users.map(u => {
        let repClass = '';
        if (u.reputation >= 500) repClass = 'rep-diamond';
        else if (u.reputation >= 100) repClass = 'rep-gold';
        else if (u.reputation > 0) repClass = 'rep-bronze';

        return `
        <div style="display:flex; align-items:center; gap:0.75rem; padding:0.5rem 0; border-bottom:1px solid var(--border);">
            <img src="${u.avatar_url || 'https://ui-avatars.com/api/?name=' + encodeURIComponent(u.username)}" class="user-avatar ${repClass}" alt="${u.username}">
            <div>
                <div style="font-weight:500;">${u.username}</div>
                <div style="font-size:0.8rem; color:var(--text-secondary);">${u.reputation} rep</div>
            </div>
        </div>
    `}).join('');
}
