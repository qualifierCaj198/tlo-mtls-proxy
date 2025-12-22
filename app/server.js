/**
 * TLO mTLS Proxy – Production Version
 * - mTLS to TLO
 * - Shared-secret auth (n8n-safe)
 * - Structured JSON output
 * - Classified errors
 * - Timeouts + retries
 * - Logging
 */

const fs = require("fs");
const https = require("https");
const crypto = require("crypto");
const express = require("express");
const { parseStringPromise } = require("xml2js");

const app = express();
app.use(express.json());

/* ================= CONFIG ================= */

const CONFIG = {
  PORT: process.env.PORT || 3000,

  SHARED_SECRET: process.env.SHARED_SECRET,

  TLO_USERNAME: process.env.TLO_USERNAME,
  TLO_PASSWORD: process.env.TLO_PASSWORD,

  CERT_PATH: process.env.TLO_CERT_PATH,
  KEY_PATH: process.env.TLO_KEY_PATH,

  TLO_URL: "https://secureapi.tlo.com/TLOWebService.asmx",
  SOAP_ACTION: "http://tlo.com/PersonSearch",

  TIMEOUT_MS: 20000,
  RETRIES: 2,
};

/* ================= UTILS ================= */

function log(level, msg, extra = {}) {
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    ...extra,
  }));
}

function xmlEscape(v) {
  return String(v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function buildSoap({ firstName, lastName, ssn }) {
  return `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tlo="http://tlo.com/">
  <soapenv:Header/>
  <soapenv:Body>
    <tlo:PersonSearch>
      <tlo:genericSearchInput>
        <tlo:Username>${xmlEscape(CONFIG.TLO_USERNAME)}</tlo:Username>
        <tlo:Password>${xmlEscape(CONFIG.TLO_PASSWORD)}</tlo:Password>
        <tlo:DPPAPurpose>0</tlo:DPPAPurpose>
        <tlo:GLBPurpose>0</tlo:GLBPurpose>
        <tlo:NumberOfRecords>25</tlo:NumberOfRecords>
        <tlo:StartingRecord>1</tlo:StartingRecord>
        <tlo:Name>
          <tlo:FirstName>${xmlEscape(firstName)}</tlo:FirstName>
          <tlo:LastName>${xmlEscape(lastName)}</tlo:LastName>
        </tlo:Name>
        <tlo:SSN>${xmlEscape(ssn)}</tlo:SSN>
      </tlo:genericSearchInput>
    </tlo:PersonSearch>
  </soapenv:Body>
</soapenv:Envelope>`;
}

/* ================= HTTPS AGENT ================= */

const agent = new https.Agent({
  cert: fs.readFileSync(CONFIG.CERT_PATH),
  key: fs.readFileSync(CONFIG.KEY_PATH),
  keepAlive: true,
});

/* ================= TLO CALL ================= */

function callTlo(soapXml) {
  const body = Buffer.from(soapXml, "utf8");

  return new Promise((resolve, reject) => {
    const req = https.request(CONFIG.TLO_URL, {
      method: "POST",
      agent,
      timeout: CONFIG.TIMEOUT_MS,
      headers: {
        "Content-Type": "text/xml; charset=utf-8",
        SOAPAction: `"${CONFIG.SOAP_ACTION}"`,
        "Content-Length": body.length,
      },
    }, res => {
      const chunks = [];
      res.on("data", d => chunks.push(d));
      res.on("end", () => {
        resolve({
          httpStatus: res.statusCode,
          raw: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/* ================= ROUTES ================= */

app.get("/health", (_, res) => res.send("ok"));

app.post("/tlo/person-search", async (req, res) => {
  if (req.header("x-shared-secret") !== CONFIG.SHARED_SECRET) {
    return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  }

  const { firstName, lastName, ssn } = req.body || {};
  if (!firstName || !lastName || !ssn) {
    return res.status(400).json({ ok: false, error: "INVALID_INPUT" });
  }

  const soap = buildSoap({ firstName, lastName, ssn });

  for (let attempt = 1; attempt <= CONFIG.RETRIES + 1; attempt++) {
    try {
      const r = await callTlo(soap);

      const parsed = await parseStringPromise(r.raw, { explicitArray: false });
      const result =
        parsed?.["soap:Envelope"]?.["soap:Body"]?.PersonSearchResponse?.PersonSearchResult;

      if (!result) {
        return res.status(502).json({
          ok: false,
          error: "SOAP_PARSE_FAILED",
          rawStart: r.raw.slice(0, 500),
        });
      }

      if (result.ErrorCode && result.ErrorCode !== "0") {
        return res.status(200).json({
          ok: false,
          tloError: true,
          errorCode: result.ErrorCode,
          errorMessage: result.ErrorMessage,
        });
      }

      return res.json({
        ok: true,
        transactionId: result.TransactionId,
        recordsFound: Number(result.NumberOfRecordsFound),
        data: result,
      });

    } catch (err) {
      log("warn", "tlo_attempt_failed", { attempt, err: err.message });
      if (attempt > CONFIG.RETRIES) {
        return res.status(504).json({ ok: false, error: "TLO_TIMEOUT" });
      }
    }
  }
});

/* ================= START ================= */

app.listen(CONFIG.PORT, () => {
  log("info", "proxy_started", { port: CONFIG.PORT });
});
