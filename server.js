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

const PORT = process.env.PORT || 3000;

const WS_URL = 'https://www1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx';
const SOAP_ACTION = 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe/nfeDistDFeInteresse';

// ── SOAP ────────────────────────────────────────────────────────────────────

function buildSoapEnvelope(chave) {
  const uf = chave.slice(0, 2);
  const cnpj = chave.slice(6, 20);
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

  return {
    ok: true,
    cStat,
    cnpjEmitente: extractField(xmlBody, 'CNPJ'),
    razaoSocial: extractField(xmlBody, 'xNome'),
    valor: extractField(xmlBody, 'vNF'),
    dataEmissao: extractField(xmlBody, 'dhEmi') || extractField(xmlBody, 'dEmi'),
    numero: extractField(xmlBody, 'nNF'),
    serie: extractField(xmlBody, 'serie'),
    modelo: extractField(xmlBody, 'mod'),
    ie: extractField(xmlBody, 'IE'),
    tpNF: extractField(xmlBody, 'tpNF'),
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
    req.setTimeout(30000, () => req.destroy(new Error('Timeout')));
    req.write(soapBody);
    req.end();
  });
}

// ── Servidor HTTP ───────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url, 'http://localhost');

  // Health check
  if (parsedUrl.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'proxy-sefaz', timestamp: Date.now() }));
    return;
  }

  // Autenticação
  const expectedSecret = process.env.SKIP_PROXY_SECRET;
  if (expectedSecret) {
    const authHeader = req.headers.authorization || '';
    if (authHeader.replace('Bearer ', '') !== expectedSecret) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, code: 'UNAUTHORIZED', message: 'Secret inválido.' }));
      return;
    }
  }

  // Consulta
  if (req.method === 'POST' && parsedUrl.pathname === '/consulta') {
    let body = '';
    for await (const chunk of req) body += chunk;

    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, code: 'BAD_REQUEST', message: 'JSON inválido.' }));
      return;
    }

    const chave = String(parsed.chave || '').trim();
    if (!/^\d{44}$/.test(chave)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, code: 'CHAVE_INVALIDA', message: 'Chave deve ter 44 dígitos.' }));
      return;
    }

    const certKey = process.env.SEFAZ_CERT_KEY;
    const certCrt = process.env.SEFAZ_CERT_CRT;
    if (!certKey || !certCrt) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, code: 'CERT_NOT_CONFIGURED', message: 'Certificado não configurado.' }));
      return;
    }

    try {
      const soapBody = buildSoapEnvelope(chave);
      const resp = await sendSoap(WS_URL, soapBody, certKey, certCrt);
      const respBody = String(resp.body || '');

      console.log('SEFAZ status:', resp.statusCode, '| cStat:', extractField(respBody, 'cStat'));

      if (resp.statusCode >= 400) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, code: 'SEFAZ_ERRO_HTTP', message: 'HTTP ' + resp.statusCode, raw: respBody.slice(0, 300) }));
        return;
      }

      const result = parseSefazResponse(respBody);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: result.ok,
        code: result.code || 'OK',
        chave,
        uf: chave.slice(0, 2),
        cnpj: chave.slice(6, 20),
        ...result,
      }));
    } catch (err) {
      console.error('Erro:', err);
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
