const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL
});

const runMigration = async () => {
    try {
        await pool.query("ALTER TABLE questions ADD COLUMN IF NOT EXISTS content TEXT;");
        console.log("Successfully added content column to questions table.");
    } catch (err) {
        console.error("Error adding column:", err);
    } finally {
        pool.end();
    }
};

runMigration();
