const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;

// Necessário no Railway (e em qualquer host atrás de proxy) para que req.ip reflita o
// IP real de quem está acessando (via X-Forwarded-For), em vez do IP do proxy interno.
// Sem isso, o rate limit abaixo trataria todo mundo como o mesmo IP.
app.set("trust proxy", true);

const APP_USERNAME = process.env.APP_USERNAME;
const APP_PASSWORD = process.env.APP_PASSWORD;

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a)); const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) { crypto.timingSafeEqual(bufA, bufA); return false; }
  return crypto.timingSafeEqual(bufA, bufB);
}

// ---------- rate limit de login (por IP) ----------
const MAX_FAILED_ATTEMPTS = 5;
const FAILURE_WINDOW_MS = 15 * 60 * 1000; // 15 min
const LOCKOUT_MS = 15 * 60 * 1000; // 15 min

const loginAttempts = new Map(); // ip -> { failures, windowStart, blockedUntil }

function getLoginAttempt(ip) {
  const now = Date.now();
  let a = loginAttempts.get(ip);
  if (!a || (now - a.windowStart > FAILURE_WINDOW_MS && a.blockedUntil < now)) {
    a = { failures: 0, windowStart: now, blockedUntil: 0 };
    loginAttempts.set(ip, a);
  }
  return a;
}

// limpeza periódica para não acumular IPs indefinidamente na memória
setInterval(() => {
  const now = Date.now();
  for (const [ip, a] of loginAttempts) {
    if (now - a.windowStart > FAILURE_WINDOW_MS && a.blockedUntil < now) loginAttempts.delete(ip);
  }
}, 60 * 60 * 1000);

// Basic Auth simples: protege tanto a página quanto a API por trás de um único usuário/senha
// compartilhado. Se as variáveis não estiverem configuradas, bloqueia tudo (falha fechada)
// em vez de deixar o painel aberto por engano. Depois de várias tentativas erradas seguidas
// do mesmo IP, bloqueia temporariamente (evita adivinhação de senha por força bruta).
function requireAuth(req, res, next) {
  if (!APP_USERNAME || !APP_PASSWORD) {
    console.error("APP_USERNAME/APP_PASSWORD não definidas — bloqueando acesso por segurança.");
    return res.status(503).send("Painel não configurado corretamente. Contate o administrador.");
  }

  const ip = req.ip;
  const attempt = getLoginAttempt(ip);
  const now = Date.now();
  if (attempt.blockedUntil > now) {
    const retrySec = Math.ceil((attempt.blockedUntil - now) / 1000);
    res.set("Retry-After", String(retrySec));
    return res.status(429).send(`Muitas tentativas com senha incorreta. Tente novamente em ${Math.ceil(retrySec / 60)} minuto(s).`);
  }

  const [scheme, encoded] = (req.headers.authorization || "").split(" ");
  if (scheme === "Basic" && encoded) {
    const decoded = Buffer.from(encoded, "base64").toString("utf-8");
    const sep = decoded.indexOf(":");
    const user = decoded.slice(0, sep);
    const pass = decoded.slice(sep + 1);
    if (safeEqual(user, APP_USERNAME) && safeEqual(pass, APP_PASSWORD)) {
      loginAttempts.delete(ip);
      return next();
    }
    // só conta como tentativa falha quando veio uma credencial de verdade (não a
    // primeira requisição sem Authorization, que é o fluxo normal do Basic Auth)
    attempt.failures++;
    if (attempt.failures >= MAX_FAILED_ATTEMPTS) attempt.blockedUntil = now + LOCKOUT_MS;
  }

  res.set("WWW-Authenticate", 'Basic realm="Painel de Prazos"');
  res.status(401).send("Acesso restrito.");
}

app.get("/api/health", (req, res) => res.json({ ok: true }));
app.use(requireAuth);

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error(
    "DATABASE_URL não definida. No Railway, adicione um plugin PostgreSQL e conecte a variável DATABASE_URL ao serviço."
  );
}

const pool = new Pool({
  connectionString,
  ssl: connectionString && !connectionString.includes("localhost") ? { rejectUnauthorized: false } : false,
});

const SEED = JSON.parse(fs.readFileSync(path.join(__dirname, "seed.json"), "utf-8"));

const SNAPSHOT_RETENTION = 30; // mantém os últimos 30 backups automáticos

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS painel_state (
      id SMALLINT PRIMARY KEY,
      data JSONB NOT NULL,
      last_modified TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS painel_snapshots (
      id SERIAL PRIMARY KEY,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS painel_snapshots_created_at_idx ON painel_snapshots (created_at DESC);`);

  const { rows } = await pool.query("SELECT id FROM painel_state WHERE id = 1");
  if (rows.length === 0) {
    await pool.query("INSERT INTO painel_state (id, data, last_modified) VALUES (1, $1::jsonb, now())", [
      JSON.stringify({ items: SEED }),
    ]);
    console.log(`Estado inicial semeado com ${SEED.length} prazos.`);
  }
}

// Backup automático: cria no máximo um snapshot por dia, sem depender de ninguém clicar
// em nada. Roda uma vez no boot e depois é checado a cada hora (se o snapshot de hoje já
// existir, não faz nada) — assim funciona mesmo que o serviço reinicie no meio do dia.
async function maybeSnapshot() {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const { rows: existing } = await pool.query(
      "SELECT id FROM painel_snapshots WHERE created_at::date = $1::date LIMIT 1",
      [today]
    );
    if (existing.length) return;

    const { rows } = await pool.query("SELECT data FROM painel_state WHERE id = 1");
    if (!rows.length) return;

    await pool.query("INSERT INTO painel_snapshots (data, created_at) VALUES ($1::jsonb, now())", [
      JSON.stringify(rows[0].data),
    ]);
    await pool.query(
      `DELETE FROM painel_snapshots WHERE id NOT IN (
         SELECT id FROM painel_snapshots ORDER BY created_at DESC LIMIT $1
       )`,
      [SNAPSHOT_RETENTION]
    );
    console.log("Backup automático criado em", new Date().toISOString());
  } catch (err) {
    console.error("Falha ao criar backup automático:", err);
  }
}

app.get("/api/state", async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT data, last_modified FROM painel_state WHERE id = 1");
    if (!rows.length) return res.status(500).json({ error: "estado não inicializado" });
    res.json({ items: rows[0].data.items, lastModified: rows[0].last_modified.toISOString() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "erro ao ler estado" });
  }
});

app.put("/api/state", async (req, res) => {
  const { items, baseline } = req.body || {};
  if (!Array.isArray(items)) return res.status(400).json({ error: "items deve ser um array" });

  try {
    const { rows } = await pool.query("SELECT last_modified FROM painel_state WHERE id = 1");
    if (!rows.length) return res.status(500).json({ error: "estado não inicializado" });
    const currentModified = rows[0].last_modified.toISOString();

    // detecção de conflito: se o cliente estava vendo uma versão diferente da atual,
    // devolve 409 com os dados mais recentes em vez de sobrescrever silenciosamente.
    if (baseline && currentModified !== baseline) {
      const { rows: freshRows } = await pool.query("SELECT data, last_modified FROM painel_state WHERE id = 1");
      return res.status(409).json({
        conflict: true,
        items: freshRows[0].data.items,
        lastModified: freshRows[0].last_modified.toISOString(),
      });
    }

    const now = new Date();
    await pool.query("UPDATE painel_state SET data = $1::jsonb, last_modified = $2 WHERE id = 1", [
      JSON.stringify({ items }),
      now,
    ]);
    res.json({ items, lastModified: now.toISOString() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "erro ao salvar estado" });
  }
});

app.get("/api/snapshots", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, created_at, jsonb_array_length(data->'items') AS item_count
       FROM painel_snapshots ORDER BY created_at DESC LIMIT $1`,
      [SNAPSHOT_RETENTION]
    );
    res.json(rows.map((r) => ({ id: r.id, createdAt: r.created_at.toISOString(), itemCount: r.item_count })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "erro ao listar backups" });
  }
});

app.post("/api/snapshots/:id/restore", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "id inválido" });
  try {
    const { rows } = await pool.query("SELECT data FROM painel_snapshots WHERE id = $1", [id]);
    if (!rows.length) return res.status(404).json({ error: "backup não encontrado" });
    const now = new Date();
    await pool.query("UPDATE painel_state SET data = $1::jsonb, last_modified = $2 WHERE id = 1", [
      JSON.stringify(rows[0].data),
      now,
    ]);
    res.json({ items: rows[0].data.items, lastModified: now.toISOString() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "erro ao restaurar backup" });
  }
});

ensureSchema()
  .then(async () => {
    app.listen(PORT, () => console.log(`Painel de Prazos rodando na porta ${PORT}`));
    await maybeSnapshot();
    setInterval(maybeSnapshot, 60 * 60 * 1000);
  })
  .catch((err) => {
    console.error("Falha ao preparar o banco de dados:", err);
    process.exit(1);
  });
