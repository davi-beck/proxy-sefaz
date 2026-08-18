/**
 * Proxy SEFAZ — servidor HTTP (Render.com / qualquer Node.js)
 *
 * Faz a consulta NFeDistribuicaoDFe na SEFAZ com mTLS (certificado A1 cliente).
 * O runtime do Skip (goja/Go) não suporta renegociação TLS; o Node.js sim.
 *
 * Deploy em 3 passos (Render.com — grátis, sem cartão):
 *   1. Criar conta em https://render.com (login com Google/GitHub)
 *   2. New → Web Service → conectar este repositório/pasta
 *   3. Adicionar Environment Variables:
 *      SEFAZ_CERT_KEY  = (conteúdo do tmp/key_pem.txt)
 *      SEFAZ_CERT_CRT  = (conteúdo do tmp/cert_pem.txt)
 *      SKIP_PROXY_SECRET = GeoCoringSefaz2026
 *
 * Após o deploy, copiar a URL (https://proxy-sefaz-xxxx.onrender.com)
 * e informar para configurar o secret SKIP_PROXY_URL no app do Skip.
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');
const zlib = require('zlib');

const PORT = process.env.PORT || 3000;

const WS_URL = 'https://www1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx';
const SOAP_ACTION = 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe/nfeDistDFeInteresse';

// ── SOAP ────────────────────────────────────────────────────────────────────

// CNPJ base do certificado A1 da Geo Coring — a SEFAZ exige que o CNPJ
// informado em <CNPJ> seja o CNPJ base do certificado digital, não o da chave.
// Configurável via env var; se não definido, usa o default da Geo Coring.
const CNPJ_BASE = process.env.SEFAZ_CNPJ_BASE || '26478473000192';

function buildSoapEnvelope(chave) {
  const uf = chave.slice(0, 2);
  const cnpj = CNPJ_BASE;
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">',
    '<soap12:Body>',
    '<nfeDistDFeInteresse xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe">',
    '<nfeDadosMsg>',
    '<distDFeInt xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.01">',
    '<tpAmb>1</tpAmb>',
    '<cUFAutor>' + uf + '</cUFAutor>',
    '<CNPJ>' + cnpj + '</CNPJ>',
    '<consChNFe><chNFe>' + chave + '</chNFe></consChNFe>',
    '</distDFeInt>',
    '</nfeDadosMsg>',
    '</nfeDistDFeInteresse>',
    '</soap12:Body>',
    '</soap12:Envelope>',
  ].join('');
}

function buildSoapEnvelopeNSU(ultNSU) {
  const uf = '35';
  const cnpj = CNPJ_BASE;
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">',
    '<soap12:Body>',
    '<nfeDistDFeInteresse xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe">',
    '<nfeDadosMsg>',
    '<distDFeInt xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.01">',
    '<tpAmb>1</tpAmb>',
    '<cUFAutor>' + uf + '</cUFAutor>',
    '<CNPJ>' + cnpj + '</CNPJ>',
    '<distNSU><ultNSU>' + ultNSU + '</ultNSU></distNSU>',
    '</distDFeInt>',
    '</nfeDadosMsg>',
    '</nfeDistDFeInteresse>',
    '</soap12:Body>',
    '</soap12:Envelope>',
  ].join('');
}

function extractField(xml, tag) {
  const m = xml.match(new RegExp('<' + tag + '>([^<]*)</' + tag + '>'));
  return m ? m[1] : '';
}

function parseSefazResponse(xmlBody) {
  const cStat = extractField(xmlBody, 'cStat');
  const xMotivo = extractField(xmlBody, 'xMotivo');

  if (cStat && cStat !== '138') {
    return { ok: false, code: 'SEFAZ_REJEICAO', cStat, message: xMotivo || 'Rejeição não especificada' };
  }

  let nfXml = '';
  const docZipMatch = xmlBody.match(/<docZip[^>]*>([^<]*)<\/docZip>/);
  if (docZipMatch) {
    try {
      const b64content = docZipMatch[1];
      const compressed = Buffer.from(b64content, 'base64');
      nfXml = zlib.gunzipSync(compressed).toString('utf8');
    } catch (e) {
      console.error('Erro ao descompactar docZip:', e.message);
    }
  }
  if (!nfXml) {
    const resNFeMatch = xmlBody.match(/<resNFe[^>]*>([\s\S]*?)<\/resNFe>/);
    if (resNFeMatch) {
      nfXml = resNFeMatch[1];
    } else {
      nfXml = xmlBody;
    }
  }

  return {
    ok: true,
    cStat,
    cnpjEmitente: extractField(nfXml, 'CNPJ') || extractField(xmlBody, 'CNPJ'),
    razaoSocial: extractField(nfXml, 'xNome') || extractField(xmlBody, 'xNome'),
    valor: extractField(nfXml, 'vNF') || extractField(xmlBody, 'vNF'),
    dataEmissao: extractField(nfXml, 'dhEmi') || extractField(nfXml, 'dEmi') || extractField(xmlBody, 'dhEmi'),
    numero: extractField(nfXml, 'nNF') || extractField(xmlBody, 'nNF'),
    serie: extractField(nfXml, 'serie') || extractField(xmlBody, 'serie'),
    modelo: extractField(nfXml, 'mod') || extractField(xmlBody, 'mod'),
    ie: extractField(nfXml, 'IE') || extractField(xmlBody, 'IE'),
    tpNF: extractField(nfXml, 'tpNF') || extractField(xmlBody, 'tpNF'),
  };
}

function parseSefazNSUResponse(xmlBody) {
  const cStat = extractField(xmlBody, 'cStat');
  const xMotivo = extractField(xmlBody, 'xMotivo');
  const ultNSU = extractField(xmlBody, 'ultNSU');
  const maxNSU = extractField(xmlBody, 'maxNSU');

  if (cStat && cStat !== '138' && cStat !== '612') {
    return { ok: false, code: 'SEFAZ_REJEICAO', cStat, message: xMotivo };
  }

  const docZipMatches = [...xmlBody.matchAll(/<docZip[^>]*NSU="(\d+)"[^>]*>([^<]*)<\/docZip>/g)];
  const nfs = [];

  for (const match of docZipMatches) {
    const nsu = match[1];
    const b64content = match[2];
    try {
      const compressed = Buffer.from(b64content, 'base64');
      const decompressed = zlib.gunzipSync(compressed).toString('utf8');
      const isResNFe = decompressed.includes('<resNFe');
      const isProcNFe = decompressed.includes('<protNFe') || decompressed.includes('<nfeProc');

      if (isResNFe || isProcNFe) {
        const xml = decompressed;
        nfs.push({
          nsu,
          chave: extractField(xml, 'chNFe'),
          cnpjEmitente: extractField(xml, 'CNPJ'),
          razaoSocial: extractField(xml, 'xNome'),
          valor: extractField(xml, 'vNF'),
          dataEmissao: extractField(xml, 'dhEmi') || extractField(xml, 'dEmi'),
          numero: extractField(xml, 'nNF'),
          serie: extractField(xml, 'serie'),
          modelo: extractField(xml, 'mod'),
          tpNF: extractField(xml, 'tpNF'),
          ie: extractField(xml, 'IE'),
          tipo: isResNFe ? 'resNFe' : 'procNFe',
        });
      }
    } catch (e) {
      console.error('Erro ao descompactar NSU', nsu, ':', e.message);
    }
  }

  return {
    ok: true,
    cStat,
    ultNSU,
    maxNSU,
    temMais: ultNSU && maxNSU && ultNSU !== maxNSU,
    count: nfs.length,
    nfs,
  };
}

function sendSoap(url, soapBody, certKey, certCrt) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const options = {
      hostname: parsedUrl.hostname,
      port: 443,
      path: parsedUrl.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/soap+xml; charset=utf-8; action="' + SOAP_ACTION + '"',
        'Content-Length': Buffer.byteLength(soapBody),
      },
      key: certKey,
      cert: certCrt,
      secureProtocol: 'TLSv1_2_method',
      rejectUnauthorized: true,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
    });

    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('Timeout')));
    req.write(soapBody);
    req.end();
  });
}

// ── Servidor HTTP ───────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url, 'http://localhost');

  if (parsedUrl.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'proxy-sefaz', timestamp: Date.now() }));
    return;
  }

  const expectedSecret = process.env.SKIP_PROXY_SECRET;
  if (expectedSecret) {
    const authHeader = req.headers.authorization || '';
    if (authHeader.replace('Bearer ', '') !== expectedSecret) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, code: 'UNAUTHORIZED' }));
      return;
    }
  }

  // Consulta por chave
  if (req.method === 'POST' && parsedUrl.pathname === '/consulta') {
    let body = '';
    for await (const chunk of req) body += chunk;

    let parsed;
    try { parsed = JSON.parse(body); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, code: 'BAD_REQUEST' }));
      return;
    }

    const chave = String(parsed.chave || '').trim();
    if (!/^\d{44}$/.test(chave)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, code: 'CHAVE_INVALIDA' }));
      return;
    }

    const certKey = process.env.SEFAZ_CERT_KEY;
    const certCrt = process.env.SEFAZ_CERT_CRT;
    if (!certKey || !certCrt) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, code: 'CERT_NOT_CONFIGURED' }));
      return;
    }

    try {
      const soapBody = buildSoapEnvelope(chave);
      const resp = await sendSoap(WS_URL, soapBody, certKey, certCrt);
      const respBody = String(resp.body || '');

      if (resp.statusCode >= 400) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, code: 'SEFAZ_ERRO_HTTP', message: 'HTTP ' + resp.statusCode, raw: respBody.slice(0, 300) }));
        return;
      }

      const result = parseSefazResponse(respBody);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: result.ok, code: result.code || 'OK', chave,
        uf: chave.slice(0, 2), cnpj: chave.slice(6, 20), ...result,
      }));
    } catch (err) {
      console.error('Erro:', err);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, code: 'SEFAZ_ERRO_REDE', message: String(err.message || err).slice(0, 200) }));
    }
    return;
  }

  // Importação massiva (distNSU)
  if (req.method === 'POST' && parsedUrl.pathname === '/importar') {
    let body = '';
    for await (const chunk of req) body += chunk;

    let parsed;
    try { parsed = JSON.parse(body); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, code: 'BAD_REQUEST' }));
      return;
    }

    const certKey = process.env.SEFAZ_CERT_KEY;
    const certCrt = process.env.SEFAZ_CERT_CRT;
    if (!certKey || !certCrt) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, code: 'CERT_NOT_CONFIGURED' }));
      return;
    }

    try {
      let ultNSU = parsed.ultNSU || '0';
      const todasNFs = [];
      let lote = 0;
      let maxNSU = '0';
      let temMais = true;

      while (temMais && lote < 20) {
        lote++;
        console.log('Importacao lote ' + lote + ' | ultNSU=' + ultNSU);

        const soapBody = buildSoapEnvelopeNSU(ultNSU);
        const resp = await sendSoap(WS_URL, soapBody, certKey, certCrt);
        const respBody = String(resp.body || '');

        const result = parseSefazNSUResponse(respBody);

        if (!result.ok) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            ok: false, code: 'SEFAZ_REJEICAO', cStat: result.cStat,
            message: result.message, importadas: todasNFs.length, nfs: todasNFs,
          }));
          return;
        }

        if (result.nfs && result.nfs.length > 0) {
          todasNFs.push(...result.nfs);
        }

        ultNSU = result.ultNSU || ultNSU;
        maxNSU = result.maxNSU || maxNSU;
        temMais = result.temMais;
        if (!temMais) break;
        await new Promise(r => setTimeout(r, 500));
      }

      console.log('Importacao concluida: ' + todasNFs.length + ' NFs em ' + lote + ' lote(s)');

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true, total: todasNFs.length, lotes: lote, ultNSU, maxNSU, nfs: todasNFs,
      }));
    } catch (err) {
      console.error('Erro importacao:', err);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, code: 'SEFAZ_ERRO_REDE', message: String(err.message || err).slice(0, 200) }));
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, code: 'NOT_FOUND' }));
});

server.listen(PORT, () => {
  console.log('Proxy SEFAZ rodando na porta', PORT);
});