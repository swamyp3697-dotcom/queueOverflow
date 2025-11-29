const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./stackoverflow.db');

const query = "what it the access denied";
console.log(`Testing search with query: "${query}"`);

// Tokenize and filter stop words (Same logic as server.js)
const stopWords = new Set(['what', 'is', 'the', 'it', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by']);
const keywords = query.toLowerCase().split(/[\s,?.!]+/).filter(w => w.length > 1 && !stopWords.has(w));

console.log("Extracted Keywords:", keywords);

if (keywords.length === 0) {
    console.log("No keywords found.");
    process.exit(0);
}

// Construct SQL query dynamically
const conditions = keywords.map(() => `(title LIKE ? OR summary LIKE ? OR tags LIKE ? OR error_type LIKE ?)`).join(' OR ');
const params = [];
keywords.forEach(k => {
    const p = `%${k}%`;
    params.push(p, p, p, p);
});

const sql = `SELECT id, title FROM questions WHERE ${conditions}`;

db.all(sql, params, (err, rows) => {
    if (err) {
        console.error("Error:", err);
    } else {
        console.log("Search Results:");
        rows.forEach(row => console.log(`- [${row.id}] ${row.title}`));
    }
    // Expected: Should find "AWS: S3 Access Denied 403"
});
