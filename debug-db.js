
import { pool } from "./services/db.js";

async function debug() {
    try {
        console.log("--- DEBUGGING HANDOFFS ---");
        const res = await pool.query(`
            SELECT 
                m.id, 
                m.conversation_id, 
                m.handoff_payload, 
                c.thread_id,
                c.id as conv_id_from_join
            FROM messages m
            LEFT JOIN conversations c ON m.conversation_id = c.id
            WHERE m.handoff_payload IS NOT NULL
            ORDER BY m.created_at DESC
            LIMIT 5
        `);

        console.log(`Found ${res.rows.length} handoffs.`);
        res.rows.forEach((r, i) => {
            console.log(`\n[${i}] Message ID: ${r.id}, Conv ID: ${r.conversation_id}`);
            console.log(`    Joined Conv ID: ${r.conv_id_from_join} (If null, JOIN failed)`);
            console.log(`    Thread ID: ${r.thread_id}`);
            console.log(`    Payload Type: ${typeof r.handoff_payload}`);
            console.log(`    Payload:`, JSON.stringify(r.handoff_payload, null, 2));
        });

        if (res.rows.length > 0) {
            const tid = res.rows[0].thread_id;
            if (tid) {
                console.log(`\n--- CHECKING MESSAGES FOR THREAD ${tid} ---`);
                const mRes = await pool.query(`
                    SELECT count(*) as cnt FROM messages m
                    JOIN conversations c ON m.conversation_id = c.id
                    WHERE c.thread_id = $1
                 `, [tid]);
                console.log(`Message count for thread: ${mRes.rows[0].cnt}`);
            }
        }

    } catch (e) {
        console.error(e);
    } finally {
        await pool.end();
    }
}

debug();
