import express from "express";
import https from "https";
import fs from "fs";
import { parseStringPromise } from "xml2js";

const app = express();
app.use(express.json({ limit: "1mb" }));

const TLO_HOST = "secureapi.tlo.com";
const TLO_PATH = "/TLOWebService.asmx";

const SHARED_SECRET = process.env.SHARED_SECRET;
const TLO_USERNAME = process.env.TLO_USERNAME;
const TLO_PASSWORD = process.env.TLO_PASSWORD;
const TLO_CERT_PATH = process.env.TLO_CERT_PATH;
const TLO_KEY_PATH = process.env.TLO_KEY_PATH;

function esc(s = "") {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function buildPersonSearchXML({ username, password, firstName, lastName, ssn }) {
  const cleanSSN = String(ssn || "").replace(/\D/g, "");
  return `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                  xmlns:tlo="http://tlo.com/">
  <soapenv:Header/>
  <soapenv:Body>
    <tlo:PersonSearch>
      <tlo:genericSearchInput>
        <tlo:Username>${esc(username)}</tlo:Username>
        <tlo:Password>${esc(password)}</tlo:Password>
        <tlo:DPPAPurpose>0</tlo:DPPAPurpose>
        <tlo:GLBPurpose>0</tlo:GLBPurpose>
        <tlo:NumberOfRecords>25</tlo:NumberOfRecords>
        <tlo:StartingRecord>1</tlo:StartingRecord>
        <tlo:Name>
          <tlo:FirstName>${esc(firstName)}</tlo:FirstName>
          <tlo:LastName>${esc(lastName)}</tlo:LastName>
        </tlo:Name>
        <tlo:SSN>${cleanSSN}</tlo:SSN>
      </tlo:genericSearchInput>
    </tlo:PersonSearch>
  </soapenv:Body>
</soapenv:Envelope>`;
}

function postSoapToTlo({ cert, key, xml }) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: TLO_HOST,
        path: TLO_PATH,
        method: "POST",
        cert,
        key,
        headers: {
          "Content-Type": "text/xml; charset=utf-8",
          "SOAPAction": "\"http://tlo.com/PersonSearch\"",
          "Content-Length": Buffer.byteLength(xml),
        },
        timeout: 30000,
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve({ status: res.statusCode || 0, body: data }));
      }
    );
    req.on("timeout", () => req.destroy(new Error("TLO request timed out")));
    req.on("error", reject);
    req.write(xml);
    req.end();
  });
}

app.get("/health", (req, res) => res.send("ok"));

app.post("/tlo/person-search", async (req, res) => {
  try {
    if (req.header("x-shared-secret") !== SHARED_SECRET) {
      return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
    }

    const { firstName, lastName, ssn } = req.body || {};
    if (!firstName || !lastName || !ssn) {
      return res.status(400).json({ ok: false, error: "BAD_REQUEST" });
    }

    const cert = fs.readFileSync(TLO_CERT_PATH);
    const key = fs.readFileSync(TLO_KEY_PATH);

    const xml = buildPersonSearchXML({
      username: TLO_USERNAME,
      password: TLO_PASSWORD,
      firstName,
      lastName,
      ssn,
    });

    const tloResp = await postSoapToTlo({ cert, key, xml });
    const raw = String(tloResp.body || "");

    if (raw.trim().startsWith("<html")) {
      return res.status(502).json({ ok: false, error: "TLO_FORBIDDEN_HTML", rawStart: raw.slice(0, 500) });
    }

    const parsed = await parseStringPromise(raw, { explicitArray: false });
    res.json({ ok: true, rawSoap: parsed });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.listen(3000, () => console.log("tlo proxy listening on 3000"));
