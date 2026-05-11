const cron = require("node-cron");
const { createClient } = require("@supabase/supabase-js");
const { sendActiveUpdateEmail, sendRenewalEmail, sendUpsellEmail } = require("./mailer");
const { DateTime } = require("luxon");
require("dotenv").config();

// Dummy Table Names for Testing
// const USERS_TABLE = "whopost_users_dummy";
// const TRANSACTIONS_TABLE = "whoposted_transactions_dummy";

// Production Table Names
const USERS_TABLE = "whopost_users";
const TRANSACTIONS_TABLE = "whoposted_transactions";
const JOBS_TABLE = "daily_linkedin_jobs_report";

// Verify Environment Variables
const requiredEnv = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "MS_CLIENT_ID", "MS_TENANT_ID", "MS_CLIENT_SECRET", "MS_SENDER_EMAIL"];
const missingEnv = requiredEnv.filter(key => !process.env[key]);

if (missingEnv.length > 0) {
    console.error(`CRITICAL ERROR: Missing environment variables: ${missingEnv.join(", ")}`);
    process.exit(1);
}

// Initialize Supabase Client
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function processDailyEmails() {
    const istTime = DateTime.now().setZone('Asia/Kolkata').toFormat('yyyy-MM-dd HH:mm:ss');
    console.log(`[${istTime}] Starting production email run...`);

    try {
        // 1. Fetch 3 latest jobs from the last 24 hours
        const last24Hours = DateTime.now().minus({ hours: 24 }).toISO();
        const { data: latestJobs, error: jobsError } = await supabase
            .from(JOBS_TABLE)
            .select("job_title, company, poster_profile_url")
            .gte("created_at", last24Hours)
            .order("created_at", { ascending: false })
            .limit(3);

        if (jobsError) console.error("Error fetching latest jobs:", jobsError);
        const jobsToInclude = latestJobs || [];

        // 2. Fetch all users from the production users table
        const { data: users, error: usersError } = await supabase
            .from(USERS_TABLE)
            .select("email, full_name");

        if (usersError) throw new Error(`Users Fetch Error: ${usersError.message}`);

        // 3. Fetch all transactions to determine subscription status
        const { data: transactions, error: transError } = await supabase
            .from(TRANSACTIONS_TABLE)
            .select("user_email, expiry_date")
            .order("expiry_date", { ascending: false });

        if (transError) throw new Error(`Transactions Fetch Error: ${transError.message}`);

        // Map transactions to get the LATEST expiry date for each email
        const userExpiries = new Map();
        transactions.forEach(t => {
            if (!userExpiries.has(t.user_email)) {
                userExpiries.set(t.user_email, new Date(t.expiry_date));
            }
        });

        console.log(`Processing emails for ${users.length} production users...`);
        const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

        for (const user of users) {
            const userEmail = user.email;
            const clientName = user.full_name || "there";
            const latestExpiry = userExpiries.get(userEmail);
            const now = new Date();

            try {
                if (!latestExpiry) {
                    console.log(`[Processing] Sending UPSELL email to: ${userEmail}`);
                    await sendUpsellEmail(userEmail, clientName, jobsToInclude);
                }
                else if (latestExpiry > now) {
                    console.log(`[Processing] Sending ACTIVE email to: ${userEmail}`);
                    await sendActiveUpdateEmail(userEmail, clientName, jobsToInclude);
                }
                else {
                    console.log(`[Processing] Sending RENEWAL email to: ${userEmail}`);
                    await sendRenewalEmail(userEmail, clientName, jobsToInclude);
                }

                // Rate limiting: 2 seconds between emails (30/min)
                await sleep(2000);
            } catch (mailErr) {
                console.error(`Failed to process email for ${userEmail}:`, mailErr.message);
            }
        }

        console.log(`Production email run completed successfully.`);
    } catch (err) {
        console.error("FATAL CRON ERROR:", err.message);
    }
}

// Schedule for 5:30 PM IST (Asia/Kolkata)
cron.schedule("30 17 * * *", () => {
    processDailyEmails();
}, {
    scheduled: true,
    timezone: "Asia/Kolkata"
});

console.log("WhoPosted Daily Mailer Service is LIVE.");
console.log(`Scheduled: 17:30 IST | Rate Limit: 30/min | Users: ${USERS_TABLE}`);

// Export for manual/scheduled triggering
module.exports = { processDailyEmails };
