const express = require('express');
const { Pool } = require('pg');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const jwt = require('jsonwebtoken');
const natural = require('natural');
const multer = require('multer');
require('dotenv').config();

const app = express();
const PORT = 3000;

// PostgreSQL Connection
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
});

// Multer Storage Config
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'public/uploads/')
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname)); // e.g. 123456789.png
    }
});
const upload = multer({ storage: storage });

// Search Index (In-Memory)
const tfidf = new natural.TfIdf();
const searchIndexMap = {}; // Map internal TF-IDF index to Question ID

function buildSearchIndex() {
    console.log("Building in-memory search index...");
    pool.query("SELECT id, title, summary, tags, error_type FROM questions", (err, res) => {
        if (err) {
            // Table might not exist yet on first run
            console.log("Skipping index build (tables might not exist yet).");
            return;
        }
        const rows = res.rows;
        rows.forEach((row, index) => {
            const text = `${row.title} ${row.summary} ${row.tags} ${row.error_type}`;
            tfidf.addDocument(text);
            searchIndexMap[tfidf.documents.length - 1] = row.id;
        });
        console.log(`Indexed ${rows.length} documents.`);
    });
}

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(passport.initialize());

// Initialize Database
function initializeDatabase() {
    const schema = `
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            username TEXT UNIQUE,
            email TEXT UNIQUE,
            google_id TEXT UNIQUE,
            avatar_url TEXT,
            reputation INTEGER DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            type TEXT DEFAULT 'actual'
        );

        CREATE TABLE IF NOT EXISTS questions (
            id SERIAL PRIMARY KEY,
            title TEXT,
            module TEXT,
            environment TEXT,
            error_type TEXT,
            summary TEXT,
            snippet TEXT,
            steps TEXT,
            expected TEXT,
            observed TEXT,
            tags TEXT,
            image_url TEXT,
            author_id INTEGER REFERENCES users(id),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS answers (
            id SERIAL PRIMARY KEY,
            question_id INTEGER REFERENCES questions(id),
            root_cause TEXT,
            fix_summary TEXT,
            config_changes TEXT,
            validation_steps TEXT,
            image_url TEXT,
            author_id INTEGER REFERENCES users(id),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS comments (
            id SERIAL PRIMARY KEY,
            parent_type TEXT, -- 'question' or 'answer'
            parent_id INTEGER,
            content TEXT,
            image_url TEXT,
            author_id INTEGER REFERENCES users(id),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS votes (
            id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES users(id),
            target_type TEXT, -- 'question' or 'answer'
            target_id INTEGER,
            value INTEGER, -- 1 or -1
            UNIQUE(user_id, target_type, target_id)
        );

        CREATE TABLE IF NOT EXISTS notifications (
            id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES users(id),
            type TEXT, -- 'answer', 'comment', 'vote'
            target_id INTEGER, -- question_id to link to
            actor_id INTEGER REFERENCES users(id),
            is_read BOOLEAN DEFAULT FALSE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS posts (
            id SERIAL PRIMARY KEY,
            title TEXT,
            content TEXT, -- Markdown
            author_id INTEGER REFERENCES users(id),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        
        -- Indexes
        CREATE INDEX IF NOT EXISTS idx_questions_author ON questions(author_id);
        CREATE INDEX IF NOT EXISTS idx_answers_question ON answers(question_id);
        CREATE INDEX IF NOT EXISTS idx_answers_author ON answers(author_id);
        CREATE INDEX IF NOT EXISTS idx_comments_parent ON comments(parent_type, parent_id);
        CREATE INDEX IF NOT EXISTS idx_votes_target ON votes(target_type, target_id);
        CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
        CREATE INDEX IF NOT EXISTS idx_posts_author ON posts(author_id);
    `;

    pool.query(schema, (err, res) => {
        if (err) {
            console.error("Error initializing database:", err);
        } else {
            console.log("Database schema initialized (PostgreSQL).");

            // Add image_url columns if they don't exist (Migration)
            const migrationSql = `
                ALTER TABLE questions ADD COLUMN IF NOT EXISTS image_url TEXT;
                ALTER TABLE answers ADD COLUMN IF NOT EXISTS image_url TEXT;
                ALTER TABLE comments ADD COLUMN IF NOT EXISTS image_url TEXT;
            `;
            pool.query(migrationSql, (migErr, migRes) => {
                if (migErr) console.log("Migration note: Columns might already exist or error:", migErr.message);
                else console.log("Schema migration (image_url) applied.");

                seedData();
                buildSearchIndex();
            });
        }
    });
}

function seedData() {
    pool.query("SELECT count(*) as count FROM users", (err, res) => {
        if (err) return;
        if (parseInt(res.rows[0].count) === 0) {
            console.log("Seeding mock data...");

            // Seed Users
            const users = [
                { username: "DevUser", email: "dev@pratishthanventures.com", google_id: "mock_1", avatar_url: "", reputation: 50 },
                { username: "LeadEng", email: "lead@pratishthanventures.com", google_id: "mock_2", avatar_url: "", reputation: 600 }, // Diamond
                { username: "Architect", email: "arch@pratishthanventures.com", google_id: "mock_3", avatar_url: "", reputation: 250 } // Gold
            ];

            users.forEach(u => {
                pool.query("INSERT INTO users (username, email, google_id, avatar_url, reputation) VALUES ($1, $2, $3, $4, $5)",
                    [u.username, u.email, u.google_id, u.avatar_url, u.reputation]);
            });

            // Seed Questions (Delayed to ensure users exist)
            setTimeout(() => {
                const questions = [
                    { title: "Java: NullPointerException in PaymentService", module: "Payment-API", environment: "PROD", error_type: "Runtime Error", summary: "NPE when processing refund", snippet: "java.lang.NullPointerException at com.company.payment.Service.refund(Service.java:42)", steps: "1. Trigger refund for order #123", expected: "Refund success", observed: "500 Error", tags: "java, spring-boot, npe", author_id: 1 },
                    { title: "React: useEffect dependency loop", module: "Frontend-Dashboard", environment: "DEV", error_type: "Runtime Error", summary: "Infinite re-render in Dashboard", snippet: "Maximum update depth exceeded.", steps: "1. Open Dashboard", expected: "Load once", observed: "Browser freeze", tags: "react, javascript, hooks", author_id: 2 },
                    { title: "AWS: S3 Access Denied 403", module: "Document-Service", environment: "UAT", error_type: "Config Issue", summary: "Cannot upload invoice PDF", snippet: "com.amazonaws.services.s3.model.AmazonS3Exception: Access Denied", steps: "1. Upload PDF", expected: "200 OK", observed: "403 Forbidden", tags: "aws, s3, iam", author_id: 1 },
                    { title: "Python: Pandas memory error on large CSV", module: "Data-Pipeline", environment: "PROD", error_type: "Runtime Error", summary: "OOM killed worker", snippet: "MemoryError: Unable to allocate 50.GiB for an array", steps: "1. Process daily dump", expected: "Success", observed: "Crash", tags: "python, pandas, memory", author_id: 3 },
                    { title: "SQL: Slow query on Users table", module: "Auth-Service", environment: "PROD", error_type: "Performance", summary: "Login takes 5s", snippet: "SELECT * FROM users WHERE email LIKE '%@gmail.com'", steps: "1. Login", expected: "<500ms", observed: "5000ms", tags: "sql, postgres, performance", author_id: 2 }
                ];

                questions.forEach(q => {
                    pool.query("INSERT INTO questions (title, module, environment, error_type, summary, snippet, steps, expected, observed, tags, author_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
                        [q.title, q.module, q.environment, q.error_type, q.summary, q.snippet, q.steps, q.expected, q.observed, q.tags, q.author_id]);
                });
                console.log("Mock data seeded.");
            }, 1000);
        }
    });
}

// Passport Config
passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: process.env.CALLBACK_URL
},
    function (accessToken, refreshToken, profile, cb) {
        const email = profile.emails[0].value;
        const avatarUrl = profile.photos && profile.photos.length > 0 ? profile.photos[0].value : null;

        // Domain Restriction
        if (!email.endsWith('@pratishthanventures.com')) {
            return cb(null, false, { message: 'Unauthorized domain' });
        }

        pool.query("SELECT * FROM users WHERE google_id = $1", [profile.id], (err, res) => {
            if (err) return cb(err);
            const row = res.rows[0];

            if (!row) {
                // Create new user
                pool.query("INSERT INTO users (username, email, google_id, avatar_url, type) VALUES ($1, $2, $3, $4, 'actual') RETURNING id",
                    [profile.displayName, email, profile.id, avatarUrl], (err, resInsert) => {
                        if (err) return cb(err);
                        return cb(null, { id: resInsert.rows[0].id, username: profile.displayName, email: email, avatar_url: avatarUrl, type: 'actual' });
                    });
            } else {
                // Update avatar if changed
                if (row.avatar_url !== avatarUrl) {
                    pool.query("UPDATE users SET avatar_url = $1 WHERE id = $2", [avatarUrl, row.id]);
                    row.avatar_url = avatarUrl;
                }
                return cb(null, row);
            }
        });
    }
));

// JWT Helper
function generateTokens(user) {
    const accessToken = jwt.sign({ id: user.id, username: user.username, avatar_url: user.avatar_url }, process.env.JWT_SECRET, { expiresIn: '15m' });
    const refreshToken = jwt.sign({ id: user.id, username: user.username, avatar_url: user.avatar_url }, process.env.JWT_SECRET, { expiresIn: '7d' });
    return { accessToken, refreshToken };
}

// Middleware
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (token == null) return res.sendStatus(401);

    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) return res.sendStatus(403);
        req.user = user;
        next();
    });
}

// Auth Routes
app.get('/auth/google',
    passport.authenticate('google', { scope: ['profile', 'email'] }));

app.get('/auth/google/callback',
    passport.authenticate('google', { session: false, failureRedirect: '/login.html?error=unauthorized' }),
    function (req, res) {
        const tokens = generateTokens(req.user);
        res.redirect(`/login.html?accessToken=${tokens.accessToken}&refreshToken=${tokens.refreshToken}&username=${encodeURIComponent(req.user.username)}&id=${req.user.id}&avatar_url=${encodeURIComponent(req.user.avatar_url || '')}`);
    });

app.post('/api/refresh', (req, res) => {
    const refreshToken = req.body.token;
    if (refreshToken == null) return res.sendStatus(401);
    jwt.verify(refreshToken, process.env.JWT_SECRET, (err, user) => {
        if (err) return res.sendStatus(403);
        const tokens = generateTokens(user);
        res.json(tokens);
    });
});

// API Routes
app.use('/api', (req, res, next) => {
    if (req.path === '/refresh') return next();
    authenticateToken(req, res, next);
});

// Generic Upload API
app.post('/api/upload', upload.single('image'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const url = `/uploads/${req.file.filename}`;
    res.json({ url: url });
});

// Posts APIs
app.post('/api/posts', (req, res) => {
    const { title, content, author_id } = req.body;

    if (!title || !content) {
        return res.status(400).json({ error: "Title and Content are required." });
    }

    const sql = `INSERT INTO posts (title, content, author_id) VALUES ($1, $2, $3) RETURNING id`;
    pool.query(sql, [title, content, author_id], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ id: result.rows[0].id });
    });
});

app.get('/api/posts/:id', (req, res) => {
    const sql = `
        SELECT p.*, u.username as author_name, u.avatar_url as author_avatar,
        (SELECT COALESCE(SUM(value), 0) FROM votes WHERE target_type = 'post' AND target_id = p.id) as score
        FROM posts p
        LEFT JOIN users u ON p.author_id = u.id
        WHERE p.id = $1
    `;
    pool.query(sql, [req.params.id], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        if (result.rows.length === 0) return res.status(404).json({ error: "Post not found" });

        const post = result.rows[0];

        // Fetch comments for post
        const commentsSql = `
            SELECT c.*, u.username as author_name 
            FROM comments c
            LEFT JOIN users u ON c.author_id = u.id
            WHERE c.parent_type = 'post' AND c.parent_id = $1
            ORDER BY c.created_at ASC
        `;

        pool.query(commentsSql, [req.params.id], (err, resC) => {
            if (err) return res.status(500).json({ error: err.message });
            post.comments = resC.rows;
            res.json(post);
        });
    });
});

app.get('/api/posts', (req, res) => {
    const sql = `
        SELECT p.*, u.username as author_name,
        (SELECT COALESCE(SUM(value), 0) FROM votes WHERE target_type = 'post' AND target_id = p.id) as score,
        (SELECT COUNT(*) FROM comments WHERE parent_type = 'post' AND parent_id = p.id) as comment_count
        FROM posts p
        LEFT JOIN users u ON p.author_id = u.id
        ORDER BY p.created_at DESC
        LIMIT 20
    `;
    pool.query(sql, (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(cleanResponse(result.rows));
    });
});


// Helper to remove null/empty values
const cleanResponse = (rows) => {
    return rows.map(row => {
        const cleaned = {};
        Object.keys(row).forEach(key => {
            if (row[key] !== null && row[key] !== "" && row[key] !== undefined) {
                cleaned[key] = row[key];
            }
        });
        return cleaned;
    });
};

// Get all questions (LIMIT 20 for Home Page)
app.get('/api/questions', (req, res) => {
    const sql = `
        SELECT q.*, u.username as author_name, 
        (SELECT COUNT(*) FROM answers WHERE question_id = q.id) as answer_count,
        (SELECT COALESCE(SUM(value), 0) FROM votes WHERE target_type = 'question' AND target_id = q.id) as score
        FROM questions q
        LEFT JOIN users u ON q.author_id = u.id
        ORDER BY q.created_at DESC
        LIMIT 20
    `;
    pool.query(sql, (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(cleanResponse(result.rows));
    });
});

// Search (Unified: Questions + Posts)
app.get('/api/search', (req, res) => {
    const query = req.query.q;
    if (!query) return res.json([]);

    // 1. Stemming & Keyword Extraction
    const stopWords = new Set(['what', 'is', 'the', 'it', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by']);
    const tokenizer = new natural.WordTokenizer();
    const rawTokens = tokenizer.tokenize(query.toLowerCase());
    const keywords = rawTokens
        .filter(w => !stopWords.has(w))
        .map(w => natural.PorterStemmer.stem(w));

    if (keywords.length === 0) return res.json([]);

    // 2. SQL Search (Union Questions & Posts)
    const sqlKeywords = query.toLowerCase().split(/[\s,?.!]+/).filter(w => w.length > 1 && !stopWords.has(w));

    let scoreCalculationQ = '';
    let scoreCalculationP = '';
    const params = [];

    sqlKeywords.forEach((k, index) => {
        const p = `%${k}%`;
        // Postgres ILIKE is case insensitive
        const termScoreQ = `(CASE WHEN q.title ILIKE $${index * 4 + 1} THEN 3 ELSE 0 END) + (CASE WHEN q.tags ILIKE $${index * 4 + 2} THEN 2 ELSE 0 END) + (CASE WHEN q.summary ILIKE $${index * 4 + 3} OR q.error_type ILIKE $${index * 4 + 4} THEN 1 ELSE 0 END)`;
        scoreCalculationQ += (index > 0 ? ' + ' : '') + termScoreQ;

        // For Posts (using same params for simplicity, though indices shift if we were dynamic, here we reuse)
        // Actually, we can't easily reuse params in a UNION with different indices unless we duplicate.
        // Simpler approach: Construct the WHERE clause for both.
        params.push(p, p, p, p);
    });

    const whereConditionsQ = sqlKeywords.map((_, index) => `(q.title ILIKE $${index * 4 + 1} OR q.summary ILIKE $${index * 4 + 3} OR q.tags ILIKE $${index * 4 + 2} OR q.error_type ILIKE $${index * 4 + 4})`).join(' OR ');

    // We need separate params for the second part of UNION if we use positional args strictly, 
    // OR we can just use the same params if we construct the query carefully. 
    // To avoid param index hell, let's do two queries and merge in memory (easier to maintain & debug).

    const sqlQ = `
        SELECT q.id, q.title, q.summary, q.tags, 'question' as type, q.created_at, u.username as author_name,
        (SELECT COUNT(*) FROM answers WHERE question_id = q.id) as answer_count,
        (SELECT COALESCE(SUM(value), 0) FROM votes WHERE target_type = 'question' AND target_id = q.id) as score
        FROM questions q
        LEFT JOIN users u ON q.author_id = u.id
        WHERE ${whereConditionsQ}
        ORDER BY q.created_at DESC
        LIMIT 20
    `;

    // Re-map params for Posts (Title & Content)
    // We'll use a new set of params for the Post query to be safe
    const paramsP = [];
    sqlKeywords.forEach(k => {
        const p = `%${k}%`;
        paramsP.push(p, p);
    });

    const whereConditionsP = sqlKeywords.map((_, index) => `(p.title ILIKE $${index * 2 + 1} OR p.content ILIKE $${index * 2 + 2})`).join(' OR ');

    const sqlP = `
        SELECT p.id, p.title, SUBSTRING(p.content, 1, 200) as summary, 'post' as tags, 'post' as type, p.created_at, u.username as author_name,
        0 as answer_count,
        (SELECT COALESCE(SUM(value), 0) FROM votes WHERE target_type = 'post' AND target_id = p.id) as score
        FROM posts p
        LEFT JOIN users u ON p.author_id = u.id
        WHERE ${whereConditionsP}
        ORDER BY p.created_at DESC
        LIMIT 20
    `;

    Promise.all([
        pool.query(sqlQ, params),
        pool.query(sqlP, paramsP)
    ]).then(([resQ, resP]) => {
        let results = [...resQ.rows, ...resP.rows];

        // Hybrid Ranking & Sorting
        results = results.map(row => {
            let relevance = 0;
            // Simple scoring based on keyword presence in title
            sqlKeywords.forEach(kw => {
                if (row.title.toLowerCase().includes(kw)) relevance += 5;
                if (row.summary && row.summary.toLowerCase().includes(kw)) relevance += 2;
                if (row.tags && row.tags.toLowerCase().includes(kw)) relevance += 3;
            });

            // Add fuzzy bonus
            sqlKeywords.forEach(kw => {
                const dist = natural.JaroWinklerDistance(kw, row.title.toLowerCase());
                if (dist > 0.9) relevance += 2;
            });

            return { ...row, relevance_score: relevance + parseInt(row.score) };
        });

        results.sort((a, b) => b.relevance_score - a.relevance_score);
        res.json(results.slice(0, 20));

    }).catch(err => {
        res.status(500).json({ error: err.message });
    });
});

// Get single question
app.get('/api/questions/:id', (req, res) => {
    const questionId = req.params.id;
    const questionSql = `
        SELECT q.*, u.username as author_name,
        (SELECT COALESCE(SUM(value), 0) FROM votes WHERE target_type = 'question' AND target_id = q.id) as score
        FROM questions q
        LEFT JOIN users u ON q.author_id = u.id
        WHERE q.id = $1
    `;

    pool.query(questionSql, [questionId], (err, resQ) => {
        if (err) return res.status(500).json({ error: err.message });
        const question = resQ.rows[0];
        if (!question) return res.status(404).json({ error: "Question not found" });

        const answersSql = `
            SELECT a.*, u.username as author_name,
            (SELECT COALESCE(SUM(value), 0) FROM votes WHERE target_type = 'answer' AND target_id = a.id) as score
            FROM answers a
            LEFT JOIN users u ON a.author_id = u.id
            WHERE a.question_id = $1
            ORDER BY score DESC, a.created_at DESC
        `;

        pool.query(answersSql, [questionId], (err, resA) => {
            if (err) return res.status(500).json({ error: err.message });
            question.answers = resA.rows;

            // Fetch comments for question and answers
            const commentsSql = `
                SELECT c.*, u.username as author_name 
                FROM comments c
                LEFT JOIN users u ON c.author_id = u.id
                WHERE (c.parent_type = 'question' AND c.parent_id = $1)
                   OR (c.parent_type = 'answer' AND c.parent_id IN (SELECT id FROM answers WHERE question_id = $1))
                ORDER BY c.created_at ASC
            `;

            pool.query(commentsSql, [questionId], (err, resC) => {
                if (err) return res.status(500).json({ error: err.message });
                const allComments = resC.rows;

                question.comments = allComments.filter(c => c.parent_type === 'question');
                question.answers.forEach(a => {
                    a.comments = allComments.filter(c => c.parent_type === 'answer' && c.parent_id === a.id);
                });

                res.json(question);
            });
        });
    });
});

// Create question with Image Upload
app.post('/api/questions', upload.single('image'), (req, res) => {
    const { title, content, tags, author_id } = req.body;

    if (!title || !content) {
        return res.status(400).json({ error: "Title and Description are required." });
    }

    const image_url = req.file ? `/uploads/${req.file.filename}` : null;

    // Insert with new content field. Old fields left null.
    const sql = `INSERT INTO questions (title, content, tags, image_url, author_id) VALUES ($1, $2, $3, $4, $5) RETURNING id`;
    const params = [title, content, tags, image_url, author_id];

    pool.query(sql, params, (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        const newId = result.rows[0].id;

        // Update Search Index
        const text = `${title} ${content} ${tags}`;
        tfidf.addDocument(text);
        searchIndexMap[tfidf.documents.length - 1] = newId;

        res.json({ id: newId });
    });
});

// Create Answer with Image Upload
app.post('/api/questions/:id/answers', upload.single('image'), (req, res) => {
    const questionId = req.params.id;
    const { root_cause, fix_summary, config_changes, validation_steps, author_id } = req.body;
    const image_url = req.file ? `/uploads/${req.file.filename}` : null;

    const sql = `INSERT INTO answers (question_id, root_cause, fix_summary, config_changes, validation_steps, image_url, author_id) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`;

    pool.query(sql, [questionId, root_cause, fix_summary, config_changes, validation_steps, image_url, author_id], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });

        // Notify Question Author
        pool.query("SELECT author_id FROM questions WHERE id = $1", [questionId], (err, resQ) => {
            if (!err && resQ.rows[0]) {
                const targetUserId = resQ.rows[0].author_id;
                if (targetUserId !== author_id) {
                    pool.query("INSERT INTO notifications (user_id, type, target_id, actor_id) VALUES ($1, 'answer', $2, $3)",
                        [targetUserId, questionId, author_id]);
                }
            }
        });

        res.json({ id: result.rows[0].id });
    });
});

// Create Comment with Image Upload
app.post('/api/comments', upload.single('image'), (req, res) => {
    const { parent_type, parent_id, content, author_id } = req.body;
    const image_url = req.file ? `/uploads/${req.file.filename}` : null;

    const sql = `INSERT INTO comments (parent_type, parent_id, content, image_url, author_id) VALUES ($1, $2, $3, $4, $5) RETURNING id`;

    pool.query(sql, [parent_type, parent_id, content, image_url, author_id], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });

        // Notify Parent Author
        let fetchAuthorSql = "";
        if (parent_type === 'question') fetchAuthorSql = "SELECT author_id, id as target_id FROM questions WHERE id = $1";
        else if (parent_type === 'answer') fetchAuthorSql = "SELECT author_id, question_id as target_id FROM answers WHERE id = $1";
        else if (parent_type === 'post') fetchAuthorSql = "SELECT author_id, id as target_id FROM posts WHERE id = $1";

        pool.query(fetchAuthorSql, [parent_id], (err, resParent) => {
            if (!err && resParent.rows[0]) {
                const targetUserId = resParent.rows[0].author_id;
                const targetId = parent_type === 'question' ? parent_id : resParent.rows[0].target_id; // Always link to question

                if (targetUserId !== author_id) {
                    pool.query("INSERT INTO notifications (user_id, type, target_id, actor_id) VALUES ($1, 'comment', $2, $3)",
                        [targetUserId, targetId, author_id]);
                }
            }
        });

        res.json({ id: result.rows[0].id });
    });
});

// Vote
app.post('/api/vote', (req, res) => {
    const { user_id, target_type, target_id, value } = req.body;
    const sql = `
        INSERT INTO votes (user_id, target_type, target_id, value) 
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (user_id, target_type, target_id) 
        DO UPDATE SET value = EXCLUDED.value
    `;

    pool.query(sql, [user_id, target_type, target_id, value], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });

        // Update Reputation
        // Simple logic: +10 for upvote, -2 for downvote (applied to author)
        // We need to find the author first
        let tableName;
        if (target_type === 'question') tableName = 'questions';
        else if (target_type === 'answer') tableName = 'answers';
        else if (target_type === 'post') tableName = 'posts';
        else return res.status(400).json({ error: "Invalid target_type for vote" });

        pool.query(`SELECT author_id FROM ${tableName} WHERE id = $1`, [target_id], (err, resAuthor) => {
            if (!err && resAuthor.rows[0]) {
                const authorId = resAuthor.rows[0].author_id;
                const repChange = value > 0 ? 10 : -2;
                if (authorId !== user_id) { // Don't rep self-votes
                    pool.query("UPDATE users SET reputation = reputation + $1 WHERE id = $2", [repChange, authorId]);
                }
            }
        });

        res.json({ success: true });
    });
});

// Notifications
app.get('/api/notifications', (req, res) => {
    const userId = req.user.id;
    const sql = `
        SELECT n.*, u.username as actor_name, u.avatar_url as actor_avatar
        FROM notifications n
        LEFT JOIN users u ON n.actor_id = u.id
        WHERE n.user_id = $1
        ORDER BY n.created_at DESC
        LIMIT 20
    `;
    pool.query(sql, [userId], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(result.rows);
    });
});

app.post('/api/notifications/read', (req, res) => {
    const userId = req.user.id;
    pool.query("UPDATE notifications SET is_read = TRUE WHERE user_id = $1", [userId], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// Top Users
app.get('/api/users/top', (req, res) => {
    pool.query("SELECT username, avatar_url, reputation FROM users ORDER BY reputation DESC LIMIT 5", (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(result.rows);
    });
});

// Start Server
pool.connect((err, client, release) => {
    if (err) {
        console.error('Error acquiring client', err.stack);
    } else {
        console.log('Connected to PostgreSQL database.');
        initializeDatabase();
    }
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
