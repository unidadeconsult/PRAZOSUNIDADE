const express = require("express");
const path = require("path");
const fs = require("fs");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;

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

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS painel_state (
      id SMALLINT PRIMARY KEY,
      data JSONB NOT NULL,
      last_modified TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  const { rows } = await pool.query("SELECT id FROM painel_state WHERE id = 1");
  if (rows.length === 0) {
    await pool.query("INSERT INTO painel_state (id, data, last_modified) VALUES (1, $1::jsonb, now())", [
      JSON.stringify({ items: SEED }),
    ]);
    console.log(`Estado inicial semeado com ${SEED.length} prazos.`);
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

app.get("/api/health", (req, res) => res.json({ ok: true }));

ensureSchema()
  .then(() => {
    app.listen(PORT, () => console.log(`Painel de Prazos rodando na porta ${PORT}`));
  })
  .catch((err) => {
    console.error("Falha ao preparar o banco de dados:", err);
    process.exit(1);
  });
