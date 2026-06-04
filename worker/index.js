/**
 * Volleyball Lessons — Cloudflare Worker
 *
 * Receives booking + contact form submissions, calls Claude to generate
 * a personalized practice plan, then sends everything to Garrett's inbox
 * via Web3Forms.
 *
 * Secrets (set via `wrangler secret put`):
 *   ANTHROPIC_API_KEY   — Anthropic API key
 *   WEB3FORMS_KEY       — Web3Forms access key
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method !== 'POST') {
      return json({ error: 'Method not allowed' }, 405);
    }

    const url = new URL(request.url);

    if (url.pathname === '/submit-booking') {
      return handleBooking(request, env);
    }
    if (url.pathname === '/submit-contact') {
      return handleContact(request, env);
    }

    return json({ error: 'Not found' }, 404);
  },
};

// ── BOOKING ──────────────────────────────────────────────────────────────────

async function handleBooking(request, env) {
  let data;
  try {
    data = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const required = ['parent_name', 'email', 'athlete_name', 'age', 'skill_level', 'selected_time', 'package'];
  for (const field of required) {
    if (!data[field]) return json({ error: `Missing field: ${field}` }, 400);
  }

  // Generate practice plan with Claude
  let practicePlan;
  try {
    practicePlan = await generatePracticePlan(data, env);
  } catch (err) {
    practicePlan = `[Practice plan generation failed: ${err.message}]`;
  }

  // Send email via Web3Forms
  const emailBody = buildBookingEmail(data, practicePlan);
  const sent = await sendEmail(env, {
    subject: `New lesson request — ${data.athlete_name} (${data.skill_level})`,
    ...emailBody,
  });

  if (!sent.success) {
    return json({ error: 'Failed to send email', detail: sent.message }, 500);
  }

  return json({ success: true });
}

// ── CONTACT ───────────────────────────────────────────────────────────────────

async function handleContact(request, env) {
  let data;
  try {
    data = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const required = ['parent_name', 'email', 'message'];
  for (const field of required) {
    if (!data[field]) return json({ error: `Missing field: ${field}` }, 400);
  }

  const sent = await sendEmail(env, {
    subject: `New contact message — ${data.parent_name}`,
    parent_name: data.parent_name,
    email: data.email,
    athlete_age: data.age || '—',
    skill_level: data.skill_level || '—',
    message: data.message,
  });

  if (!sent.success) {
    return json({ error: 'Failed to send email', detail: sent.message }, 500);
  }

  return json({ success: true });
}

// ── CLAUDE — PRACTICE PLAN ────────────────────────────────────────────────────

async function generatePracticePlan(data, env) {
  const sessionCount = packageToSessions(data.package);
  const goals = data.goals?.trim() || 'general skill development';

  const prompt = `You are an expert volleyball coach assistant. Generate a detailed, actionable practice plan for a private lesson series.

ATHLETE PROFILE:
- Name: ${data.athlete_name}
- Age: ${data.age}
- Skill level: ${data.skill_level}
- Sessions booked: ${data.package} (${sessionCount} session${sessionCount > 1 ? 's' : ''})
- Goals / focus areas: ${goals}

TASK:
Write a structured practice plan covering all ${sessionCount} session${sessionCount > 1 ? 's' : ''}.

GUIDELINES:
- Each session is 60 minutes.
- Beginner: focus heavily on fundamentals, short reps, confidence building.
- Developing: build on basics, introduce game-like drills, fix key technique flaws.
- Intermediate: tactical awareness, consistency under pressure, specialization.
- Advanced: high-rep competitive drills, system play, mental performance.
- For multi-session packages: show progression across sessions — early sessions build the foundation, later sessions add complexity and game-speed application.
- Be specific and practical. Include drill names, rep counts, and time estimates where helpful.
- Keep each session plan to ~150–200 words. Tight and actionable.

FORMAT:
Use plain text with clear section headers like "Session 1 — [Focus]" etc. No markdown symbols like **, ##, or *.
End with a short 2-3 sentence coaching note to Garrett about this specific athlete.`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-opus-4-8',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Anthropic API ${response.status}: ${err}`);
  }

  const result = await response.json();
  return result.content[0].text;
}

// ── EMAIL ─────────────────────────────────────────────────────────────────────

async function sendEmail(env, fields) {
  const payload = {
    access_key: env.WEB3FORMS_KEY,
    ...fields,
  };

  const res = await fetch('https://api.web3forms.com/submit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(payload),
  });

  return res.json();
}

// ── HELPERS ───────────────────────────────────────────────────────────────────

function packageToSessions(pkg) {
  if (pkg?.includes('10')) return 10;
  if (pkg?.includes('5')) return 5;
  return 1;
}

function buildBookingEmail(data, practicePlan) {
  return {
    parent_name: data.parent_name,
    email: data.email,
    phone: data.phone || '—',
    athlete_name: data.athlete_name,
    athlete_age: data.age,
    skill_level: data.skill_level,
    requested_time: data.selected_time,
    package: data.package,
    goals: data.goals || '—',
    '--- PRACTICE PLAN ---': practicePlan,
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}
